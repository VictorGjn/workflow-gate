# Cookbook notebooks, pattern by pattern

Full citations and reasoning behind each cross-cutting rule in `SKILL.md`. Load this file when you need the source detail for a specific pattern — `SKILL.md` alone is enough for day-to-day decisions.

## The four classic patterns (these map to the Workflow tool)

### 1. Basic workflows — chaining, parallel, routing
**Source:** `patterns/agents/basic_workflows.ipynb`

**What it is.** Three ~15-line functions over one `llm_call(prompt, system_prompt="", model="claude-sonnet-4-6")` helper (`max_tokens=4096`, `temperature=0.1`, returns `.content[0].text`):
- `chain(input, prompts: list[str])` — a `for` loop that string-concatenates each step's raw text output into the next prompt. Worked example: a 4-step data transform (extract metrics → normalize to % → sort → render markdown table).
- `parallel(prompt, inputs, n_workers=3)` — `ThreadPoolExecutor(max_workers=3)` broadcasting one prompt over N independent inputs, blocking gather at the end. Example: 4 stakeholder groups analyzed concurrently with the same prompt.
- `route(input, routes: dict)` — a selector `llm_call` emits `<reasoning>…</reasoning><selection>…</selection>`, a regex (`re.search(f"<{tag}>(.*?)</{tag}>", …)`) pulls the key, a dict lookup dispatches to a specialized prompt. Example: 4-way support-ticket router.

The notebook explicitly disclaims: *"sample implementations meant to demonstrate core concepts — not production code."* No retries, no schema, temperature hardcoded, routing keyed off fragile regex over hand-rolled XML.

**When to use.** Chain when each step's full output is literally the next step's input. Parallel when independent inputs all want the *same* prompt concurrently. Route when inputs fall into a few known categories each deserving a different prompt.

**Maps onto Workflow tool:**
- `chain` → **`pipeline()`** — the canonical "pipeline() by default for multi-stage work."
- `parallel` → **`parallel()`** — and it's the real anchor for the **fixed, named fan-out** rule: the cookbook's own `parallel()` is exactly a hardcoded list of N inputs gathered synchronously, never an open-ended loop.
- `route` → **no distinct primitive.** Express it as an `agent()` whose **schema output** carries a discriminator field (e.g. `{route: "billing"}`), then host-language branching to a second differently-prompted `agent()`. Note the cookbook does the *opposite* of the schema rule — it regex-scrapes a `<selection>` tag, and a single malformed tag breaks the dict lookup with zero handling. Cite this as **the ad-hoc precursor the schema-output rule fixes**, not as evidence the tool already does it right.

This notebook grounds `pipeline()`-by-default, `parallel()`-as-fixed-fan-out, and schema-over-regex. It grounds **none** of the audit-loop machinery — that comes from #2.

### 2. Evaluator–optimizer — generate → evaluate → refine
**Source:** `patterns/agents/evaluator_optimizer.ipynb`

**What it is.** The whole pattern is one control-flow function:
```python
def loop(task, evaluator_prompt, generator_prompt):
    thoughts, result = generate(generator_prompt, task)
    memory = [result]
    while True:
        evaluation, feedback = evaluate(evaluator_prompt, result, task)
        if evaluation == "PASS":
            return result, chain_of_thought
        context = "\n".join(["Previous attempts:", *[f"- {m}" for m in memory], f"\nFeedback: {feedback}"])
        thoughts, result = generate(generator_prompt, task, context)
        memory.append(result)
```
Termination is a single exact-string compare, `evaluation == "PASS"`. The evaluator prompt defines `PASS, NEEDS_IMPROVEMENT, or FAIL`, but the loop only branches on `"PASS"` — **`FAIL` and `NEEDS_IMPROVEMENT` are handled identically**, both just retry. Generator and evaluator are the same `llm_call`, no model split. Worked example: implement an O(1) `MinStack`; the evaluator's first rejection was robustness/style (missing exception handling, type hints, docstrings), not correctness.

**This is the cookbook home of the build → audit → fix → re-audit centerpiece** — but it is a *baseline*, and several rules in `SKILL.md` are **deliberate hardening added on top**, not things the notebook demonstrates. Be honest about which is which:

| Rule | In this notebook? |
|---|---|
| generate → evaluate → refine loop, gated on evaluator's explicit verdict | **Yes** — the core shape |
| Evaluator is a separate call from the generator | **Yes** — evaluator prompt says "you should be evaluating only and not attempting to solve the task" |
| 2-round cap then escalate | **No** — loop is `while True`, unbounded. The cap is a deviation. |
| Converged = zero NEW findings | **No** — one binary PASS gate, no plateau detection |
| Asymmetric authority (accept/reject/re-loop distinct) | **Partial** — only PASS vs not; FAIL≡NEEDS_IMPROVEMENT |
| Schema output by default | **No** — regex-scraped `<thoughts>`/`<evaluation>`/`<feedback>` XML |
| Model-tiering | **No** — same model both roles |
| Prefer mechanical/ground-truth check over a 2nd LLM judge | **No** — evaluator is an LLM in 100% of cases, even for the LeetCode task where a unit test would be strictly better |

**Maps onto Workflow tool:** closest to **`pipeline(generator_agent, evaluator_agent)` wrapped in an outer loop** — not `parallel()` (evaluator needs the generator's output). Concretely: `agent()` build → separate `agent()` reviewer with **its own prompt and no shared scratchpad/history** → schema verdict → host code decides accept/reject/re-loop → `agent()` fix fed the reviewer's findings verbatim → re-audit, **capped at 2 rounds then escalate**.

**Loop-stop rules (hardening, grounded partly here and partly in the Outcomes notebooks #7):**
- Cap at 2 rounds by default, then escalate — but the right number tracks rubric strictness; Anthropic's own default in Outcomes is 3, raised to 5 for a strict rubric, so don't present "2" as a universal Anthropic constant.
- **The iteration cap is a named terminal outcome, not a silent give-up** (Outcomes exposes `max_iterations_reached` as a first-class state).
- Converged = zero NEW findings; require a liveness/evidence proof on any "zero findings" verdict.
- Prefer a mechanical/ground-truth check (test suite, linter, type-checker) over a second LLM-judge pass **where one exists** — this notebook is precisely where that ground truth was *available and not used*, which is why the rule exists.

### 3. Orchestrator–workers — dynamic N-way fan-out
**Source:** `patterns/agents/orchestrator_workers.ipynb`

**What it is.** `FlexibleOrchestrator`, two single-pass phases, no loop-back:
- **Plan:** one `llm_call` asks the model to "break this task down into 2-3 distinct approaches" and return `<tasks><task><type>…</type><description>…</description></task>…</tasks>`. A hand-rolled `parse_tasks()` string-slices the tags (`line[6:-7]`) — brittle, no real XML parser, no schema. **The count and types of subtasks are decided by the model at runtime, not fixed in code.** That runtime dynamism is the whole point.
- **Execute:** a plain `for` loop (NOT async/threaded in the reference impl) does one `llm_call` per parsed task; each worker gets the original task + its own narrow instruction, not other workers' output. Empty `<response>` → substitute a literal error string, no retry.

Cost is stated as "N+1 LLM calls (1 orchestrator + N workers)." Same model for both. **No synthesis step** — the notebook lists "add a synthesis phase" under Next Steps. Worked example: 2–3 marketing-copy variants (formal/technical vs conversational) for an eco water bottle.

**When to use.** When the optimal subtasks genuinely depend on the input and can't be predicted.

**When NOT to use:**
- Simple single-output tasks
- Latency-critical paths
- Subtasks are predictable — use plain pre-defined parallelization (a fixed fan-out) instead

**Maps onto Workflow tool:**
- Planning call → one `agent()` with **schema output** (`{analysis, tasks: [{type, description}]}`). This is a strict improvement over the notebook's regex/line-slice parser — the cookbook's own fragility *is* the justification for schema-by-default.
- Worker dispatch → **`parallel()`** over the task list (turning the notebook's own "Next Step: parallelize with asyncio" into something structural).
- Missing synthesis → a final `agent()` stage: `pipeline(orchestrator, parallel(...workers), synthesis)`.

**The one load-bearing exception this notebook adds:** when a prior agent's structured output *determines the branch count itself*, use a **data-driven fan-out sized from that output**, not a hardcoded N. This is the legitimate carve-out to "prefer a fixed, named fan-out" — reserved for genuinely unbounded discovery spaces. It grounds **none** of the review/audit, tiering, isolation, or HITL claims — those aren't in this notebook.

### 4. Async multi-agent orchestration — peer messaging + non-blocking spawn
**Source:** `patterns/agents/async_multi_agent_orchestration.ipynb`

**What it is.** An explicit mechanics-only demo ("There is no domain task here — just the messaging and subagent mechanics") on raw `asyncio`. Two building blocks: a `Hub` (per-agent `inbox` dict + `asyncio.Event` + `status` in `{active, idling, done, crashed}`) and a generic `run_agent()` (tool-use loop, `max_turns=20`, tools `send_message` + `wait_for_message(timeout=60s)`). The load-bearing line: `results[-1]["content"] += hub.render(inbox)` — incoming peer messages ride along on the next tool result; **agents never poll and only see messages at their next turn boundary.** Part 2 gives a lead agent `create_subagents(≤10)` (returns immediately, non-blocking), `get_status()`, and `kill_subagents()`; the lead spawns 3 helpers sleeping 1/2/3s, checks status, collects reports, and kills stragglers — **all coordination logic lives inside the lead LLM's own tool loop**, not the host.

**Maps onto Workflow tool — mostly does NOT, and this is worth saying plainly:**
- `parallel()` is a **synchronous fan-out/join**: the host blocks until every `agent()` returns, then proceeds with all results. This notebook is the opposite — non-blocking spawn, LLM-driven polling/waiting/killing.
- There is **no `send_message`/peer-inbox analogue**; in the Workflow tool all inter-agent communication is host-mediated (host reads one agent's schema output, builds the next agent's prompt). Agents never message each other directly.
- **What does map:** its fixed 3-helper, single-collection-round shape reinforces the "fixed, named fan-out over open-ended loops" rule — it never demonstrates unbounded spawning either.
- **Genuine gap to flag, not paper over:** `parallel()` has no analogue to `get_status`/`kill_subagents` — no polling in-flight branches, no cancelling stragglers once enough return ("take the first 2 of 3 audits, cancel the third"). If a use case needs early-termination-on-partial-results, that's a capability this cookbook shows and the Workflow tool lacks. Cite this notebook to justify **why `parallel()` should be scoped to barrier-only use**, not as validation of `parallel()` itself.

---

## Managed Agents patterns (grounding principles; mechanisms mostly don't port)

Everything below runs on the hosted Managed Agents beta, not the Workflow tool. Each entry states what principle transfers and what mechanism does not.

### 5. Plan big, execute small — coordinator/worker cost split
**Source:** `managed_agents/CMA_plan_big_execute_small.ipynb`

**What it is.** A cheap **worker** (`claude-sonnet-5`) scoped to just `web_search`/`web_fetch` (every other tool off), and a strong **coordinator** whose only special power is a `multiagent={"type":"coordinator", "agents":[worker.id]}` field — the server then auto-grants it `create_agent`/`send_to_agent`/`wait_for_agents`/`list_agents` and auto-grants the worker `submit_result`/`send_to_parent`. The coordinator's system prompt *is* the planning logic: decompose, delegate in parallel, **always call `wait_for_agents` before drawing any conclusion** (the synchronization barrier), then synthesize. Running example: verify 20 facts (10 US parks × entrance-fee + reservation) each against its own nps.gov page. Measured on the authors' own runs: **~2.5× cheaper, ~3× faster** than a rigor-matched solo frontier agent, 84–98% of tokens billed at the cheap rate — explicitly flagged as *one sample*, "the structure is the stable part."

*(Note: the coordinator's default model in the notebook is a placeholder name unrelated to a shipped Claude model — cite the pattern, not the specific model choice.)*

**What transfers to the Workflow tool:**
- **Model-tiering** — strong model plans + synthesizes, cheap model does the token-heavy reading. This is the real, dollar-quantified grounding for the tiering rule and for "plan-big/execute-small as a single-phase N-way fan-out." Coverage-shaped tasks (document review, log sweeps, codebase sweeps) fit; narrow questions or discovery-style search do not (the split's coordination overhead erases the gap; a run with *no spawns* means you paid a frontier round-trip for nothing).
- `wait_for_agents` = **`parallel()` as a barrier**: don't synthesize until every branch reports. Direct match.
- **Worker tool-scoping as a security boundary** (workers read untrusted web pages, so minimal tool surface caps blast radius) — a genuinely new line, distinct from `isolation:'worktree'` (concurrent writes). Scope a fan-out agent's tools to the minimum when it touches untrusted input.
- **Verify the decomposition, not only each unit.** Their committed run audited all 20 facts correctly but built the *list of 10 parks* from unverified model memory and got it wrong. A fixed named fan-out only checks execution of the units you picked — spend one extra delegated check on the plan itself.
- **Brief granularity has a cost floor** — splitting into more, narrower briefs *raised* their bill. Sharpens "prefer a fixed, named fan-out": finer is not free.

**What does NOT port:**
- The coordinator chooses N dynamically inside its own tool-use loop mid-inference — there's no calling script pre-declaring `parallel(agent(), agent(), …)`. Replicating it means a `pipeline()` stage whose schema output (a task list) sizes a following `parallel()` — an indirect construction, in mild tension with the fixed-N bias.
- Per-thread token metering, SSE event types, and session provisioning are API plumbing with no Workflow analogue.
- This notebook has **no audit/review loop** — don't cite it for the build→audit→fix bullets.

### 6. Gate for human-in-the-loop
**Source:** `managed_agents/CMA_gate_human_in_the_loop.ipynb`

**What it is.** Two custom tools — `decide(receipt_id, action, reason)` and `escalate(receipt_id, question)` — over 12 fixture receipts. The gate mechanism: **any** custom tool call pauses the whole session (`stop_reason.type == "requires_action"`); the caller must POST a `user.custom_tool_result` before it resumes. `decide()` is auto-resolved instantly and just logged; only `escalate()` (near-threshold/ambiguous/suspicious cases) routes to a human stub. So the **branching implements selective review; the pause protocol is uniform.** (Footgun: `stop_reason.event_ids` is a sliding window of only the next 5 pending calls — dedupe with a `responded_to` set or you double-respond and get a 400.)

**What transfers:**
- Classify each work item into a `lane: "decide" | "escalate"` schema field with reason/question; escalate is the minority path; the decide path is still **logged, not silent**. This is exactly the schema-output rule applied to a triage stage.

**What does NOT transfer:**
- The notebook's gate is a mid-turn protocol block; `agent()` calls run start-to-finish and hand back one result — there's no "pause this agent mid-execution and wait for a human" primitive.
- So a Workflow HITL gate is necessarily **coarser**: pause *between two sequential top-level Workflow calls*, with git-commit + handoff as the checkpoint. Default **Advisory (no pause)**, gate only an irreversible external side effect, and prefer doing that action *after* the Workflow returns.

### 7. Verify with an outcome grader
**Sources:** `CMA_verify_with_outcome_grader.ipynb`, `CMA_iterate_fix_failing_tests.ipynb`, `CMA_prompt_versioning_and_rollback.ipynb` (the last two are **mislabeled in the repo** — despite their filenames, both contain the same Outcomes writer/grader example, no failing-test loop and no versioning content; flag this rather than trusting the titles).

**What it is.** A single `user.define_outcome` event carrying `description` (what the writer reads), `rubric` (what the grader reads), and `max_iterations` (default 3, max 20; set to 5 here). After each writer turn the platform spins up a **fresh, stateless grader** — same model/tools, brand-new context window, zero visibility into the writer's reasoning — hands it only the rubric + artifact, and requires a per-criterion verdict before continuing. Terminal states: `{satisfied, max_iterations_reached, failed, interrupted}` (`failed` fires when description and rubric structurally contradict). Worked run: a cited EV-charging brief, 3 grading passes (5/7 → 6/7 → 7/7), where the grader caught an 8-K exhibit masquerading as the required 10-K by actually opening the filing. The rubric decomposes into checkable sub-actions per citation: **LIVE** (re-fetch the URL), **VERBATIM** (exact-string match the quote), **SUPPORTS_CLAIM**.

**This is the strongest cookbook grounding for the independent/blind/adversarial-audit principle** — and it explains *why* the separation is load-bearing:
- **Reviewer isolation is about context, not just filesystem.** The grader gets a fresh context window and cannot be talked out of its verdict by the writer's reasoning. In Workflow terms: the audit-stage `agent()` must **not inherit the builder's transcript/scratchpad**, independent of `isolation:'worktree'` (which is about concurrent writes — a different axis this notebook doesn't touch).
- **Same-context self-grading fails** — a writer with the rubric in its own prompt "will say it passed whenever it believes it did," won't re-fetch a URL, won't notice a misremembered quote. This is the documented reason the reviewer must be a separate call.
- **Anti-rubber-stamp:** "the default failure mode is a grader that approves everything." Force falsifiable, evidence-producing checks per criterion (fetch, string-match, trace) and a no-fire list. This is the real grounding for "require liveness proof on zero findings" and "converged = zero new findings."
- **Terminal-state discipline:** the iteration cap is a named outcome (`max_iterations_reached`), not a silent stop. If every run hits the cap repeating the same finding, the writer can't act on it — rewrite the rubric, don't raise the cap.

**Two refinements this notebook motivates:**
- **Convergence has two valid variants.** A "zero NEW findings" stop (looser — tolerates residual known issues) and Outcomes' `satisfied` (stricter — ALL criteria pass). Use the hard-bar variant when 100%-clean is actually required; the looser variant otherwise.
- **Schema-by-default has a legitimate exception here.** The grader returns a *mandated free-text format* ("Line 1: Coverage N/7. Citations M/K verified." + templated bullets), not JSON — because the consumer is the writer's next LLM turn, not a program branching on fields. Refine the rule: **schema for machine-to-machine handoffs; a tightly-specified TEXT template for a reviewer report another LLM turn will read.**

**What it does NOT support:** model-tiering (grader uses the *same* model as writer — this contradicts, don't cite it for tiering), worktree isolation, fixed fan-out, or `parallel()` (single writer, single grader, sequential, beta feature, results explicitly non-reproducible).

### 8. Iterate against a ground-truth check
**Source:** `managed_agents/CMA_orchestrate_issue_to_pr.ipynb`

**What it is.** **One** agent with full sandbox tools shepherds a slugify-bug fix end-to-end via a mock GitHub CLI, in a cloud env with `pytest` so it runs the **real test suite**. Two scripted recovery points — a non-zero PR-checks result (real pytest failure text) and a review-bot blocking merge on a missing docstring — are **not reviewer agents**; they're tool output the single agent reads and reacts to inline. The loop is open-ended, terminating only because the fixture has exactly two failure points. End state verified by an **independent follow-up turn**, not the agent's own summary.

**What transfers:** the one real lesson is **self-correction via mechanical ground truth** — feed real tool output (failing pytest, a lint/policy check) back to the same actor and let it fix-and-recheck, preferring that ground-truth signal over a second LLM-judge call. This grounds "prefer mechanical/ground-truth checks where one exists" for a **single implementer stage**. Also: **verify end state with an independent check, not the actor's self-report.**

**What does NOT transfer:**
- This is one agent's own tool loop, **not** a multi-agent build→audit→fix example — there's no separate reviewer, no asymmetric authority, no second call of any kind.
- Do not cite it for the reviewer-authority pattern (that's #2/#7).
- No topology to map onto `agent()/pipeline()/parallel()`.

### 9. Coordinate a specialist team
**Source:** `managed_agents/CMA_coordinate_specialist_team.ipynb`

**What it is.** A coordinator + **3 heterogeneous specialists**, each with its own prompt and **scoped toolset**: a researcher (web_search/web_fetch), a case-study picker (file read only, no web), a pricing modeler (rules file only). The coordinator's `multiagent:{type:"coordinator", agents:[…]}` roster is bound at create time; its 4-step prose procedure drives scheduling. The **real observed trace**: the researcher and pricing modeler run **concurrently** (independent), the case-study picker is **deferred** until the researcher reports (data dependency), then the coordinator synthesizes the final proposal. No harness DAG — the dependency ordering emerges from the coordinator's prompt.

**What transfers as a pattern-level lesson:** a heterogeneous multi-specialist task is a **mixed pipeline/parallel DAG keyed off real data dependencies**, not a flat `parallel()` and not a linear `pipeline()`. In Workflow terms: `parallel(researcher, pricing) → case_study_picker(input: researcher_result) → synthesis(input: all three)`. This is the concrete refinement to "pipeline() by default, parallel() only as a barrier" — use `parallel()` for the independent *subset* nested inside an otherwise sequential pipeline. It also grounds **context/tool-scoping**: give each specialist only the tools its role needs (the pricer can't leak a scraped competitor price; a large corpus stays in one subagent and never reaches the coordinator's context) — real grounding for "custom `agentType` only for genuinely specialized lenses" and for scoping context per role.

**What does NOT transfer:**
- No review/audit loop, no accept/reject authority, no convergence
- No model-tiering (all agents share one model; tiering is an unexercised aside)
- No worktree/git scenario (read-only mounts)
- The notebook itself concedes a single agent *could* write the proposal — the split is for safety/context-economy/separation, not capability. Don't cite it for any of those other claims.

### 10. Remember user preferences
**Source:** `managed_agents/CMA_remember_user_preferences.ipynb`

**What it is.** A `memory_store` mounted as a plain directory (no vector search — Claude reads/writes it with ordinary file tools), versioned, up to 8 per session, survives across completely separate sessions. Session two recalls preferences with zero restated context. Backend can seed/list/audit/correct out-of-band.

**Maps onto Workflow tool — it does NOT, and this is worth saying plainly.** This is persistent per-end-user state on a hosted product across days; a Workflow orchestrates ephemeral subagents within one invocation. The one legitimate echo: the **git-commit + handoff checkpoint** between sequential top-level Workflow calls is the architectural analog to a memory store — externalized, inspectable, versioned state that outlives a run and is explicitly re-attached next time. Cite it as reinforcement for "persist state as inspectable artifacts outside the ephemeral run, re-attach explicitly," and for **avoiding nested `workflow()` calls** (prefer sequential top-level calls checkpointed by commit + handoff). Do **not** invent a memory-store Workflow primitive — none exists.

### 11. Explore before acting
**Source:** `managed_agents/CMA_explore_unfamiliar_codebase.ipynb`

**What it is.** A single agent onboarding to a repo with a **deliberately stale architecture doc** (describes an old monolith; code is microservices). System prompt: *"Explore before answering, docs can be stale. Verify what you read against actual code structure. Write notes as you go."*

**What transfers:** a thin but real grounding for one prompting habit — a **recon/grounding stage** (before build/audit/fix) told to explore, verify docs against real code, and report rather than parrot.

**Caveat:** free-text notes are fine for human auditability but an **anti-pattern for feeding a next stage** — route the recon stage's output through **schema output** when it feeds a later `agent()`/decision. Do not cite this notebook for any multi-agent, review, or concurrency mechanics.

### 12. Operate in production
**Source:** `managed_agents/CMA_operate_in_production.ipynb`

**What it is.** Production plumbing for the *hosted* product: MCP toolsets, **vaults** for per-end-user credentials (agent never sees the raw token), webhooks with HMAC verification, and resource lifecycle management. *(Despite any "durability" framing, it contains no retry/backoff, timeout, or observability content.)*

**Maps onto Workflow tool — essentially not.** Different world: long-running multi-tenant sessions vs. one process orchestrating subagents synchronously. Claude Code shells out with the user's ambient credentials — no vault analog. The single loosely-transferable idea is **optimistic-concurrency-checked updates** (a version check rejects stale writes) — a generic concurrency-control analogy, not a substantiation of Workflow's worktree semantics. It's evidence that "concurrent writers need explicit guards" is a real, recurring problem class; it says nothing about how `isolation:'worktree'` itself merges, conflicts, or resolves — those are a different mechanism (filesystem-level isolation, not version-checked writes) that this notebook doesn't touch.
