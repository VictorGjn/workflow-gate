<div align="center">

# workflow-gate

### A human-approval gate for Claude Code's multi-agent Workflow tool — approve the exact script before it spawns a single agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)
[![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-Plugin-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/VictorGjn/workflow-gate)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=for-the-badge)](https://github.com/VictorGjn/workflow-gate)
[![Runtime: Node](https://img.shields.io/badge/runtime-Node-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://github.com/VictorGjn/workflow-gate)

</div>

---

Claude Code's native `Workflow` tool can fan out into a whole tree of sub-agents — `pipeline()`, `parallel()`, multiple model tiers, worktree isolation — from a single call. That's powerful, and it's also the one action in your session most likely to burn real money before you've read what it's about to do.

**`workflow-gate` puts a human in front of that launch.** It's a `PreToolUse` hook that blocks the `Workflow` tool from running until you've approved the **exact** script about to execute — and it shows you a plain-language estimate of the script's shape and cost *before* you decide.

## Why this exists

A multi-agent workflow is the highest-leverage, highest-blast-radius call in Claude Code. Once it starts, agents spawn, models spin up, and tokens are spent — on a script you may have only skimmed. The built-in confirmation prompt is bypassable by permission mode and doesn't pin the approval to the script's actual contents, so an edit-and-rerun sails straight through.

`workflow-gate` closes that gap with one idea: **you approve a specific script, identified by its content, and nothing else runs.**

## What you see when it fires

When the `Workflow` tool tries to launch an un-approved script, the hook blocks it and hands Claude a summary parsed from the *unexecuted* script text — no agents have run yet. Illustrative example:

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

## How it works

Honest, mechanical, no magic:

- **By-name `PreToolUse` match.** The hook intercepts the `Workflow` tool's launch call specifically — not every tool, not a broad permission bucket.
- **Content fingerprinting.** Approval is keyed to `SHA-256(script text + hook version)`. Approve script A, and only byte-identical script A runs. Change the script or bump the hook version, and the approval no longer matches.
- **Static estimate, zero execution.** Before you approve, the hook reads the script *as text* and reports phase names, `agent()` call-site count, model-tier mix, whether it uses `pipeline()` / `parallel()`, worktree isolation, and schema outputs. Nothing is run to produce this — it's parsed from the source.
- **A `SessionStart` hook** announces in-context that the gate is active, so Claude knows the constraint from the first turn.
- **Fails open.** ~150 lines of plain Node, zero dependencies. On any internal error the gate steps aside rather than wedging your session. Kill switch: set `WORKFLOW_GATE_OFF=1`.

### Bundled skill

The plugin also ships a **`workflow-orchestration-patterns`** skill: cost-tiering guidance, capability-aware phase agents (skills / MCP tools), and an advisor-gated escalation protocol for capability requests discovered mid-run — so the workflows you *do* approve are shaped well in the first place.

## Where it fits (and what came closest)

This exact combination didn't exist before — verified against a real research pass over GitHub code and repos, npm, the official and community Claude Code plugin marketplaces, and the broader agent-framework / cost-governance landscape:

| | Content-pinned approval | Re-gates on edit | Static cost/shape estimate | Real human step |
|---|:---:|:---:|:---:|:---:|
| **workflow-gate** | ✅ SHA-256 of script | ✅ any edit re-triggers | ✅ parsed from unexecuted script | ✅ |
| Claude Code's built-in prompt | ❌ | ❌ | ❌ | ⚠️ bypassable by permission mode |
| Nearest third-party hook | ❌ | ❌ | ❌ | ❌ unblocks via automated marker file |

The closest neighbours are materially weaker: the built-in prompt has no fingerprinting and is bypassable by permission mode; the nearest third-party hook "approves" by dropping an automated marker file, not by a person reviewing anything.

## Honest limitations

Stated plainly, because this is the part that matters:

> **The approval-recording step is a procedural trust boundary, not cryptographic proof that a human actually reviewed the script.** `workflow-gate` defends against **accidental and expensive launches** — the fat-finger rerun, the un-read fan-out, the edited script that would otherwise reuse a stale approval. It does **not** defend against an adversarial agent that sets out to record approval on its own. If your threat model includes a hostile agent, this is not your control.

What it does do well: make sure that when a workflow runs, it's the exact one you meant, and you saw its shape first.

## Install

Inside Claude Code:

```
/plugin marketplace add VictorGjn/workflow-gate
/plugin install workflow-gate@victorgjn
```

That's it — the `PreToolUse` gate and the `SessionStart` announcement are active on your next session.

To disable temporarily without uninstalling:

```
WORKFLOW_GATE_OFF=1
```

Full technical documentation lives in [`plugin/README.md`](plugin/README.md).

## License

MIT © [VictorGjn](https://github.com/VictorGjn). A personal open-source project — issues and PRs welcome.
