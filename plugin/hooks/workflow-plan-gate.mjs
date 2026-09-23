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
//   prompt       UserPromptSubmit: the human typing "override manual approval" lifts the gate for the
//                session (optionally "for 2h"); "restore manual approval" puts it back. No agent action.
//   override     CLI: `override 2h` does the same, machine-wide, from a terminal; `off` ends every override.
//   status|clear  CLI: inspect / reset recorded approvals.
//
// Intended flow: Workflow call blocked -> a graph editor opens in the browser and THIS HOOK WAITS
// (up to WAIT_MS, inside hooks.json's timeout) while a human is on the page -> they click Approve
// -> the hook allows the call, rewritten (updatedInput) to run the approved file. Nobody at the
// desk (page untouched for SEEN_MS)? The hook denies with the chat path instead: the human says
// "approved" in chat, the agent runs `approve-path` on the file, retries, and the hook lets it
// through. A standing `override` skips all of it for a bounded time.
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

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const STATE = join(homedir(), '.claude', 'workflow-plan-gate-state.json');
// A standing override: `override 2h` lets every Workflow call through until then, loudly. For the
// human who is away from the desk and knows what the session is about to launch.
const OVERRIDE = join(homedir(), '.claude', 'workflow-gate-override.json');
const SELF = `"${fileURLToPath(import.meta.url)}"`;
const NODE = 'node';
// How long the hook itself waits for the browser decision. Must stay under hooks.json's timeout
// (900 s): a hook killed at its timeout renders NO decision, which is the fail-open we refuse.
const WAIT_MS = process.env.WORKFLOW_GATE_WAIT !== undefined ? Number(process.env.WORKFLOW_GATE_WAIT) * 1000 : 14 * 60 * 1000;
const SEEN_MS = 90 * 1000;              // nobody touched the page by then: they are not at the desk

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
// Override state: `{ global: { until }, sessions: { <session_id>: { until } } }`. A chat override is
// scoped to the session that said it (a forgotten one dies with the session); the CLI one is global.
const loadOverride = () => { try { const o = JSON.parse(readFileSync(OVERRIDE, 'utf8')); return o.until ? { global: { until: o.until } } : o; } catch { return {}; } };
const saveOverride = (o) => { mkdirSync(dirname(OVERRIDE), { recursive: true }); writeFileSync(OVERRIDE, JSON.stringify(o, null, 2)); };
const overrideUntil = (session) => {
  const o = loadOverride(), now = Date.now();
  return Math.max(o.global?.until > now ? o.global.until : 0, session && o.sessions?.[session]?.until > now ? o.sessions[session].until : 0);
};
// The human's own words, read by the UserPromptSubmit hook. Matched on the prompt as typed — no
// agent in the loop, no command to run. Duration optional ("override manual approval for 3h").
const OVERRIDE_ON = /\b(override|bypass|skip|disable|lift)\b[^.\n]{0,40}\b(manual approval|the gate|workflow[- ]gate|plan[- ]gate|approvals?)\b|\bmanual approval\b[^.\n]{0,20}\boverride\b|\boverride manual\b/i;
const OVERRIDE_OFF = /\b(restore|re-?enable|resume|stop overriding|end override|cancel override)\b[^.\n]{0,30}\b(manual approval|the gate|workflow[- ]gate|approvals?)\b|\bgate (back )?on\b|\boverride off\b|\bmanual approval (back )?on\b/i;
const DURATION = /\b(\d+)\s*(m(?:in(?:utes?)?)?|h(?:ours?)?|d(?:ays?)?)\b/i;
const DEFAULT_CHAT_OVERRIDE_MS = 8 * 3600e3;
function parseOverridePrompt(text) {
  if (OVERRIDE_OFF.test(text)) return { off: true };
  if (!OVERRIDE_ON.test(text)) return null;
  const d = DURATION.exec(text);
  const ms = d ? Number(d[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[d[2][0].toLowerCase()] : DEFAULT_CHAT_OVERRIDE_MS;
  return { until: Date.now() + ms };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // A parallel()/pipeline() whose first argument is an identifier (not an inline [array]) fans out
  // over a runtime-sized list, so agentSites undercounts — badly. This gate itself once reported
  // "4 call sites" for a script that launched 7 agents: parallel(DIMENSIONS.map(d => agent(...)))
  // is ONE site that launches six. The true count is not knowable statically, so don't print a
  // confident number — say the runtime count is higher.
  // ponytail: first-char check, not a parser. Misses parallel(xs.filter(...).map(...)) written as an
  // inline array-returning call chain; add acorn if that starts mattering.
  const fanOut = /\b(?:parallel|pipeline)\(\s*[A-Za-z_$]/.test(script);
  return { name: nameMatch?.[1], description: descMatch?.[1], phases, agentSites, tiers, hasParallel, hasPipeline, hasWorktree, hasSchema, loopHint, fanOut };
}

function estimateLines(est) {
  if (!est) return ['(no inline script to estimate from — scriptPath/name-based call; open the file to inspect)'];
  const tierStr = Object.entries(est.tiers).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(', ') || 'none (all default/inherited model)';
  return [
    `  name: ${est.name || '(unnamed)'}`,
    `  description: ${est.description || '(none)'}`,
    `  phases: ${est.phases.length ? est.phases.join(' → ') : '(none declared)'}`,
    `  agent() call sites: ${est.agentSites}${est.fanOut ? ' — ⚠ AGENTS ACTUALLY LAUNCHED IS HIGHER: a parallel()/pipeline() fans out over a runtime list, so one site here launches many. Read the script for the list size before approving.' : ''}${est.loopHint ? ' (script has a while-loop — actual count may be higher/unbounded)' : ''}`,
    `  explicit model overrides: ${tierStr}`,
    `  shape: ${est.hasPipeline ? 'pipeline ' : ''}${est.hasParallel ? 'parallel ' : ''}${!est.hasPipeline && !est.hasParallel ? '(no pipeline/parallel — likely a single linear chain)' : ''}`,
    `  isolation:'worktree': ${est.hasWorktree ? 'yes' : 'no'}   schema outputs used: ${est.hasSchema ? 'yes' : 'no'}`,
  ];
}

// Opens the graph editor for a scriptPath call: spawns the approval server DETACHED and points a
// browser at it. The server outlives this hook (it becomes the live view after approval), and the
// hook's own wait below is bounded well inside hooks.json's timeout — a hook killed at its timeout
// renders NO decision, which would silently degrade the gate to "just ask".
//
// Returns the URL, or null if anything at all went wrong — the text flow is always still there.
function openEditor(scriptPath, fp) {
  try {
    const dir = join(tmpdir(), 'workflow-gate');
    mkdirSync(dir, { recursive: true });
    // Keyed by fingerprint: two gate invocations at once (which parallel subagents make likely)
    // must not clobber each other's handshake and approve against the wrong server.
    const portFile = join(dir, fp.replace(/[^a-z0-9]/gi, '_') + '.port');
    rmSync(portFile, { force: true });
    const nonce = randomBytes(16).toString('hex');
    const server = join(dirname(fileURLToPath(import.meta.url)), 'approve-server.mjs');
    if (!existsSync(server)) return null;

    spawn(process.execPath, [server, nonce, portFile, scriptPath],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();

    // The server binds an ephemeral port and writes it here. Busy-wait briefly: this is bounded at
    // well under a second, versus the human-scale wait we are explicitly refusing to do in-hook.
    const deadline = Date.now() + 3000;
    let port = '';
    while (Date.now() < deadline) {
      try { port = readFileSync(portFile, 'utf8').trim(); if (port) break; } catch {}
    }
    if (!port) return null;

    // The nonce lives ONLY in this URL. It is never logged and never passed as a CLI arg, so a
    // local process (the agent included) can't replay it to self-approve.
    const url = `http://127.0.0.1:${port}/?n=${nonce}`;
    // ponytail: `start` treats its first quoted argument as a window title, so the empty "" is
    // mandatory or this opens a blank console window instead of the browser.
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return url;
  } catch { return null; }
}

// Waits for the human's decision on the page. Returns 'approved' | 'cancelled' | 'unattended' (nobody
// touched the page within SEEN_MS — they are not at the desk, fall back to the chat flow) |
// 'timeout' (present but undecided at the deadline) | 'gone' (server died without a decision).
async function waitForDecision(url) {
  const stateUrl = url.replace('/?n=', '/state?n=');
  const t0 = Date.now();
  let misses = 0;
  while (Date.now() - t0 < WAIT_MS) {
    let s = null;
    try { const r = await fetch(stateUrl, { signal: AbortSignal.timeout(2000) }); if (r.ok) s = await r.json(); } catch {}
    if (!s) { if (++misses >= 3) return 'gone'; await sleep(1000); continue; }
    misses = 0;
    if (s.decided) return s.approved ? 'approved' : 'cancelled';
    if (!s.seen && Date.now() - t0 > SEEN_MS) return 'unattended';
    await sleep(1000);
  }
  return 'timeout';
}

// The documented default is to pass the script INLINE ("do not Write it to a file first"), so an
// editor that only opens for scriptPath calls never opens on the path that matters. Persist the
// inline text to a file the retry can re-read, and tell the agent to retry with that path.
// ponytail: `<cwd>/.claude/workflow-gate/` — never `.claude/workflows/`, which registers slash
// commands. tmpdir only when cwd is the home dir (no repo to keep it in).
function persistInline(content, cwd, fp) {
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const inRepo = cwd && norm(cwd) !== norm(homedir());
  const dir = inRepo ? join(cwd, '.claude', 'workflow-gate') : join(tmpdir(), 'workflow-gate');
  mkdirSync(dir, { recursive: true });
  // Every repo this plugin runs in would otherwise grow an untracked folder of agent drafts.
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const p = join(dir, 'gate-' + fp.replace(/[^a-z0-9]/gi, '_') + '.mjs');
  // The file is named after the DRAFT's fingerprint. If the human already edited and approved it
  // and the agent retries the same draft inline, overwriting would silently discard their edits.
  if (existsSync(p)) {
    const onDisk = readFileSync(p, 'utf8');
    if (onDisk !== content && loadState()[fingerprintOf({ scriptPath: p }, onDisk)]) return { path: p, approvedEdit: true };
  }
  writeFileSync(p, content);
  return { path: p, approvedEdit: false };
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
    const until = overrideUntil(input.session_id);
    if (until) {
      emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'workflow-gate: manual approval overridden' },
        systemMessage: [`⚠️ Workflow plan-gate: manual approval OVERRIDDEN until ${new Date(until).toLocaleString()} — this workflow runs WITHOUT human review.`,
          ...estimateLines(est), `The human ends it by saying "restore manual approval" (or ${NODE} ${SELF} override off).`].join('\n') });
    }
    // The edit has to land somewhere the retry will re-read: the scriptPath as given, or the inline
    // script persisted to one. The editor approves the FILE, so the retry must use scriptPath.
    let editorPath = ti.scriptPath || null, editorUrl = null, approvedEdit = false;
    if (!process.env.WORKFLOW_GATE_NO_UI && content) {
      try { if (!editorPath) ({ path: editorPath, approvedEdit } = persistInline(content, input.cwd, fp)); } catch { editorPath = null; }
      if (editorPath && !approvedEdit) editorUrl = openEditor(editorPath, fp);
    }
    if (approvedEdit) {
      emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
        `⛔ Workflow plan-gate — the human already reviewed, EDITED and approved this plan as a file. Your inline draft is not what they approved.\nRe-read ${editorPath} and retry with { scriptPath: ${JSON.stringify(editorPath)} } — do not pass the script inline again.` } });
    }

    // The wait that makes "Approve & run" real: stay in this hook while a human is on the page, and
    // when they approve, let THIS call through — rewritten to run the file they approved, edits
    // included — instead of denying and asking them to come back and say so in chat.
    let verdict = null;
    if (editorUrl && WAIT_MS > 0) {
      verdict = await waitForDecision(editorUrl);
      if (verdict === 'approved') {
        const onDisk = readFileSync(editorPath, 'utf8');
        const rec = loadState()[fingerprintOf({ scriptPath: editorPath }, onDisk)];
        if (rec) {
          const { script, ...rest } = ti;
          emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'workflow-gate: approved in the graph editor',
              updatedInput: { ...rest, scriptPath: editorPath } },
            systemMessage: `✅ Workflow plan-gate: approved in the graph editor — ${rec.summary}. Running ${editorPath}${onDisk !== content ? ' (the human EDITED the plan; the file is what runs, not the draft)' : ''}.` });
        }
        verdict = 'mismatch';
      }
      if (verdict === 'cancelled') {
        emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
          `⛔ Workflow plan-gate — the human CANCELLED this plan in the graph editor. Do not retry it as is: ask what they want changed.` } });
      }
    }
    // When the browser gate is up, the deny text must NOT hand the agent a `record` command next
    // to it: two trust models side by side is how self-approval loops happen. Nor the nonce: the
    // URL below is printed WITHOUT it, because the agent reads this text and a nonce here is a
    // POST /approve away from approving content the human never saw. The chat path below is for
    // the human who is NOT at the desk (phone, remote) — it records against the FILE, so the retry
    // still runs what the editor would have.
    const reason = [
      `⛔ Workflow plan-gate — no recorded human approval for this exact script.`,
      ...(editorUrl ? [
        ``,
        verdict === 'unattended' ? `A graph editor opened in the human's browser (${editorUrl.replace(/\?n=.*$/, '')}) but nobody touched it for ${SEEN_MS / 1000} s — they are probably not at their desk. It stays open ~20 min.`
        : verdict === 'timeout' ? `The human is on the graph editor (${editorUrl.replace(/\?n=.*$/, '')}) but has not decided after ${Math.round(WAIT_MS / 60000)} min. Retrying this call reopens the wait.`
        : verdict === 'gone' ? `The graph editor closed without a decision (tab closed, or the approval server stopped). Retrying this call reopens it.`
        : `A graph editor just opened in the human's browser (${editorUrl.replace(/\?n=.*$/, '')}) — they review the flow there, edit missions/tiers, and approve. That approval lifts this gate on its own.`,
        `DO NOT retry blind and DO NOT record an approval yourself.`,
        `If the human says in chat that they approve (they cannot reach the browser), and ONLY then, record it against the file and retry:`,
        `   ${NODE} ${SELF} approve-path --path ${JSON.stringify(editorPath)} --summary "approved in chat"`,
        `The human can lift this gate themselves at any time by typing "override manual approval" (optionally "for 2h") in chat — the plugin reads that message directly, no command for you to run. "restore manual approval" puts it back.`,
        `Either way retry with { scriptPath: ${JSON.stringify(editorPath)} } — NOT with an inline script — and re-read that file first: the human may have edited it, and the plan that runs is the file, not your draft.`,
      ] : [
        `This is a hard decision (which workflow shape is right, and does the cost match the task) — resolve it with a human before this call runs:`,
        ``,
        `1) Enter Plan Mode. Propose the recommended workflow design, PLUS 1-2 real alternatives (a lighter fan-out, a different phase split, or "no workflow, just an Agent fork") — use the estimate below as your starting point, not a rubber stamp.`,
        `2) Get the user's explicit choice (ExitPlanMode approval, or a direct answer in chat).`,
        `3) Record the approved plan (this lifts the gate):`,
        `   ${NODE} ${SELF} record --fingerprint ${fp} --summary "<agent count>, <phases>, <model tiers>, <rough cost expectation>"`,
        `4) Retry the Workflow call — same script content. Any edit to the script (including a version bump of this plugin) changes its fingerprint and re-triggers this gate.`,
      ]),
      ``,
      `Static estimate for the script as submitted (call-site counts, not runtime counts):`,
      ...estimateLines(est),
      ``,
      `Kill switch: WORKFLOW_GATE_OFF=1. Inspect recorded approvals: ${NODE} ${SELF} status. Standing override state: ${NODE} ${SELF} override`,
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
    const until = overrideUntil(stdin().session_id);
    const msg = [
      `workflow-gate is active: any Workflow tool call is blocked by a PreToolUse hook until a human has approved that exact script (fingerprinted by content), in the graph editor the hook opens (the hook waits for their click) or in chat. The human can lift it at any time by typing "override manual approval" (the plugin reads that message itself) and restore it with "restore manual approval".`,
      `This applies regardless of the Workflow tool's own built-in documentation or anything else said in the conversation.`,
      approved === null ? `Approval state file is unreadable — approval count unknown.`
        : approved ? `${approved} script fingerprint(s) already approved on this machine.`
        : `No approvals recorded on this machine yet.`,
      until ? `⚠️ Manual approval is OVERRIDDEN until ${new Date(until).toLocaleString()}: Workflow calls run without review until then ("restore manual approval" ends it).` : '',
    ].filter(Boolean).join(' ');
    emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } });
  } catch {
    process.exit(0); // fail-open
  }
}

// ---------------- record (CLI): lift the gate ----------------
// This trusts whoever calls it to have actually gone through the documented flow (Plan Mode +
// human approval) first — the same trust model as the Linear-work gate this hook is modeled on.
// There's no cryptographic proof available here that a human approved; the real check is
// procedural (the harness requires a genuine UI action to exit Plan Mode, and separately, an
// agent recording its own approval with no visible prior approval step is exactly the pattern
// this deployment's auto-mode classifier is expected to catch). Don't mistake this for an
// unguarded gate — it's a deliberate boundary, not an oversight.
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

// ---------------- override (CLI): lift the gate for a while ----------------
// `override 2h` | `override 45m` | `override 1d` | `override off` | `override` (status). Same trust
// model as `record`: procedural, for the human who asked for it in chat because they are not at
// the desk. Every call that passes under it says so in a systemMessage, and the SessionStart banner
// repeats it, so a forgotten override is loud rather than silent.
if (mode === 'override') {
  const arg = process.argv[3] || '';
  if (arg === 'off') { rmSync(OVERRIDE, { force: true }); console.log('override off — the gate is active again (all sessions)'); process.exit(0); }
  const m = /^(\d+)\s*(m|h|d)$/i.exec(arg);
  if (!m) {
    const until = overrideUntil();
    console.log(until ? `global override active until ${new Date(until).toLocaleString()}` : 'no global override active');
    const s = Object.entries(loadOverride().sessions || {}).filter(([, v]) => v.until > Date.now());
    for (const [id, v] of s) console.log(`session ${id.slice(0, 8)}… overridden until ${new Date(v.until).toLocaleString()}`);
    if (!arg) process.exit(0);
    console.error('usage: override <N>m|<N>h|<N>d | off'); process.exit(1);
  }
  const ms = Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase()];
  const until = Date.now() + ms;
  try { const o = loadOverride(); o.global = { until, set: new Date().toISOString() }; saveOverride(o); }
  catch (e) { console.error(`❌ could not write ${OVERRIDE}: ${e.message}`); process.exit(1); }
  console.log(`⚠️ gate overridden until ${new Date(until).toLocaleString()} — every Workflow call runs without review until then`);
  process.exit(0);
}

// ---------------- prompt (UserPromptSubmit): the human's own words lift or restore the gate ----------------
// "override manual approval" typed in chat, at any moment, sets a session-scoped override — the
// plugin reads the prompt itself; nothing for the agent to run, nothing it could forget or refuse.
// "restore manual approval" clears it. The agent only learns about it through additionalContext.
if (mode === 'prompt') {
  try {
    const input = stdin();
    const r = parseOverridePrompt(String(input.prompt || ''));
    if (!r) process.exit(0);
    const o = loadOverride();
    o.sessions = o.sessions || {};
    for (const [id, v] of Object.entries(o.sessions)) if (!(v.until > Date.now())) delete o.sessions[id];   // sweep expired
    const session = input.session_id || 'unknown';
    let ctx;
    if (r.off) {
      delete o.sessions[session]; delete o.global;
      ctx = `workflow-gate: manual approval RESTORED by the human — every Workflow call is gated again.`;
    } else {
      o.sessions[session] = { until: r.until, set: new Date().toISOString() };
      ctx = `workflow-gate: manual approval OVERRIDDEN by the human for this session until ${new Date(r.until).toLocaleString()} — Workflow calls run without the gate. Say so once when you launch one. "restore manual approval" ends it.`;
    }
    saveOverride(o);
    emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } });
  } catch { process.exit(0); }   // fail-open: a broken prompt hook must never block a prompt
}

// ---------------- status / clear (CLI) ----------------
// ---------------- approve-path (CLI): record an approval for a script FILE ----------------
// Called by approve-server.mjs after the human approves in the graph editor. The server has just
// written the edited file, so the fingerprint must be recomputed from the file, here — the server
// deliberately doesn't own fingerprinting, or it would silently drift from this file on the next
// version bump.
if (mode === 'approve-path') {
  try {
    const rest = process.argv.slice(3);
    let path = null, summary = '';
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--path') path = rest[++i];
      else if (rest[i] === '--summary') summary = rest[++i];
    }
    if (!path) { console.error('usage: approve-path --path <file> --summary "<text>"'); process.exit(1); }
    const fp = fingerprintOf({ scriptPath: path }, readFileSync(path, 'utf8'));
    const st = loadState();
    st[fp] = { summary, ts: new Date().toISOString() };
    if (!saveState(st)) { console.error(`❌ failed to write ${STATE} — approval was NOT recorded, the gate is still active`); process.exit(1); }
    console.log(`✅ recorded approval for ${fp}`);
    process.exit(0);
  } catch (e) { console.error(String(e)); process.exit(1); }
}

// ---------------- selftest (CLI): the estimator's one non-trivial branch ----------------
// `node workflow-plan-gate.mjs selftest`. Guards the fan-out detection, which is the difference
// between telling a human "4 agents" and "4 sites, but more agents than that will run".
if (mode === 'selftest') {
  const eq = (got, want, what) => { if (got !== want) { console.error(`FAIL ${what}: got ${got}, want ${want}`); process.exit(1); } };
  eq(estimate('parallel(DIMENSIONS.map(d => agent(d.p)))').fanOut, true, 'fan-out over an identifier');
  eq(estimate('pipeline(items, x => agent(x))').fanOut, true, 'pipeline over an identifier');
  eq(estimate('parallel([() => agent("a"), () => agent("b")])').fanOut, false, 'inline array is not fan-out');
  eq(estimate('const r = await agent("solo")').fanOut, false, 'a bare agent() call is not fan-out');
  eq(estimate('parallel([() => agent("a")])').agentSites, 1, 'call sites still counted');
  // the real regression: this gate reported 4 sites for a script that launched 7 agents
  eq(estimateLines(estimate('parallel(DIMS.map(d => agent(d.p)))'))[3].includes('HIGHER'), true, 'warning reaches the human');
  // reach: an inline script must land in a file the retry can re-read, inside the repo when there is one
  const fakeRepo = join(tmpdir(), 'wg-selftest-repo');
  const inRepo = persistInline('export const meta = {}', fakeRepo, 'script:abc').path;
  eq(inRepo.startsWith(join(fakeRepo, '.claude', 'workflow-gate')), true, 'inline script persisted under <cwd>/.claude/workflow-gate');
  eq(readFileSync(inRepo, 'utf8'), 'export const meta = {}', 'persisted content is verbatim');
  eq(readFileSync(join(dirname(inRepo), '.gitignore'), 'utf8'), '*\n', 'the folder ignores itself');
  const home = persistInline('x', homedir(), 'script:abc').path;
  eq(home.startsWith(join(tmpdir(), 'workflow-gate')), true, 'home cwd falls back to tmpdir');
  rmSync(home, { force: true });
  rmSync(fakeRepo, { recursive: true, force: true });
  // the human's words: what lifts the gate, what restores it, what does neither
  eq(!!parseOverridePrompt('override manual approval')?.until, true, 'plain phrase overrides');
  eq(!!parseOverridePrompt('please override the manual approval for the next runs')?.until, true, 'phrase with words in between');
  eq(parseOverridePrompt('override manual approval for 2h').until - Date.now() > 7100e3, true, 'duration parsed (2h)');
  eq(parseOverridePrompt('restore manual approval')?.off, true, 'restore turns it off');
  eq(parseOverridePrompt('override off')?.off, true, 'override off turns it off');
  eq(parseOverridePrompt('let us discuss the manual approval flow'), null, 'talking about it is not an override');
  eq(parseOverridePrompt('override the CSS in the header'), null, 'override of something else is not an override');
  // the wait: a server that answers seen+approved lets the hook through; one nobody touches does not
  {
    const { createServer } = await import('node:http');
    const fake = (state) => new Promise((res) => { const s = createServer((q, r) => { r.end(JSON.stringify(state)); }); s.listen(0, '127.0.0.1', () => res(s)); });
    const s1 = await fake({ seen: true, decided: true, approved: true });
    eq(await waitForDecision(`http://127.0.0.1:${s1.address().port}/?n=x`), 'approved', 'approved page lets the call through');
    s1.close();
    const s2 = await fake({ seen: true, decided: true, approved: false });
    eq(await waitForDecision(`http://127.0.0.1:${s2.address().port}/?n=x`), 'cancelled', 'cancel is a cancel');
    s2.close();
    eq(await waitForDecision('http://127.0.0.1:1/?n=x'), 'gone', 'no server is gone, not a wait');
  }
  // Jev advice: the score→tier policy and the confidence floor, on a canned answer set — no network.
  {
    const { adviceFrom, requestFor } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'advise.mjs')).href);
    const skel = { name: 'x', agents: [{ id: 'a0', mission: 'm' }, { id: 'a1', mission: 'm' }, { id: 'a2', mission: 'm' }] };
    const a = adviceFrom({
      kind: { type: 'choice', choice: 'review', confidence: 1 },
      stakes: { type: 'score', score: 1.64, confidence: 0.46 },
      a0: { type: 'score', score: 0.2, confidence: 0.9 }, a1: { type: 'score', score: 1.97, confidence: 0.96 }, a2: { type: 'score', score: 1.1, confidence: 0.3 },
    }, skel);
    eq(a.kind.choice, 'review', 'confident choice is kept');
    eq(a.stakes, null, 'stakes under the confidence floor is silence, not a guess');
    eq(a.agents.a0.tier, 'haiku', 'band 0 → haiku');
    eq(a.agents.a1.tier, 'opus', 'band 2 → opus');
    eq(a.agents.a2, undefined, 'low-confidence agent gets no suggestion');
    const req = requestFor({ agents: [{ id: 'a0', mission: 'x'.repeat(5000) }] });
    eq(req.state.agents[0].mission.length, 1500, 'mission is truncated before egress');
    eq(Object.keys(req.questions).join(), 'kind,stakes,a0', 'one score question per agent');
    const bad = requestFor({ agents: [{ id: 'kind', mission: 'x' }, { id: '__proto__', mission: 'x' }, { id: 'a7', mission: 'x' }] });
    eq(Object.keys(bad.questions).join(), 'kind,stakes,a7', 'ids outside aN cannot shadow a question or the prototype');
    eq(bad.questions.kind.type, 'choice', 'the kind question survives an agent named kind');
  }
  console.log('selftest OK');
  process.exit(0);
}

// The history viewer: a persistent, READ-ONLY daemon — one per machine, reused across sessions and
// projects, showing every run this machine has plus anything running right now. It is a separate
// process from the gate on purpose and has no approval route at all (see history-server.mjs).
// Pick a project back up without reading six weeks of transcripts. Assembles one thread out of the
// four places the work already lives and nothing joins: handoffs, session transcripts, memories, and
// the Linear hook's state. Read-only; it writes nothing but the session index.
if (mode === 'thread') {
  const query = process.argv.slice(3).filter((a) => !a.startsWith('--')).join(' ');
  if (!query) { console.error('usage: thread "<what you were working on>"'); process.exit(1); }
  const here = dirname(fileURLToPath(import.meta.url));
  const { indexSessions } = await import(pathToFileURL(join(here, 'sessions.mjs')).href);
  const { searchThread, sessionDetail } = await import(pathToFileURL(join(here, 'threads.mjs')).href);
  const idx = await indexSessions();
  const th = searchThread(query, { sessionIndex: idx });
  const p = (s = '') => console.log(s);
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

  p(`THREAD  "${query}"`);
  p(`${th.handoffs.length} handoffs · ${th.sessions.length} sessions · ${th.memories.length} memories`
    + (th.tickets.length ? ` · tickets ${th.tickets.map((t) => t.ticket).join(', ')}` : ''));

  const last = th.handoffs[th.handoffs.length - 1];
  if (last) {
    p(`\n── WHERE YOU LEFT IT ─ ${last.date || ''}  ${last.title}`);
    if (last.status) p(`   status: ${clip(last.status, 150)}`);
    if (last.resume) p('\n' + last.resume.split('\n').slice(0, 5).map((l) => '   ' + l).join('\n'));
    if (last.failed) p('\n   DO NOT RETRY:\n' + last.failed.split('\n').slice(0, 4).map((l) => '   ' + l).join('\n'));
  }

  p('\n── THE THREAD, OLDEST FIRST ──');
  for (const h of th.handoffs) {
    p(`\n▸ ${h.date || '??'}  ${h.title}`);
    if (h.status) p(`   ${clip(h.status, 120)}`);
    const d = (h.decisions || '').split('\n').filter((l) => l.trim().startsWith('-')).slice(0, 3);
    for (const l of d) p('     ' + clip(l, 140));
  }

  p('\n── SESSIONS THAT WORKED ON IT ──');
  for (const s of th.sessions.slice(0, 6)) {
    const det = sessionDetail(s.project, s.sessionId, { maxPrompts: 2 });
    p(`\n▸ ${(s.endedAt || '').slice(0, 10)}  ${Math.round(s.activeMs / 60000)} min active · ${s.sittings} sittings · ${s.mentions} mentions`);
    p(`   titled: ${clip(s.title, 90) || '(none)'}`);
    if (det) {
      if (det.prompts[0]) p(`   asked ${det.promptCount}x, first: ${clip(det.prompts[0].text, 100)}`);
      if (det.wrote.length) p(`   wrote ${det.wrote.length}: ${det.wrote.slice(0, 4).map((w) => w.path.split(/[\\/]/).pop()).join(', ')}`);
      if (det.gitCommands.length) p(`   git: ${clip(det.gitCommands[0], 90)}`);
    }
    if (s.workflows.length) p(`   workflows: ${s.workflows.join(', ')}`);
    if (s.skills.length) p(`   skills: ${s.skills.join(', ')}`);
  }

  if (th.memories.length) {
    p('\n── MEMORIES ──');
    for (const m of th.memories.slice(0, 8)) p(`   [${m.type || '?'}] ${m.file.replace(/\.md$/, '')} — ${clip(m.description, 78)}`);
  }
  process.exit(0);
}

if (mode === 'history') {
  const portFile = join(homedir(), '.claude', 'workflow-gate-history-port');
  const openUrl = (url) => {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  };
  // A pid on its own proves nothing: pids get recycled, and then this would print a URL pointing at
  // whatever now owns that port. Ask the daemon itself.
  const answers = async (u) => {
    try { return (await fetch(u, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
  };
  const fromFile = () => {
    try {
      const p = JSON.parse(readFileSync(portFile, 'utf8'));
      return p.port ? `http://127.0.0.1:${p.port}/?n=${p.nonce}` : null;
    } catch { return null; }
  };
  let url = fromFile();
  if (url && !(await answers(url))) url = null;
  if (!url) {
    const server = join(dirname(fileURLToPath(import.meta.url)), 'history-server.mjs');
    if (!existsSync(server)) { console.error('history-server.mjs is missing'); process.exit(1); }
    rmSync(portFile, { force: true });
    spawn(process.execPath, [server], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !url) {
      await new Promise((r) => setTimeout(r, 100));   // wait, do not spin a core for five seconds
      url = fromFile();
    }
    if (!url) { console.error('the history server did not start'); process.exit(1); }
  }
  console.log(url);
  if (!process.argv.includes('--no-open')) openUrl(url);
  process.exit(0);
}

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
