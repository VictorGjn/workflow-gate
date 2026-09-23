// Picking a project back up after six weeks, without reading six weeks of transcripts.
//
// The thread of a piece of work is already on disk, in four places that nothing joins: the session
// transcripts, the handoffs, the memories, and the Linear hook's state. Measured on "company brain":
// 14 sessions mention it, 7 handoffs cover it, 38 memories touch it — and ZERO sessions say so in
// their title. The densest one (148 mentions) is called "Let's surface the hubspot automations work".
// So a thread cannot be assembled from titles or metadata. It is assembled by searching the text.
//
// Handoffs carry the part that matters most and is nowhere else: of 72 on disk, 58 have a Decisions
// section, 69 name a next action, 24 list what was tried and must not be retried again.
//
// Read-only, zero dependencies, no network.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const H = homedir();
const HANDOFFS = join(H, '.claude', 'handoffs');
const MEMORY = join(H, '.claude', 'projects', 'C--Users-victo', 'memory');
const PROJECTS = join(H, '.claude', 'projects');
const ls = (p) => { try { return readdirSync(p); } catch { return []; } };

// ---------------------------------------------------------------------------- handoffs
// Section headings drift between handoffs (Decisions / Decisions made / Done closed), so match on a
// stem rather than an exact title, and keep the prose verbatim — a summary of a decision is a
// second-hand decision.
const SECTION = /^##+[ \t]*(.+?)[ \t]*$/gm;
function sectionsOf(md) {
  const out = [];
  const marks = [...md.matchAll(SECTION)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : md.length;
    out.push({ title: marks[i][1].trim(), body: md.slice(start, end).trim() });
  }
  return out;
}
const pick = (secs, re) => secs.filter((s) => re.test(s.title)).map((s) => s.body).join('\n\n').trim() || null;

// '# gbrain — Handoff (2026-07-01)' has a real name; '# Handoff' does not. Fall back to the filename
// rather than showing seven rows all called Handoff.
function titleOf(h1, file) {
  const t = h1.split('—')[0].replace(/^#+\s*/, '').trim();
  if (t && !/^handoff\b/i.test(t)) return t;
  return file.replace(/\.md$/, '')
    .replace(/[-_]?\d{4}-\d{2}-\d{2}$/, '')
    .replace(/[_-]+/g, ' ')
    .trim() || t || file;
}

export function readHandoff(file) {
  let md; try { md = readFileSync(join(HANDOFFS, file), 'utf8'); } catch { return null; }
  const secs = sectionsOf(md);
  const h1 = (md.match(/^#\s+(.+)$/m) || [])[1] || file.replace(/\.md$/, '');
  // "# title — Handoff (2026-09-03) · Status: ready (design done, no code yet)"
  const status = (h1.match(/Status:\s*(.+)$/) || md.match(/^\*\*Status:?\*\*\s*(.+)$/m) || [])[1] || null;
  const date = (file.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  let mtime = null; try { mtime = statSync(join(HANDOFFS, file)).mtimeMs; } catch {}
  return {
    file, title: titleOf(h1, file), status: status?.trim() || null,
    date: date || (mtime ? new Date(mtime).toISOString().slice(0, 10) : null), dateFromFile: !!date,
    mtime, chars: md.length,
    resume: pick(secs, /resume here|next|goal/i),
    decisions: pick(secs, /decision/i),
    failed: pick(secs, /failed|do not retry/i),
    open: pick(secs, /open question/i),
    done: pick(secs, /done|closed|discovered/i),
  };
}

// ---------------------------------------------------------------------------- the search
// One case-insensitive scan over everything, with the term as a plain string: the caller types
// "company brain" or "PRD-132", not a regex, and a stray bracket must not throw.
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The query is split on separators too, not only spaces: someone looking for a thread types
// 'company-brain' as readily as 'company brain', and they are the same thread. A query of nothing
// BUT separators ('---') leaves no terms, and an empty RegExp matches at every position — which on
// 120 MB of transcripts means millions of empty matches and every file reported as a hit. Null
// instead, and the caller returns an empty thread.
const termRe = (q) => {
  const parts = q.trim().split(/[\s._-]+/).filter(Boolean).map(esc);
  return parts.length ? new RegExp(parts.join('[\\s._-]?'), 'gi') : null;
};
const count = (text, re) => { const m = String(text).match(re); return m ? m.length : 0; };

// A transcript is 5 MB of JSON; counting mentions in the raw text is both fast and good enough to
// rank. Extracting WHAT was said needs the parsed lines, so that is done only for the top hits.
export function searchThread(query, { sessionIndex, maxSessions = 12 } = {}) {
  const re = termRe(query);
  const out = { query, handoffs: [], memories: [], skills: [], sessions: [], tickets: [] };
  if (!re) return out;                                   // nothing to search for is not everything
  const ticketVotes = {};

  for (const f of ls(HANDOFFS)) {
    // README/INDEX files live in the handoffs folder without being handoffs; they have no status, no
    // decisions and no next action, and they would head the chronology by being the oldest file there.
    if (!f.endsWith('.md') || /^(readme|index|_)/i.test(f)) continue;
    let md; try { md = readFileSync(join(HANDOFFS, f), 'utf8'); } catch { continue; }
    const n = count(md, re) + count(f, re) * 5;          // a hit in the filename is a strong signal
    if (n) out.handoffs.push({ ...readHandoff(f), mentions: n });
  }
  out.handoffs.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.mtime - b.mtime);

  for (const f of ls(MEMORY)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    let md; try { md = readFileSync(join(MEMORY, f), 'utf8'); } catch { continue; }
    const n = count(md, re) + count(f, re) * 5;
    if (n) out.memories.push({ file: f, mentions: n, type: (md.match(/^\s*type:\s*(\w+)/m) || [])[1] || null,
      description: (md.match(/^description:\s*(.+)$/m) || [])[1] || '' });
  }
  out.memories.sort((a, b) => b.mentions - a.mentions);

  for (const d of ls(join(H, '.claude', 'skills'))) if (count(d, re)) out.skills.push(d);

  for (const proj of ls(PROJECTS)) for (const f of ls(join(PROJECTS, proj))) {
    if (!f.endsWith('.jsonl')) continue;
    let text; try { text = readFileSync(join(PROJECTS, proj, f), 'utf8'); } catch { continue; }
    const n = count(text, re);
    if (n < 3) continue;                                  // one passing mention is not participation
    const id = f.slice(0, -6);
    const s = sessionIndex?.sessions?.[id];
    out.sessions.push({
      sessionId: id, project: proj, mentions: n,
      title: s?.title || null, endedAt: s?.endedAt || null, activeMs: s?.activeMs || 0,
      sittings: s?.sittings || 1, workflows: s?.workflows || [], skills: s?.skills || [],
      tickets: s?.tickets || [], tools: s?.tools || {},
    });
    for (const t of s?.tickets || []) ticketVotes[t] = (ticketVotes[t] || 0) + 1;
  }
  out.sessions.sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''));
  out.sessions = out.sessions.slice(0, maxSessions);
  // A ticket named by one session that merely mentioned the term is noise; one named by several is
  // the thread. Keep the recurring ones, and never more than can be read at a glance.
  out.tickets = Object.entries(ticketVotes).filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, n]) => ({ ticket: t, sessions: n }));
  return out;
}

// ---------------------------------------------------------------------------- inputs & outputs
// What a session was ASKED and what it PRODUCED. Both are in the transcript and neither is indexed:
// the prompts are what you told it to do, the written paths are what came out. Parsed on demand for
// one session, because it means walking that session's whole file.
export function sessionDetail(project, sessionId, { maxPrompts = 25 } = {}) {
  const file = join(PROJECTS, project, sessionId + '.jsonl');
  let text; try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const prompts = [], wrote = new Map(), read = new Set(), commands = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'user' && !e.isSidechain && typeof e.message?.content === 'string'
      && !/^\s*<(command-|task-notification|system-reminder|local-command)/.test(e.message.content)) {
      const t = e.message.content.replace(/\s+/g, ' ').trim();
      if (t) prompts.push({ at: e.timestamp || null, text: t.slice(0, 400) });
    }
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type !== 'tool_use') continue;
      const i = b.input || {};
      const p = i.file_path || i.path || i.notebook_path;
      if (typeof p === 'string' && p.length > 3) {
        if (/^(Write|Edit|NotebookEdit)$/.test(b.name)) wrote.set(p, (wrote.get(p) || 0) + 1);
        else read.add(p);
      }
      // Commits and pushes are decisions that left the machine — worth surfacing on their own.
      if (b.name === 'Bash' && typeof i.command === 'string' && /\bgit (commit|push|tag)\b/.test(i.command))
        commands.push(i.command.replace(/\s+/g, ' ').slice(0, 160));
    }
  }
  return {
    sessionId, project,
    prompts: prompts.slice(0, maxPrompts), promptCount: prompts.length,
    wrote: [...wrote.entries()].sort((a, b) => b[1] - a[1]).map(([path, n]) => ({ path, edits: n })),
    readCount: read.size,
    gitCommands: [...new Set(commands)].slice(0, 12),
  };
}
