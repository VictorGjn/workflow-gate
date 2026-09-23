// Local check, not shipped with the plugin. Run from this directory after `npm i --no-save acorn@8`:
//   node live-view-test.mjs
//
// The live run view (v1.5.0). Three things, and every one of them was broken before the code existed:
//  · the SERVER — after Approve it used to die(0), so the tab that approved the plan went dark. It
//    now stays up read-only. Everything here runs against a throwaway HOME, so the approval record
//    and the fake run directory never touch the real ~/.claude.
//  · the MATCHER — journal.jsonl carries no label and no phase, only hashed keys, so an agent can
//    only be placed by searching its prompt for the literal chunks of a call site. The first version
//    of that search found nothing on 89 of the 105 real transcripts on this machine, because a
//    prompt is as often `a` + `b` or promptFor(x) as it is one template literal.
//  · the WINDOW — the deciding chunk has been found 26 000 characters into a prompt, so there is no
//    prefix worth shipping to the browser. The search happens server-side; only an id crosses.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const HOOKS = fileURLToPath(new URL('..', import.meta.url));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The editor's own code, up to the boot IIFE: the extractor and the live placement, no DOM needed.
const html = readFileSync(join(HOOKS, 'graph-editor.html'), 'utf8');
const jsBody = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const page = new Function('acorn', jsBody.slice(0, jsBody.indexOf('// ---------------------------------------------------------------- boot'))
  + '\n return { extract, matchRun, matchLive, matchNeedles, RUN_OF, setGraph: (g) => { GRAPH = g } };')(acorn);

// ---------------------------------------------------------------- the fixture run
const T = mkdtempSync(join(tmpdir(), 'wg-live-'));
const SESS = join(T, '.claude', 'projects', 'proj', 'sess');
const RUNDIR = join(SESS, 'subagents', 'workflows', 'wf_test123');
mkdirSync(RUNDIR, { recursive: true });
mkdirSync(join(SESS, 'workflows'), { recursive: true });

// Two call sites the extractor cannot reach the same way: one plain template literal, one prompt
// built by `+` concatenation — the shape whose `assembled` is a 40-character source snippet.
const PLAN = join(T, 'plan.mjs');
writeFileSync(PLAN, [
  "export const meta = { name: 'live-fixture', description: 'two agents, one phase', phases: [{ title: 'Scan' }] }",
  "const CONTEXT = 'ctx'",
  "const scan = await agent(`${CONTEXT}\\nSurvey the mooring winch telemetry and list every anomaly.`, { label: 'scan', phase: 'Scan' })",
  "const fix = await agent(`${CONTEXT}\\n` + `Given ${scan}, ` + 'draft the remediation plan for the winch, in full.', { label: 'fix', phase: 'Scan' })",
  // two call sites that share one helper: nothing in either prompt can tell them apart
  "const brief = (x) => `${CONTEXT}\\nStandard brief number ${x}. Do the thing thoroughly and report back.`",
  "const r1 = await agent(brief(1), { label: 'r1', phase: 'Scan' })",
  "const r2 = await agent(brief(2), { label: 'r2', phase: 'Scan' })",
  'return { scan, fix }',
].join('\n'));

const BULK = 'filler line that says nothing in particular.\n'.repeat(700);   // ~30 000 characters
const P1 = 'ctx\n' + BULK + 'Survey the mooring winch telemetry and list every anomaly.';
const P2 = 'ctx\nGiven {"anomalies":3}, draft the remediation plan for the winch, in full.';
const line = (o) => JSON.stringify(o) + '\n';
const user = (t, text) => line({ type: 'user', timestamp: t, message: { role: 'user', content: text } });
const tool = (t, name) => line({ type: 'assistant', timestamp: t, message: { role: 'assistant', model: 'claude-sonnet-5',
  content: [{ type: 'tool_use', id: 'x', name, input: {} }],
  usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 200000, output_tokens: 500 } } });

writeFileSync(join(RUNDIR, 'agent-a1.jsonl'), user('2026-09-03T10:00:00.000Z', P1) + tool('2026-09-03T10:00:04.000Z', 'Grep') + tool('2026-09-03T10:00:09.000Z', 'Read'));
writeFileSync(join(RUNDIR, 'agent-a2.jsonl'), user('2026-09-03T10:00:12.000Z', P2) + tool('2026-09-03T10:00:14.000Z', 'Bash'));
writeFileSync(join(RUNDIR, 'agent-a3.jsonl'), user('2026-09-03T10:00:30.000Z', 'a prompt assembled entirely at runtime, sharing no literal with the script'));
writeFileSync(join(RUNDIR, 'agent-x1.jsonl'), user('2026-09-03T10:00:40.000Z', 'ctx\nStandard brief number 1. Do the thing thoroughly and report back.'));
writeFileSync(join(RUNDIR, 'journal.jsonl'),
  line({ type: 'started', key: 'v2:aaa', agentId: 'a1' })
  + line({ type: 'started', key: 'v2:bbb', agentId: 'a2' })
  + line({ type: 'result', key: 'v2:aaa', agentId: 'a1', result: { anomalies: 3 } }));

const g = page.extract(readFileSync(PLAN, 'utf8'));
page.setGraph(g);
check('a `+`-concatenated prompt still yields matchable chunks',
  g.nodes[1].matchChunks.some((c) => /draft the remediation plan for the winch/.test(c)), JSON.stringify(g.nodes[1].matchChunks));

// ---------------------------------------------------------------- the server, sandboxed
const NONCE = 'test-nonce-0123456789';
const PORTFILE = join(T, 'port');
const env = { ...process.env, HOME: T, USERPROFILE: T };
const srv = spawn(process.execPath, [join(HOOKS, 'approve-server.mjs'), NONCE, PORTFILE, PLAN], { env, stdio: 'ignore' });
srv.unref();

let port = null;
for (let i = 0; i < 60 && !port; i++) { await sleep(50); try { port = readFileSync(PORTFILE, 'utf8').trim(); } catch {} }
if (!port) { console.error('server never wrote its port'); srv.kill(); process.exit(1); }
const url = (p) => `http://127.0.0.1:${port}${p}?n=${NONCE}`;
const ORIGIN = { origin: `http://127.0.0.1:${port}` };

try {
  // Before approval /live says nothing is running — the tail must never precede the decision.
  const pre = await fetch(url('/live')).then((r) => r.json());
  check('/live before approval: not running', pre.running === false, JSON.stringify(pre));

  const ok = await fetch(url('/approve'), { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN }, body: JSON.stringify({ script: readFileSync(PLAN, 'utf8'), summary: 'test', match: page.matchNeedles() }) });
  check('approve succeeds', ok.status === 200, String(ok.status));

  // THE invariant: run mode must not reopen the gate. Exactly one approval, before and after.
  const again = await fetch(url('/approve'), { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN }, body: JSON.stringify({ script: 'x', summary: 'y' }) });
  check('a second approval is 409, not a second approval', again.status === 409, String(again.status));
  const cancel = await fetch(url('/cancel'), { method: 'POST', headers: ORIGIN });
  check('cancel after approval is 409 too', cancel.status === 409, String(cancel.status));

  // …and the server is still alive and still serving the page it approved.
  check('the editor page is still served after approval', (await fetch(url('/'))).status === 200);
  check('the script is still served after approval', (await fetch(url('/script'))).status === 200);
  check('a bad nonce is still 403 in run mode', (await fetch(`http://127.0.0.1:${port}/live?n=wrong`)).status === 403);

  // THE self-approval path, and it was open. The history daemon's port file is an ordinary
  // user-writable file that the gated agent can write, and its contents used to be spliced
  // unescaped into this page's <script> — three lines from `const NONCE`. Close the quote, run JS
  // in the page's own origin, and the mandatory Origin check passes with the nonce in scope.
  const payload = "x';fetch('/approve?n='+NONCE,{method:'POST',body:'{}'});//";
  writeFileSync(join(T, '.claude', 'workflow-gate-history-port'),
    JSON.stringify({ port: 1, nonce: payload, pid: process.pid, at: Date.now() }));
  const poisoned = await fetch(url('/')).then((r) => r.text());
  check('a port file cannot inject script into the editor page',
    !poisoned.includes(payload) && !poisoned.includes('fetch(\'/approve') && /const HISTORY_URL = '';/.test(poisoned),
    poisoned.match(/const HISTORY_URL = '[^\n]*/)?.[0] || 'HISTORY_URL missing');
  // …and a well-formed one still produces the link, so the validator is not simply refusing everything.
  writeFileSync(join(T, '.claude', 'workflow-gate-history-port'),
    JSON.stringify({ port: 4321, nonce: 'a'.repeat(48), pid: process.pid, at: Date.now() }));
  const clean = await fetch(url('/')).then((r) => r.text());
  check('a well-formed port file still yields the history link',
    clean.includes("const HISTORY_URL = 'http://127.0.0.1:4321/?n=" + 'a'.repeat(48) + "'"),
    clean.match(/const HISTORY_URL = '[^\n]*/)?.[0] || 'missing');

  const live = await fetch(url('/live')).then((r) => r.json());
  const a1 = live.agents.find((a) => a.agentId === 'a1');
  const a2 = live.agents.find((a) => a.agentId === 'a2');
  check('/live found the run directory', live.started === true && live.runId === 'wf_test123', JSON.stringify({ started: live.started, runId: live.runId }));
  const a3 = live.agents.find((a) => a.agentId === 'a3');
  const x1 = live.agents.find((a) => a.agentId === 'x1');
  check('every agent is reported', live.agents.length === 4, String(live.agents.length));
  check('the SERVER reports two indistinguishable call sites as a tie, and places neither',
    x1.nodeId === null && Array.isArray(x1.tied) && x1.tied.length === 2
    && x1.tied.includes(g.nodes[2].id) && x1.tied.includes(g.nodes[3].id), JSON.stringify({ nodeId: x1?.nodeId, tied: x1?.tied }));
  check('an agent the journal never mentioned still appears — the transcript file IS the list',
    !!a3 && a3.done === false, JSON.stringify(a3));
  check('a prompt with no literal of its own is placed nowhere, not somewhere',
    a3.nodeId === null && a3.matchLen === 0, JSON.stringify({ nodeId: a3?.nodeId, matchLen: a3?.matchLen }));
  check('agents arrive in start order, not in readdir order',
    live.agents.map((a) => a.agentId).join() === 'a1,a2,a3,x1', live.agents.map((a) => a.agentId).join());
  check('each agent is placed on its own call site', a1.nodeId === g.nodes[0].id && a2.nodeId === g.nodes[1].id, `${a1.nodeId}/${a2.nodeId}`);
  check('a chunk 30 000 characters into the prompt still matches — no window',
    a1.matchLen >= 24 && P1.indexOf('Survey the mooring') > 29000, `matchLen ${a1.matchLen} at offset ${P1.indexOf('Survey the mooring')}`);
  check('the prompt itself never crosses the wire', !('promptHead' in a1) && JSON.stringify(live).length < 4000, JSON.stringify(live).length + ' bytes');
  check('tool calls are counted from the transcript', a1.toolCalls === 2 && a2.toolCalls === 1, `${a1.toolCalls}/${a2.toolCalls}`);
  check('the last tool is the last one used', a1.lastTool === 'Read' && a2.lastTool === 'Bash', `${a1.lastTool}/${a2.lastTool}`);
  check('a journal result marks the agent done', a1.done === true && a2.done === false);
  check('the result preview survives', /anomalies/.test(a1.resultPreview), a1.resultPreview);
  check('elapsed comes from the transcript timestamps', a1.startedAt === '2026-09-03T10:00:00.000Z' && a1.lastAt === '2026-09-03T10:00:09.000Z', `${a1.startedAt}→${a1.lastAt}`);
  check('the read offset is server-side state, never shipped', !('offset' in a1));

  // The promise made in place of a pre-run estimate: what has been SPENT so far, mid-run, from the
  // same forward-only pass. One Sonnet 5 turn here is 100 in + 1000 cache-write + 200k cache-read
  // + 500 out = $0.0442; a1 has two such turns.
  const oneTurn = (100 * 2 + 1000 * 2 * 1.25 + 200000 * 0.2 + 500 * 10) / 1e6;
  check('a live agent carries what it has cost so far', Math.abs(a1.cost - oneTurn * 2) < 1e-9, `$${a1.cost} vs $${oneTurn * 2}`);
  check('and the run total is the sum of them', Math.abs(live.cost - (oneTurn * 2 + oneTurn)) < 1e-9, `$${live.cost}`);
  check('the model comes off the transcript — the record does not exist yet', a1.model === 'claude-sonnet-5', String(a1.model));
  // An agent that has produced no billable turn yet is null, not zero — and must not raise the
  // unpriced flag, which means 'this DID cost something we could not price' and would overstate.
  const a3c = live.agents.find((a) => a.agentId === 'a3');
  check('an agent with no billable turn yet is null, and does not flag the run as unpriced',
    a3c.cost === null && a3c.usage.turns === 0 && live.unpriced === false,
    JSON.stringify({ cost: a3c.cost, turns: a3c.usage.turns, unpriced: live.unpriced }));

  // Incremental read: appending must add, not recount. This is the whole reason /live is cheap.
  appendFileSync(join(RUNDIR, 'agent-a2.jsonl'), tool('2026-09-03T10:00:20.000Z', 'Write'));
  const live2 = await fetch(url('/live')).then((r) => r.json());
  const a2b = live2.agents.find((a) => a.agentId === 'a2');
  check('an appended tool call is picked up once', a2b.toolCalls === 2 && a2b.lastTool === 'Write', `${a2b.toolCalls}/${a2b.lastTool}`);

  // A half-written line must be ignored, not double-counted when it completes.
  appendFileSync(join(RUNDIR, 'agent-a2.jsonl'), '{"type":"assistant","message":{"role":"assist');
  const live3 = await fetch(url('/live')).then((r) => r.json());
  check('a partial line is not counted', live3.agents.find((a) => a.agentId === 'a2').toolCalls === 2);
  appendFileSync(join(RUNDIR, 'agent-a2.jsonl'), 'ant","content":[{"type":"tool_use","id":"x","name":"Edit","input":{}}]}}\n');
  const live4 = await fetch(url('/live')).then((r) => r.json());
  const a2c = live4.agents.find((a) => a.agentId === 'a2');
  check('…and is counted exactly once when it completes', a2c.toolCalls === 3 && a2c.lastTool === 'Edit', `${a2c.toolCalls}/${a2c.lastTool}`);

  check('not finished while the record is missing', live4.finished === false);
  writeFileSync(join(SESS, 'workflows', 'wf_test123.json'), JSON.stringify({ runId: 'wf_test123', scriptPath: PLAN, status: 'completed', agentCount: 2, workflowProgress: [] }));
  const live5 = await fetch(url('/live')).then((r) => r.json());
  check('the consolidated record is what finished means', live5.finished === true);
} finally {
  srv.kill();
  await sleep(100);   // let the child handle close before the process does, or libuv asserts
}

// ---------------------------------------------------------------- browser-side placement
page.matchLive([
  { agentId: 'a2', nodeId: g.nodes[1].id, state: 'running', byOrder: false },
  { agentId: 'a1', nodeId: g.nodes[0].id, state: 'done', byOrder: false },
]);
check('agents land on the call site the server named, arrival order be damned',
  page.RUN_OF.a0.length === 1 && page.RUN_OF.a0[0].state === 'done'
  && page.RUN_OF.a1.length === 1 && page.RUN_OF.a1[0].state === 'running',
  JSON.stringify({ a0: page.RUN_OF.a0.map((a) => a.state), a1: page.RUN_OF.a1.map((a) => a.state) }));

// A prompt built entirely at runtime matches no literal chunk: place it, and admit how.
page.matchLive([{ agentId: 'x', nodeId: null, state: 'running', byOrder: false }]);
check('an unplaceable agent falls back to call-site order, flagged',
  page.RUN_OF.a0.length === 1 && page.RUN_OF.a0[0].byOrder === true && page.RUN_OF.a1.length === 0,
  JSON.stringify({ a0: page.RUN_OF.a0.length, byOrder: page.RUN_OF.a0[0]?.byOrder }));

// Indistinguishable call sites — the same helper called twice — must not be silently collapsed onto
// whichever one happens to be first. A tie is placed by arrival order, and flagged as such.
page.matchLive([
  { agentId: 'first', nodeId: null, tied: ['a0', 'a1'], state: 'done', byOrder: false },
  { agentId: 'second', nodeId: null, tied: ['a0', 'a1'], state: 'running', byOrder: false },
]);
check('a tie between two call sites is spread by arrival order, both flagged',
  page.RUN_OF.a0[0]?.agentId === 'first' && page.RUN_OF.a1[0]?.agentId === 'second'
  && page.RUN_OF.a0[0].byOrder && page.RUN_OF.a1[0].byOrder,
  JSON.stringify({ a0: page.RUN_OF.a0.map((a) => a.agentId), a1: page.RUN_OF.a1.map((a) => a.agentId) }));

// Two agents from one fan-out share a call site; neither is a guess.
page.matchLive([{ agentId: 'p', nodeId: 'a0', state: 'running', byOrder: false }, { agentId: 'q', nodeId: 'a0', state: 'done', byOrder: false }]);
check('several agents stack on the one site that owns them',
  page.RUN_OF.a0.length === 2 && page.RUN_OF.a0.every((a) => !a.byOrder), String(page.RUN_OF.a0.length));

// ---------------------------------------------------------------- accuracy, against real runs
// The check that caught two design errors. "A chunk matched somewhere in the graph" is not the
// property that matters — landing on the RIGHT call site is. The completed record carries both
// agentId and label, so the editor's own post-run label matcher gives ground truth, and the whole
// live path (the server's nodeFor, then matchLive's fallback, in real arrival order) can be scored
// against it. First cut: 16 of the first 105 transcripts matched at all. Second: 182 of 196 placed
// correctly, 7 SILENTLY wrong — two calls to the same promptFor() helper are indistinguishable and
// the longest match picked whichever came first. Now: 195 of 196, and the one miss is flagged in the
// panel as placed by call-site order. That last part is the invariant — a guess may be wrong, but it
// must never look like a fact.
function nodeForLike(prompt, spec) {          // the server's nodeFor, same behaviour
  let best = 0, tied = [];
  for (const [id, chunks] of spec) {
    let len = 0;
    for (const c of chunks) if (c.length > len && prompt.includes(c)) len = c.length;
    if (!len) continue;
    if (len > best) { best = len; tied = [id]; } else if (len === best) tied.push(id);
  }
  return { nodeId: tied.length === 1 ? tied[0] : null, matchLen: best, tied: tied.length > 1 ? tied : null };
}

const R = join(homedir(), '.claude', 'projects');
const ls = (p) => { try { return readdirSync(p); } catch { return []; } };
let scored = 0, correct = 0, silentlyWrong = 0;
for (const proj of ls(R)) for (const sess of ls(join(R, proj))) {
  for (const f of ls(join(R, proj, sess, 'workflows'))) {
    if (!/^wf_.*\.json$/.test(f)) continue;
    const dir = join(R, proj, sess, 'subagents', 'workflows', f.replace('.json', ''));
    if (!ls(dir).length) continue;
    let rec; try { rec = JSON.parse(readFileSync(join(R, proj, sess, 'workflows', f), 'utf8')); } catch { continue; }
    if (!rec.script) continue;
    let gg; try { gg = page.extract(rec.script); } catch { continue; }
    const recorded = (rec.workflowProgress || []).filter((x) => x.type === 'workflow_agent' && x.agentId);
    if (!recorded.length) continue;

    page.setGraph(gg);
    page.matchRun({ agents: recorded.map((a) => ({ label: a.label, phase: a.phaseTitle, agentId: a.agentId })) });
    const truth = {};
    for (const nid of Object.keys(page.RUN_OF)) for (const a of page.RUN_OF[nid]) truth[a.agentId] = nid;

    const spec = gg.nodes.map((nn) => [nn.id, nn.matchChunks || []]);
    const live = [];
    for (const a of [...recorded].sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0))) {
      let raw; try { raw = readFileSync(join(dir, 'agent-' + a.agentId + '.jsonl'), 'utf8'); } catch { continue; }
      let e; try { e = JSON.parse(raw.slice(0, raw.indexOf('\n'))); } catch { continue; }
      const c = e.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
      if (text) live.push({ agentId: a.agentId, byOrder: false, ...nodeForLike(text, spec) });
    }
    if (!live.length) continue;
    page.setGraph(gg);
    page.matchLive(live);
    const got = {};
    for (const nid of Object.keys(page.RUN_OF)) for (const a of page.RUN_OF[nid]) got[a.agentId] = { nid, byOrder: a.byOrder };
    for (const a of live) {
      if (!truth[a.agentId]) continue;
      scored++;
      if (got[a.agentId]?.nid === truth[a.agentId]) correct++;
      else if (!got[a.agentId]?.byOrder) silentlyWrong++;
    }
  }
}
if (scored) {
  check(`no live agent is silently placed on the wrong call site (${scored} recorded agents)`, silentlyWrong === 0, `${silentlyWrong} silent`);
  check(`placement is right for at least 95% of them`, correct * 20 >= scored * 19, `${correct}/${scored} = ${(correct / scored * 100).toFixed(1)}%`);
} else console.log('SKIP  no recorded runs with transcripts on this machine');

rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
