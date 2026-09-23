// What a workflow run actually cost, from the only place that knows: the transcripts.
//
// The run record's `tokens` is NOT spend — it is the agent's final context size. Measured on the 21
// recorded runs here: the record totals 41 M tokens where 3.37 BILLION were actually billed, 81x
// more, because almost all of it is cache reads the record never mentions. Costing from
// `totalTokens` is wrong by an order of magnitude, so this reads `message.usage` per transcript
// line instead: input, cache write, cache read, output, each priced separately.
//
// ponytail: zero dependencies, one JSON cache, no index. A completed run's transcripts never change,
// so it is costed once and remembered; only in-progress runs are re-read.

import { readdirSync, readFileSync, writeFileSync, statSync, createReadStream, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

// One transcript's billable usage. Reads FORWARD ONLY from `state.offset` when a state object is
// given, so a run still in flight costs its new bytes per poll instead of its whole history: a
// 60-agent run is 200 MB, and re-reading that every 2.5 seconds is not a viewer, it is a disk
// benchmark. Without a state it reads from the start, which is what a completed run needs once.
export async function usageOfTranscript(file, state = null) {
  const u = emptyUsage();
  let size; try { size = statSync(file).size; } catch { return u; }
  const start = state ? Math.min(state.offset || 0, size) : 0;
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
    const x = e?.message?.usage;
    if (!x) return;
    u.in += x.input_tokens || 0;
    u.cw += x.cache_creation_input_tokens || 0;
    u.cr += x.cache_read_input_tokens || 0;
    u.out += x.output_tokens || 0;
    u.turns++;
    // A run still in flight has no record, so no model is known for it — but every assistant line
    // names the model that produced it. That is the only way live cost is anything but zero.
    if (!u.model && e.message.model) u.model = e.message.model;
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
  return e && e.pricesAt === PRICES_AT ? e : null;
}

export function putCost(cache, runId, costed, extra = {}) {
  cache[runId] = {
    pricesAt: PRICES_AT, at: Date.now(), total: costed.total, usage: costed.usage,
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
      let t; try { t = statSync(join(wdir, f)).mtimeMs; } catch { continue; }
      out.push({ runId: id, record: join(wdir, f), dir: join(R, proj, sess, 'subagents', 'workflows', id),
        project: proj, session: sess, mtime: t, live: false });
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
