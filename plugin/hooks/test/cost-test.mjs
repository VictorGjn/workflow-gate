// Local check, not shipped with the plugin. Run from this directory:
//   node cost-test.mjs
//
// The money path. Two things make this worth a test rather than a glance:
//  · the run record's `tokens` is the agent's FINAL CONTEXT SIZE, not spend — costing from it is
//    wrong by ~21x on this machine's own history, so the arithmetic must come from message.usage;
//  · cache reads are ~90% of every real run's token volume and are billed at a tenth of input
//    (a published quarter-dollar on Fable 5.1), so a wrong multiplier silently moves the total by
//    an order of magnitude in either direction.
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { costOf, priceOf, usageOfTranscript, costRun, emptyUsage, cachedCost, putCost, PRICES_AT, COST_SCHEME, buildPriors, priorsFor, scriptHash } from '../cost.mjs';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- the price table -----------------------------------------------------------------------
check('an unknown model is unpriced, never silently free', priceOf('gpt-5') === null && costOf('gpt-5', emptyUsage()) === null);
check('the 1M context id folds onto its base model', priceOf('claude-opus-5[1m]')?.key === 'claude-opus-5', JSON.stringify(priceOf('claude-opus-5[1m]')));
check('a dated snapshot folds onto its base model', priceOf('claude-haiku-4-5-20251001')?.key === 'claude-haiku-4-5');
check('a bare alias resolves', priceOf('opus')?.key === 'claude-opus-5' && priceOf('fable')?.key === 'claude-fable-5-1');

// 1M input tokens on Sonnet 5 at $2/MTok = $2 exactly. Each component priced on its own:
const oneM = { in: 1e6, cw: 0, cr: 0, out: 0, turns: 1 };
check('input is priced at the table rate', near(costOf('claude-sonnet-5', oneM), 2), String(costOf('claude-sonnet-5', oneM)));
check('output is 5x input on Sonnet 5', near(costOf('claude-sonnet-5', { ...emptyUsage(), out: 1e6 }), 10));
check('a cache WRITE is 1.25x input', near(costOf('claude-sonnet-5', { ...emptyUsage(), cw: 1e6 }), 2.5));
check('a cache READ is 0.1x input where no rate is published', near(costOf('claude-sonnet-5', { ...emptyUsage(), cr: 1e6 }), 0.2));
check('Fable 5.1 uses its PUBLISHED cache-read rate, not the 0.1x default',
  near(costOf('claude-fable-5-1', { ...emptyUsage(), cr: 1e6 }), 0.25), '$' + costOf('claude-fable-5-1', { ...emptyUsage(), cr: 1e6 }));
// The whole point: reading a million cached tokens must not cost the same as reading a million fresh ones.
check('cache read is an order of magnitude under fresh input',
  costOf('claude-opus-5', { ...emptyUsage(), cr: 1e6 }) * 10 === costOf('claude-opus-5', { ...emptyUsage(), in: 1e6 }));

// ---- transcript parsing ----------------------------------------------------------------------
const T = mkdtempSync(join(tmpdir(), 'wg-cost-'));
const line = (o) => JSON.stringify(o) + '\n';
const usage = (i, cw, cr, o) => ({ input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o });

const tx = join(T, 'agent-a1.jsonl');
writeFileSync(tx,
  line({ type: 'user', message: { role: 'user', content: 'go' } })                       // no usage: not a turn
  + line({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: usage(100, 1000, 50000, 200) } })
  + line({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: usage(50, 0, 60000, 300) } })
  + '{"type":"assistant","message":{"usage":{"input_tokens":9'    // a half-written trailing line
);
const u = await usageOfTranscript(tx);
check('usage is summed across turns, partial line ignored',
  u.in === 150 && u.cw === 1000 && u.cr === 110000 && u.out === 500 && u.turns === 2, JSON.stringify(u));
check('the model is read off the transcript', u.model === 'claude-sonnet-5', String(u.model));
check('a missing transcript is zero, not a throw', (await usageOfTranscript(join(T, 'nope.jsonl'))).turns === 0);

// ---- incremental reads, and the half-written record ------------------------------------------
// The live path polls the same growing file every few seconds. A record still being written must be
// left alone AND counted once it completes: advancing the offset past it loses its tokens for good,
// and counting it twice inflates the bill. Both were live bugs.
const inc = join(T, 'agent-inc.jsonl');
const oneTurn = line({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: usage(10, 0, 0, 20) } });
writeFileSync(inc, oneTurn);
const st = { offset: 0 };
const p1 = await usageOfTranscript(inc, st);
check('a first incremental read counts the completed record', p1.turns === 1 && p1.out === 20, JSON.stringify(p1));
check('the offset stopped at the end of that record', st.offset === Buffer.byteLength(oneTurn, 'utf8'), String(st.offset));

const p2 = await usageOfTranscript(inc, st);
check('re-polling an unchanged file counts nothing twice', p2.turns === 0, JSON.stringify(p2));

// Append HALF of the next record, as a writer mid-flush would leave it.
const nextTurn = line({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: usage(1, 2, 3, 4) } });
const half = nextTurn.slice(0, 40);
appendFileSync(inc, half);
const offsetBefore = st.offset;
const p3 = await usageOfTranscript(inc, st);
check('a half-written record is not counted', p3.turns === 0, JSON.stringify(p3));
check('…and the offset does NOT move past it', st.offset === offsetBefore, `${st.offset} vs ${offsetBefore}`);

// Now complete it, exactly as the writer would.
appendFileSync(inc, nextTurn.slice(40));
const p4 = await usageOfTranscript(inc, st);
check('once complete, the record is counted exactly once',
  p4.turns === 1 && p4.in === 1 && p4.cw === 2 && p4.cr === 3 && p4.out === 4, JSON.stringify(p4));
check('and the offset is now the whole file',
  st.offset === Buffer.byteLength(oneTurn + nextTurn, 'utf8'), String(st.offset));

// ---- one message, many lines ------------------------------------------------------------------
// Claude Code writes a line per content block and repeats the message's usage on each, output growing
// as it streams. Summed per line, one message was billed 6 times. Counted once, at its LAST line.
const msg = (id, o) => line({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-sonnet-5', usage: usage(5, 100, 1000, o) } });
const dup = join(T, 'agent-dup.jsonl');
writeFileSync(dup, msg('msg_A', 8) + msg('msg_A', 50) + msg('msg_A', 112)
  + line({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', usage: usage(1, 0, 0, 1) } }));   // no id
const d = await usageOfTranscript(dup);
check('a message id on 3 lines is one turn, costed at its last line',
  d.turns === 2 && d.in === 6 && d.cw === 100 && d.cr === 1000 && d.out === 113, JSON.stringify(d));

// The same message straddling two polls: the second poll returns only the delta, and no new turn.
const split = join(T, 'agent-split.jsonl');
writeFileSync(split, msg('msg_B', 8));
const sst = { offset: 0 };
const s1 = await usageOfTranscript(split, sst);
appendFileSync(split, msg('msg_B', 112));
const s2 = await usageOfTranscript(split, sst);
check('a message split across polls adds only its growth, not a second copy',
  s1.turns === 1 && s2.turns === 0 && s2.in === 0 && s2.cr === 0 && s2.out === 104, JSON.stringify(s2));

// ---- per-run costing -------------------------------------------------------------------------
writeFileSync(join(T, 'agent-a2.jsonl'),
  line({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5', usage: usage(0, 0, 1e6, 0) } }));
// An agent served from the resume cache was NOT re-billed. Counted as $0 and flagged, never dropped.
writeFileSync(join(T, 'agent-a3.jsonl'),
  line({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', usage: usage(1e6, 0, 0, 0) } }));

const run = await costRun(T, [
  { agentId: 'a1', label: 'scan', model: 'claude-sonnet-5' },
  { agentId: 'a2', label: 'fan', model: null },                       // model only in the transcript
  { agentId: 'a3', label: 'skipped', model: 'claude-opus-5', cached: true },
]);
const expect = costOf('claude-sonnet-5', u) + costOf('claude-haiku-4-5', { ...emptyUsage(), cr: 1e6 });
check('run total is the sum of its priced agents', near(run.total, expect), `$${run.total.toFixed(4)} vs $${expect.toFixed(4)}`);
check('a resumed agent costs nothing and is counted as resumed',
  run.resumed === 1 && run.agents.find((a) => a.label === 'skipped').cost === 0, JSON.stringify({ resumed: run.resumed }));
check('a resumed agent contributes no tokens either', run.usage.in === 150 + 0, String(run.usage.in));
check('an agent with no model in the record is priced from its transcript',
  run.agents.find((a) => a.label === 'fan').model === 'claude-haiku-4-5');

const unp = await costRun(T, [{ agentId: 'a1', label: 'x', model: 'some-future-model' }]);
check('an unpriced model is reported, and the total is a floor',
  unp.total === 0 && unp.unpriced.includes('some-future-model'), JSON.stringify(unp.unpriced));

// ---- cache keyed on the price table ----------------------------------------------------------
const c = {};
putCost(c, 'wf_x', run);
check('a cached figure is returned under the same price table', cachedCost(c, 'wf_x')?.total === run.total);
c.wf_x.pricesAt = '1999-01-01';
check('a figure costed under different prices is NOT reused', cachedCost(c, 'wf_x') === null, 'stamped ' + PRICES_AT);
putCost(c, 'wf_y', run);
delete c.wf_y.scheme;                                 // cached before message.id dedupe existed
check('a figure costed under an older method is NOT reused', cachedCost(c, 'wf_y') === null, 'scheme ' + COST_SCHEME);

// ---- priors: what the approval screen shows as past spend ------------------------------------
const ag = (label, cost, extra = {}) => ({ label, cost, resumed: false, ...extra });
const rows = [1, 2, 3, 4].map((t) => ({ name: 'nightly', status: 'completed', when: t * 1e12, sh: t === 4 ? scriptHash('v2') : scriptHash('v1'),
  cost: { total: t, agents: [ag('scan', t / 2), ag('scan', 0, { resumed: true }), ag('write', null)] } }));
rows.push({ name: 'nightly', status: 'failed', when: 9e12, sh: null, cost: { total: 100, agents: [] } });
const idx = buildPriors(rows);
const pr = priorsFor('nightly', 'v2', idx);
check('priors: median, p75, max and n over completed runs only (history.html method)',
  pr.n === 4 && pr.median === 3 && pr.p75 === 4 && pr.max === 4 && pr.from === 1e12 && pr.to === 4e12, JSON.stringify(pr));
check('priors: runs of this exact script are counted apart', pr.exact === 1 && priorsFor('nightly', 'v3', idx).exact === 0);
check('priors: resumed ($0) and unpriced agents stay out of the per-label median',
  pr.sites.scan.n === 4 && pr.sites.scan.median === 1.5 && !Object.hasOwn(pr.sites, 'write'), JSON.stringify(pr.sites));
idx.names.nightly[0].agents[0].outcome = 'FAIL';      // the newest run's scan agent, $2
check('priors: a FAIL-judged agent is left out of its label median', priorsFor('nightly', null, idx).sites.scan.n === 3);
const mk = (models) => ({ names: { w: [{ when: 1, total: 1, agents: models.map((m) => ({ label: 's', model: m, cost: 1 })) }] } });
check('priors: a site names the one model it was measured on, and only a model-shaped one',
  priorsFor('w', null, mk(['claude-opus-5[1m]'])).sites.s.model === 'claude-opus-5[1m]'
  && priorsFor('w', null, mk(['claude-opus-5', 'claude-haiku-4-5'])).sites.s.model === null
  && priorsFor('w', null, mk(['<img src=x onerror=alert(1)>'])).sites.s.model === null);
check('priors: no history is null, not zeros', priorsFor('weekly', null, idx) === null && priorsFor('nightly', null, { names: {} }) === null);
check('priors: a hostile index is null or filtered, never a throw',
  priorsFor('__proto__', null, idx) === null && priorsFor('toString', null, idx) === null
  && priorsFor('nightly', null, { names: { nightly: { length: 1e9 } } }) === null
  && priorsFor('nightly', null, { names: { nightly: [{ total: '1; rm -rf', when: 1 }] } }) === null
  && priorsFor('nightly', null, null) === null && priorsFor('nightly', null, 'x') === null);

rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
