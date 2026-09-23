// Intent and model routing for the graph editor, on Jev (TypeSafe System One).
//
// The cheap decision layer in front of the expensive one: Jev reads the script's SKELETON (name,
// phases, one mission per agent) and answers typed questions — what kind of work the workflow is,
// how much a wrong result costs, and what each agent needs from its model. The tier policy (score
// band → haiku / sonnet / opus) lives HERE in code, not in the model: Jev never sees a model name.
//
// Advice only. It never allows or denies — the gate's promise is "a human approved this exact
// script", and a classifier must not quietly become that human. An answer below MIN_CONFIDENCE is
// dropped rather than shown as a guess. Without TYPESAFE_API_KEY the feature is simply absent.
//
// ponytail: raw fetch, no SDK — the plugin ships from a cache dir with zero dependencies.

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
export const MAX_AGENTS = 40;
const MISSION_CHARS = 1500;

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
  }
  return {
    model: process.env.TYPESAFE_MODEL || 'jev-latest',
    state: { workflow: { name: skel.name || null, description: skel.description || null, phases: skel.phases || [] }, agents },
    questions,
  };
}

// Pure: Jev's answers → what the editor shows. Anything under MIN_CONFIDENCE is silence, not a guess.
export function adviceFrom(answers, skel) {
  const sure = (a) => a && typeof a.confidence === 'number' && a.confidence >= MIN_CONFIDENCE;
  const band = (a) => Math.min(Math.max(Math.round(a.score), 0), LEVELS.length - 1);
  const out = { kind: null, stakes: null, agents: {} };
  if (sure(answers.kind)) out.kind = { choice: answers.kind.choice, confidence: answers.kind.confidence };
  if (sure(answers.stakes)) out.stakes = { level: band(answers.stakes), text: STAKES[band(answers.stakes)], confidence: answers.stakes.confidence };
  for (const a of agentsOf(skel)) {
    const ans = answers[a.id];
    if (!sure(ans)) continue;
    const b = band(ans);
    out.agents[a.id] = { tier: TIER[b], level: LEVELS[b], confidence: ans.confidence };
  }
  return out;
}

// null = feature absent (no key) or Jev unreachable; the editor shows nothing either way.
export async function askJev(skel) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestFor(skel)),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return adviceFrom((await r.json()).answers || {}, skel);
  } catch { return null; }
}
