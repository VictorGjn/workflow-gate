// Local check, not shipped with the plugin. Run from this directory after `npm i --no-save acorn@8`:
//   node escaping-test.mjs [path/to/graph-editor.html]
//
// TRUST BOUNDARY tests. The mission textarea turns free human text into executable JavaScript that
// gets written over the user's file and then marked approved. Every case below SHIPPED BROKEN in the
// first version of the editor: an apostrophe wrote a SyntaxError to disk, and `${process.env.X}`
// typed as prose became a live interpolation in the approved script. They live here so they cannot
// regress quietly.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const EDITOR = process.argv[2] || fileURLToPath(new URL('../graph-editor.html', import.meta.url));
const html = readFileSync(EDITOR, 'utf8');
const body = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const pure = body.slice(0, body.indexOf('// ---------------------------------------------------------------- state'));
const { extract, applyEdits } = new Function('acorn', pure + '\n return { extract, applyEdits };')(acorn);

const OPTS = { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true };
const parses = (t) => { try { acorn.parse(t, OPTS); return true; } catch { return false; } };
// The literal's runtime VALUE after splicing — escaping that merely parses but mangles the text
// would be a quieter bug than a SyntaxError, not a smaller one.
const valueOf = (src) => {
  const ast = acorn.parse(src, OPTS);
  let out = null;
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee?.name === 'agent') {
      const a = n.arguments[0];
      if (a.type === 'Literal') out = a.value;
      else if (a.type === 'TemplateLiteral') out = a.quasis.map((q) => q.value.cooked).join('\u0000');
    }
    for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
  })(ast);
  return out;
};

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

// ---- plain string literal -----------------------------------------------------------
const strS = [
  "export const meta = { name: 'x', description: 'd' }",
  "const a = await agent('plain', { label: 'solo' })",
  'return a',
].join('\n');
const gs = extract(strS);

for (const [what, text] of [
  ['an apostrophe', "it's fine"],
  ['a newline', 'line one\nline two'],
  ['a Windows path', 'C:\\Users\\victo'],
  ['a quote-escape attempt', "x') ; console.log('pwned"],
  ['a tab and a CR', 'a\tb\r\nc'],
]) {
  const out = applyEdits(strS, gs.nodes, { a0: { mission: text } });
  check(`string literal: ${what} still parses`, parses(out));
  check(`string literal: ${what} keeps its exact value`, parses(out) && valueOf(out) === text,
    parses(out) ? JSON.stringify(valueOf(out)) : 'did not parse');
}

// ---- template literal ---------------------------------------------------------------
const tplS = [
  "export const meta = { name: 'x', description: 'd' }",
  "const S = 'ctx'",
  'const a = await agent(`${S}\\ntail`, { label: \'solo\' })',
  'return a',
].join('\n');
const gt = extract(tplS);

for (const [what, text] of [
  ['prose mentioning ${}', '\nthe ${} syntax is fine\n'],
  ['prose that looks like an interpolation', '\nsee ${process.env.SECRET} here\n'],
  ['prose containing a backtick', '\nrun `npm test` first\n'],
  ['a trailing backslash', '\nends with a backslash \\\n'],
]) {
  const out = applyEdits(tplS, gt.nodes, { a0: { mission: text } });
  check(`template: ${what} still parses`, parses(out));
  // Assert on the parsed VALUE, not the source text: the correct output contains an ESCAPED
  // \${...}, which a naive source-text regex flags as a false positive.
  check(`template: ${what} stays TEXT, never code`,
    parses(out) && valueOf(out).endsWith(text),
    parses(out) ? 'value preserved verbatim' : 'did not parse');
}

// The one that matters most: an interpolation typed as prose must not gain an expression slot.
{
  const out = applyEdits(tplS, gt.nodes, { a0: { mission: '\n${process.env.SECRET}\n' } });
  const ast = acorn.parse(out, OPTS);
  let exprs = -1;
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'TemplateLiteral' && exprs === -1) exprs = n.expressions.length;
    for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
  })(ast);
  check('typed ${process.env.SECRET} adds NO new interpolation to the template',
    exprs === 1, `template has ${exprs} expression(s); the original had 1`);
}

// ---- a prompt that legitimately ends in an interpolation ------------------------------
const tailS = [
  "export const meta = { name: 'x', description: 'd' }",
  "const T = 'go'",
  'const a = await agent(`Do this:\\n${T}`, { label: \'ends-expr\' })',
  'return a',
].join('\n');
const tail = extract(tailS).nodes[0];
check('its editable tail is empty (that is correct)', tail.mission === '');
check('but the assembled prompt is not, so Approve stays reachable',
  tail.assembled.trim().length > 0, JSON.stringify(tail.assembled));
check('assembled renders interpolations as visible placeholders', tail.assembled.includes('\u27e8T\u27e9'));

// ---- a computed prompt is shown, never faked as editable ------------------------------
const computed = extract("const a = await agent(d.prompt, { label: 'x' })").nodes[0];
check('a computed prompt has no editable span', computed.missionSpan === null);
check('a computed prompt is still shown as a placeholder', /\u27e8d\.prompt\u27e9/.test(computed.assembled), computed.assembled);

console.log(`\n${fail === 0 ? 'ESCAPING PASSED' : 'ESCAPING FAILED'} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
