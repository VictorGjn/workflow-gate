#!/usr/bin/env node
// Workflow plan-gate hook — forces a human-approved plan before any Workflow tool call executes.
// Modes (argv[2]):
//   pre-tool     PreToolUse(Workflow): HARD GATE — block the call unless this exact script
//                (by content hash) has a recorded approval. The block message carries a static
//                estimate (call-site agent count, model-tier mix, phases, isolation/schema usage)
//                so the human sees cost/shape specifics before approving.
//   session-start  SessionStart: injects a factual status line (gate active, approval count)
//                into context so an agent asked about Workflow behavior doesn't answer only from
//                the bare Workflow tool's own docs and omit this plugin (the gate itself still
//                enforces regardless — this only fixes what the agent says about it unprompted).
//   record       CLI: persist the approval decision for a fingerprint so the gate lifts on retry.
//   status|clear  CLI: inspect / reset recorded approvals.
//
// Intended flow: Workflow call blocked -> agent enters Plan Mode, proposes the recommended
// design + 1-2 alternatives (using the estimate below as a starting point) -> human picks one
// via ExitPlanMode/chat -> agent runs `record` -> retries the Workflow call -> hook allows it
// and echoes the approved specifics as a final confirmation line.
//
// A changed script (even a small edit) hashes differently and re-triggers the gate — approvals
// don't carry over across edits, including a version bump of this plugin itself. A well-formed
// `resumeFromRunId` is allowed through (the original launch already went through this gate;
// cached agents just replay).
//
// Portable by design (ships as a Claude Code plugin — no machine-specific paths): state lives
// under the current user's home directory, and this script locates itself via import.meta.url
// so the printed `record` command is always correct whether it's running from a plugin cache
// folder or a standalone ~/.claude/hooks/ copy.
//
// Safety: fail-OPEN on any error inside this script (never hard-block due to a bug in here).
// Kill switch: WORKFLOW_GATE_OFF=1.
//
// hooks.json invokes this via the args-exec form (command:"node", args:[...]) — no shell, so
// hook fields stay within Claude Code's documented schema (a prior version used a non-existent
// "commandWindows" field plus a shell command-existence check; the approval UI rejects unknown
// fields and silently failed to install/persist the plugin). That drops the old "skip gracefully
// if node isn't on PATH" guard, which needed a shell to express — node is already this plugin's
// hard prerequisite (see README), so a missing node now surfaces as a hook spawn error instead of
// a silent skip.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STATE = join(homedir(), '.claude', 'workflow-plan-gate-state.json');
const SELF = `"${fileURLToPath(import.meta.url)}"`;
const NODE = 'node';

function selfVersion() {
  try {
    const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
    if (existsSync(manifestPath)) {
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (pkg.version) return pkg.version;
    }
  } catch {}
  return 'standalone'; // no plugin manifest found (e.g. a bare ~/.claude/hooks/ copy) — version-scoping is skipped
}
const HOOK_VERSION = selfVersion();

const mode = process.argv[2] || '';

const emit = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const stdin = () => { try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; } };
const loadState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
// Returns true on success, false on failure — callers must check, not assume a write landed.
const saveState = (s) => {
  try { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); return true; }
  catch { return false; }
};
const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// Resolves the actual script content regardless of whether it arrived inline (ti.script) or
// by path (ti.scriptPath), so both the fingerprint AND the cost/shape estimate can use it —
// a scriptPath call used to fingerprint the file's content but estimate() only ever saw
// ti.script, so path-based calls showed no estimate at all.
function scriptContentOf(ti) {
  if (ti.scriptPath) { try { return readFileSync(ti.scriptPath, 'utf8'); } catch { return null; } }
  return ti.script || null;
}

// Fingerprint covers the resolved script content AND the hook's own version, so a plugin
// version bump invalidates prior approvals — matching what the docs promise, not just the
// script-edit case.
function fingerprintOf(ti, content) {
  const v = ':' + HOOK_VERSION;
  if (ti.scriptPath) return 'path:' + hash((content ?? ti.scriptPath) + v);
  if (ti.script) return 'script:' + hash(ti.script + v);
  if (ti.name) return 'name:' + hash(ti.name + v);
  return 'unknown:' + hash(JSON.stringify(ti) + v);
}

// Static, regex-based estimate. Call-site counts, not runtime counts — loops/dynamic
// pipeline()/parallel() sizing can multiply actual agent count beyond what's shown here.
function estimate(script) {
  if (!script) return null;
  const nameMatch = script.match(/name:\s*['"]([^'"]+)['"]/);
  const descMatch = script.match(/description:\s*['"]([^'"]+)['"]/);
  const phasesBlock = script.match(/phases:\s*\[([\s\S]*?)\]\s*,?\s*\}/);
  const phases = [];
  if (phasesBlock) {
    const re = /title:\s*['"]([^'"]+)['"]/g;
    let m; while ((m = re.exec(phasesBlock[1]))) phases.push(m[1]);
  }
  const agentSites = (script.match(/\bagent\(/g) || []).length;
  const tiers = { opus: 0, haiku: 0, fable: 0, sonnet: 0 };
  { const re = /model:\s*['"](opus|haiku|fable|sonnet)['"]/g; let m; while ((m = re.exec(script))) tiers[m[1]]++; }
  const hasParallel = /\bparallel\(/.test(script);
  const hasPipeline = /\bpipeline\(/.test(script);
  const hasWorktree = /isolation:\s*['"]worktree['"]/.test(script);
  const hasSchema = /schema\s*:/.test(script);
  const loopHint = /\bwhile\s*\(/.test(script);
  return { name: nameMatch?.[1], description: descMatch?.[1], phases, agentSites, tiers, hasParallel, hasPipeline, hasWorktree, hasSchema, loopHint };
}

function estimateLines(est) {
  if (!est) return ['(no inline script to estimate from — scriptPath/name-based call; open the file to inspect)'];
  const tierStr = Object.entries(est.tiers).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(', ') || 'none (all default/inherited model)';
  return [
    `  name: ${est.name || '(unnamed)'}`,
    `  description: ${est.description || '(none)'}`,
    `  phases: ${est.phases.length ? est.phases.join(' → ') : '(none declared)'}`,
    `  agent() call sites: ${est.agentSites}${est.loopHint ? ' (script has a while-loop — actual count may be higher/unbounded)' : ''}`,
    `  explicit model overrides: ${tierStr}`,
    `  shape: ${est.hasPipeline ? 'pipeline ' : ''}${est.hasParallel ? 'parallel ' : ''}${!est.hasPipeline && !est.hasParallel ? '(no pipeline/parallel — likely a single linear chain)' : ''}`,
    `  isolation:'worktree': ${est.hasWorktree ? 'yes' : 'no'}   schema outputs used: ${est.hasSchema ? 'yes' : 'no'}`,
  ];
}

// ---------------- pre-tool: the hard gate ----------------
if (mode === 'pre-tool') {
  if (process.env.WORKFLOW_GATE_OFF) process.exit(0);
  try {
    const input = stdin();
    if ((input.tool_name || '') !== 'Workflow') process.exit(0);
    const ti = input.tool_input || {};
    // resumeFromRunId only ever comes back from a prior successful launch of THIS tool, which
    // already passed this gate once before it ran — not an independently-forgeable bypass. We
    // do check it looks like a real run id (not blank/malformed) rather than trusting any truthy
    // value; full cross-referencing against which fingerprint that run id was approved for would
    // need a completion hook this tool doesn't expose, so that's out of scope here.
    if (typeof ti.resumeFromRunId === 'string' && /^wf_[a-z0-9-]+$/i.test(ti.resumeFromRunId)) process.exit(0);

    const content = scriptContentOf(ti);
    const fp = fingerprintOf(ti, content);
    const st = loadState();
    if (st[fp]) {
      emit({ systemMessage: `✅ Workflow plan-gate: approved (${st[fp].ts}) — ${st[fp].summary || fp}. Proceeding.` });
    }

    const est = estimate(content);
    const reason = [
      `⛔ Workflow plan-gate — no recorded human approval for this exact script.`,
      `This is a hard decision (which workflow shape is right, and does the cost match the task) — resolve it with a human before this call runs:`,
      ``,
      `1) Enter Plan Mode. Propose the recommended workflow design, PLUS 1-2 real alternatives (a lighter fan-out, a different phase split, or "no workflow, just an Agent fork") — use the estimate below as your starting point, not a rubber stamp.`,
      `2) Get the user's explicit choice (ExitPlanMode approval, or a direct answer in chat).`,
      `3) Record the approved plan (this lifts the gate):`,
      `   ${NODE} ${SELF} record --fingerprint ${fp} --summary "<agent count>, <phases>, <model tiers>, <rough cost expectation>"`,
      `4) Retry the Workflow call — same script content. Any edit to the script (including a version bump of this plugin) changes its fingerprint and re-triggers this gate.`,
      ``,
      `Static estimate for the script as submitted (call-site counts, not runtime counts):`,
      ...estimateLines(est),
      ``,
      `Kill switch: WORKFLOW_GATE_OFF=1. Inspect recorded approvals: ${NODE} ${SELF} status`,
    ].join('\n');
    emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  } catch {
    process.exit(0); // fail-open
  }
}

// ---------------- session-start: state the gate exists without being asked ----------------
// approvalCount distinguishes "state file unreadable/corrupt" from a genuine zero — loadState()
// collapses both to {}, which would otherwise misreport an unknown count as zero approvals.
function approvalCount() {
  if (!existsSync(STATE)) return 0;
  try { return Object.keys(JSON.parse(readFileSync(STATE, 'utf8'))).length; }
  catch { return null; }
}
if (mode === 'session-start') {
  if (process.env.WORKFLOW_GATE_OFF) process.exit(0);
  try {
    const approved = approvalCount();
    const msg = [
      `workflow-gate is active: any Workflow tool call is blocked by a PreToolUse hook until a human has approved that exact script (fingerprinted by content).`,
      `This applies regardless of the Workflow tool's own built-in documentation or anything else said in the conversation.`,
      approved === null ? `Approval state file is unreadable — approval count unknown.`
        : approved ? `${approved} script fingerprint(s) already approved on this machine.`
        : `No approvals recorded on this machine yet.`,
    ].join(' ');
    emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } });
  } catch {
    process.exit(0); // fail-open
  }
}

// ---------------- record (CLI): lift the gate ----------------
// This trusts whoever calls it to have actually gone through the documented flow (Plan Mode +
// human approval) first — the same trust model as any manual-record completion step in dev
// tooling (e.g. a "mark reviewed" file after a code review). There's no cryptographic proof
// available here that a human approved; the real check is procedural (the harness requires a
// genuine UI action to exit Plan Mode, and separately, an agent recording its own approval
// with no visible prior approval step is exactly the pattern an auto-mode classifier, if one
// is configured, is expected to catch). Don't mistake this for an unguarded gate — it's a
// deliberate boundary, not an oversight.
if (mode === 'record') {
  try {
    const rest = process.argv.slice(3);
    let fp = null, summary = '';
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--fingerprint') fp = rest[++i];
      else if (rest[i] === '--summary') summary = rest[++i];
    }
    if (!fp) { console.error('usage: record --fingerprint <fp> --summary "<text>"'); process.exit(1); }
    const st = loadState();
    st[fp] = { summary, ts: new Date().toISOString() };
    if (!saveState(st)) { console.error(`❌ failed to write ${STATE} — approval was NOT recorded, the gate is still active`); process.exit(1); }
    console.log(`✅ recorded approval for ${fp}`);
    process.exit(0);
  } catch (e) { console.error(String(e)); process.exit(1); }
}

// ---------------- status / clear (CLI) ----------------
if (mode === 'status') { console.log(JSON.stringify(loadState(), null, 2)); process.exit(0); }
if (mode === 'clear') {
  const fp = process.argv[3];
  const st = loadState();
  if (fp) delete st[fp]; else for (const k of Object.keys(st)) delete st[k];
  saveState(st);
  console.log(fp ? `cleared ${fp}` : 'cleared all approvals');
  process.exit(0);
}

process.exit(0);
