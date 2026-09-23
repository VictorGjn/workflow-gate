// What a workflow run actually cost, from the only place that knows: the transcripts.
//
// The run record's `tokens` is NOT spend — it is the agent's final context size. Measured on the 15
// recorded runs here: the record totals 91 M tokens where 1.91 BILLION were actually billed, 21x
// more, because almost all of it is cache reads the record never mentions. Costing from
// `totalTokens` is wrong by an order of magnitude, so this reads `message.usage` per message
// instead: input, cache write, cache read, output, each priced separately.
//
// ponytail: zero dependencies, one JSON cache, no database. A completed run's transcripts never change,
// so it is costed once and remembered; only in-progress runs are re-read. The one index (priors, at
// the end) is derived from that cache, for the approval screen.

import { readdirSync, readFileSync, writeFileSync, statSync, createReadStream, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// Anthropic first-party $/MTok — input, output, and the published cache-read rate where one exists
// (otherwise cache read is 0.1x input, cache write 1.25x input). SUBSCRIPTION USERS: this is the
// API-equivalent cost of the run, not a bill. Bump PRICES_AT whenever a number here changes: it is
// stored with every cached figure, so a price change re-costs rather than silently re-baselining.
export const PRICES_AT = '2026-06-24';
const PRICE = {
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'claude-fable-5': { in: 10, out: 50 },
  'claude-mythos-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

// Records carry `claude-opus-5[1m]` (the 1M-context id) and bare aliases like `opus`. Neither is a
// separate price line, so both fold onto the base model. An unknown model costs nothing and is
// REPORTED as unpriced — a silent zero would understate a run.
export function priceOf(model) {
  if (!model) return null;
  let k = String(model).replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
  const alias = { opus: 'claude-opus-5', fable: 'claude-fable-5-1', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5' };
  k = alias[k] || k;
  return PRICE[k] ? { key: k, ...PRICE[k] } : null;
}

export function costOf(model, u) {
  const p = priceOf(model);
  if (!p) return null;
  return (u.in * p.in + u.cw * p.in * 1.25 + u.cr * (p.cacheRead ?? p.in * 0.1) + u.out * p.out) / 1e6;
}

export const emptyUsage = () => ({ in: 0, cw: 0, cr: 0, out: 0, turns: 0, model: null });
export function addUsage(a, b) {
  for (const k of ['in', 'cw', 'cr', 'out', 'turns']) a[k] += b[k];
  a.model = a.model || b.model;
  return a;
}

// Bump when the way a transcript is costed changes: stamped with every cached figure next to
// PRICES_AT, so figures from the old method are re-costed rather than served. 2: dedupe by message.id.
export const COST_SCHEME = 2;

// Claude Code writes one transcript line per content block and repeats the whole message's usage on
// each, output_tokens growing as it streams (measured here: 22.5 k repeats over 17.5 k messages, output
// never shrinking). Summing per line overcounted spend, x6 on one sampled message. So each message.id
// counts once, at its LAST line: a repeat swaps out what its earlier line contributed, which keeps an
// incremental read's delta right too. `seen` maps id -> that contribution. No id: its own message.
// Shared by usageOfTranscript and the gate's live view (approve-server liveRun).
export function addEntry(u, e, seen) {
  const x = e?.message?.usage;
  if (!x) return false;
  const v = { in: x.input_tokens || 0, cw: x.cache_creation_input_tokens || 0,
    cr: x.cache_read_input_tokens || 0, out: x.output_tokens || 0 };
  const id = e.message.id;
  const prev = id ? seen.get(id) : null;
  for (const k of ['in', 'cw', 'cr', 'out']) u[k] += v[k] - (prev ? prev[k] : 0);
  if (!prev) u.turns++;
  if (id) seen.set(id, v);
  // A run still in flight has no record, so no model is known for it — but every assistant line
  // names the model that produced it. That is the only way live cost is anything but zero.
  if (!u.model && e.message.model) u.model = e.message.model;
  return true;
}

// One transcript's billable usage. Reads FORWARD ONLY from `state.offset` when a state object is
// given, so a run still in flight costs its new bytes per poll instead of its whole history: a
// 60-agent run is 200 MB, and re-reading that every 2.5 seconds is not a viewer, it is a disk
// benchmark. Without a state it reads from the start, which is what a completed run needs once.
export async function usageOfTranscript(file, state = null) {
  const u = emptyUsage();
  let size; try { size = statSync(file).size; } catch { return u; }
  const start = state ? Math.min(state.offset || 0, size) : 0;
  // On the state, not per call: one message's lines can straddle two polls.
  const seen = state ? (state.seen ||= new Map()) : new Map();
  if (size <= start) return u;
  // readline hands back a trailing fragment as if it were a line. Counting it would advance the
  // offset past a record that is still being written, and its tokens would never be counted once it
  // completed — the live cost would quietly run under. So each line is held until the next one
  // proves it was newline-terminated, and the last one is only accepted if the file ends in \n.
  let consumed = 0, held = null;
  const endsWithNewline = () => {
    let fd;
    try {
      fd = openSync(file, 'r');
      const b = Buffer.alloc(1);
      return readSync(fd, b, 0, 1, size - 1) === 1 && b[0] === 0x0a;
    } catch { return false; } finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
  };
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8', start }), crlfDelay: Infinity });
  const take = (line) => {
    consumed += Buffer.byteLength(line, 'utf8') + 1;      // the newline this line was split on
    if (!line || line.indexOf('"usage"') < 0) return;        // cheap reject before the JSON parse
    let e; try { e = JSON.parse(line); } catch { return; }
    addEntry(u, e, seen);
  };
  for await (const line of rl) {
    if (held !== null) take(held);
    held = line;
  }
  if (held !== null && endsWithNewline()) take(held);
  if (state) state.offset = start + Math.min(consumed, size - start);
  return u;
}

// Per-agent cost for one run. `cached: true` agents were served from the resume cache and were not
// re-billed, so they are counted as $0 and flagged rather than dropped — a run that looks free
// because it resumed should say so.
// `state`, when given, is a Map of agentId -> { offset, usage } kept by the caller across polls of
// the same in-flight run. Completed runs pass nothing and are read once.
export async function costRun(runDir, agents, state = null) {
  const out = { total: 0, usage: emptyUsage(), agents: [], unpriced: [], resumed: 0 };
  for (const a of agents) {
    if (!a.agentId) continue;
    if (a.cached) {
      out.resumed++;
      out.agents.push({ agentId: a.agentId, label: a.label, model: a.model, cost: 0, resumed: true, usage: emptyUsage() });
      continue;
    }
    let u;
    if (state) {
      let st = state.get(a.agentId);
      if (!st) state.set(a.agentId, st = { offset: 0, usage: emptyUsage() });
      addUsage(st.usage, await usageOfTranscript(join(runDir, 'agent-' + a.agentId + '.jsonl'), st));
      u = st.usage;
    } else {
      u = await usageOfTranscript(join(runDir, 'agent-' + a.agentId + '.jsonl'));
    }
    const model = a.model || u.model;               // record first, transcript for a run still going
    const c = costOf(model, u);
    if (c === null && u.turns && !out.unpriced.includes(model)) out.unpriced.push(model);
    addUsage(out.usage, u);
    out.total += c || 0;
    out.agents.push({ agentId: a.agentId, label: a.label, model, cost: c, resumed: false, usage: u });
  }
  return out;
}

// ---------------------------------------------------------------------------- cache
// Keyed by runId, stamped with the price table it was computed under. A completed run is costed
// once; anything still running is recomputed by the caller every poll (there are never many).
const CACHE = join(homedir(), '.claude', 'workflow-gate-cost-cache.json');

export function loadCache() {
  try { return JSON.parse(readFileSync(CACHE, 'utf8')); } catch { return {}; }
}

// Write via a temp file + rename: two viewers open at once must never leave a half-written cache,
// and a corrupt cache would silently re-cost 200 MB on every load.
export function saveCache(cache) {
  try {
    const tmp = CACHE + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, CACHE);
  } catch { /* a cache that cannot be written is slow, not wrong */ }
}

export function cachedCost(cache, runId) {
  const e = cache[runId];
  return e && e.pricesAt === PRICES_AT && e.scheme === COST_SCHEME ? e : null;
}

export function putCost(cache, runId, costed, extra = {}) {
  cache[runId] = {
    pricesAt: PRICES_AT, scheme: COST_SCHEME, at: Date.now(), total: costed.total, usage: costed.usage,
    resumed: costed.resumed, unpriced: costed.unpriced,
    agents: costed.agents.map((a) => ({ label: a.label, model: a.model, cost: a.cost, resumed: a.resumed, turns: a.usage.turns })),
    ...extra,
  };
  return cache[runId];
}

// ---------------------------------------------------------------------------- run discovery
// Every workflow run this machine has records for, newest first, across every project and session.
export function listRuns() {
  const R = join(homedir(), '.claude', 'projects');
  const ls = (p) => { try { return readdirSync(p); } catch { return []; } };
  const out = [];
  for (const proj of ls(R)) for (const sess of ls(join(R, proj))) {
    const wdir = join(R, proj, sess, 'workflows');
    for (const f of ls(wdir)) {
      if (!/^wf_.*\.json$/.test(f)) continue;
      const id = f.replace(/\.json$/, '');
      let t; try { t = statSync(join(wdir, f)); } catch { continue; }
      out.push({ runId: id, record: join(wdir, f), dir: join(R, proj, sess, 'subagents', 'workflows', id),
        project: proj, session: sess, mtime: t.mtimeMs, size: t.size, live: false });
    }
  }
  // A run directory with no record yet is a run still going — in ANY session, which is the point.
  for (const proj of ls(R)) for (const sess of ls(join(R, proj))) {
    const base = join(R, proj, sess, 'subagents', 'workflows');
    for (const d of ls(base)) {
      if (!/^wf_/.test(d) || out.some((r) => r.runId === d)) continue;
      let t; try { t = statSync(join(base, d)).mtimeMs; } catch { continue; }
      out.push({ runId: d, record: null, dir: join(base, d), project: proj, session: sess, mtime: t, live: true });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------------------- priors
// What past runs of a workflow cost, for the approval screen. The history daemon writes this small
// index after each costing pass; the gate and the editor only ever READ it, so neither walks a
// transcript. The file is under ~/.claude, which the agent being gated can write: priorsFor hands
// back numbers only, and a label or name from the file is a lookup key, never echoed.
const PRIORS = join(homedir(), '.claude', 'workflow-gate-priors.json');
const PRIORS_RUNS = 50;                   // per workflow name, newest first
export const scriptHash = (s) => (s ? createHash('sha256').update(String(s).replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16) : null);

// Same method as history.html's header, so the two pages never disagree on a p75.
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// rows: [{ name, when (ms), sh, status, cost: a cachedCost entry }]. Only completed runs: a run
// killed at minute two says nothing about what a full one costs. Resumed ($0) and unpriced agents
// are left out of the per-label figures, which they would drag toward zero.
export function buildPriors(rows) {
  const names = Object.create(null);
  for (const r of rows) {
    if (!r.name || r.status !== 'completed' || !Number.isFinite(r.cost?.total) || !Number.isFinite(r.when)) continue;
    const agents = (r.cost.agents || []).filter((a) => !a.resumed && Number.isFinite(a.cost))
      .map((a) => ({ label: a.label, model: a.model, cost: a.cost, ...(a.outcome ? { outcome: a.outcome } : {}) }));
    (names[r.name] ||= []).push({ when: r.when, total: r.cost.total, sh: r.sh || null, agents });
  }
  for (const k in names) names[k] = names[k].sort((a, b) => b.when - a.when).slice(0, PRIORS_RUNS);
  return { at: Date.now(), names };
}

export function savePriors(p) {
  try {
    const tmp = PRIORS + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(p));
    renameSync(tmp, PRIORS);
  } catch { /* no priors is an empty line on the approval screen, not an error */ }
}

// null when there is no history for this name — the caller then shows nothing at all. `exact` counts
// runs of this very script text: names drift across versions, so 0 there means "another population".
// FAIL-judged agents (G10 outcome check) are left out of the per-label medians: a cheap failure is not
// a cheap success. Total by construction: any surprise in the file is null, never a throw, because
// the gate calls this on its deny path.
export function priorsFor(name, script = null, index) {
  try {
    if (index === undefined) { try { index = JSON.parse(readFileSync(PRIORS, 'utf8')); } catch { return null; } }
    const names = index?.names;
    if (typeof name !== 'string' || !names || typeof names !== 'object' || !Object.hasOwn(names, name) || !Array.isArray(names[name])) return null;
    const runs = names[name].filter((r) => r && Number.isFinite(r.total) && r.total >= 0 && Number.isFinite(r.when));
    if (!runs.length) return null;
    const costs = Object.create(null), models = Object.create(null);
    for (const r of runs) for (const a of Array.isArray(r.agents) ? r.agents : []) {
      if (!a || typeof a.label !== 'string' || !Number.isFinite(a.cost) || a.cost < 0 || a.outcome === 'FAIL') continue;
      (costs[a.label] ||= []).push(a.cost);
      (models[a.label] ||= new Set()).add(a.model);
    }
    // The tier it was measured on, so a figure next to a changed model select says whose it is. Only a
    // single, model-id-shaped value comes through; anything else is null ("mixed or unknown").
    const sites = Object.create(null);
    for (const k in costs) {
      const m = models[k].size === 1 ? [...models[k]][0] : null;
      sites[k] = { median: pct(costs[k], 0.5), n: costs[k].length, model: typeof m === 'string' && /^[\w.[\]-]{1,60}$/.test(m) ? m : null };
    }
    const totals = runs.map((r) => r.total), whens = runs.map((r) => r.when), sh = scriptHash(script);
    return { n: runs.length, median: pct(totals, 0.5), p75: pct(totals, 0.75), max: Math.max(...totals),
      from: Math.min(...whens), to: Math.max(...whens), exact: sh ? runs.filter((r) => r.sh === sh).length : null, sites };
  } catch { return null; }
}
