// What each Claude Code session was, derived from the transcript it already writes.
//
// The point is joining sessions to work: a Linear issue, a project, a repo. Today nothing does that
// — `linear-work-state.json` keys on `repo#branch`, and most sessions run from the home directory
// with no branch at all, so the branch cannot identify them. What CAN: the session's own transcript
// names the issues it worked on, in the opening prompt, in Linear URLs, in the branches it touched.
//
// Read-only. This never writes to a session, never touches the Linear hook's state, and never calls
// the network. It reads transcripts and writes one index file.
//
// ponytail: zero dependencies, one JSON index, incremental on (size, mtime). A transcript that has
// not changed is not re-read — 120 MB across 33 sessions today, and it only grows.

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, renameSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROJECTS = join(homedir(), '.claude', 'projects');
const INDEX = join(homedir(), '.claude', 'session-index.json');
export const INDEX_VERSION = 1;

// A Linear id is TEAM-123. Bare-word false positives are the risk (UTF-8, ISO-8601, HTTP-404), so
// the team prefix must be one Victor actually has, or the id must arrive inside a linear.app URL.
const TEAMS = /^(PRD|SYR|OPS|HELP)$/i;
const ID_RE = /\b([A-Z][A-Z0-9]{1,5})-(\d{1,5})\b/g;
const URL_RE = /linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]{1,5}-\d{1,5})/gi;
const PROJECT_URL_RE = /linear\.app\/[^/\s]+\/project\/([^/\s"'`)\]]+)/gi;

export function ticketsIn(text) {
  const out = new Set();
  if (!text) return out;
  for (const m of String(text).matchAll(URL_RE)) out.add(m[1].toUpperCase());
  for (const m of String(text).matchAll(ID_RE)) if (TEAMS.test(m[1])) out.add((m[1] + '-' + m[2]).toUpperCase());
  return out;
}
export function projectsIn(text) {
  const out = new Set();
  if (!text) return out;
  for (const m of String(text).matchAll(PROJECT_URL_RE)) out.add(decodeURIComponent(m[1]));
  return out;
}

// The opening prompt makes a far better title than a uuid. Skip the harness's own injected turns —
// command stdout, task notifications, system reminders — and take the first thing a human typed.
const isHumanPrompt = (e) => e.type === 'user' && !e.isSidechain
  && typeof e.message?.content === 'string'
  && !/^\s*<(command-|task-notification|system-reminder|local-command)/.test(e.message.content);

function titleFrom(text) {
  const t = String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, 120);
}

async function scanTranscript(file) {
  const IDLE_GAP_MS = 30 * 60 * 1000;    // a pause longer than this is a different sitting
  let lastT = null;
  const s = {
    startedAt: null, endedAt: null, activeMs: 0, sittings: 1, lines: 0, title: null,
    cwds: new Set(), branches: new Set(), tickets: new Set(), projects: new Set(),
    tools: {}, skills: new Set(), models: new Set(), userTurns: 0,
  };
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    s.lines++;
    if (e.timestamp) {
      const t = Date.parse(e.timestamp);
      s.startedAt = s.startedAt || e.timestamp; s.endedAt = e.timestamp;
      if (lastT != null && t >= lastT) {
        const gap = t - lastT;
        if (gap <= IDLE_GAP_MS) s.activeMs += gap; else s.sittings++;
      }
      lastT = t;
    }
    if (e.cwd) s.cwds.add(e.cwd);
    if (e.gitBranch && e.gitBranch !== 'HEAD') s.branches.add(e.gitBranch);
    if (e.message?.model) s.models.add(e.message.model);

    if (isHumanPrompt(e)) {
      s.userTurns++;
      const text = e.message.content;
      if (!s.title) s.title = titleFrom(text);
      for (const t of ticketsIn(text)) s.tickets.add(t);
      for (const p of projectsIn(text)) s.projects.add(p);
    }
    const c = e.message?.content;
    if (Array.isArray(c)) for (const b of c) {
      if (b.type === 'tool_use') {
        s.tools[b.name] = (s.tools[b.name] || 0) + 1;
        if (b.name === 'Skill' && b.input?.skill) s.skills.add(b.input.skill);
        // An id inside a tool call counts only where it can't be an example: a Linear tool, or a
        // shell line driving the Linear CLI. Scanning every tool input instead turned an
        // `identifier: "SYR-1"` in a code fixture into a ticket with a session attached.
        if (/linear/i.test(b.name)) for (const t of ticketsIn(JSON.stringify(b.input || '').slice(0, 4000))) s.tickets.add(t);
        else if (b.name === 'Bash' && /\blinear\b/.test(b.input?.command || '')) for (const t of ticketsIn(b.input.command)) s.tickets.add(t);
      }
    }
  }
  // Branch names carry ids too: feat/prd-132-… is the convention the Linear hook already relies on.
  // Split on / and _ ONLY: the hyphen is part of the id. Removing it turned feat/prd-132-refactor
  // into FEAT PRD 132 REFACTOR, which matches nothing, so this line contributed exactly nothing.
  for (const br of s.branches) for (const t of ticketsIn(br.replace(/[/_]/g, ' ').toUpperCase())) s.tickets.add(t);
  return s;
}

const setsToArrays = (s) => ({
  ...s,
  cwds: [...s.cwds], branches: [...s.branches], tickets: [...s.tickets].sort(),
  projects: [...s.projects], skills: [...s.skills], models: [...s.models],
});

// Workflow runs recorded under this session's own directory — the join is the directory name, so it
// needs no index of its own.
function workflowsOf(project, sessionId) {
  const dir = join(PROJECTS, project, sessionId, 'workflows');
  try { return readdirSync(dir).filter((f) => /^wf_.*\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')); }
  catch { return []; }
}

export function loadIndex() {
  try {
    const i = JSON.parse(readFileSync(INDEX, 'utf8'));
    return i.version === INDEX_VERSION ? i : { version: INDEX_VERSION, sessions: {} };
  } catch { return { version: INDEX_VERSION, sessions: {} }; }
}

export function saveIndex(idx) {
  try {
    const tmp = INDEX + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(idx));
    renameSync(tmp, INDEX);
  } catch { /* an index that cannot be written is slow, not wrong */ }
}

// Rescan only what changed. A finished session's transcript never changes again; the live one grows,
// and is re-read whenever its size or mtime moves.
export async function indexSessions({ onProgress } = {}) {
  const idx = loadIndex();
  const ls = (p) => { try { return readdirSync(p); } catch { return []; } };
  const seen = new Set();
  for (const project of ls(PROJECTS)) {
    for (const f of ls(join(PROJECTS, project))) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.slice(0, -6);
      const file = join(PROJECTS, project, f);
      let st; try { st = statSync(file); } catch { continue; }
      seen.add(sessionId);
      const prev = idx.sessions[sessionId];
      if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
      const scanned = await scanTranscript(file);
      idx.sessions[sessionId] = {
        sessionId, project, size: st.size, mtime: st.mtimeMs,
        ...setsToArrays(scanned),
        workflows: workflowsOf(project, sessionId),
      };
      onProgress?.(sessionId);
    }
  }
  for (const id of Object.keys(idx.sessions)) if (!seen.has(id)) delete idx.sessions[id];
  saveIndex(idx);
  return idx;
}

// ---------------------------------------------------------------------------- the Linear join
// The hook's own state, read but never written: repo#branch -> issue. It is the deliberate record of
// what Victor said a branch was for, so it outranks anything inferred from a transcript.
export function linearState() {
  try { return JSON.parse(readFileSync(join(homedir(), '.claude', 'linear-work-state.json'), 'utf8')); }
  catch { return {}; }
}

// Sessions grouped by the work they touched. A session can name several tickets and belong to
// several groups — that is honest: one sitting often moves two tickets.
export function byTicket(idx, state = linearState()) {
  const groups = {};
  const add = (ticket, sessionId, how) => {
    const g = groups[ticket] = groups[ticket] || { ticket, sessions: [], branches: new Set(), how: {} };
    if (!g.sessions.includes(sessionId)) g.sessions.push(sessionId);
    (g.how[sessionId] = g.how[sessionId] || new Set()).add(how);
  };
  // Branch -> issue, as recorded by the hook. This is the strong signal.
  const branchIssue = {};
  for (const [key, v] of Object.entries(state)) {
    if (!v || !v.issue) continue;
    const branch = key.split('#').slice(1).join('#');
    if (branch) (branchIssue[branch] = branchIssue[branch] || new Set()).add(v.issue);
  }
  for (const s of Object.values(idx.sessions)) {
    for (const t of s.tickets) add(t, s.sessionId, 'named in the session');
    for (const br of s.branches) for (const t of branchIssue[br] || []) { add(t, s.sessionId, 'branch linked in Linear hook'); groups[t].branches.add(br); }
  }
  for (const g of Object.values(groups)) {
    g.branches = [...g.branches];
    for (const k of Object.keys(g.how)) g.how[k] = [...g.how[k]];
  }
  return groups;
}
