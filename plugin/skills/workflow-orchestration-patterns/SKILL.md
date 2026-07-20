---
name: workflow-orchestration-patterns
description: "Grounds decisions about Claude Code's Workflow tool (agent()/pipeline()/parallel()) in specific Anthropic claude-cookbooks notebooks — see references/notebooks.md for full citations. Use when writing or reviewing a Workflow script, deciding pipeline vs parallel, picking a model tier for cost control, choosing a verification pattern, or judging whether a task justifies a workflow at all. Do NOT use for general agent-architecture selection (use agent-patterns) or generic task delegation without the Workflow tool (use coordinator-pattern)."
requiredApps: []
---

# Workflow Orchestration Patterns

Guidance for when and how to reach for Claude Code's Workflow tool (`agent()` / `pipeline()` / `parallel()`, schema outputs, `isolation`, custom `agentType`). Every rule below traces to a specific Anthropic claude-cookbooks notebook — full per-notebook detail, worked examples, and what does/doesn't transfer lives in `references/notebooks.md`; read that when you need the source reasoning behind a rule, not for routine use.

## Read this first: two different substrates

The cookbook material splits into two families, and conflating them is the main way this skill goes wrong:

1. **`patterns/agents/` notebooks** — plain Python over the Messages API, ~15-line functions, no framework. These are the direct ancestors of the Workflow-tool primitives (chaining → `pipeline()`, parallel → `parallel()`, evaluator loop → `pipeline()` wrapped in a loop). **Map cleanly.**
2. **`managed_agents/` (CMA) notebooks** — Anthropic's separate hosted **Managed Agents** beta (stateful cloud sessions, event streams, `multiagent` coordinator fields, `define_outcome` loops, memory stores, vaults, webhooks). This is a **different product** from Claude Code's Workflow tool — its mechanisms (mid-turn session pause, server-driven grade/revise loops, per-thread token metering) have **no analogue** in `agent()/pipeline()/parallel()`. What transfers is the *design principle*, and where it doesn't, say so plainly instead of forcing an analogy.

**When to reach for a Workflow at all:** as a default heuristic, look for 3+ genuinely independent angles, or a need for a fresh/unbiased second opinion — a single linear task is usually a single `agent()` call or no Workflow at all. That's not a strict eligibility gate, though: a justified 2-stage chain (build → independent review), an evaluator-optimizer loop, a triage-then-escalate gate, or a single verification pass can all be a Workflow on their own merits even without 3 distinct angles — see the patterns below.

## Cross-cutting rules

- **`pipeline()` by default; `parallel()` only as a deliberate barrier** when a later stage needs ALL prior results at once. (`references/notebooks.md` #1, #5, #9)
- **Schema output by default** on any `agent()` result that feeds another agent/decision; free text only for final human-facing synthesis — **except** a reviewer report consumed by another LLM turn, where a tightly-specified text template is better. (#3, #7)
- **Build → independent/blind/adversarial audit → fix → re-audit**, reviewer with asymmetric accept/reject/re-loop authority. The reviewer must not inherit the builder's transcript/scratchpad — isolation here is about *context*, not just concurrent writes. (#2, #7)
- **Loop-stop rules:** 2-round cap then escalate (deliberate hardening — the source pattern's own default is unbounded, Anthropic's own comparable default is 3); the cap is a **named terminal state**, not a silent stop; converged = zero NEW findings (or the stricter "all criteria pass" bar when required); require liveness/evidence proof on "zero findings"; prefer a mechanical/ground-truth check over a second LLM-judge pass where one exists. (#2, #7, #8)
- **Model-tiering** — strong model plans/reviews, cheap model executes, strong model does the final blind verify. Grounded by real ~2.5×/~3× cost/speed numbers on a single-phase N-way fan-out; not grounded where the source notebooks use one model throughout (#7, #9). See "Cost management" below for the size/role breakdown. (#5)
- **Verify the plan's decomposition, not only each unit's execution** — a fixed fan-out only checks execution of the units picked; spend one extra check on whether the picked units were right. (#5)
- **Scope a fan-out/specialist agent's tools to the minimum**, especially when it touches untrusted input — a security boundary, distinct from worktree isolation. (#5, #9) A **custom `agentType` with a narrower registry-level toolset** is the hard version of this boundary; naming a capability list in a prompt (see "Capability-aware phase agents" below) is a softer, instructional one — don't confuse the two for genuinely untrusted input.
- **`isolation:'worktree'` only when multiple agents write the same repo concurrently.** (thin precedent in #12; no notebook demonstrates worktrees directly)
- **Custom `agentType` only for genuinely specialized lenses** (security, over-engineering, domain-specific personas), not as a default for ordinary build/research agents. (#9) A phase-agent that needs to invoke a `Skill` or a specific MCP tool (see "Capability-aware phase agents" below) is a separate, tool-access reason to set `agentType` explicitly — not a stylistic one, and not in tension with this rule.
- **Fixed, named fan-out by default; data-driven fan-out only for genuinely unbounded discovery**, where a prior agent's structured output determines the branch count itself. (#1, #3, #4, #5 — brief-granularity has a real cost floor, finer is not free)
- **Avoid nested `workflow()` calls** — prefer sequential top-level calls with git-commit + handoff as the checkpoint between them. (#10)
- **HITL: default Advisory (no pause); gate only an irreversible external side effect** (push, deploy, message send, paid-API write), and prefer doing that action *after* the Workflow returns. A Workflow gate is necessarily coarser than a mid-turn pause — it sits between two top-level calls, not inside one. (#6) This is about gating specific *actions a workflow's script takes* — a separate concern from a plugin-level pre-execution approval gate on the Workflow tool itself (if one is installed), which applies to every launch regardless of what the script does internally.
- **`parallel()` is barrier-only** — no polling or cancelling in-flight branches once enough have returned. Named limitation, not an oversight to "fix." (#4)

## Cost management: picking a model tier

Match model strength to task size and role — reserve the strongest models for judgment, not volume:

- **Cheap tier (e.g. Haiku)** — small, mechanical, narrowly-scoped units: implementing a change a stronger model already specified, applying an already-accepted fix, gathering/summarizing one item in a fan-out. Never let a cheap-tier agent decide accept/reject on its own output — that call belongs to whatever model specified or will review the work.
- **Mid tier (e.g. Sonnet, usually the default)** — most builds, most reviews, most calls to a single `agent()`. Omit `model` entirely unless a specific reason argues for a change; the default is correct for most calls in a workflow.
- **Strong tier (e.g. Opus)** — large-context synthesis, a hard verification pass, or a decision with real consequences: reviewing across many findings at once, a final blind audit before something ships, planning a decomposition many cheaper agents will execute against.
- **Advisor/orchestrator tier** — reserve a top-tier model for **orchestration and critique, not bulk execution**: planning the decomposition up front, or a short sanity-check pass on a synthesis before it's acted on. Its value is catching what a narrower or more literal model would miss or over-build — not doing the work itself. Keep its output terse; it's a check, not a rewrite.

**What actually earns tiering, and what doesn't:**
- Tiering pays off when it genuinely narrows *scope* per agent (each one reads/produces less) — not merely when a cheaper model name is swapped onto an identically-sized task. A large share of any agent's cost is context/reading overhead, which a cheaper model pays too. The plan-big/execute-small notebook's own 2.5×/3× number (#5) held because each worker's *job* was narrower, not because the cheap tier is intrinsically cheaper at the same job.
- The largest, most mechanically-similar fan-outs are where tiering the executor down pays for itself repeatedly; a 2-3-agent task rarely needs it.
- A fresh review agent is cheap relative to a bad rework round, and using a cheap tier to implement makes that review **more** necessary, not less — cheap-tier implementation should tighten the audit loop, never replace it.
- Don't default to the advisor/orchestrator tier for first drafts. Its return is highest on synthesis and critique; using it for routine implementation pays top-tier prices for work a cheaper tier does just as well.

## Capability-aware phase agents

Neither project skills nor MCP tools are automatic inside a `Workflow` — a phase-agent only reaches for one if (a) it has access and (b) its prompt gives it a reason to. Left implicit, domain-matching is unreliable: a Haiku agent told only "build the login form" has no signal that a `frontend-design` skill exists, let alone that it should load it. This is a Claude-Code-specific extension with no cookbook precedent (unlike the rest of this file).

- **Skills needed proof of tool access; MCP tools don't.** `Skill` tool access on a subagent was verified directly (spawned one, had it invoke a real skill, confirmed it loaded), not assumed. MCP tools are simpler: the Workflow tool's own docs already state agents can reach any session-connected MCP tool via `ToolSearch`, no separate verification needed. Either way, name the specific skill or MCP tool explicitly in the prompt rather than leaving discovery implicit.
- **Name the capability explicitly in the prompt.** Don't rely on implicit domain-matching. Open the `agent()` prompt with a direct instruction: `Load the <skill-name> skill via the Skill tool, then...` or `Use the <mcp-tool-name> MCP tool to...`. This also makes the choice visible to whoever reviews the script at plan-gate time — an unnamed, hoped-for capability is invisible to review; a named one isn't.
- **Set `agentType` to a type confirmed to include the tool you're naming** (e.g. `'general-purpose'`, which has full tool access) whenever a phase-agent needs to invoke a `Skill`. The unspecified default workflow subagent's toolset is not documented to include it — don't assume it silently does; either verify it or pin `agentType`.
- **Match the capability to the phase's actual job, not its model tier.** Cheap-tier (Haiku) execution agents doing narrowly-scoped domain work benefit from loading the matching *convention* skill (a frontend-conventions skill, a backend-patterns skill, ...) so their output follows house conventions without the orchestrator spelling out every rule inline — this is exactly the kind of narrow, mechanical task cheap-tier execution is suited for (see "Cost management" above). A Sonnet/Opus-tier reviewer whose job includes design/UX/accessibility quality should be told to run the matching *audit* skill (a design-review skill, an accessibility-compliance skill, a UI-quality skill, ...) as its actual review method, not just "review this and use your judgment."
- **One audit lens per agent, not a capability pile-up.** If a review genuinely needs multiple angles (design system fit *and* accessibility *and* generic AI-tell cleanup), that's the existing "Perspective-diverse verify" pattern — `parallel()` one agent per lens, each loading its own skill — not one agent instructed to load three skills (or three MCP tools) in sequence. Stacking blurs which one drove which finding and burns context on guidance that may partially conflict.
- **Pick the narrowest-matching skill, not the broadest.** A full brand→tokens→layout→a11y design pipeline and a broad multi-stack UI/UX skill can overlap significantly with a compliance-only accessibility skill. Read each skill's own description before picking — loading the broadest available skill by default costs more context and gives a less targeted review than the one whose description actually matches the phase's job.

The examples below use illustrative skill names (`frontend-design`, a `dembrandt`-style design-review skill) — swap in whatever your own project's skills are actually called; the pattern is what matters, not these specific names.

```js
// Haiku build agent gets a convention skill for its domain, explicitly.
// schema is required here — without one, agent() returns plain text, and
// built.path below would be undefined.
const built = await agent(
  `Load the frontend-design skill via the Skill tool, then implement the login form component per: ${spec}`,
  { label: 'build:frontend', phase: 'Build', model: 'haiku', agentType: 'general-purpose', schema: BUILD_SCHEMA }
)
// Sonnet reviewer gets an audit skill as its review method, not freeform judgment
const review = await agent(
  `Load the dembrandt skill via the Skill tool and run its Forward pipeline as a design review over the component built at ${built.path}. Report pass/fail per dimension.`,
  { label: 'review:ui', phase: 'Review', model: 'sonnet', agentType: 'general-purpose', schema: REVIEW_SCHEMA }
)
```

## Capability escalation: advisor-gated requests

Static allocation (above) covers what the orchestrator anticipates. It won't cover everything a worker discovers it needs mid-task — and a worker shouldn't unilaterally reach for something it wasn't granted, silently work around the gap, or silently fail. The protocol: **workers report, an advisor-tier agent judges, and only genuine risk reaches the human** — mid-run, at the scope of one request, not the whole script.

**A named grant list is a soft boundary, not a hard one.** `agentType:'general-purpose'` grants the `Skill` tool broadly — telling a worker "only use X" is an instruction it could in principle ignore, the same as any other prompt instruction. For genuinely untrusted input, use the hard boundary from the cross-cutting rules above (a custom `agentType` with a narrower registry-level toolset), not this protocol. This protocol is the mitigation for the common case: a well-behaved cheap-tier worker that hits a real, legitimate gap.

The protocol itself is a fixed sequence:

1. **Worker reports, it doesn't request-and-wait.** Its schema output includes an optional `capabilityRequest: {kind, name, reason}` field alongside its normal result (`kind` distinguishes a skill request from an MCP-tool request). Its prompt says explicitly: *"If you need a tool or skill outside your granted list, don't attempt a workaround — stop and report what you need and why."*
2. **Host-side script checks that field** — plain JS branching, not another agent call, so there's no round-trip cost until something's actually requested.
3. **An advisor-tier `agent()` judges by consequence, not novelty**, whenever a request is present. A capability being *unplanned* isn't itself a reason to escalate. Reserve escalation for what already warrants care: destructive/hard-to-reverse actions (write or delete on shared state, deploys), actions visible outside the session (posting, pushing, sending messages), or anything touching credentials/secrets — the same categories, not a new taxonomy. It returns `{decision: 'auto_allow' | 'escalate_to_human', rationale}` against that list (see "Cost management" above — this is exactly the advisor tier's use case). The advisor is judging the worker's **self-reported** `reason`, not an independently verified one — a worker processing untrusted content could have that content shape the stated reason into something that reads as low-risk. That's a sharper version of the "soft boundary" caveat above, not a separate one: for a phase whose input is genuinely untrusted, this protocol still isn't a substitute for the hard `agentType`-scoping boundary.
4. **`auto_allow` distinguishes skill requests from MCP tool requests** — they aren't interchangeable. `kind:'skill'` extends the `Skill`-tool grant list; `kind:'mcp'` extends a separate MCP-tool grant list with its own instruction (`Use the <tool> MCP tool via ToolSearch`, not `Load the <skill> skill`). The script retries the same worker with the grant added, capped at 2 rounds (reusing "Loop-stop rules"). If the cap is hit with a request still outstanding, escalate anyway — even if every individual grant so far was itself auto-allowed; repeated capability creep in one phase is worth a human's attention regardless of whether any single grant looked risky, and the cap is a named terminal state, not a free pass once it's reached.
5. **`escalate_to_human` cannot pause mid-run — the Workflow tool can't do that.** (See the HITL cross-cutting rule: gating sits between two top-level calls, not inside one.) The script returns a structured `{status: 'needs_human_decision', request, rationale}` result and stops cleanly instead of guessing. The calling agent surfaces it in chat; a follow-up top-level call — optionally with `resumeFromRunId`, so already-completed work replays from cache — continues once the human decides.

This complements, not duplicates, a plugin-level plan-gate (if one is installed on the `Workflow` tool itself): a plan-gate approves the whole script's shape and cost *before* anything runs; this protocol handles capability creep discovered only *after* workers are already running. Different granularity, same underlying principle — a human decides on real risk, not the model.

```js
const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    capabilityRequest: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['skill', 'mcp'] },
        name: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['kind', 'name', 'reason'],
    },
  },
  required: ['path'],
}
const ADVISOR_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['auto_allow', 'escalate_to_human'] },
    rationale: { type: 'string' },
  },
  required: ['decision', 'rationale'],
}

const grantedSkills = ['frontend-design'] // capabilities this worker was explicitly given
const grantedMcpTools = []

let result, round = 0
do {
  result = await agent(
    `Load skills from [${grantedSkills.join(', ')}] via the Skill tool, and use only these MCP tools if ` +
    `needed: [${grantedMcpTools.join(', ') || 'none granted'}]. Implement: ${spec}. If you need a tool or ` +
    `skill outside those lists, don't work around it — set capabilityRequest instead.`,
    { label: 'build:frontend', phase: 'Build', model: 'haiku', agentType: 'general-purpose', schema: WORKER_SCHEMA }
  )
  if (!result.capabilityRequest) break

  const judged = await agent(
    `A Haiku worker requested the ${result.capabilityRequest.kind} "${result.capabilityRequest.name}" because: ` +
    `${result.capabilityRequest.reason}. Judge by consequence: destructive/hard-to-reverse, visible outside ` +
    `this session, or touches credentials/secrets → escalate_to_human. Otherwise → auto_allow.`,
    { label: 'advisor:capability-judge', phase: 'Build', model: 'opus', schema: ADVISOR_SCHEMA }
  )
  if (judged.decision === 'escalate_to_human') {
    return { status: 'needs_human_decision', request: result.capabilityRequest, rationale: judged.rationale }
  }
  const grantList = result.capabilityRequest.kind === 'skill' ? grantedSkills : grantedMcpTools
  grantList.push(result.capabilityRequest.name) // auto_allow: expand the grant, retry
} while (++round < 2)

// Cap hit with a request still outstanding: escalate even though every individual grant so far was
// itself auto-allowed. Named terminal state per "Loop-stop rules" above, not a silent stop.
if (result.capabilityRequest) {
  return {
    status: 'needs_human_decision',
    request: result.capabilityRequest,
    rationale: '2-round cap hit — capability requests kept recurring',
  }
}
```

## Worked examples

Two of the most-used patterns from the rules above, shown as code — everything else in this skill until now was named in prose or the table but never demonstrated running.

**Two-stage pipeline, no barrier** — the reviewer for item 1 starts as soon as item 1's build finishes, while item 2 is still building (the "`pipeline()` by default" rule):

```js
const results = await pipeline(
  components,
  c => agent(`Implement ${c.name} per: ${c.spec}`, { label: `build:${c.name}`, phase: 'Build', model: 'haiku' }),
  built => agent(
    `Blind review of the build at ${built.path} against ${built.spec} — no access to the builder's reasoning.`,
    { label: `review:${built.name}`, phase: 'Review', schema: REVIEW_SCHEMA }
  )
)
```

**Evaluator-optimizer loop with the 2-round cap** the "Loop-stop rules" bullet requires — the cap is a named terminal state, not a silent stop:

```js
let round = 0, verdict, draft = await agent(`Draft: ${brief}`, { phase: 'Draft' })
do {
  verdict = await agent(`Blind review against: ${criteria}. Draft: ${draft}`, { phase: 'Review', schema: VERDICT_SCHEMA })
  if (verdict.pass || ++round >= 2) break
  draft = await agent(`Revise per: ${verdict.findings}. Original: ${draft}`, { phase: 'Draft' })
} while (true)
if (!verdict.pass) log(`2-round cap hit, unresolved: ${verdict.findings}`)
```

See "Capability-aware phase agents" and "Capability escalation" above for the build/review pair with explicit skill-loading and the advisor-gated request protocol — the build/review pair is reused in full in "Output" below.

## Quick reference: situation → cookbook pattern → Workflow construct

| Situation | Cookbook pattern | Concrete Workflow-tool construct |
|---|---|---|
| Multi-stage transform, each step feeds the next | Chaining (#1) | `pipeline(stage1, stage2, …)` |
| Same prompt over N independent, known inputs | Parallel (#1) | `parallel(agent×N)`, fixed named fan-out |
| Classify then dispatch to specialized handling | Routing (#1) | `agent()` with schema `{route}` → host branch → 2nd `agent()` |
| Produce → critique → refine until it passes | Evaluator-optimizer (#2) | `pipeline(builder, reviewer)` in a loop, 2-round cap, blind reviewer `agent()` |
| Rigorous blind audit against checkable criteria | Verify with an outcome grader (#7) | reviewer `agent()` with **no shared context**, schema/text verdict, terminal-state cap |
| Fix against a real test/lint/type signal | Iterate against a ground-truth check (#8) | single implementer `agent()` re-fed mechanical output; independent verify turn |
| Subtasks unknown until a planner decides them | Orchestrator-workers (#3) | `agent()` planner (schema) → data-sized `parallel()` → synthesis `agent()` |
| Coverage task: lots of mandatory reading, cheap can absorb it | Plan big, execute small (#5) | strong planner `agent()` → `parallel()` cheap workers → strong synthesis; tool-scope workers; `parallel()`=barrier |
| Different kinds of expertise + a data dependency | Coordinate a specialist team (#9) | mixed DAG: `parallel(independent) → dependent agent → synthesis`; scope tools per role |
| Human review of a minority of ambiguous items | Gate for human-in-the-loop (#6) | `agent()` triage → schema `{lane: decide\|escalate}`; **human between two top-level Workflow calls**, not mid-agent |
| Recon before building | Explore before acting (#11) | recon `agent()` told to verify docs vs. code; **schema** output to next stage |
| Carry state across separate runs | Remember user preferences (#10) | no primitive — git-commit + handoff checkpoint between sequential top-level calls |
| Peer-to-peer async agents / cancel stragglers | Async multi-agent orchestration (#4) | **not supported** — `parallel()` is barrier-only; named gap |
| Multi-tenant creds / webhooks / MCP in production | Operate in production (#12) | **not applicable** to Claude Code (hosted-product plumbing) |
| Need a top-tier sanity check before acting on a synthesis | Plan big, execute small (#5) tiering principle | Advisor-tier `agent()`, terse critique, not a rewrite — final pass, not a first draft |
| Phase's work matches an existing skill's conventions/audit method, or needs a specific MCP tool | (no cookbook precedent — Claude Code-specific) | `agent()` prompt names the capability explicitly (`Load the <skill> skill via the Skill tool...`); `agentType:'general-purpose'` (or another type confirmed to include `Skill`) for skills — see "Capability-aware phase agents" above |
| Worker hits a real capability gap mid-run; must not self-grant or silently work around it | (no cookbook precedent — Claude Code-specific) | worker reports via schema `{capabilityRequest}` → advisor-tier `agent()` judges by consequence → `auto_allow` retries in-place (2-round cap) or `escalate_to_human` returns and stops — see "Capability escalation" above |

Numbers in parentheses refer to the matching section in `references/notebooks.md`.

## Output

What correctly applying this skill produces: a `Workflow` script with a real `meta` header, phasing, model-tiering, a pipeline (not a barrier), and — per "Capability-aware phase agents" — explicit skill-loading with `agentType` pinned for tool access. This is the same build/review pair shown as fragments above, assembled into the complete, submittable script:

```js
export const meta = {
  name: 'frontend-component-with-review',
  description: 'Build a component, then review it against the design system',
  phases: [{ title: 'Build' }, { title: 'Review' }],
}

const BUILD_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: { pass: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } },
  required: ['pass', 'findings'],
}

const built = await agent(
  `Load the frontend-design skill via the Skill tool, then implement the login form component per: ${spec}. Return the file path you wrote to.`,
  { label: 'build:frontend', phase: 'Build', model: 'haiku', agentType: 'general-purpose', schema: BUILD_SCHEMA }
)
const review = await agent(
  `Load the dembrandt skill via the Skill tool and run its Forward pipeline as a design review over the component built at ${built.path}. Report pass/fail per dimension.`,
  { label: 'review:ui', phase: 'Review', model: 'sonnet', agentType: 'general-purpose', schema: REVIEW_SCHEMA }
)
return { built, review }
```

This is what a human reviews at plan-gate time: the phasing, the model choice per phase, and — because the skill names are written into the prompts rather than left implicit — which project conventions and audit method each agent is actually going to apply.
