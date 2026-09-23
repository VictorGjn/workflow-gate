// Intent and model routing for the graph editor, on Jev (TypeSafe System One).
//
// The cheap decision layer in front of the expensive one: Jev reads the script's SKELETON (name,
// phases, one mission per agent) and answers typed questions — what kind of work the workflow is,
// how much a wrong result costs, and what each agent needs from its model. The tier policy (score
// band → haiku / sonnet / opus) lives HERE in code, not in the model: Jev never sees a model name.
//
// Advice only. It never allows or denies — the gate's promise is "a human approved this exact
// script", and a classifier must not quietly become that human. A tier answer under its floor is
// flagged as low confidence, never shown as a tier. Without TYPESAFE_API_KEY the feature is simply absent.
//
// ponytail: raw fetch, no SDK — the plugin ships from a cache dir with zero dependencies.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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

// Agent ids share the questions map with `kind` and `stakes` and the advice map's prototype. Only
// the editor's own `aN` ids get through — anything else is not from the page.
const ID = /^a\d+$/;
const agentsOf = (skel) => (skel.agents || []).filter((a) => ID.test(String(a?.id))).slice(0, MAX_AGENTS);

// The skeleton is what the editor already extracted (acorn, client-side) — no second parser here.
export function requestFor(skel) {
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
export function adviceFrom(answers, skel) {
  const p01 = (x) => typeof x === 'number' && x >= 0 && x <= 1;
  const valid = (a) => a && p01(a.confidence) && Number.isFinite(a.score ?? 0);
  const sure = (a) => valid(a) && a.confidence >= MIN_CONFIDENCE;
  const band = (a) => Math.min(Math.max(Math.round(a.score), 0), LEVELS.length - 1);
  const out = { kind: null, stakes: null, agents: {}, fx: {} };
  answers = answers && typeof answers === 'object' ? answers : {};
  if (sure(answers.kind) && Object.hasOwn(KINDS, answers.kind.choice)) out.kind = { choice: answers.kind.choice, confidence: answers.kind.confidence };
  if (sure(answers.stakes) && Number.isFinite(answers.stakes.score)) out.stakes = { level: band(answers.stakes), text: STAKES[band(answers.stakes)], confidence: answers.stakes.confidence };
  const highStakes = !out.stakes || out.stakes.level === STAKES.length - 1;   // unknown stakes: the strict floor
  for (const a of agentsOf(skel)) {
    // A Noul is its own probability — no separate confidence. The editor thresholds it.
    const fx = answers[a.id + FX]?.noul;
    if (p01(fx)) out.fx[a.id] = fx;
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

// null = feature absent (no key) or Jev unreachable; the editor shows nothing either way.
export async function askJev(skel, cacheDir = null) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return null;
  const body = JSON.stringify(requestFor(skel));   // hashed and sent as the same string
  const file = cacheDir && cacheFile(cacheDir, body);
  let answers = file && readCache(file);
  if (!answers) {
    answers = await systemOne(key, body);
    if (!answers) return null;
    if (file) writeCache(cacheDir, file, answers);
  }
  return adviceFrom(answers, skel);
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
