// Local check, not shipped with the plugin. Run from this directory after `npm i --no-save acorn@8`:
//   node review-aids-test.mjs [path/to/graph-editor.html]
//
// The editor's review aids: a tier inserted into a call that had none (byte-preserving, refused when
// it would not take), the price line, the "needs your eyes" lints, and the diff against the last
// approved text. None of them may touch Approve.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const EDITOR = process.argv[2] || fileURLToPath(new URL('../graph-editor.html', import.meta.url));
const html = readFileSync(EDITOR, 'utf8');
const body = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const pure = body.slice(0, body.indexOf('// ---------------------------------------------------------------- state'));
const F = new Function('acorn', pure + '\n return { extract, applyEdits, withModel, priceDelta, needsEyes, diffGraphs };')(acorn);

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const j = JSON.stringify;

// ---- G7: model insert for inherited agents ------------------------------------------------
const ins = (src, tier = 'haiku') => { const g = F.extract(src); const r = F.withModel(src, g.nodes, {}, 'a0', tier); return r.edits ? F.applyEdits(src, g.nodes, r.edits) : r; };
check('options object: model spliced after the brace, nothing else moves', ins(`await agent('x', { label: 'scan' })`) === `await agent('x', { model: 'haiku', label: 'scan' })`, j(ins(`await agent('x', { label: 'scan' })`)));
check('empty options object', ins(`await agent('x', {})`) === `await agent('x', { model: 'haiku' })`, j(ins(`await agent('x', {})`)));
check('no options argument: one is appended after the prompt', ins('await agent(`do ${a} now`)') === "await agent(`do ${a} now`, { model: 'haiku' })", j(ins('await agent(`do ${a} now`)')));
check('trailing comma still parses and takes', typeof ins(`await agent('x',)`) === 'string' && F.extract(ins(`await agent('x',)`)).nodes[0].model === 'haiku', j(ins(`await agent('x',)`)));
check('spread: no insert point', F.extract(`await agent('x', { ...base })`).nodes[0].modelInsert === null);
check('spread arguments: no insert point (the new object could land past the options)', F.extract("const args = ['x', { model: 'opus' }]\nawait agent(...args)").nodes.find((n) => n.kind === 'agent').modelInsert === null);
check('computed key: no insert point', F.extract(`await agent('x', { [k]: 1 })`).nodes[0].modelInsert === null);
check("quoted 'model' key: no insert point (an insert would be overridden)", F.extract(`await agent('x', { 'model': 'opus' })`).nodes[0].modelInsert === null);
check('options in a variable: no insert point', F.extract(`await agent('x', opts)`).nodes[0].modelInsert === null);
check('workflow() is not an agent: no insert point', F.extract(`await workflow('w')`).nodes[0].modelInsert === null);
{
  const src = `await agent('a', { label: 'one' })\nawait agent('b')`;
  const g = F.extract(src);
  check("'inherited' is never written", F.applyEdits(src, g.nodes, { a0: { model: 'inherited' }, a1: { model: 'inherited' } }) === src);
  check('an unknown value is never written', F.applyEdits(src, g.nodes, { a1: { model: "haiku' }); evil('" } }) === src);
  const out = F.applyEdits(src, g.nodes, { a0: { model: 'sonnet' }, a1: { model: 'haiku', mission: 'bb' } });
  check('insert and mission edit together, right-to-left offsets hold', out === `await agent('a', { model: 'sonnet', label: 'one' })\nawait agent('bb', { model: 'haiku' })`, j(out));
  check('an existing literal model is replaced, not inserted', F.applyEdits(`agent('x', { model: "opus" })`, F.extract(`agent('x', { model: "opus" })`).nodes, { a0: { model: 'haiku' } }) === `agent('x', { model: "haiku" })`);
}
check('withModel refuses a tier the call would not end up running on', !!F.withModel(`agent('x', opts)`, F.extract(`agent('x', opts)`).nodes, {}, 'a0', 'haiku').error);

// ---- G7: price delta ------------------------------------------------------------------------
{
  const nodes = [{ id: 'a0' }, { id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
  const models = { a0: 'inherited', a1: 'inherited', a2: 'opus', a3: 'haiku' };
  const advice = { prices: { haiku: 1, sonnet: 2, opus: 5, fable: 10 }, agents: { a0: { tier: 'haiku' }, a1: { tier: 'haiku' }, a2: { tier: 'sonnet' }, a3: { tier: null, low: true } } };
  const lines = F.priceDelta(nodes, advice, (n) => models[n.id]);
  check('inherited is priced as opus and says so', lines.includes('haiku ≈ 1/5 the per-token price of inherited (priced as opus) on 2 agents'), j(lines));
  check('explicit tier ratio', lines.includes('sonnet ≈ 1/2.5 the per-token price of opus on 1 agent'), j(lines));
  check('low-confidence and agreeing agents add nothing', lines.length === 2, j(lines));
  check('no price table, no line', F.priceDelta(nodes, { agents: advice.agents }, (n) => models[n.id]).length === 0);
}

// ---- G6: needs your eyes ---------------------------------------------------------------------
{
  const loops = F.extract(`const XS = [1, 2]
for (const x of XS) await agent('a')
for (let i = 0; i < 3; i++) await agent('b')
while (!done) await agent('c')
for (const f of files) await agent('d')`).nodes;
  check('for-of over a module const array is bounded', loops[0].loop?.bounded === true, j(loops[0].loop));
  check('i < 3 is bounded', loops[1].loop?.bounded === true, j(loops[1].loop));
  check('while is unbounded', loops[2].loop?.bounded === false, j(loops[2].loop));
  check('for-of over a runtime list is unbounded', loops[3].loop?.bounded === false, j(loops[3].loop));
  check('the loop id is the flow diamond, so its back-edge can be highlighted', F.extract(`while (!done) await agent('c')`).flow.nodes.some((x) => x.id === F.extract(`while (!done) await agent('c')`).nodes[0].loop.id));

  const src = `const BIG = [${Array.from({ length: 12 }, (_, i) => `{ slug: 's${i}' }`).join(', ')}]
await parallel(files.map((f) => () => agent('scan ' + f)))
await parallel(files.map((f) => () => agent('cheap ' + f, { model: 'haiku' })))
await parallel(BIG.map((d) => () => agent(d.slug)))
while (!ok) await agent('retry', { model: 'haiku' })
await agent('ship it', { model: 'haiku' })
await agent('read only', { model: 'haiku' })`;
  const g = F.extract(src), model = (n) => n.model;
  const e = F.needsEyes(g.nodes, model, null);
  check('runtime fan-out on the inherited model is flagged', e.top.some((t) => t.id === 'a0' && /top rate/.test(t.why[0])), j(e));
  check('the same fan-out on haiku is not', !e.top.some((t) => t.id === 'a1'), j(e));
  check('×12 with no model is flagged', e.top.some((t) => t.id === 'a2' && /×12/.test(t.why.join())), j(e));
  check('an agent in an unbounded loop is flagged', e.top.some((t) => t.id === 'a3'), j(e));
  check('capped at 3, total kept', e.top.length === 3 && e.total === 3, j(e));
  const withFx = F.needsEyes(g.nodes, model, { stakes: { level: 2 }, fx: { a4: 0.9, a5: 0.4 } });
  check('a confident side-effect flag from Jev ranks, labelled as advice', withFx.top[0].id === 'a4' && /Jev \(advice, 90%\)/.test(withFx.top[0].why[0]), j(withFx.top[0]));
  check('under the 0.7 floor it does not', !withFx.top.some((t) => t.id === 'a5') && withFx.total === 4, j(withFx));
  check('a downgrade the human applied clears the top-tier lint', !F.needsEyes(g.nodes, (n) => (n.id === 'a0' ? 'haiku' : n.model), null).top.some((t) => t.id === 'a0'));
}

// ---- G9: diff against the last approved text ---------------------------------------------------
{
  const before = F.extract(`phase('Scan')
await agent('scan the repo', { label: 'scan' })
await agent('fix what scan found', { label: 'fix', model: 'opus' })
await agent('write the report', { label: 'report' })
await agent('unnamed one')`);
  const after = F.extract(`phase('Scan')
await agent('an inserted unnamed one')
await agent('scan the repo', { label: 'scan' })
await agent('fix what scan found', { label: 'fix', model: 'haiku' })
await agent('write the summary', { label: 'summary' })
await agent('unnamed one')`);
  const d = F.diffGraphs(before, after);
  const by = (label) => d.status[after.nodes.find((n) => n.label === label || n.assembled === label).id];
  check('same label, same prompt: unchanged', by('scan') === 'same', j(d));
  check('same label, model changed: changed, and says which', by('fix') === 'changed' && j(d.fields[after.nodes.find((n) => n.label === 'fix').id]) === '["model"]', j(d.fields));
  check('a renamed agent is removed + added, never silently paired', by('summary') === 'added' && d.removed.includes('report'), j(d));
  check('default labels pair by order among themselves', d.status.a0 === 'changed' && d.status.a4 === 'added', j(d.status));
  const same = F.diffGraphs(before, F.extract(`phase('Scan')
await agent('scan the repo', { label: 'scan' })
await agent('fix what scan found', { label: 'fix', model: 'opus' })
await agent('write the report', { label: 'report' })
await agent('unnamed one')`));
  check('identical agents: nothing added, changed or removed', same.added === 0 && same.changed === 0 && same.removed.length === 0, j(same));
  const fan = F.diffGraphs(F.extract(`const D = [{ p: 'one' }, { p: 'two' }]\nawait parallel(D.map((d) => () => agent(d.p, { label: 'x' })))`),
    F.extract(`const D = [{ p: 'one' }, { p: 'TWO' }]\nawait parallel(D.map((d) => () => agent(d.p, { label: 'x' })))`));
  check('a per-item prompt change is a mission change', fan.status.a0 === 'changed' && fan.fields.a0.includes('mission'), j(fan));
  const at = F.diffGraphs(F.extract(`await agent('scan', { label: 'x', agentType: 'Explore' })`), F.extract(`await agent('scan', { label: 'x', agentType: 'general-purpose' })`));
  check('an agentType change is not dimmed as unchanged', at.status.a0 === 'changed' && at.fields.a0.includes('options'), j(at));
  const long = (w) => F.extract(`await agent(build('${'a'.repeat(50)} ${w}'), { label: 'x' })`);
  const cut = F.diffGraphs(long('read'), long('rm -rf'));
  const v = (p, m) => `const P = '${p}'\nawait agent(P, { label: 'a' })\nawait agent('${m}', { label: 'b' })`;
  const out = F.diffGraphs(F.extract(v('list files', 'one')), F.extract(v('rm -rf the repo', 'two')), v('list files', 'one'), v('rm -rf the repo', 'two'));
  check('a const the prompt reads changed: the node says so, and so does the header', out.status.a0 === 'changed' && out.fields.a0.includes('context') && out.outside === true, j(out));
  const help = (p) => `function build() { return '${p}' }\nawait agent(build(), { label: 'a' })\nawait agent('x', { label: 'b' })`;
  check('a helper changed outside every call is flagged as outside', F.diffGraphs(F.extract(help('read')), F.extract(help('delete')), help('read'), help('delete')).outside === true);
  check('only a call changed: nothing outside', F.diffGraphs(F.extract(v('p', 'one')), F.extract(v('p', 'two')), v('p', 'one'), v('p', 'two')).outside === false);
  check('a change past the summary cut is still a change', cut.status.a0 === 'changed', j(cut));
}

console.log(`\n${fail === 0 ? 'REVIEW AIDS PASSED' : 'REVIEW AIDS FAILED'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
