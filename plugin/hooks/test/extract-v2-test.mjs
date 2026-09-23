// Local check, not shipped with the plugin. Run from this directory after `npm i --no-save acorn@8`:
//   node extract-v2-test.mjs [path/to/graph-editor.html]
//
// Extractor v2: the cases the gate's honesty depends on. Written BEFORE the code — every check here
// failed on the v1 extractor (guards counted as ≥1 agent, ×n for a literal array of 6, no data edges,
// phase() calls ignored, a ternary model shown as "default", ×3 stamped on each inline thunk).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const EDITOR = process.argv[2] || fileURLToPath(new URL('../graph-editor.html', import.meta.url));
const html = readFileSync(EDITOR, 'utf8');
const body = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const pure = body.slice(0, body.indexOf('// ---------------------------------------------------------------- state'));
const { extract } = new Function('acorn', pure + '\n return { extract };')(acorn);

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const j = JSON.stringify;
const edge = (g, s, t) => g.edges.find((e) => e.source === s && e.target === t);

// ---- the real script: 8 agents from 3 sites, survey feeds critique AND spec ----------------
const real = readFileSync(fileURLToPath(new URL('./fixtures/sota-graph.mjs', import.meta.url)), 'utf8');
const g = extract(real);
check('3 call sites', g.nodes.length === 3, String(g.nodes.length));
check('minAgents is 8, the truth', g.minAgents === 8, String(g.minAgents));
check('fan-out over DIMENSIONS resolves to 6', g.nodes[0].fanOut?.n === 6 && g.nodes[0].fanOut?.over === 'DIMENSIONS', j(g.nodes[0].fanOut));
check('fan-out labels are the six real ones', j(g.nodes[0].fanOut?.labels) === j(['survey:node-anatomy','survey:conditional-edges','survey:layout-engineering','survey:inspector-panels','survey:canvas-interaction','survey:agent-graph-semantics']), j(g.nodes[0].fanOut?.labels));
check('data edge survey→critique', edge(g, 'a0', 'a1')?.kind === 'data' && edge(g, 'a0', 'a1')?.via === 'survey', j(edge(g, 'a0', 'a1')));
check('data edge survey→spec (the skip edge the phase chain cannot draw)', edge(g, 'a0', 'a2')?.via === 'survey', j(edge(g, 'a0', 'a2')));
check('data edge critique→spec', edge(g, 'a1', 'a2')?.via === 'critique', j(edge(g, 'a1', 'a2')));
check('exactly 3 data edges, no cross-product', g.edges.length === 3, String(g.edges.length));
check('survey result is interpolated raw: may contain null', edge(g, 'a0', 'a1')?.mayContainNull === true, j(edge(g, 'a0', 'a1')));
check('no guards on the real script', g.nodes.every((n) => !n.guard));
check('effort absent → null (rendered as inherited, never "default")', g.nodes.every((n) => n.effort === null), j(g.nodes.map((n) => n.effort)));
check('writes-to derived from prompt text', g.nodes[1].writesTo?.some((w) => /00-CRITIQUE\.md/.test(w)) === true, j(g.nodes[1].writesTo));
check('agent(d.prompt) over a literal array resolves every item prompt', g.nodes[0].fanOut?.prompts?.length === 6 && /Node design at the state of the art/.test(g.nodes[0].fanOut.prompts[0]), j(g.nodes[0].fanOut?.prompts?.map((p) => p.slice(0, 30))));
check('…and the node shows the first item prompt, not ⟨d.prompt⟩', /^⟨CONTEXT⟩/.test(g.nodes[0].assembled) && /DIMENSION: Node design/.test(g.nodes[0].assembled), g.nodes[0].assembled.slice(0, 40));
check('context: CONTEXT is a shared constant with a preview', g.nodes[1].context?.some((c) => c.kind === 'const' && c.expr === 'CONTEXT' && c.chars > 1000), j(g.nodes[1].context));

// ---- the reviewer's counter-examples: every one printed minAgents=2 for a real count of 1 -----
const rv = (s) => extract(s).minAgents;
check('catch clause is a guard', rv(`try { await agent('a') } catch { await agent('fallback') }`) === 1);
check('early return skips what follows', rv(`const r = await agent('scan')\nif (!r.ok) return r\nconst b = await agent('fix')`) === 1);
check('early throw skips what follows', rv(`const r = await agent('scan')\nif (!r.ok) throw new Error('x')\nconst b = await agent('fix')`) === 1);
check('helper function is called ? times', rv(`async function fix(){ return agent('fix') }\nconst r = await agent('scan')\nif (!r.ok) await fix()`) === 1);
check('arrow helper in a const is called ? times', rv(`const fix = async () => agent('fix')\nconst r = await agent('scan')\nawait fix()`) === 1);
check('a let array can be resized: runtime fan-out, counts 1', rv(`let DIMS=[{slug:'a'},{slug:'b'},{slug:'c'}]\nif (args.quick) DIMS = DIMS.slice(0,1)\nawait parallel(DIMS.map(d => () => agent(d.slug)))`) === 1);
check('inline thunks and IIFEs still count normally', rv(`const [a, b] = await parallel([() => agent('a'), async () => { return agent('b') }])\nawait (async () => agent('c'))()`) === 3);
const ds = extract(`const [a, b] = await parallel([() => agent('a'), () => agent('b')])\nconst c = await agent(\`\${a} then \${b}\`)`);
check('destructured parallel result: a→c and b→c, one producer each', edge(ds, 'a0', 'a2')?.via === 'a' && edge(ds, 'a1', 'a2')?.via === 'b' && ds.edges.length === 2, j(ds.edges));
check('writes-to ignores and/or and URLs', extract("const a = await agent('Write the risks and/or benefits, see https://example.com/x, then save to /tmp/out.md')").nodes[0].writesTo.join() === '/tmp/out.md', j(extract("const a = await agent('Write the risks and/or benefits, see https://example.com/x, then save to /tmp/out.md')").nodes[0].writesTo));
check('context: survey is upstream from a0, may contain null', g.nodes[1].context?.some((c) => c.kind === 'upstream' && c.producers[0] === 'a0' && c.mayContainNull), j(g.nodes[1].context));
check('context: critique is upstream from a1 into spec', g.nodes[2].context?.some((c) => c.kind === 'upstream' && c.producers[0] === 'a1'), j(g.nodes[2].context));

// ---- phase() calls, the documented default ---------------------------------------------
const ph = extract(`export const meta = { name: 'p', description: 'd', phases: [{ title: 'Scan' }, { title: 'Fix' }] }
phase('Scan')
const a = await agent('find things')
phase('Fix')
const b = await agent('fix things')
const c = await agent('other', { phase: 'Verify' })`);
check('phase() call groups the agents after it', ph.nodes[0].phase === 'Scan' && ph.nodes[1].phase === 'Fix', j(ph.nodes.map((n) => n.phase)));
check('opts.phase still wins over phase()', ph.nodes[2].phase === 'Verify');

// ---- opts that are not literals must never read as "inherited" ---------------------------
const op = extract(`const big = true
const a = await agent('x', { model: big ? 'opus' : 'sonnet', effort: 'high', isolation: 'worktree', agentType: 'engineer',
  schema: { type: 'object', properties: { findings: {}, verdict: {} } } })
const b = await agent('y', { effort: args.effort })`);
check('ternary model → computed, with its source', op.nodes[0].model === 'computed' && /big \?/.test(op.nodes[0].modelText), j([op.nodes[0].model, op.nodes[0].modelText]));
check('computed model has no splice span', op.nodes[0].modelSpan === null);
check('effort / isolation / agentType read', op.nodes[0].effort === 'high' && op.nodes[0].isolation === 'worktree' && op.nodes[0].agentType === 'engineer');
check('schema top-level keys read', j(op.nodes[0].schemaKeys) === j(['findings', 'verdict']), j(op.nodes[0].schemaKeys));
check('computed effort → computed', op.nodes[1].effort === 'computed');

// ---- guards: a site under a condition contributes 0 to the lower bound -------------------
const gd = extract(`const r = await agent('always')
if (!r.ok) await agent('only when not ok')
const v = r.deep ? await agent('deep') : await agent('shallow')
while (budget.remaining() > 50000) { await agent('loop body') }
for (const x of items) await agent('per item')`);
check('unguarded site has no guard', gd.nodes[0].guard === null);
check('if-guard captured verbatim', gd.nodes[1].guard?.text === '!r.ok' && gd.nodes[1].guard?.kind === 'if', j(gd.nodes[1].guard));
check('ternary arms are guarded, alternate marked else', gd.nodes[2].guard?.text === 'r.deep' && gd.nodes[3].guard?.else === true, j([gd.nodes[2].guard, gd.nodes[3].guard]));
check('while body is a loop guard', gd.nodes[4].guard?.kind === 'loop' && /budget/.test(gd.nodes[4].guard?.text), j(gd.nodes[4].guard));
check('for-of body is a loop guard', gd.nodes[5].guard?.kind === 'loop');
check('lower bound counts only the unguarded site', gd.minAgents === 1, String(gd.minAgents));
check('flags: loop + budget', gd.flags.loop === true && gd.flags.budget === true, j(gd.flags));

// ---- inline thunks are N sites running once each, never ×N ----------------------------------
const th = extract(`const [a, b, c] = await parallel([() => agent('a'), () => agent('b'), () => agent('c')])`);
check('parallel([thunk×3]) is 3 sites, no fan-out, 3 agents', th.nodes.length === 3 && th.nodes.every((n) => !n.fanOut) && th.minAgents === 3, j([th.nodes.length, th.minAgents]));

// ---- named-stage fan-out is runtime, never null ------------------------------------------
const ns = extract(`const stage = (item) => agent(\`do \${item}\`)
const out = await pipeline(items, stage, (r) => agent(\`check \${r}\`))`);
check('agent inside a named stage function is a runtime fan-out', ns.nodes[0].fanOut?.n === null && ns.nodes[0].fanOut?.over === 'items', j(ns.nodes[0].fanOut));
check('inline second stage is also fan-out over items', ns.nodes[1].fanOut?.over === 'items', j(ns.nodes[1].fanOut));
check('stage param carries a data edge from the previous stage', edge(ns, 'a0', 'a1')?.kind === 'data' && edge(ns, 'a0', 'a1')?.via === 'r', j(ns.edges));

// ---- .filter(Boolean) clears the null warning ----------------------------------------------
const nf = extract(`const s = (await parallel(items.map((i) => () => agent(i)))).filter(Boolean)
const t = await agent(\`\${JSON.stringify(s)}\`)`);
check('filter(Boolean) → mayContainNull false', edge(nf, 'a0', 'a1')?.mayContainNull === false, j(nf.edges));

// ---- workflow() nesting is an opaque node ---------------------------------------------------
const wf = extract(`const sub = await workflow('review-changes', { files })
const done = await agent(\`summarise \${JSON.stringify(sub)}\`)`);
check('workflow() call is an opaque node', wf.nodes[0].kind === 'workflow' && /review-changes/.test(wf.nodes[0].label), j(wf.nodes[0]));
check('its result is a data edge like any other', edge(wf, 'a0', 'a1')?.via === 'sub');
check('opaque node counts ≥1 but is flagged', wf.minAgents >= 2 && wf.flags.nested === true, j([wf.minAgents, wf.flags]));

// ---- the honesty invariant over every completed run on this machine ---------------------------
{
  const root = join(homedir(), '.claude', 'projects');
  let runs = 0, lies = 0;
  for (const proj of readdirSync(root)) for (const sess of (() => { try { return readdirSync(join(root, proj)); } catch { return []; } })()) {
    const wf = join(root, proj, sess, 'workflows'); let files = []; try { files = readdirSync(wf); } catch { continue; }
    for (const f of files) if (/^wf_.*\.json$/.test(f)) {
      let r; try { r = JSON.parse(readFileSync(join(wf, f), 'utf8')); } catch { continue; }
      if (typeof r.script !== 'string' || r.status !== 'completed') continue;
      runs++;
      let min; try { min = extract(r.script).minAgents; } catch (e) { lies++; console.log(`  parse fail ${f}: ${e.message.slice(0, 60)}`); continue; }
      if (min > r.agentCount) { lies++; console.log(`  LIE ${f}: static ${min} > actual ${r.agentCount}`); }
    }
  }
  check(`honesty: static lower bound never exceeds the truth (${runs} completed runs on this machine)`, lies === 0, `${lies} lie(s)`);
}

// ---- the flowchart: control flow from statement structure, not from data edges ------------
{
  const fe = (fl, s, t) => fl.edges.find((e) => e.source === s && e.target === t);
  const fg = g.flow;
  check('flow: start → survey → critique → spec → end', fe(fg, 'start', 'a0') && fe(fg, 'a0', 'a1') && fe(fg, 'a1', 'a2') && fe(fg, 'a2', 'end'), j(fg.edges.map((e) => e.source + '>' + e.target)));
  // No data edge, sequential awaits: the old graph drew these as one flat row of roots.
  const sq = extract(`await agent('a')\nawait agent('b')\nawait agent('c')`).flow;
  check('flow: sequence without data edges is a chain', fe(sq, 'a0', 'a1') && fe(sq, 'a1', 'a2') && !fe(sq, 'a0', 'a2'), j(sq.edges.map((e) => e.source + '>' + e.target)));
  // Loop with an early break: review → decision; yes → out of the loop; no → fix → back to the loop head.
  const lp = extract(`for (let i = 0; i < 3; i++) {\n  const r = await agent('review')\n  if (r.pass) break\n  await agent('fix')\n}\nawait agent('ship')`).flow;
  const loop = lp.nodes.find((n) => n.kind === 'loop'), dec = lp.nodes.find((n) => n.kind === 'decision');
  check('flow: loop head and a decision exist', loop && dec, j(lp.nodes));
  check('flow: loop → review → decision', loop && dec && fe(lp, loop.id, 'a0') && fe(lp, 'a0', dec.id));
  check('flow: decision yes = break → ship, no → fix', dec && fe(lp, dec.id, 'a2')?.label === 'yes' && fe(lp, dec.id, 'a1')?.label === 'no', j(lp.edges));
  check('flow: fix loops back (back edge) and loop done → ship', loop && fe(lp, 'a1', loop.id)?.kind === 'back' && fe(lp, loop.id, 'a2')?.label === 'done', j(lp.edges));
  // Early return: the decision's yes edge goes to END, no continues.
  const er = extract(`const r = await agent('scan')\nif (!r.ok) return r\nawait agent('fix')`).flow;
  const d2 = er.nodes.find((n) => n.kind === 'decision');
  check('flow: early return draws yes → end, no → fix', d2 && fe(er, d2.id, 'end')?.label === 'yes' && fe(er, d2.id, 'a1')?.label === 'no', j(er.edges));
  // A helper is inlined where it is called; try/catch draws the error path.
  const hp = extract(`async function fix() { try { return await agent('fix') } catch { return agent('fallback') } }\nconst r = await agent('scan')\nawait fix()`).flow;
  check('flow: helper inlined at its call, error edge to the fallback', fe(hp, 'a2', 'a0') && fe(hp, 'a0', 'a1')?.kind === 'error' && fe(hp, 'a0', 'end') && fe(hp, 'a1', 'end'), j(hp.edges));
  // pipeline stages run in order; a ternary stage is a decision.
  const pl = extract(`await pipeline(items, (c) => agent('research'), (b, c) => b ? agent('verify') : null)`).flow;
  const d3 = pl.nodes.find((n) => n.kind === 'decision');
  check('flow: pipeline stage order, ternary stage is a decision', d3 && fe(pl, 'a0', d3.id) && fe(pl, d3.id, 'a1')?.label === 'yes' && fe(pl, d3.id, 'end')?.label === 'no', j(pl.edges));
}

console.log(`\n${fail === 0 ? 'EXTRACT V2 PASSED' : 'EXTRACT V2 FAILED'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
