// Local check, not shipped with the plugin. Run from this directory:
//   node threads-test.mjs
//
// Assembling the thread of a project. The parsing is where this can quietly rot: handoff headings
// drift between files (Decisions / Decisions made / Done closed), half the handoffs have no date in
// their filename, and a title of "# Handoff" names nothing. All three were real on disk.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

// threads.mjs reads from HOME, so give it one of our own.
const T = mkdtempSync(join(tmpdir(), 'wg-thread-'));
process.env.HOME = T; process.env.USERPROFILE = T;
const HANDOFFS = join(T, '.claude', 'handoffs');
const MEMORY = join(T, '.claude', 'projects', 'C--Users-victo', 'memory');
const SESS = join(T, '.claude', 'projects', 'proj');
mkdirSync(HANDOFFS, { recursive: true });
mkdirSync(MEMORY, { recursive: true });
mkdirSync(SESS, { recursive: true });

writeFileSync(join(HANDOFFS, 'company-brain-m6-2026-07-17.md'), `# company-brain M6 — Handoff (2026-07-17) · Status: in-progress

## Resume here
- **Next action:** finish the TRUTH tier.

## Decisions
- **Fleet-wide scope: remove the vessel gate entirely.** Victor's call.
- Second decision here.

## Failed — do NOT retry
- \`pip install gcf-python\` — blocked by a safety classifier.

## Open questions
- Does the enricher set market_role?
`);
// No date in the filename, and a title that names nothing: both must still come out usable.
writeFileSync(join(HANDOFFS, 'gbrain_setup.md'), `# Handoff: gbrain

## Decisions made
- **Brain home:** PGLite local.

## Next steps
- wire the company brain to the relayer
`);
writeFileSync(join(HANDOFFS, 'README.md'), '# Handoffs folder\n\nNot a handoff. Mentions company brain in passing.\n');
writeFileSync(join(HANDOFFS, 'unrelated-2026-01-01.md'), '# something else — Handoff\n\n## Decisions\n- nothing to do with it\n');

writeFileSync(join(MEMORY, 'project_brain.md'), '---\nname: project-brain\ndescription: the company brain substrate\nmetadata:\n  type: project\n---\n\ncompany brain notes\n');
writeFileSync(join(MEMORY, 'MEMORY.md'), '# index — company brain company brain company brain\n');

const line = (o) => JSON.stringify(o) + '\n';
writeFileSync(join(SESS, 's1.jsonl'),
  line({ type: 'user', timestamp: '2026-07-17T09:00:00.000Z', message: { role: 'user', content: 'work on the company brain please — the company brain wiring, and the brain again' } })
  + line({ type: 'assistant', timestamp: '2026-07-17T09:05:00.000Z', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'a', name: 'Write', input: { file_path: 'C:/repo/out/brain.md' } }] } })
  + line({ type: 'assistant', timestamp: '2026-07-17T09:06:00.000Z', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'git commit -m "company brain wiring"' } }] } })
  + line({ type: 'user', timestamp: '2026-07-17T09:07:00.000Z', message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' } }));
writeFileSync(join(SESS, 's3.jsonl'),
  line({ type: 'user', timestamp: '2026-07-19T09:00:00.000Z', gitBranch: 'feat/prd-132-brain-wiring',
    message: { role: 'user', content: 'unrelated words entirely' } }));
writeFileSync(join(SESS, 's2.jsonl'),
  line({ type: 'user', timestamp: '2026-07-18T09:00:00.000Z', message: { role: 'user', content: 'something entirely different' } }));

const { readHandoff, searchThread, sessionDetail } = await import('../threads.mjs');

// ---- handoff parsing ---------------------------------------------------------------------------
const h = readHandoff('company-brain-m6-2026-07-17.md');
check('the title drops the "— Handoff" suffix', h.title === 'company-brain M6', h.title);
check('status is read off the H1', /in-progress/.test(h.status || ''), String(h.status));
check('the date comes from the filename', h.date === '2026-07-17' && h.dateFromFile === true, `${h.date} fromFile=${h.dateFromFile}`);
check('decisions are kept verbatim, not summarised', /remove the vessel gate entirely/.test(h.decisions || ''));
check('"Failed — do NOT retry" is picked up under its own heading', /gcf-python/.test(h.failed || ''));
check('open questions are separated from decisions',
  /market_role/.test(h.open || '') && !/market_role/.test(h.decisions || ''));

const g = readHandoff('gbrain_setup.md');
check('a title of just "Handoff" falls back to the filename', g.title === 'gbrain setup', g.title);
check('no date in the filename falls back to mtime, and says so',
  /^\d{4}-\d{2}-\d{2}$/.test(g.date || '') && g.dateFromFile === false, `${g.date} fromFile=${g.dateFromFile}`);
check('"Decisions made" is matched as well as "Decisions"', /PGLite/.test(g.decisions || ''));

// ---- the branch convention, which silently did nothing ----------------------------------------
// `feat/prd-132-…` is the convention the Linear hook relies on, and the code claimed to read it. It
// was splitting on [/_-], which deletes the hyphen the id is MADE of: FEAT PRD 132 matches nothing.
const { indexSessions } = await import('../sessions.mjs');
const idx = await indexSessions();
const s3 = idx.sessions.s3;
check('a ticket is recovered from the branch name alone',
  !!s3 && s3.tickets.includes('PRD-132'), JSON.stringify(s3?.tickets));
check('…and the branch itself is recorded', !!s3 && s3.branches.includes('feat/prd-132-brain-wiring'), JSON.stringify(s3?.branches));

// ---- the search --------------------------------------------------------------------------------
const th = searchThread('company brain');
check('a README in the handoffs folder is not a handoff',
  !th.handoffs.some((x) => /readme/i.test(x.file)), th.handoffs.map((x) => x.file).join(', '));
check('an unrelated handoff is left out', !th.handoffs.some((x) => /unrelated/.test(x.file)));
check('both matching handoffs are found, oldest first',
  th.handoffs.length === 2 && th.handoffs[0].date < th.handoffs[1].date, th.handoffs.map((x) => x.date).join(' → '));
check('the memory index file is excluded from memories', !th.memories.some((m) => m.file === 'MEMORY.md'));
check('a matching memory is found with its type', th.memories.some((m) => m.type === 'project'), JSON.stringify(th.memories));
check('a session mentioning it 3+ times is included, one that never does is not',
  th.sessions.length === 1 && th.sessions[0].sessionId === 's1', JSON.stringify(th.sessions.map((s) => s.sessionId)));
// "company-brain" and "company brain" are the same thread; a hyphen must not split it.
check('the query matches across a hyphen or a dot', searchThread('company-brain').handoffs.length === 2);
check('a query with regex metacharacters does not throw', searchThread('brain (v2) [x]').handoffs.length === 0);
// A query of nothing but separators used to build `new RegExp('')`, which matches at every position:
// every handoff, every memory and every transcript came back a hit, with millions of empty matches
// allocated per file. It is reachable from the page, which only checks the query is 3 characters.
for (const junk of ['---', '   -  ', '...', '___']) {
  const r = searchThread(junk);
  check(`a query of only separators (${JSON.stringify(junk)}) finds nothing, not everything`,
    r.handoffs.length === 0 && r.memories.length === 0 && r.sessions.length === 0,
    `h${r.handoffs.length} m${r.memories.length} s${r.sessions.length}`);
}

// ---- inputs and outputs -------------------------------------------------------------------------
const det = sessionDetail('proj', 's1');
check('prompts are the inputs, harness turns excluded',
  det.promptCount === 1 && /company brain please/.test(det.prompts[0].text), JSON.stringify(det.prompts));
check('written files are the outputs', det.wrote.length === 1 && det.wrote[0].path === 'C:/repo/out/brain.md', JSON.stringify(det.wrote));
check('git commits are surfaced separately', det.gitCommands.length === 1 && /company brain wiring/.test(det.gitCommands[0]));
check('a missing session is null, not a throw', sessionDetail('proj', 'nope') === null);

rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
