// Local check, not shipped with the plugin. Run from this directory:
//   node history-test.mjs
//
// The history daemon, against a throwaway HOME so neither the real cost cache, the real notes, nor
// the real ~/.claude is touched. Two things this exists for:
//  · the LIVE half — a run with no record yet, in a session nobody is watching — had never executed
//    anywhere. On a machine with no interrupted run there is nothing to exercise it, so build one.
//  · the daemon must remain incapable of approving. That is the property that lets it be persistent
//    and hold its nonce in a file, so it is asserted, not assumed.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOOKS = fileURLToPath(new URL('..', import.meta.url));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = mkdtempSync(join(tmpdir(), 'wg-hist-'));
const SESS = join(T, '.claude', 'projects', 'demo-proj', 'demo-sess');
const WF = join(SESS, 'workflows');
const SUB = join(SESS, 'subagents', 'workflows');
mkdirSync(WF, { recursive: true });

const line = (o) => JSON.stringify(o) + '\n';
const usage = (i, cw, cr, o) => ({ input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o });
const turn = (model, u) => line({ type: 'assistant', timestamp: '2026-09-03T10:00:00.000Z', message: { role: 'assistant', model, usage: u } });

// ---- a COMPLETED run: record + transcripts ----------------------------------------------------
const doneDir = join(SUB, 'wf_done0001-aaa');
mkdirSync(doneDir, { recursive: true });
writeFileSync(join(doneDir, 'agent-d1.jsonl'), turn('claude-sonnet-5', usage(0, 0, 1e6, 0)));   // $0.20
writeFileSync(join(doneDir, 'agent-d2.jsonl'), turn('claude-sonnet-5', usage(0, 0, 1e6, 0)));   // $0.20
writeFileSync(join(WF, 'wf_done0001-aaa.json'), JSON.stringify({
  runId: 'wf_done0001-aaa', workflowName: 'finished-fixture', status: 'completed', timestamp: Date.now(),
  durationMs: 120000, totalTokens: 4242, script: 'export const meta = {}', scriptPath: 'C:/tmp/plan.mjs',
  result: { report: 'C:/tmp/out/report.md', misc: ['/var/tmp/second.json'] },
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: 'Scan' },
    { type: 'workflow_agent', index: 1, agentId: 'd1', label: 'scan', phaseTitle: 'Scan', model: 'claude-sonnet-5', state: 'done' },
    { type: 'workflow_agent', index: 2, agentId: 'd2', label: 'scan', phaseTitle: 'Scan', model: 'claude-sonnet-5', state: 'done' },
  ],
}));

// ---- a LIVE run: a directory with transcripts and a journal, and NO record --------------------
const liveDir = join(SUB, 'wf_live0002-bbb');
mkdirSync(liveDir, { recursive: true });
writeFileSync(join(liveDir, 'agent-L1.jsonl'), turn('claude-haiku-4-5', usage(0, 0, 1e6, 0)));  // $0.10
writeFileSync(join(liveDir, 'agent-L2.jsonl'), turn('claude-haiku-4-5', usage(0, 0, 1e6, 0)));  // $0.10
writeFileSync(join(liveDir, 'journal.jsonl'),
  line({ type: 'started', key: 'v2:a', agentId: 'L1' })
  + line({ type: 'started', key: 'v2:b', agentId: 'L2' })
  + line({ type: 'result', key: 'v2:a', agentId: 'L1', result: { ok: true } }));

// ---- the daemon --------------------------------------------------------------------------------
const env = { ...process.env, HOME: T, USERPROFILE: T };
const srv = spawn(process.execPath, [join(HOOKS, 'history-server.mjs')], { env, stdio: 'ignore' });
srv.unref();

const portFile = join(T, '.claude', 'workflow-gate-history-port');
let cfg = null;
for (let i = 0; i < 80 && !cfg; i++) { await sleep(50); try { cfg = JSON.parse(readFileSync(portFile, 'utf8')); } catch {} }
if (!cfg) { console.error('history server never wrote its port'); srv.kill(); process.exit(1); }
const base = `http://127.0.0.1:${cfg.port}`;
const q = (p) => `${base}${p}${p.includes('?') ? '&' : '?'}n=${cfg.nonce}`;

try {
  // ---- it cannot approve, and it cannot be driven from outside the page ------------------------
  check('a bad nonce is refused', (await fetch(`${base}/runs?n=wrong`)).status === 403);
  check('there is no approval route at all', (await fetch(q('/approve'), { method: 'POST', headers: { origin: base }, body: '{}' })).status === 404);
  check('a POST with no Origin is refused', (await fetch(q('/note'), { method: 'POST', body: '{}' })).status === 403);
  check('a POST from another origin is refused',
    (await fetch(q('/note'), { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}' })).status === 403);
  check('the page is served', (await fetch(q('/'))).status === 200);

  // ---- both runs, from a session nobody is watching ---------------------------------------------
  let d = null;
  for (let i = 0; i < 40; i++) {                      // the completed one is costed in the background
    d = await fetch(q('/runs')).then((r) => r.json());
    if (d.runs.find((r) => r.runId === 'wf_done0001-aaa')?.cost != null) break;
    await sleep(150);
  }
  const done = d.runs.find((r) => r.runId === 'wf_done0001-aaa');
  const live = d.runs.find((r) => r.runId === 'wf_live0002-bbb');
  check('both runs are listed, from a session this process never opened', !!done && !!live, JSON.stringify(d.runs.map((r) => r.runId)));
  check('the run with no record is marked live', live.live === true && done.live === false);
  check('a completed run is costed from its transcripts', Math.abs(done.cost - 0.4) < 1e-9, '$' + done.cost);
  check('record tokens are carried but NOT used as cost', done.recordTokens === 4242 && done.cost !== 4242);

  // The point of the live half: a number while it can still change your mind.
  check('a LIVE run is costed too, with the model read off its transcripts',
    Math.abs(live.cost - 0.2) < 1e-9, '$' + live.cost);
  check('live progress comes from the journal, not from a record',
    live.doneCount === 1 && live.agentCount === 2, `${live.doneCount}/${live.agentCount}`);

  // ---- detail: labels, outputs, and the live re-costing -----------------------------------------
  const det = await fetch(q('/run?id=wf_done0001-aaa')).then((r) => r.json());
  check('two agents sharing one label collapse to one row', det.callSites.length === 1 && det.callSites[0].n === 2,
    JSON.stringify(det.callSites));
  check('the label row carries the pair’s combined cost', Math.abs(det.callSites[0].cost - 0.4) < 1e-9, '$' + det.callSites[0].cost);
  check('paths named in the result are surfaced as outputs',
    det.outputs.includes('C:/tmp/out/report.md') && det.outputs.includes('/var/tmp/second.json'), JSON.stringify(det.outputs));
  const ldet = await fetch(q('/run?id=wf_live0002-bbb')).then((r) => r.json());
  check('a live run has a detail view and a fresh cost', Math.abs(ldet.cost - 0.2) < 1e-9, '$' + ldet.cost);

  // ---- the live run finishes: the record lands ---------------------------------------------------
  writeFileSync(join(liveDir, 'agent-L2.jsonl'), turn('claude-haiku-4-5', usage(0, 0, 1e6, 0)) + turn('claude-haiku-4-5', usage(0, 0, 1e6, 0)));
  const after = await fetch(q('/runs')).then((r) => r.json());
  check('a live run is re-costed on every poll, never frozen',
    Math.abs(after.runs.find((r) => r.runId === 'wf_live0002-bbb').cost - 0.3) < 1e-9,
    '$' + after.runs.find((r) => r.runId === 'wf_live0002-bbb').cost);

  writeFileSync(join(WF, 'wf_live0002-bbb.json'), JSON.stringify({
    runId: 'wf_live0002-bbb', workflowName: 'was-live', status: 'completed', timestamp: Date.now(),
    workflowProgress: [{ type: 'workflow_agent', index: 1, agentId: 'L1', label: 'x', model: 'claude-haiku-4-5', state: 'done' }],
  }));
  const ended = await fetch(q('/runs')).then((r) => r.json());
  check('once the record lands it stops being live', ended.runs.find((r) => r.runId === 'wf_live0002-bbb').live === false);

  // ---- notes, keyed on the label ------------------------------------------------------------------
  await fetch(q('/note'), { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ runId: 'wf_done0001-aaa', verdict: 'mixed', text: 'the scan over-fetched' }) });
  const nr = await fetch(q('/note'), { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ runId: 'wf_done0001-aaa', label: 'scan', verdict: 'failed', text: 'narrow this prompt' }) });
  const notes = (await nr.json()).notes;
  check('a run verdict and a label verdict coexist',
    notes.verdict === 'mixed' && notes.agents.scan.verdict === 'failed' && notes.agents.scan.text === 'narrow this prompt',
    JSON.stringify(notes));
  // Both are used as object keys. `__proto__` writes through the prototype setter and `constructor`
  // resolves to Object itself — either one used to return 200 and silently drop the note.
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    const r1 = await fetch(q('/note'), { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ runId: bad, verdict: 'worked' }) });
    const r2 = await fetch(q('/note'), { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ runId: 'wf_done0001-aaa', label: bad, verdict: 'worked' }) });
    check(`\`${bad}\` is refused as a runId and as a label`, r1.status === 400 && r2.status === 400, `${r1.status}/${r2.status}`);
  }
  check('Object was not polluted by the attempt', ({}).verdict === undefined);
  // Not just the three obvious ones: any inherited key resolves through the prototype chain, so a
  // label of `toString` used to "update" the inherited function and silently save nothing.
  for (const inherited of ['toString', 'valueOf', 'hasOwnProperty']) {
    const r = await fetch(q('/note'), { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ runId: 'wf_done0001-aaa', label: inherited, verdict: 'worked', text: 'kept' }) });
    const back = (await r.json()).notes;
    check(`a label of \`${inherited}\` is stored as a real note`,
      r.status === 200 && back.agents[inherited]?.verdict === 'worked', `${r.status} ${JSON.stringify(back.agents[inherited])}`);
  }
  check('those notes survive the round trip to disk',
    JSON.parse(readFileSync(join(T, '.claude', 'workflow-gate-notes.json'), 'utf8'))['wf_done0001-aaa'].agents.toString?.verdict === 'worked');
  check('a non-string label is refused',
    (await fetch(q('/note'), { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ runId: 'wf_done0001-aaa', label: { evil: 1 }, verdict: 'worked' }) })).status === 400);
  check('an oversized note is answered 413, not left hanging',
    (await fetch(q('/note'), { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ runId: 'wf_done0001-aaa', text: 'x'.repeat(300000) }) })).status === 413);
  check('an invented verdict is refused',
    (await fetch(q('/note'), { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ runId: 'wf_done0001-aaa', verdict: 'brilliant' }) })).status === 400);
  const back = await fetch(q('/runs')).then((r) => r.json());
  check('notes survive a reload and come back with the list', back.notes['wf_done0001-aaa'].verdict === 'mixed');
  check('the notes file is written under HOME, not next to the code',
    JSON.parse(readFileSync(join(T, '.claude', 'workflow-gate-notes.json'), 'utf8'))['wf_done0001-aaa'].agents.scan.verdict === 'failed');
} finally {
  srv.kill();
  await sleep(100);
  rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
