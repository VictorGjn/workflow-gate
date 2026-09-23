#!/usr/bin/env node
// Persistent, READ-ONLY viewer for every workflow run this machine has — across all projects and
// sessions, finished and still running — with what each one actually cost and what you thought of it.
//
// Deliberately a separate process from approve-server.mjs. That one is the gate: 61 approved
// fingerprints depend on it, its whole job is to not fail open, and it must not share a process with
// a cost cache that walks 200 MB of transcripts. THIS SERVER CANNOT APPROVE ANYTHING — there is no
// /approve route, no fingerprint writing, no path to workflow-plan-gate.mjs. It writes your own
// notes, the cost cache, and the priors index the approval screen reads — numbers only, and the
// readers (cost.mjs priorsFor) take nothing else from it.
//
// Security is the gate's SHAPE with a different threat model, not its guarantees: loopback bind,
// nonce in the URL, Origin mandatory on POST — but this nonce is written to a file and printed to
// stdout so a later `history` invocation can reuse the daemon, and the daemon lives 8 hours. The
// gate's nonce, by contrast, exists only inside one URL and dies with the decision. That is
// acceptable HERE because nothing reachable from this process can approve, spend, or delete — the
// single write route stores prose. Anything added later that is not prose invalidates that
// reasoning and needs the gate's nonce discipline instead.
//
// ponytail: zero dependencies. One JSON cache, one JSON notes file, one derived priors file, no database.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, renameSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { listRuns, costRun, loadCache, saveCache, cachedCost, putCost, PRICES_AT, buildPriors, savePriors, scriptHash } from './cost.mjs';
import { judgeRun, outcomeOn } from './advise.mjs';
import { indexSessions } from './sessions.mjs';
import { searchThread, sessionDetail } from './threads.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT_FILE = join(homedir(), '.claude', 'workflow-gate-history-port');
const NOTES_FILE = join(homedir(), '.claude', 'workflow-gate-notes.json');
const IDLE_MS = 8 * 60 * 60 * 1000;      // a viewer nobody has opened in 8 hours is not a viewer

const nonce = randomBytes(24).toString('hex');
let lastHit = Date.now();
const cache = loadCache();
let costing = false;                      // one costing pass at a time: it is disk-bound

const die = (code) => { server.close(); server.closeAllConnections(); setTimeout(() => process.exit(code), 50).unref(); };

// ---------------------------------------------------------------------------- notes
// Keyed by runId, and WITHIN a run by agent LABEL, not agentId. An agent id is a random hex string
// that means nothing six weeks later and is different on every re-run; a label is the call site,
// which is the thing you would actually go and fix. A fan-out shares one label across N agents on
// purpose — the note is about the call site, not one of its copies.
function loadNotes() { try { return JSON.parse(readFileSync(NOTES_FILE, 'utf8')); } catch { return {}; } }
function saveNotes(n) {
  const tmp = NOTES_FILE + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(n, null, 1));
  renameSync(tmp, NOTES_FILE);
}

// ---------------------------------------------------------------------------- run summaries
function readRecord(r) {
  if (!r.record) return null;
  try { return JSON.parse(readFileSync(r.record, 'utf8')); } catch { return null; }
}

const agentsOf = (rec) => (rec?.workflowProgress || []).filter((x) => x.type === 'workflow_agent');

// A run still going has no record: everything known about it comes from the directory itself.
function liveShape(r) {
  let files = []; try { files = readdirSync(r.dir); } catch {}
  const ids = files.filter((f) => /^agent-.*\.jsonl$/.test(f)).map((f) => f.slice(6, -6));
  let done = 0;
  try {
    const j = readFileSync(join(r.dir, 'journal.jsonl'), 'utf8');
    done = (j.match(/"type"\s*:\s*"result"/g) || []).length;
  } catch {}
  return { agents: ids.map((id) => ({ agentId: id, label: null, model: null, state: 'running' })), done };
}

// Paths the workflow said it wrote. `result` is free-form JSON, so this is a scan for things that
// look like files — honestly labelled as such in the UI, never presented as a guaranteed artefact list.
function outputsOf(rec) {
  const found = new Set();
  const walk = (v, depth = 0) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') {
      for (const m of v.matchAll(/(?:[A-Za-z]:[\\/]|\/)[^\s"'`,;)\]]*\.[A-Za-z0-9]{1,6}\b/g)) found.add(m[0]);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v === 'object') return Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(rec?.result);
  return [...found].slice(0, 40);
}

// The record-derived half of a summary, memoized: /runs is polled every 2.5 s while anything is live
// or pending, and re-parsing every record for that is the bulk of the poll. Keyed on the record's
// mtime+size (ponytail: a same-size rewrite within one mtime tick serves stale, unlikely for an
// append-once record). Live runs are not memoized, their journal moves under a fixed dir mtime, and
// the cost fields never are: costMissing fills them in AFTER the first summary.
const MEMO = new Map(), MEMO_MAX = 5000;
function recordPart(r) {
  const m = r.record && MEMO.get(r.record);
  if (m && m.mtime === r.mtime && m.size === r.size) return m.v;
  const v = describe(r);
  if (!v.live) {
    if (MEMO.size >= MEMO_MAX) MEMO.delete(MEMO.keys().next().value);
    MEMO.set(r.record, { mtime: r.mtime, size: r.size, v });
  }
  return v;
}

function summarise(r) {
  const cost = cachedCost(cache, r.runId);
  // A fresh object every time: /runs writes live cost onto it.
  return { ...recordPart(r),
    cost: cost ? cost.total : null, costUsage: cost ? cost.usage : null,
    resumed: cost ? cost.resumed : 0, unpriced: cost ? cost.unpriced : [], delivered: deliveredOf(cost) };
}

// A retried approved call carries only scriptPath: the text that ran is the one approved for that
// path (the gate rewrites the call to it), taken from the baseline the approval wrote. Never the file
// as it is now — it may have changed since the run. A baseline newer than the run describes a later
// approval, so it says nothing about this one.
const APPROVED_DIR = join(homedir(), '.claude', 'workflow-gate', 'approved');
function approvedTextOf(rec) {
  if (!rec?.scriptPath) return null;
  try {
    const b = JSON.parse(readFileSync(join(APPROVED_DIR, createHash('sha256').update(resolve(rec.scriptPath)).digest('hex').slice(0, 16) + '.json'), 'utf8'));
    const ran = Date.parse(rec.timestamp || rec.startTime || '');
    return typeof b.text === 'string' && !(Date.parse(b.ts) > ran) ? b.text : null;
  } catch { return null; }
}

function describe(r) {
  const rec = readRecord(r);
  const live = !rec;
  const shape = live ? liveShape(r) : null;
  const agents = live ? shape.agents : agentsOf(rec);
  return {
    runId: r.runId, live, project: r.project, session: r.session,
    name: rec?.workflowName || (rec?.summary || '').slice(0, 60) || (live ? '(running)' : '(unnamed)'),
    summary: rec?.summary || '', status: live ? 'running' : (rec?.status || 'unknown'),
    when: rec?.timestamp || rec?.startTime || r.mtime,
    durationMs: rec?.durationMs || null,
    agentCount: agents.length, doneCount: live ? shape.done : agents.filter((a) => /done|complete/.test(a.state || '')).length,
    defaultModel: rec?.defaultModel || null,
    sh: scriptHash(rec?.script || approvedTextOf(rec)),   // which script text ran: the priors say when it is not this one
    recordTokens: rec?.totalTokens || null,
    outputs: rec ? outputsOf(rec).length : 0,
  };
}

// Cost every completed run that is not in the cache yet, one at a time, in the background. The first
// run of this viewer walks ~200 MB of transcripts; blocking /runs on that would mean a minute of
// blank page, so the list ships immediately with cost:null and the page polls until they fill in.
async function costMissing(runs = null) {
  if (costing) return;
  costing = true;
  try {
    for (const r of runs || listRuns()) {
      if (r.live || cachedCost(cache, r.runId)) continue;
      const rec = readRecord(r);
      if (!rec) continue;
      const costed = await costRun(r.dir, agentsOf(rec));
      const old = cache[r.runId];
      putCost(cache, r.runId, costed);
      // A re-cost (new price table) keeps the outcome verdicts: same agents, same order.
      if (old?.outcome) { cache[r.runId].outcome = old.outcome; cache[r.runId].agents.forEach((a, i) => { if (old.agents?.[i]?.outcome) a.outcome = old.agents[i].outcome; }); }
      saveCache(cache);
    }
    writePriors(runs || listRuns());               // before judging: a slow Jev must not hold the priors back
    // Only when a judgment can happen: an awaited no-op still yields, and /runs would report costing:true.
    if (outcomeOn() && Date.now() >= judgeOffUntil) { await judgeMissing(runs || listRuns()); writePriors(runs || listRuns()); }
  } catch { /* a viewer that cannot cost is still a viewer */ }
  finally { costing = false; }
}

// Opt-in (G10): did each agent of a costed, completed run deliver? Asked once per run, stored in the
// cost cache next to its figures. Jev unreachable: stop, and not again for JUDGE_BACKOFF_MS, or every
// 2.5 s poll would wait out an 8 s timeout per run while new runs sit uncosted behind the lock.
const JUDGE_BACKOFF_MS = 10 * 60 * 1000;
let judgeOffUntil = 0;
async function judgeMissing(runs) {
  if (!outcomeOn() || Date.now() < judgeOffUntil) return;
  for (const r of runs) {
    const c = !r.live && cachedCost(cache, r.runId);
    if (!c || c.outcome) continue;
    const rec = readRecord(r);
    if (rec?.status !== 'completed') continue;
    const v = await judgeRun(r.dir, agentsOf(rec));
    if (!v) { judgeOffUntil = Date.now() + JUDGE_BACKOFF_MS; return; }
    c.agents.forEach((a, i) => { if (v[i]) a.outcome = v[i]; });
    c.outcome = { at: Date.now() };
    saveCache(cache);
  }
}

// "k/n agents delivered" and what each delivered one cost, from the verdicts above. null = not judged.
function deliveredOf(c) {
  if (!c?.outcome) return null;
  const j = c.agents.filter((a) => a.outcome), pass = j.filter((a) => a.outcome === 'PASS').length;
  return { pass, judged: j.length, fail: j.filter((a) => a.outcome === 'FAIL').length,
    review: j.filter((a) => a.outcome === 'REVIEW').length, costPerPass: pass ? c.total / pass : null };
}

// The approval screen's "past runs" line, precomputed here so the gate never walks a transcript.
// Rewritten only when it changed: costMissing runs on every 2.5 s poll.
let lastPriors = '';
function writePriors(runs) {
  const rows = [];
  for (const r of runs) {
    const cost = !r.live && cachedCost(cache, r.runId);
    if (!cost) continue;
    const d = recordPart(r);
    rows.push({ name: d.name, status: d.status, when: typeof d.when === 'number' ? d.when : Date.parse(d.when), sh: d.sh, cost });
  }
  const p = buildPriors(rows), s = JSON.stringify(p.names);
  if (s !== lastPriors) { savePriors(p); lastPriors = s; }
}

// A run in flight is re-costed on every poll, but only over the bytes written since the last one —
// per-run, per-agent offsets live here and are dropped when the run ends.
const liveState = new Map();
async function costLive(r) {
  const shape = liveShape(r);
  let st = liveState.get(r.runId);
  if (!st) liveState.set(r.runId, st = new Map());
  return costRun(r.dir, shape.agents.map((a) => ({ ...a, model: null })), st);
}

// ---------------------------------------------------------------------------- server
const server = createServer(async (req, res) => {
  lastHit = Date.now();
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (code, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const json = (o) => send(200, JSON.stringify(o), 'application/json; charset=utf-8');

  if (url.searchParams.get('n') !== nonce) return send(403, 'bad nonce');
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return send(403, 'bad origin');
  if (req.method === 'POST' && !origin) return send(403, 'must come from the viewer page');

  try {
    if (url.pathname === '/' && req.method === 'GET') {
      return send(200, readFileSync(join(HERE, 'history.html'), 'utf8').replace('__NONCE__', nonce),
        'text/html; charset=utf-8');
    }

    if (url.pathname === '/runs' && req.method === 'GET') {
      const all = listRuns();                           // walked once per poll, not once per use
      const runs = all.map(summarise);
      // A run in flight has no cached figure and never will until it ends — cost it now. There are
      // never many, and its number is the whole reason to look at a live run at all.
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        if (!r.live) { liveState.delete(r.runId); continue; }   // it ended: drop its offsets
        const c = await costLive(all[i]);
        r.cost = c.total; r.costUsage = c.usage; r.unpriced = c.unpriced;
      }
      costMissing(all);                                // fire and forget; the page polls
      const notes = loadNotes();
      // The page polls every 2.5 s and most polls change nothing: answer those 304, no body.
      const body = JSON.stringify({ runs, notes, pricesAt: PRICES_AT, costing, pending: runs.filter((r) => !r.live && r.cost === null).length });
      const etag = '"' + createHash('sha1').update(body).digest('base64url') + '"';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-store' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', etag });
      return res.end(body);
    }

    // One thread of work, assembled across handoffs, sessions, memories and tickets. On demand only:
    // it reads every transcript (120 MB, ~450 ms today), which is fine for a search someone typed
    // and would not be fine on a poll.
    if (url.pathname === '/thread' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').slice(0, 120).trim();
      if (q.length < 3) return json({ query: q, error: 'type at least three characters' });
      const idx = await indexSessions();
      const th = searchThread(q, { sessionIndex: idx });
      // The prompts and the written files are what "inputs and outputs" means, and they are only in
      // the transcript — parsed for the handful of sessions actually shown.
      th.sessions = th.sessions.slice(0, 8).map((x) => ({ ...x, detail: sessionDetail(x.project, x.sessionId, { maxPrompts: 6 }) }));
      return json(th);
    }

    if (url.pathname === '/run' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      const r = listRuns().find((x) => x.runId === id);
      if (!r) return send(404, 'no such run');
      const rec = readRecord(r);
      const base = summarise(r);
      let costed = cachedCost(cache, r.runId);
      if (r.live) costed = await costLive(r);
      const byLabel = {};
      for (const a of (costed?.agents || [])) {
        const k = a.label || '(unlabelled)';
        (byLabel[k] = byLabel[k] || { label: k, model: a.model, n: 0, cost: 0, turns: 0, resumed: 0, fail: 0 });
        if (a.outcome === 'FAIL') byLabel[k].fail++;
        byLabel[k].n++; byLabel[k].cost += a.cost || 0;
        byLabel[k].turns += a.turns ?? a.usage?.turns ?? 0;
        if (a.resumed) byLabel[k].resumed++;
      }
      return json({
        ...base,
        script: rec?.script || null, scriptPath: rec?.scriptPath || null,
        phases: (rec?.workflowProgress || []).filter((x) => x.type === 'workflow_phase').map((p) => p.title),
        agents: agentsOf(rec).map((a) => ({ label: a.label, phase: a.phaseTitle, model: a.model, state: a.state,
          durationMs: a.durationMs, toolCalls: a.toolCalls, lastToolName: a.lastToolName,
          resultPreview: String(a.resultPreview || '').slice(0, 300), cached: !!a.cached })),
        callSites: Object.values(byLabel).sort((a, b) => b.cost - a.cost),
        outputs: rec ? outputsOf(rec) : [],
        cost: costed ? costed.total : null, costUsage: costed ? costed.usage : null,
        notes: loadNotes()[id] || null,
      });
    }

    // The ONLY write. It cannot approve anything — it touches one JSON file of your own prose.
    if (url.pathname === '/note' && req.method === 'POST') {
      let body = '';
      let tooBig = false;
      // Answer 413 rather than destroying the socket, which leaves the caller waiting forever.
      req.on('data', (c) => { if (tooBig) return; body += c; if (body.length > 2e5) { tooBig = true; send(413, 'note too large'); } });
      req.on('end', () => {
        if (tooBig) return;
        try {
          const { runId, label, verdict, text } = JSON.parse(body);
          if (!runId || typeof runId !== 'string') return send(400, 'runId required');
          if (label !== undefined && typeof label !== 'string') return send(400, 'label must be a string');
          // Both become object keys. `__proto__` writes through the prototype setter and `constructor`
          // resolves to Object itself — either one silently drops the note and returns 200.
          if ([runId, label].some((k) => k != null && /^(__proto__|constructor|prototype)$/.test(k)))
            return send(400, 'reserved key');
          if (verdict && !['worked', 'mixed', 'failed'].includes(verdict)) return send(400, 'bad verdict');
          const notes = loadNotes();
          // `entry.agents[label] || {}` reads through the prototype chain: a label of `toString` or
          // `valueOf` resolves to the inherited function, which is then "updated" and never saved.
          // Own-property checks, so only a key this object actually has is ever reused.
          const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
          if (!own(notes, runId)) notes[runId] = { agents: {} };
          const entry = notes[runId];
          if (!own(entry, 'agents')) entry.agents = {};
          if (label && !own(entry.agents, label)) entry.agents[label] = {};
          const target = label ? entry.agents[label] : entry;
          if (verdict !== undefined) target.verdict = verdict || undefined;
          if (text !== undefined) target.text = String(text).slice(0, 4000) || undefined;
          target.at = Date.now();
          saveNotes(notes);
          return json({ ok: true, notes: notes[runId] });
        } catch (e) { return send(500, String(e.message)); }
      });
      return;
    }

    send(404, 'no');
  } catch (e) {
    send(500, String(e.message));
  }
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(PORT_FILE, JSON.stringify({ port: server.address().port, nonce, pid: process.pid, at: Date.now() }));
  console.log('http://127.0.0.1:' + server.address().port + '/?n=' + nonce);
  costMissing();
});

setInterval(() => { if (Date.now() - lastHit > IDLE_MS) die(0); }, 60000).unref();
