// Intent, model and tool routing for the graph editor, on Jev (TypeSafe System One).
//
// The cheap decision layer in front of the expensive one: Jev reads the script's SKELETON (name,
// phases, one mission per agent) and answers typed questions — what kind of work the workflow is,
// how much a wrong result costs, what each agent needs from its model, and which agent type (so which
// tools) should run it. The tier policy (score band → haiku / sonnet / opus) lives HERE in code, not
// in the model: Jev never sees a model name. It does see agent-type names: they ARE the choice, read
// from the local agent definitions, and its pick is only kept if it is one of them.
//
// Advice only. It never allows or denies — the gate's promise is "a human approved this exact
// script", and a classifier must not quietly become that human. A tier answer under its floor is
// flagged as low confidence, never shown as a tier. Without TYPESAFE_API_KEY the feature is simply absent.
//
// ponytail: raw fetch, no SDK — the plugin ships from a cache dir with zero dependencies. JevRouter
// (BillionsBobby/JevRouter) was weighed for the tool routing: same systemone Choice, plus an npm
// dependency this process cannot take and a fallback policy that picks for the human.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The same policy as the skill's "Cost management: picking a model tier" (skills/workflow-orchestration-
// patterns/SKILL.md) — change both or they drift.
const LEVELS = [
  'Mechanical work a stronger model already specified',
  'Ordinary build or review requiring judgment',
  'Large-context synthesis or a decision with real consequences',
];
const TIER = ['haiku', 'sonnet', 'opus'];              // one per LEVELS band
const STAKES = ['read-only, easily redone', 'produces artifacts someone will act on', 'changes shared state, ships, deploys, or touches credentials'];
const KINDS = {
  review: 'Reviewing or auditing existing code or changes',
  research: 'Gathering and synthesizing information',
  build: 'Writing or changing code or artifacts',
  migration: 'Transforming or moving a system between versions or stacks',
  other: 'None of these clearly fits',
};
export const MIN_CONFIDENCE = 0.5;
// A downgrade on a workflow that ships or deploys needs more certainty than one on a read-only one.
// ponytail: 0.7 is borrowed from another pipeline's routine-prompt floor; recalibrate on outcome data.
export const HIGH_STAKES_CONFIDENCE = 0.7;
// fable above opus; inherited/computed is the session's model, unknown here, so ranked top: any
// suggestion for it counts as a downgrade and meets the stricter floor.
const RANK = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
const rankOf = (m) => RANK[m] ?? 3;
const CACHE_TTL_MS = 30 * 60 * 1000;
export const MAX_AGENTS = 40;
const MISSION_CHARS = 1500;
const FX = '_fx';
const TYPE = '_type';

// Agent ids share the questions map with `kind` and `stakes` and the advice map's prototype. Only
// the editor's own `aN` ids get through — anything else is not from the page.
const ID = /^a\d+$/;
const agentsOf = (skel) => (skel.agents || []).filter((a) => ID.test(String(a?.id))).slice(0, MAX_AGENTS);

// ---------------------------------------------------------------------------- agent types (tools)
// `agent()` has no `tools` option: `agentType` is its only tool boundary, so routing tools means
// routing agent types. The catalog is what Claude Code's registry lists, minus ~/.claude/agents (personal
// definitions drift; the package ships the ones a workflow should reach for): (none), then
// <project>/.claude/agents (shadowing a same-named built-in), the built-ins, then this plugin's agents/
// and every enabled plugin's, as <plugin>:<name>.
// First name wins. Names are VERBATIM frontmatter (`(@_@) engineer` is a real registry name); one that
// cannot sit inside a quoted literal is skipped, since it could never be spliced. The same check is
// in the editor's applyEdits — change both.
// The (none) rule is the skill's "custom agentType only for specialized lenses" — change both.
export const NO_TYPE = '(none)';
const BUILTIN_TYPES = [
  { name: NO_TYPE, description: 'No specialized agent type: the default workflow subagent. The norm for ordinary build, research and review work, except a mission that invokes a skill: it is not documented to have the Skill tool.', tools: 'every tool connected to the session' },
  { name: 'general-purpose', description: 'Multi-step tasks that must invoke a Skill or a specific MCP tool.', tools: 'all tools' },
  { name: 'Explore', description: 'Read-only search across many files: locates code and reports conclusions, does not edit.', tools: 'all except Agent, Edit, Write, NotebookEdit' },
  { name: 'Plan', description: 'Software architect: designs an implementation plan, returns steps and critical files, does not edit.', tools: 'all except Agent, Edit, Write, NotebookEdit' },
].map((t) => ({ ...t, skills: [], source: 'built-in' }));
// ponytail: one single-stage Choice (JevRouter's default ceiling too). Past 32, ask coarse-then-final
// in two calls.
export const MAX_TYPES = 32;
const DESC_CHARS = 200;
const spliceable = (s) => typeof s === 'string' && s.length > 0 && s.length <= 100 && !/['"`\\\r\n\u2028\u2029]|\$\{/.test(s);
const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

// The keys this needs from a definition's frontmatter: one-line values, a folded/literal block, or
// a `- item` list (joined with ", "). ponytail: not YAML — anything else reads as missing.
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  let key = null;
  for (const line of m ? m[1].split(/\r?\n/) : []) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) { key = kv[1]; out[key] = /^[>|][-+]?$/.test(kv[2]) ? '' : kv[2]; continue; }
    const item = line.match(/^\s+-\s+(.*)$/);
    if (key && item) out[key] += (out[key] ? ', ' : '') + unquote(item[1]);
    else if (key && /^\s+\S/.test(line)) out[key] += (out[key] ? ' ' : '') + line.trim();
  }
  return out;
}

// Top-level agents/*.md only: a subfolder adds its own segment to the registry name.
function typesIn(dir, source, plugin = null) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  return files.flatMap((f) => {
    let fm; try { fm = frontmatter(readFileSync(join(dir, f), 'utf8')); } catch { return []; }
    const name = (plugin ? plugin + ':' : '') + unquote(fm.name || ''), description = unquote(fm.description || '');
    if (!spliceable(name) || !fm.name || !description) return [];
    const list = (v) => unquote(v || '').replace(/^\[(.*)\]$/, '$1').split(/,\s*/).map(unquote).filter(Boolean);
    // The tools the agent really gets: disallowedTools comes out of an explicit list, or qualifies
    // "all tools" — what Jev reads and what the editor's Skill check tests.
    const allowed = list(fm.tools), denied = list(fm.disallowedTools);
    const tools = allowed.length ? allowed.filter((t) => !denied.includes(t)).join(', ')
      : 'all tools' + (denied.length ? ' except ' + denied.join(', ') : '');
    return [{ name, description: description.slice(0, DESC_CHARS), tools, skills: list(fm.skills), source }];
  });
}

// This plugin's agents first (the running copy, which may be newer than the installed one), then
// every plugin the user settings enable. ponytail: user-scope enablement only — a plugin enabled
// only in a project's settings is not read.
const OWN_AGENTS = { plugin: 'workflow-gate', dir: join(dirname(fileURLToPath(import.meta.url)), '..', 'agents') };
function pluginAgentDirs() {
  try {
    const installed = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
    const enabled = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).enabledPlugins || {};
    return Object.entries(installed).filter(([k, v]) => enabled[k] === true && v?.[0]?.installPath)
      .map(([k, v]) => ({ plugin: k.split('@')[0], dir: join(v[0].installPath, 'agents') }));
  } catch { return []; }
}

// projectDir: the session's project root, or null. The project dir is writable by the agents this
// gate constrains, so each entry carries its source and tools for the human to read next to the pick.
export function agentTypes(projectDir, plugins = [OWN_AGENTS, ...pluginAgentDirs()]) {
  const seen = new Set(), out = [];
  const project = projectDir ? typesIn(join(projectDir, '.claude', 'agents'), 'project') : [];
  // (none) first; then a project definition shadows a built-in of the same name, as Claude Code does.
  for (const t of [BUILTIN_TYPES[0], ...project, ...BUILTIN_TYPES.slice(1), ...plugins.flatMap((p) => typesIn(p.dir, 'plugin', p.plugin))]) {
    if (seen.has(t.name) || out.length >= MAX_TYPES) continue;
    seen.add(t.name); out.push(t);
  }
  return out;
}

// The skeleton is what the editor already extracted (acorn, client-side) — no second parser here.
// types: the agentTypes() catalog; empty = no type question.
export function requestFor(skel, types = []) {
  const agents = agentsOf(skel).map((a) => ({
    id: String(a.id), label: String(a.label || ''), phase: a.phase ? String(a.phase) : null,
    model: String(a.model || 'inherited'), mission: String(a.mission || '').slice(0, MISSION_CHARS),
  }));
  const questions = {
    kind: { type: 'choice', instructions: 'What kind of work is this workflow as a whole?', criteria: KINDS },
    stakes: { type: 'score', instructions: 'How consequential is a wrong result of this workflow?', criteria: STAKES },
  };
  for (const a of agents) {
    questions[a.id] = { type: 'score', instructions: { question: `What does the agent with id ${a.id} need from its model?`, agent: a.id }, criteria: LEVELS };
    // Same request, one more yes/no per agent: what the reviewer should read first. `_fx` can never
    // match ID, so it cannot shadow another agent's question.
    questions[a.id + FX] = { type: 'noul', instructions: { question: `Does the mission of the agent with id ${a.id} push, publish, deploy, delete, or write outside its working directory?`, agent: a.id } };
    // fromEntries defines own keys: a type named __proto__ is data, never the criteria's prototype.
    if (types.length) questions[a.id + TYPE] = { type: 'choice', criteria: Object.fromEntries(types.map((t) => [t.name, `${t.description} Tools: ${t.tools}.`])),
      instructions: { question: `Which agent type should run the agent with id ${a.id}? The type fixes which tools it can reach. ${NO_TYPE} is the norm; pick a named type only when the mission needs that type's specialized lens or its tools.`, agent: a.id } };
  }
  return {
    model: process.env.TYPESAFE_MODEL || 'jev-latest',
    state: { workflow: { name: skel.name || null, description: skel.description || null, phases: skel.phases || [] }, agents },
    questions,
  };
}

// Pure: Jev's answers → what the editor shows. The answers come from the network or from a cache
// file anything local can write, so every field is checked here and tiers only ever come from TIER.
// kind/stakes under MIN_CONFIDENCE are silence. A tier under its floor — HIGH_STAKES_CONFIDENCE for
// a downgrade unless stakes are known to be low, MIN_CONFIDENCE otherwise — is flagged, not dropped.
// A type pick is kept only if it names a catalog entry; (none) comes out as type: null. Under its floor
// a pick is not a suggestion, but where Jev hesitated is information: the two likeliest catalog types,
// with their probabilities, for the human to choose between — never a fallback chosen for them.
export function adviceFrom(answers, skel, types = []) {
  const p01 = (x) => typeof x === 'number' && x >= 0 && x <= 1;
  const valid = (a) => a && p01(a.confidence) && Number.isFinite(a.score ?? 0);
  const sure = (a) => valid(a) && a.confidence >= MIN_CONFIDENCE;
  const band = (a) => Math.min(Math.max(Math.round(a.score), 0), LEVELS.length - 1);
  const byName = new Map(types.map((t) => [t.name, t]));
  const out = { kind: null, stakes: null, agents: {}, fx: {}, types: {} };
  answers = answers && typeof answers === 'object' ? answers : {};
  if (sure(answers.kind) && Object.hasOwn(KINDS, answers.kind.choice)) out.kind = { choice: answers.kind.choice, confidence: answers.kind.confidence };
  if (sure(answers.stakes) && Number.isFinite(answers.stakes.score)) out.stakes = { level: band(answers.stakes), text: STAKES[band(answers.stakes)], confidence: answers.stakes.confidence };
  const highStakes = !out.stakes || out.stakes.level === STAKES.length - 1;   // unknown stakes: the strict floor
  for (const a of agentsOf(skel)) {
    // A Noul is its own probability — no separate confidence. The editor thresholds it.
    const fx = answers[a.id + FX]?.noul;
    if (p01(fx)) out.fx[a.id] = fx;
    const ty = answers[a.id + TYPE], t = valid(ty) && byName.get(ty.choice);
    if (t) out.types[a.id] = ty.confidence >= MIN_CONFIDENCE
      ? { type: t.name === NO_TYPE ? null : t.name, tools: t.tools, source: t.source, confidence: ty.confidence }
      : { low: true, confidence: ty.confidence, floor: MIN_CONFIDENCE,
          alts: Object.entries(ty.probabilities && typeof ty.probabilities === 'object' ? ty.probabilities : {})
            .filter(([n, p]) => byName.has(n) && p01(p)).sort((x, y) => y[1] - x[1]).slice(0, 2)
            .map(([n, p]) => ({ type: n === NO_TYPE ? null : n, p })) };
    const ans = answers[a.id];
    if (!valid(ans) || !Number.isFinite(ans.score)) continue;
    const b = band(ans);
    const down = rankOf(TIER[b]) < rankOf(String(a.model || 'inherited'));
    const floor = down && highStakes ? HIGH_STAKES_CONFIDENCE : MIN_CONFIDENCE;
    out.agents[a.id] = ans.confidence >= floor
      ? { tier: TIER[b], level: LEVELS[b], confidence: ans.confidence }
      : { tier: null, low: true, confidence: ans.confidence, floor };
  }
  return out;
}

// Cached by the exact bytes sent: the same skeleton, question set and model id is the same answer,
// so a retry (a new approve-server) or a re-ask after an undo costs nothing. Raw answers only —
// adviceFrom re-derives, and re-validates, everything shown.
const cacheFile = (dir, body) => join(dir, createHash('sha256').update(body).digest('hex').slice(0, 32) + '.json');
function readCache(file) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return Date.now() - c.at < CACHE_TTL_MS ? c.answers : null;
  } catch { return null; }
}
function writeCache(dir, file, answers) {
  try {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {   // prune on write: the dir never outgrows one TTL of reviews
      try { if (Date.now() - statSync(join(dir, f)).mtimeMs > CACHE_TTL_MS) unlinkSync(join(dir, f)); } catch {}
    }
    writeFileSync(file, JSON.stringify({ at: Date.now(), answers }));
  } catch { /* a cache that cannot be written is just a cache miss next time */ }
}

// null = feature absent (no key) or Jev unreachable; the editor shows nothing either way. The type
// catalog is part of the body, so an edited agent definition is a new cache key.
export async function askJev(skel, cacheDir = null, types = []) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return null;
  const body = JSON.stringify(requestFor(skel, types));   // hashed and sent as the same string
  const file = cacheDir && cacheFile(cacheDir, body);
  let answers = file && readCache(file);
  if (!answers) {
    answers = await systemOne(key, body);
    if (!answers) return null;
    if (file) writeCache(cacheDir, file, answers);
  }
  return adviceFrom(answers, skel, types);
}

// One call to Jev: its answers map, or null when it cannot be reached.
async function systemOne(key, body) {
  try {
    const r = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return (await r.json()).answers || {};
  } catch { return null; }
}

// ---------------------------------------------------------------------------- outcome (post-run)
// Did the spend produce anything? After a run is costed, the history daemon asks Jev one yes/no per
// agent on its mission and the head of its result. OPT-IN TWICE — a key AND WORKFLOW_GATE_OUTCOME=1 —
// because result excerpts leave the machine, which the advice call never does. The thresholds are
// here, in code: Jev returns a probability, never a verdict. A FAIL is a flag for the history page
// and a reason to leave the agent out of the priors medians, not ground truth: 1.5 KB of a long
// result can misjudge it. Runs after the fact, on a finished run: nothing here can touch an approval.
export const OUTCOME_PASS = 0.8, OUTCOME_FAIL = 0.5;
export const outcomeOn = () => !!process.env.TYPESAFE_API_KEY && process.env.WORKFLOW_GATE_OUTCOME === '1';
export function outcomeOf(p) {
  if (typeof p !== 'number' || !(p >= 0 && p <= 1)) return null;
  return p >= OUTCOME_PASS ? 'PASS' : p < OUTCOME_FAIL ? 'FAIL' : 'REVIEW';
}
export function outcomeRequest(items) {
  const agents = items.slice(0, MAX_AGENTS).map((x, i) => ({ id: 'a' + i,
    mission: String(x.mission || '').slice(0, MISSION_CHARS), result: String(x.result || '').slice(0, MISSION_CHARS) }));
  const questions = {};
  for (const a of agents) questions[a.id] = { type: 'noul', instructions: { question: `Does the result of the agent with id ${a.id} substantively satisfy its mission as written — not a refusal, an error, or an empty or placeholder claim of success?`, agent: a.id } };
  return { model: process.env.TYPESAFE_MODEL || 'jev-latest', state: { agents }, questions };
}

// The mission as the agent received it: the first user line of its transcript. ponytail: reads at
// most 1 MB, like the gate's live matcher; a longer first line falls back to the record's preview.
function missionOf(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.allocUnsafe(1 << 20);
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    for (const line of text.split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const c = e.message?.content;
      const t = typeof c === 'string' ? c : e.type === 'user' && Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n') : '';
      if (t) return t;
    }
  } catch {} finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
  return null;
}

// One verdict per agent that has an agentId, in the record's order (the same agents, same order, as
// costRun and the cost cache). null = resumed (not re-run, nothing to judge) or unanswered. Returns
// null when off or when Jev cannot be reached, so the caller retries on a later pass.
export async function judgeRun(runDir, recAgents) {
  if (!outcomeOn()) return null;
  const agents = recAgents.filter((a) => a.agentId);
  const results = new Map();
  try {
    for (const line of readFileSync(join(runDir, 'journal.jsonl'), 'utf8').split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'result' && e.agentId) results.set(e.agentId, typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? ''));
    }
  } catch { /* no journal: the record's previews are all there is */ }
  const todo = agents.map((a, i) => ({ i, cached: !!a.cached,
    mission: missionOf(join(runDir, 'agent-' + a.agentId + '.jsonl')) || a.promptPreview || '',
    result: results.get(a.agentId) ?? a.resultPreview ?? '' })).filter((x) => !x.cached);
  const out = agents.map(() => null);
  for (let k = 0; k < todo.length; k += MAX_AGENTS) {
    const batch = todo.slice(k, k + MAX_AGENTS);
    const answers = await systemOne(process.env.TYPESAFE_API_KEY, JSON.stringify(outcomeRequest(batch)));
    if (!answers) return null;
    batch.forEach((x, j) => { out[x.i] = outcomeOf(answers['a' + j]?.noul); });
  }
  return out;
}
