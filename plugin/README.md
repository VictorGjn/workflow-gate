# workflow-gate

Blocks Claude Code's `Workflow` tool (the multi-agent orchestration tool) until a human has approved the specific script about to run. Before you enable it, read `hooks/workflow-plan-gate.mjs` — it's ~150 lines, plain Node, no dependencies.

**What it does:** any `Workflow` call is blocked with a static estimate (phases, agent count, model-tier mix) until the exact script content has a recorded approval. The intended flow is: blocked → agent enters Plan Mode and proposes the design + alternatives → you approve → agent records the approval → retries → it runs. Any edit to the script (including a plugin version bump) re-triggers the gate — approvals don't carry over across changes.

Also ships the `workflow-orchestration-patterns` skill — guidance for authoring `Workflow` scripts, grounded in Anthropic's own `claude-cookbooks` examples. Includes "Capability-aware phase agents" (an orchestrator names the skills/MCP tools each phase-agent gets, e.g. a Haiku frontend builder loading a project-specific frontend-conventions skill, a Sonnet reviewer loading a design-review skill via the `Skill` tool as its review method) and "Capability escalation" (a worker that hits a real capability gap mid-run reports it via schema instead of self-granting or working around it; an advisor-tier agent auto-allows low-risk requests or stops the run for a human decision on anything destructive, externally visible, or credential-touching).

**SessionStart banner:** a `SessionStart` hook injects a short note into context on every session stating the gate is active, so the agent says so if asked what launching a `Workflow` does — without it, an agent answers from the bare `Workflow` tool's own docs and omits this plugin entirely. The gate itself enforces regardless of what the agent says; this only fixes the agent's unprompted description of it.

**Fail-safe:** the hook fails open on any internal error (never blocks due to its own bug). Kill switch: set `WORKFLOW_GATE_OFF=1`.

**Hook fields:** `hooks.json` uses only fields in Claude Code's documented hook schema — specifically the `command`/`args` exec form (no shell), so the same entry works on every OS without an OS-specific command string. An earlier version used an invented `commandWindows` field, which isn't part of the schema; the plugin-approval UI (used at least by Claude Desktop) rejects unknown hook fields, which silently broke install/persistence there. Node on `PATH` is a hard prerequisite as a result — there's no shell left to skip gracefully if it's missing.

**Honesty about the trust boundary:** `record` is a procedural completion step, not cryptographic proof of human approval — nothing stops an agent (or a user) from running `record` without a real review. It defends against accidental or expensive launches, not an adversarial agent. Treat it accordingly.

## Installing

In Claude Code, add this marketplace with `extraKnownMarketplaces` pointing at this repo (or use the interactive plugin manager):

```json
{
  "extraKnownMarketplaces": {
    "victorgjn": {
      "source": {
        "source": "github",
        "repo": "VictorGjn/workflow-gate"
      }
    }
  },
  "enabledPlugins": {
    "workflow-gate@victorgjn": true
  }
}
```

That's it — no `git clone`, no manual editing of any file beyond these two settings.json keys.

The marketplace catalog manifest (`.claude-plugin/marketplace.json`) lives at this **repo's root**, not inside `plugin/` — Claude Code's marketplace refresh only reliably finds a manifest at the default root location, even when a `source.path` override is declared for a nested one. The plugin itself (`.claude-plugin/plugin.json`, `hooks/`, `skills/`) stays here in `plugin/`; the root manifest's `plugins[0].source` points at `"./plugin"`.

## Updating

Bump `version` in **both** `plugin/.claude-plugin/plugin.json` (the plugin's own manifest) and the matching `plugins[0].version` entry in the root `.claude-plugin/marketplace.json` (the catalog), push. Claude Code re-syncs marketplaces on its own schedule; if you need it sooner, run the plugin/marketplace update command. Note: a version bump changes the hook script's content, which re-triggers the plan-gate for everyone on first use after updating — that's expected, not a bug.
