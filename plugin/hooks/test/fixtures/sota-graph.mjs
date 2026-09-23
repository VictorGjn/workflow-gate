export const meta = {
  name: 'sota-agent-graph-editor',
  description: 'Bring the workflow-gate graph editor to the state of the art in graph engineering',
  phases: [{ title: 'Survey' }, { title: 'Critique' }, { title: 'Spec' }],
}

const OUT = 'C:/Users/victo/AppData/Local/Temp/claude/C--Users-victo/e27825b4-d84f-46ea-aa2d-4bb09ec35dd7/scratchpad/sota'
const EDITOR = 'C:/Users/victo/Repos/syroco-product-ops/claude-plugins/hooks/graph-editor.html'

// Ground truth, verified against the Workflow authoring reference. Agents must design against THIS,
// not against an imagined API — a panel showing fields that do not exist is worse than none.
const API = `
GROUND TRUTH — the real agent() signature in Claude Code's Workflow tool:
  agent(prompt: string, opts?: {
    label?, phase?, schema?, model?, effort?, isolation?: 'worktree', agentType?
  })
- prompt is the FIRST ARGUMENT, a string (often a template literal interpolating shared context).
- There is NO 'tools' option and NO 'context' option. Tools come from agentType (a named subagent
  whose definition carries a tool list) or are discovered at runtime via ToolSearch. "Context" is
  whatever the prompt string interpolates: shared constants, and prior agents' return values.
- schema is a JSON Schema forcing structured output — a real, displayable per-agent contract.
- effort is 'low'|'medium'|'high'|'xhigh'|'max'.
- Composition: parallel(thunks) is a barrier; pipeline(items, ...stages) has no barrier;
  phase(title) groups agents. Control flow is plain JS — if/ternary/while/.filter — so a
  "conditional edge" is an agent() call sitting inside a JS condition, not a declared guard.
- Data flow is real: an agent's return value is passed into a later agent's prompt.
`

const CONTEXT = `${API}
WHAT WE HAVE TODAY (the thing being upgraded): a single self-contained HTML page, served by a local
approval server, that renders the agent DAG a human must approve before the workflow runs. Current
state: cytoscape + built-in breadthfirst layout; phases as compound parent nodes; one node per
agent() call site; a ×N badge when parallel()/pipeline() fans out over a runtime list; node face =
label + model tier + truncated mission; a right side panel editing mission text and model tier;
Approve disabled until every node has been opened. Edges are drawn phase-to-phase, which is crude.
Constraints that are NOT negotiable: single HTML file, no build step, scripts only from cdnjs or
jsdelivr, no node dependencies, must work offline-ish and in both light and dark.

THE USER'S VERDICT: "I feel like we're not at all at the state of the art of graph engineering."
He wants: the side panel to show model, prompt, context and tools; the node face to stay ruthlessly
minimal (name, model, goal); and EDGES TO CARRY CONDITIONS, like a real graph.

Use WebSearch/WebFetch aggressively (8-20 sources), prefer primary sources, cite every URL, and flag
anything you could not verify. Write your report to ${OUT}/<your-slug>.md with the Write tool.
Return ONLY: {file, headline_findings (6-10 bullets), what_we_should_steal (concrete, 3-6 items)}.
`

const DIMENSIONS = [
  { slug: 'node-anatomy', prompt: `${CONTEXT}
DIMENSION: Node design at the state of the art. Study the best node-based editors ever shipped, most
of which are NOT web apps: Unreal Blueprint, Houdini, TouchDesigner, Blender geometry nodes, Nuke,
Max/MSP, Substance Designer, plus web ones (ComfyUI, n8n, Rivet, Node-RED, Retool Workflows).
Answer concretely: what is ON a node face vs deliberately off it; how ports/pins are typed, coloured
and labelled; how a node signals state (dirty, error, disabled, has-overrides); collapsed vs expanded
node modes and semantic zoom / level-of-detail rules; how density is controlled at 40+ nodes; how a
node communicates "this is one template that runs N times". Be specific enough to implement: sizes,
what text, what badges, what is hidden until hover or zoom.` },

  { slug: 'conditional-edges', prompt: `${CONTEXT}
DIMENSION: Edges that carry meaning — THE user's specific complaint. How do serious systems render a
condition on a transition? Study: BPMN sequence flows with conditional expressions + gateway
diamonds, AWS Step Functions Choice states, Camunda, Unreal Blueprint execution pins vs data pins
(two edge KINDS on one canvas), Node-RED, n8n IF/Switch nodes, LangGraph conditional edges
(add_conditional_edges + its drawn representation), state-machine tools (XState visualizer, Stately),
and classic control-flow / dataflow graph drawing.
Answer: when is a condition a labelled edge vs an explicit decision node? How are guard expressions
displayed without wrecking readability (truncation, hover, placement along the edge)? How are
execution-order edges distinguished from data-dependency edges visually? What is the convention for
an edge that may not fire at all, and for edges into/out of a fan-out? Give a concrete visual spec.` },

  { slug: 'layout-engineering', prompt: `${CONTEXT}
DIMENSION: Layout at the state of the art, and what actually runs in a browser from a CDN today.
Cover: ELK layered (elkjs) and its real option set (layering strategy, node placement, ORTHOGONAL
routing, port constraints, hierarchy/compound handling, edge label placement) versus dagre versus
cytoscape's built-in breadthfirst/fcose versus Graphviz-wasm versus d3-dag versus hand-rolled
Sugiyama. IMPORTANT: verify what each package actually ships on cdnjs and jsdelivr as a usable
browser global — we discovered cytoscape-dagre on cdnjs neither self-registers nor exposes a global,
which silently broke our layout. Check before recommending.
Also: incremental/stable layout after an edit (how do you re-layout without teleporting the user's
mental map — mental map preservation literature), compound/nested layout for phase groups, edge
label placement, and orthogonal edge routing quality. Give a ranked recommendation with the exact
CDN URL and global name for the winner, plus the fallback.` },

  { slug: 'inspector-panels', prompt: `${CONTEXT}
DIMENSION: The property inspector. The user wants model, prompt, context and tools visible per node —
that is a LOT of content in a 380px panel, and cramming it is how inspectors become unusable.
Study the best property panels shipped: Blender N-panel/properties editor, Unreal Details panel,
Figma right rail, Houdini parameter panes, Retool inspector, VS Code settings UI, Postman request
builder, and prompt-engineering IDEs (Vellum, PromptLayer, LangSmith playground).
Answer: progressive disclosure patterns that actually work; how long free-text (a 2000-char prompt)
is edited in a side rail without becoming a scrolling nightmare; how a read-only computed value is
distinguished from an editable one; how you show an inherited/default value vs an explicit override;
how a list of tools or capabilities is presented compactly; how validation errors are surfaced in a
panel; when to promote editing into a modal or a full-width drawer instead. Concrete spec.` },

  { slug: 'canvas-interaction', prompt: `${CONTEXT}
DIMENSION: Canvas interaction and navigation at scale, plus accessibility — the part everyone skips.
Cover: selection models (click, marquee, lasso, select-connected, select-by-type), keyboard-first
navigation of a graph (arrow-key traversal along edges, tab order, focus rings), search and
filter-to-subgraph, minimap conventions and when a minimap is useless, focus/isolate mode, breadcrumbs
for nested graphs, and undo/redo granularity expectations in node editors.
ACCESSIBILITY IS A FIRST-CLASS PART OF THIS DIMENSION: a canvas-rendered graph is invisible to a
screen reader. Find what actually exists — ARIA patterns for node-link diagrams, the accessible
alternative (a tree/table view of the same graph), WCAG requirements that bite here, and any shipped
example that does it well. If the honest answer is "almost nobody does this", say so and specify the
minimum credible fallback view.` },

  { slug: 'agent-graph-semantics', prompt: `${CONTEXT}
DIMENSION: What an AGENT graph specifically needs that a generic dataflow graph does not.
Study how agent frameworks visualise their own graphs: LangGraph (get_graph().draw_mermaid_png,
conditional edges, subgraphs, interrupts), AutoGen Studio, CrewAI, OpenAI Agents SDK handoffs,
Swarm, Dify, Flowise, Vellum, and Anthropic's own published agent-architecture diagrams.
Answer: how is an agent's TOOL INVENTORY shown (badges? a list? an icon strip?) — and at what
altitude; how are handoffs distinguished from data passing; how is a structured-output contract
(JSON schema) represented; how is model/tier and cost shown per node; how are retries, verification
loops and adversarial-check patterns drawn; how is a subgraph or nested workflow collapsed.
Then answer the hard one: given our real API has NO per-agent tools field, what is the honest,
non-fabricated way to show "what this agent can do" on the graph?` },
]

const survey = await parallel(DIMENSIONS.map((d) => () =>
  agent(d.prompt, { label: `survey:${d.slug}`, phase: 'Survey' })))

// Barrier is right here: the critic must judge our code against the WHOLE survey, and the spec
// author needs every report plus the critique together.
const critique = await agent(`${CONTEXT}

You are the harshest possible reviewer of the CURRENT implementation. Read the actual file with the
Read tool: ${EDITOR} (about 430 lines). Also read ${OUT}/ reports if they exist.

Here is what the survey agents just found:
${JSON.stringify(survey, null, 2)}

Go through our editor and name, specifically, everywhere it falls short of what the survey describes.
Be concrete: quote the line, say what a state-of-the-art editor does instead, and say whether the gap
matters for THIS use case (a human approving an agent plan) or is irrelevant polish for it.
Separate: (a) genuinely wrong / misleading, (b) missing and load-bearing, (c) missing but correctly
cut for this use case. Do not pad category (b) to seem thorough — a gap that does not serve plan
approval belongs in (c).
Write it to ${OUT}/00-CRITIQUE.md and return ONLY {file, worst_five (ordered), verdict_one_line}.`,
  { label: 'critique-current-editor', phase: 'Critique' })

const spec = await agent(`${CONTEXT}

Write the implementable redesign spec. Read every report in ${OUT}/ with the Read tool, including
00-CRITIQUE.md. Survey headlines: ${JSON.stringify(survey, null, 2)}
Critique: ${JSON.stringify(critique, null, 2)}

Write ${OUT}/00-SPEC.md. It must be buildable by someone who has not read the research:

1. NODE FACE — exact contents at each zoom level. The user wants ruthless minimalism: flow name,
   model, goal. Say precisely what "goal" maps to given our real API, and where the ×N fan-out
   marker and state badges go. Give dimensions and typography.
2. EDGES — the full visual language. Execution order vs data dependency vs conditional. How a JS
   condition wrapping an agent() call becomes a labelled edge, what the label says, how it truncates,
   and what an edge out of a fan-out looks like. This is the user's loudest complaint — be exact.
3. SIDE PANEL — model, prompt, context, tools, schema, effort, phase. Say exactly which are real
   fields, which are derived, and which we must NOT fabricate. Specify progressive disclosure and
   how a 2000-char prompt is edited without a scrolling nightmare.
4. LAYOUT — the pick, with the exact CDN URL and browser global name, verified to exist. Include the
   fallback and the re-layout-after-edit rule.
5. INTERACTION + A11Y — the minimum credible set, including the non-canvas accessible view.
6. WHAT WE DELIBERATELY DO NOT BUILD, and why. Be ruthless here; a spec that includes everything is
   a spec nobody ships.
7. BUILD ORDER — sequenced steps, each independently shippable, with a rough size for each.

Rules: cite URLs. Where reports disagree, say so rather than averaging. Never specify a UI for a
field that does not exist in the real agent() API — call that out explicitly where the user's request
implies one. Return ONLY the file path and a 12-line executive summary.`,
  { label: 'redesign-spec', phase: 'Spec' })

return { survey: survey.map((s) => s?.file), critique, spec }
