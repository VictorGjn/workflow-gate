# workflow-gate

Blocks Claude Code's `Workflow` tool (the multi-agent orchestration tool) until a human has approved the specific script about to run. Before you enable it, read `hooks/` — plain Node, no runtime dependencies (the graph editor loads acorn, cytoscape and dagre from public CDNs in the browser).

**What it does:** any `Workflow` call is blocked until the exact script content has a recorded approval. On the blocked call a graph editor opens in your browser and **the hook waits for your click**: Approve lets that very call through (rewritten via `updatedInput` to run the file you approved, edits included), Cancel denies it. Any edit to the script (including a plugin version bump) re-triggers the gate — approvals don't carry over across changes.

**Not at your desk.** The hook waits only while someone is on the page (first mouse move or key press = present). Untouched for 90 s, it denies with the chat path instead: you say "approved" in chat, the agent runs `approve-path` against the file and retries.

**Override, in your own words.** Type **"override manual approval"** in chat at any moment (optionally "for 2h"; default 8 h) and the gate lifts for that session — a `UserPromptSubmit` hook in the plugin reads the prompt itself, so there is no command for the agent to run, forget or refuse. **"restore manual approval"** puts it back. Every Workflow call that passes under an override says so in a systemMessage, and the SessionStart banner repeats it, so a forgotten override is never silent; a chat override is scoped to the session that said it and expires on its own. `node hooks/workflow-plan-gate.mjs override 2h` / `off` is the same thing from a terminal, global to the machine.

**The graph editor.** A small local approval server (detached, loopback-only, single-use nonce in
the URL) serves a **flowchart** of the script, not a lane diagram: `start` → one node per `agent()`
call site → `end`, with a diamond for every `if`/ternary/`&&`/`switch` (yes / no edges, the JS
predicate verbatim), a hexagon for every loop with an amber back-edge, a red edge for a `catch` path,
a `×N` badge where a `parallel()`/`pipeline()` fans out, and helpers inlined where they are called.
Control flow comes from the statement structure, so a script whose agents hand results over through
files — no data edge at all — still reads as a sequence instead of one flat row. A dotted grey edge
means "reuses an earlier result" where the flow does not already say "then". Layout is dagre
(jsdelivr UMD; breadthfirst fallback offline). Each node face carries an icon for what the agent does
(review, test, research, plan, synthesis, ship, build — a keyword heuristic over label then prompt),
its purpose (the first sentence of the prompt as the agent receives it), and model · effort. The
reviewer reads and edits missions and model tiers in the side panel, then clicks Approve — which
writes the edited script and records the approval, exactly as the `record` CLI does. An inline
`script` (the documented default) is first persisted to
`<cwd>/.claude/workflow-gate/gate-<fingerprint>.mjs` (gitignored; tmpdir when cwd is your home), and
the plan that runs is that file, not the agent's draft. **Approve is enabled as soon as the script
parses** — no per-node click requirement. Closing the tab or letting it time out does *not* approve.

Editing is deliberately limited to the declarative skeleton — missions and model tiers. Imperative
control flow is shown but never rewritten, and a computed prompt is marked non-editable rather than
offering a text box that cannot be spliced back. Edits are applied by splicing the original bytes at
AST offsets, so untouched regions are never re-emitted and a no-op edit is byte-identical — which the
content-hash fingerprint requires. Set `WORKFLOW_GATE_NO_UI=1` to disable the editor and keep the text
flow everywhere.

**What the graph says.** The header carries the number being approved — `≥ N agents will run` — as a
static lower bound: a call site under `if`/ternary/`catch`/early-return/helper-function counts 0, a
fan-out over a module-scope literal array counts its length, a runtime fan-out counts 1. Checked
against every recorded run on the author's machine (`hooks/test/extract-v2-test.mjs`): the bound never
exceeds the real count. Edges are typed, never a phase cross-product: solid = a prior result is
interpolated into this prompt, dashed = the target sits under a JS condition, whose predicate is drawn
verbatim; a faint lane→lane edge means "order only, nothing passed". The panel shows model and effort
(editable only where a literal exists — otherwise "inherited" or "decided at runtime", never a
fabricated default), the assembled prompt with every `⟨interpolation⟩` as a chip that opens its
producer, what each chip resolves to (upstream result — flagged when it may contain `null` — shared
constant, per-item value, or runtime), isolation, schema keys, agentType, and the sentence that
matters: without `agentType` the agent reaches every MCP tool connected to the session, writes included.

**During a run.** *Approve & run* no longer ends the page. The tab that approved the plan keeps the
same graph and paints the run onto it as it happens: per-node state, `k/N done` against the declared
fan-out, the last tool each agent called, elapsed time, and a header comparing what has launched so
far against `approved ≥ N`. Live events carry no label and no phase — only hashed keys, and the
record that has labels is written at completion — so an agent is placed by searching its prompt for
the literal chunks of each call site, wherever those hide in the source: a template literal, an `a`
+ `b` concatenation, a helper that returns one. The search runs in the server, once per agent,
because prompts reach 190 000 characters and the deciding chunk has been found 26 000 in — no prefix
small enough to ship every poll is big enough to match on. Two call sites can be indistinguishable —
the same helper called twice — and that is reported as a tie, not resolved by luck. Scored against
the 196 recorded agents on the author's machine whose label is known
(`hooks/test/live-view-test.mjs`): 195 land on the right call site. Whatever has no literal to match
on, or a literal shared by two sites, is placed by arrival order and *says so* in the panel — a
guess may be wrong, it must never look like a fact. No Stop button: stopping a workflow is Claude
Code's to do, and `/workflows` in the terminal remains the way to do it. When the run record lands
the page switches over to it, for the exact labels and token counts. The approval itself is
unchanged and still single-use — from the moment Approve is pressed every POST answers 409, the
server serves four read-only routes and nothing else, and it exits a minute after the run record
appears or five minutes after the last poll, whichever comes first.

**After a run.** If this exact script has already run, a *Show last run* button paints Claude Code's
own run record onto the same graph: per-node state, `k/N done` on fan-outs, skipped conditionals
faded, and the header compares `approved ≥ N` with the number that actually launched.

**Intent and model routing (Jev, optional).** With `TYPESAFE_API_KEY` in the environment Claude Code
runs in (shell export, or `env` in `settings.json`), the editor asks [Jev](https://docs.typesafe.ai/patterns/intent-routing)
— TypeSafe's System One model — three typed questions in one call: what kind of work the workflow
is, how costly a wrong result would be, and, per agent, what its mission needs from a model
(mechanical / judgment / synthesis). The header shows the first two; selecting an agent shows the
suggested tier next to its `model` with an **apply** button that splices it into the script like any
other edit. The tier policy (score band → `haiku` / `sonnet` / `opus`) is in `hooks/advise.mjs`, not
in the model, and any answer under 0.5 confidence is dropped rather than shown. **Advice only:** it
never approves or denies anything; the human still does. **Egress:** the skeleton the page extracted
— workflow name, phases, one mission per agent (≤ 1500 chars each), never the whole file — is sent
to `api.typesafe.ai` from the local server (the key never reaches the browser); the header says so
whenever it happened. No key, no call, nothing shown.

## History, cost, and what you thought of it

`node hooks/workflow-plan-gate.mjs history` opens a **persistent, read-only viewer** listing every
workflow run this machine has — across every project and session, finished and still running — with
what each one actually cost and room to say how it went. It is a separate daemon from the gate on
purpose: the gate's whole job is to not fail open, and it must not share a process with a cost cache
that walks 200 MB of transcripts. **The viewer cannot approve anything** — no `/approve` route, no
fingerprint writing; the only thing it writes is your own notes.

**Cost is measured, not estimated.** The run record's `tokens` is the agent's *final context size*,
not spend: summed over the 21 runs recorded on the author's machine it reads 41 M tokens where 3.37
**billion** were actually billed — 81x more, because almost all of it is cache reads the record never
mentions. So costing reads `message.usage` out of each transcript and prices input, cache write
(1.25x input), cache read (0.1x input, or a published rate where one exists) and output separately.
Completed runs are costed once and cached under the price table's date, so a price change re-costs
instead of silently re-baselining. Those are **Anthropic first-party API rates — on a subscription
this is the API-equivalent cost of the run, not your bill.**

**There is deliberately no pre-run estimate.** It was measured and it does not hold: across those 21
runs, dollars-per-*declared*-agent — the only quantity the gate knows before launching — spreads
**184x** (one script declares 1 agent and launches 61). The least-bad predictor, dollars per model
turn, still spreads 11.6x, and turn count is not knowable in advance. No script has ever been run
twice, so there is no per-script prior either. What replaces it is exact rather than predicted: the
live view shows the bill climbing during the run, next to the distribution of past runs (median,
p75, max), so "already $180 at twenty minutes" arrives while you can still act on it.

The gate's footer carries a **History & cost** link whenever the viewer is running, so the two
reach each other; they stay separate pages on separate ports, which is what keeps a cost cache out
of the process whose job is to not fail open.

**Notes are keyed on the label, not the agent id.** An agent id is a random hex string that means
nothing six weeks later and differs on every re-run; a label names the call site, which is the prompt
you would actually go and fix. Each run gets a verdict (worked / mixed / failed) and free text, and
so does each label within it.

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

## Tests

`node hooks/test/<name>-test.mjs`. The extractor tests need `acorn` (`npm i --no-save acorn` in `hooks/test/`, gitignored). `live-view-test` and `extract-v2-test` score against the Workflow runs recorded on the machine they run on, so their numbers are machine-specific.

## Updating

Bump `version` in **both** `plugin/.claude-plugin/plugin.json` (the plugin's own manifest) and the matching `plugins[0].version` entry in the root `.claude-plugin/marketplace.json` (the catalog), push. Claude Code re-syncs marketplaces on its own schedule; if you need it sooner, run the plugin/marketplace update command. Note: a version bump changes the hook script's content, which re-triggers the plan-gate for everyone on first use after updating — that's expected, not a bug.
