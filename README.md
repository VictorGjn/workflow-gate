<div align="center">
  <img src="assets/logo.svg" width="120" alt="workflow-gate logo — a striped barrier arm on a hinge">

# workflow-gate

### Approve the exact script before it runs. Then govern what it's allowed to spend and touch while it does.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)
[![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-Plugin-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/VictorGjn/workflow-gate)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=for-the-badge)](https://github.com/VictorGjn/workflow-gate)
[![Runtime: Node](https://img.shields.io/badge/runtime-Node-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://github.com/VictorGjn/workflow-gate)

</div>

---

Claude Code's native `Workflow` tool can fan out into a whole tree of sub-agents — `pipeline()`, `parallel()`, multiple model tiers, worktree isolation — from a single call. That's powerful, and it raises two separate questions before you let it run: *should this launch at all*, and once it's running, *what is each agent inside it actually allowed to spend and touch*.

**`workflow-gate` answers both.** A `PreToolUse` hook blocks the launch until you approve the exact script, content-fingerprinted so an edit-and-rerun can't sneak through on a stale approval. And a bundled skill teaches Claude how to design the workflow itself so cost and access are deliberate, not accidental — which model tier does which job, which skills or MCP tools each agent actually gets, and what happens when an agent hits a capability gap it wasn't granted mid-run.

The gate is the part you notice first. The tiering and capability rules are what actually keep a run from quietly costing more, or touching more, than you meant.

## Why this exists

A multi-agent workflow is the highest-leverage, highest-blast-radius call in Claude Code, and it fails in two different ways that most tooling only half-addresses:

1. **It launches something you didn't fully review.** The built-in confirmation prompt is bypassable by permission mode and doesn't pin approval to the script's actual content — edit the script and rerun, and it sails through on the old approval.
2. **Once it's running, nobody decided what each agent gets.** A cheap-tier agent ends up doing judgment calls it shouldn't. A worker reaches for a tool it was never explicitly granted, or silently works around not having it. Nobody is watching whether the model-tier mix actually matches the task, or whether an agent quietly escalated its own access.

`workflow-gate` closes the first gap with a content-fingerprinted approval. It closes the second with a skill that makes cost and capability decisions explicit *at design time*, plus a runtime protocol for the gaps that only show up once agents are actually running.

## Cost and capability governance

Most approval hooks stop at "should this launch" and have nothing to say about what happens once it does. This is the part that fills that gap.

### Cost control through model-tier selection

The bundled `workflow-orchestration-patterns` skill gives Claude an explicit framework for picking a model per agent, instead of defaulting every call to whatever's convenient:

| Tier | Use for | Never for |
|---|---|---|
| **Cheap** (Haiku) | Small, mechanical, narrowly-scoped units — applying an already-accepted fix, summarizing one item in a fan-out | Deciding accept/reject on its own output |
| **Mid** (Sonnet, default) | Most builds, most reviews, most single `agent()` calls | — |
| **Strong** (Opus) | Large-context synthesis, a hard verification pass, a decision with real consequences | Routine implementation a cheaper tier handles just as well |
| **Advisor** (Opus) | Planning the decomposition, a terse sanity-check before something ships | Bulk execution |

It's not "cheaper model = better" — the skill is explicit that tiering only pays off when it genuinely narrows *scope* per agent, not when a cheaper model name gets swapped onto an identically-sized task. A large share of any agent's cost is context and reading overhead, which a cheap tier pays too.

### Capability-aware phase agents

Skills and MCP tools aren't automatic inside a `Workflow` — an agent only reaches for one if it has access *and* its prompt gives it a reason to. Left implicit, that's unreliable: a Haiku agent told only "build the login form" has no signal a `frontend-conventions` skill even exists.

The skill's fix: **name the capability explicitly, and verify the agent actually has access to it.**

```js
const built = await agent(
  `Load the frontend-conventions skill via the Skill tool, then implement the login form per: ${spec}`,
  { label: 'build:frontend', phase: 'Build', model: 'haiku', agentType: 'general-purpose', schema: BUILD_SCHEMA }
)
```

`agentType: 'general-purpose'` isn't decoration — `Skill`-tool access on a subagent was verified directly (spawned one, had it invoke a real skill, confirmed it loaded), not assumed. The unspecified default toolset for a bare workflow agent isn't documented to include it.

### Capability escalation: an advisor decides, not the worker

The part that's genuinely rare: what happens when an agent discovers **mid-run** that it needs something it wasn't granted. Most setups either let the worker silently reach for it, or the whole workflow just breaks.

`workflow-gate`'s pattern: **the worker reports, an advisor-tier agent judges the request, and only real risk reaches a human.**

```js
// worker reports a gap instead of working around it or silently failing
result = await agent(
  `Load skills from [${grantedSkills.join(', ')}] via the Skill tool. Implement: ${spec}. ` +
  `If you need something outside that list, don't work around it — set capabilityRequest instead.`,
  { model: 'haiku', agentType: 'general-purpose', schema: WORKER_SCHEMA }
)

if (result.capabilityRequest) {
  // an advisor-tier agent judges by consequence, not by whether the request was merely unplanned
  const judged = await agent(
    `Worker requested "${result.capabilityRequest.name}" because: ${result.capabilityRequest.reason}. ` +
    `Destructive, externally visible, or credential-touching → escalate_to_human. Otherwise → auto_allow.`,
    { model: 'opus', schema: ADVISOR_SCHEMA }
  )

  if (judged.decision === 'escalate_to_human') {
    // the Workflow tool can't pause mid-run — stop cleanly with a structured result instead of guessing
    return { status: 'needs_human_decision', request: result.capabilityRequest, rationale: judged.rationale }
  }
  // auto_allow: grant expands, worker retries — capped, so repeated requests still escalate eventually
}
```

Auto-allow retries the worker with the grant expanded, capped at two rounds — hit the cap and it escalates anyway, even if every individual request looked safe in isolation, because *repeated* capability creep in one phase is itself worth a human's attention. This is stated plainly as a **soft, instructional boundary** — a named grant list is an instruction the model could in principle ignore, not a hard security wall. For genuinely untrusted input, the skill points to the harder boundary (a custom `agentType` with a narrower registry-level toolset) instead.

## What you see when the launch gate fires

The launch gate is the visible part. It blocks the `Workflow` tool and hands Claude a summary parsed from the *unexecuted* script text — no agents have run yet. Illustrative example:

```
⛔ workflow-gate — approval required before this Workflow runs

  Script fingerprint : a1b9f4…c7 (SHA-256 of script text + hook version)
  Status             : NOT APPROVED

  Static estimate (parsed from script, nothing executed):
    Phases             : discover → draft → verify → publish
    agent() calls      : 7 call-sites
    Model-tier mix     : 2× opus, 4× sonnet, 1× haiku
    Composition        : pipeline() + parallel() (fan-out in "draft")
    Worktree isolation : yes
    Schema outputs     : 3 typed outputs

  This script has not been approved for this exact content.
  Review the estimate above, then record approval to proceed.
  Any edit to the script changes the fingerprint and re-gates it.
```

Approve it, and it runs. Edit one line and rerun — the fingerprint changes, and the gate fires again. **No stale approvals, ever.**

## How the launch gate works

Honest, mechanical, no magic:

- **By-name `PreToolUse` match.** The hook intercepts the `Workflow` tool's launch call specifically — not every tool, not a broad permission bucket.
- **Content fingerprinting.** Approval is keyed to `SHA-256(script text + hook version)`. Approve script A, and only byte-identical script A runs.
- **Static estimate, zero execution.** The hook reads the script *as text* and reports phase names, `agent()` call-site count, model-tier mix, composition, isolation, and schema usage — nothing is run to produce this.
- **A `SessionStart` hook** announces in-context that the gate is active, so Claude knows the constraint from the first turn, not just when it hits the block.
- **Fails open.** ~150 lines of plain Node, zero dependencies. On any internal error the gate steps aside rather than wedging your session. Kill switch: set `WORKFLOW_GATE_OFF=1`.

## Where it fits

Verified against a real research pass over GitHub code and repos, npm, the official and community Claude Code plugin marketplaces, and the broader agent-framework / cost-governance landscape — nothing else bundles all three of these:

| | Content-pinned launch approval | Model-tier cost guidance | Runtime capability escalation |
|---|:---:|:---:|:---:|
| **workflow-gate** | ✅ SHA-256, re-gates on edit | ✅ explicit tier framework | ✅ advisor-judged, human-escalated |
| Claude Code's built-in prompt | ⚠️ bypassable by permission mode | ❌ | ❌ |
| Nearest third-party hook | ❌ unblocks via automated marker file | ❌ | ❌ |
| Generic agent guardrail plugins | ⚠️ broad Bash/Write blocking, not launch-specific | ❌ | ❌ |

Most tools in this space stop at "should this run." This one also answers "what is it allowed to cost and touch while it does" — which is the harder, less-solved problem.

## Honest limitations

Stated plainly, because this is the part that matters:

> **The approval-recording step is a procedural trust boundary, not cryptographic proof that a human actually reviewed the script.** `workflow-gate` defends against **accidental and expensive launches**, not an adversarial agent that sets out to record its own approval. Likewise, the capability grant list is an **instruction**, not an enforced sandbox — a genuinely untrusted phase needs the harder `agentType`-scoping boundary, not this protocol alone.

What it does do well: make sure a workflow that runs is the exact one you meant, sized and scoped the way you actually decided, not however the model defaulted to.

## Install

Inside Claude Code:

```
/plugin marketplace add VictorGjn/workflow-gate
/plugin install workflow-gate@victorgjn
```

That's it — the `PreToolUse` gate, the `SessionStart` announcement, and the `workflow-orchestration-patterns` skill are active on your next session.

To disable the launch gate temporarily without uninstalling:

```
WORKFLOW_GATE_OFF=1
```

Full technical documentation lives in [`plugin/README.md`](plugin/README.md).

## License

MIT © [VictorGjn](https://github.com/VictorGjn). A personal open-source project — issues and PRs welcome.
