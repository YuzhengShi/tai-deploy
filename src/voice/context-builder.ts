/**
 * What a call starts knowing. The text agent gets its context written into the group folder before its container starts
 * (memory_context.md); a call gets the same state as Deepgram `agent.context.messages`, so the voice agent begins mid-relationship
 * instead of from zero:
 *
 *   - COMPETENCY.md, condensed, as a read_competency call the agent "already made" (a client-side function call in the History);
 *   - the student's memories, as a recall_memory call it already made;
 *   - the last lines of the page's chat are in the prompt's background block, NOT as History turns (as turns they were taken for what TAi had
 *     just said to this student, and the call opened with "how can I help you with Raft today?").
 *
 * And, for a mock interview, the assignment context that the start_mock_interview tool writes to groups/<folder>/interview_context.json
 * (ported from voice/context-loader.ts; the Python fallback is gone: the tool host is what runs those scripts now).
 */
import path from 'path';

import { distance } from './canvas-text.js';

import { interviewProfile, readText, summarizeCompetency } from './competency.js';
import { sharesWord } from './interview-topic.js';
import { parseWeekBrief, type WeekBriefView } from './week-brief.js';
import { isWorkCategory, workFactOf, workFactsFromExport } from '../work-facts.js';
import type { StoredWorkFact } from '../work-facts.js';

export type HistoryItem =
  | { type: 'History'; role: 'user' | 'assistant'; content: string }
  | { type: 'History'; function_calls: Array<{ id: string; name: string; client_side: true; arguments: string; response: string }> };

export interface ChatLine {
  role: 'user' | 'assistant';
  text: string;
}

export interface StudentContext {
  competencyText: string | null;
  competencySummary: string;
  memories: string[];
  /** What TAi remembers of their work (a repository, where a session stopped, a problem: docs/STUDENT_STATE.md), newest first: the three kinds the memories above leave out. */
  work: StoredWorkFact[];
  recentChat: ChatLine[];
  courseStatus: string;
}

export interface StudentContextSource {
  groupsDir: string;
  folder: string;
  jid: string;
  /** The page's chat, newest last (the portal's HistoryStore). */
  recentChat?: (folder: string, n: number) => ChatLine[];
  /** The student's memories as lines; without it they are read from groups/<folder>/memory_store.json. */
  memories?: (folder: string, jid: string) => string[];
  /** What TAi remembers of the student's work, newest first; without it the same file's repository, thread and issue rows are read (workFactsFromExport). */
  workFacts?: (folder: string) => StoredWorkFact[];
  warn?: (message: string) => void;
  /** The clock (default Date.now): the deadlines of the course status are told as they stand at this moment. */
  now?: () => number;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** The most facts of their work a call holds (the caps per kind add up to 35). */
const WORK_KEPT = 40;

/** Text that goes into a prompt: no control characters, collapsed, capped. */
export function clip(text: string, max: number): string {
  const clean = text.replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3).trimEnd() + '...';
}

/**
 * Memories from the file the text agent's pre-flight writes (and the IPC watcher refreshes after each memory_store). The three kinds of fact about their work (a repository, where a
 * session stopped, a problem) are not here: they come in `work`, so that nothing is said twice.
 */
export function memoriesFromStore(groupDir: string, limit = 6): string[] {
  const text = readText(path.join(groupDir, 'memory_store.json'), groupDir);
  if (!text) return [];
  try {
    const store = JSON.parse(text) as { memories?: Array<{ text?: unknown; category?: unknown; key?: unknown; value?: unknown; created_at?: unknown }> };
    const memories = Array.isArray(store.memories) ? store.memories : [];
    return memories
      .filter((m) => m && typeof m.text === 'string' && m.text.trim() && !isWorkCategory(m.category))
      .sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0))
      .slice(0, limit)
      .map((m) => {
        const kv = typeof m.key === 'string' && typeof m.value === 'string' && m.key && m.value ? ` [${m.key}=${m.value}]` : '';
        const category = typeof m.category === 'string' && m.category ? `[${m.category}]` : '[memory]';
        return clip(`${category}${kv} ${m.text as string}`, 300);
      });
  } catch {
    return [];
  }
}

/**
 * "- 2026-11-02 17:00 UTC (Mon Nov 2, 9:00 AM PST): Midterm Mastery Part 2 (within 24 hours)" as it stands now: "- Midterm Mastery Part 2: due in 62
 * minutes (Mon Nov 2, 9:00 AM PST)", or "was due 27 minutes ago". The file is written every six hours, and the model, given "9:00 AM PST" and the
 * time, said "is due" of a deadline that had passed half an hour before.
 */
export function freshDeadline(line: string, now: number): string {
  const m = /^-\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})\s*UTC\s*\(([^)]*)\):\s*(.*?)(?:\s*\((?:within|in)\s[^)]*\))?\s*$/.exec(line.trim());
  if (!m) return line;
  const due = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  if (Number.isNaN(due.getTime())) return line;
  const away = distance(due.toISOString(), now);
  return `- ${m[7]}: ${away.endsWith(' ago') ? `was due ${away}` : `due ${away}`} (${m[6]})`;
}

/**
 * What a call needs of COURSE_STATUS.md: the deadlines, the alerts and the names of the weeks. The file opens with the syllabus (whose
 * first words are a land acknowledgement), so its first 1200 characters, which is all that fitted before, held nothing of use.
 */
export function courseStatusExcerpt(status: string, max = 1500, now: number = Date.now()): string {
  const sections = new Map<string, string>();
  let name = '';
  for (const line of status.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      name = heading[1].toLowerCase();
      sections.set(name, '');
    } else if (name) sections.set(name, `${sections.get(name) ?? ''}${line}\n`);
  }
  const section = (title: string): string => [...sections.entries()].find(([k]) => k.startsWith(title))?.[1].trim() ?? '';
  const weeks = section('course structure')
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*(module\b|:?-)/i.test(l))
    .map((l) => l.split('|')[1]?.trim())
    .filter(Boolean)
    .join('; ');
  const deadlines = section('upcoming deadlines')
    .split('\n')
    .map((l) => freshDeadline(l, now))
    .join('\n');
  // "due within 24 hours" was true when the file was written; the deadlines above say how it stands now
  const alerts = section('alerts')
    .split('\n')
    .filter((l) => !/^-\s*due within/i.test(l.trim()))
    .join('\n')
    .trim();
  const parts = [/^Last synced:.*$/m.exec(status)?.[0] ?? '', deadlines && `Upcoming deadlines:\n${deadlines}`, alerts && `Alerts:\n${alerts}`, weeks && `The course's modules: ${weeks}`].filter(Boolean);
  return parts.length > 1 ? clip(parts.join('\n\n'), max) : clip(status, max);
}

export function loadStudentContext(src: StudentContextSource): StudentContext {
  const groupDir = path.join(src.groupsDir, src.folder);
  const competencyText = readText(path.join(groupDir, 'COMPETENCY.md'), groupDir);
  let memories: string[] = [];
  try {
    memories = src.memories ? src.memories(src.folder, src.jid).slice(0, 6).map((m) => clip(m, 300)) : memoriesFromStore(groupDir);
  } catch (err) {
    src.warn?.(`voice: memories unavailable (${(err as Error).message})`);
  }
  let work: StoredWorkFact[] = [];
  try {
    const given = src.workFacts ? src.workFacts(src.folder) : workFactsFromExport(readText(path.join(groupDir, 'memory_store.json'), groupDir));
    // whoever gave them, a prompt gets well-formed facts with bounded text, newest first (a failing read is no facts)
    work = (Array.isArray(given) ? given : [])
      .map((f) => (f && typeof f === 'object' ? workFactOf(f) : null))
      .filter((f): f is StoredWorkFact => f !== null)
      .sort((a, b) => b.at - a.at)
      .slice(0, WORK_KEPT);
  } catch (err) {
    src.warn?.(`voice: what is remembered of their work is unavailable (${(err as Error).message})`);
  }
  let recentChat: ChatLine[] = [];
  try {
    recentChat = (src.recentChat?.(src.folder, 12) ?? [])
      .filter((l) => (l.role === 'user' || l.role === 'assistant') && typeof l.text === 'string' && l.text.trim())
      .slice(-5)
      .map((l) => ({ role: l.role, text: clip(l.text, 600) }));
  } catch (err) {
    src.warn?.(`voice: chat history unavailable (${(err as Error).message})`);
  }
  const status = readText(path.join(src.groupsDir, 'global', 'COURSE_STATUS.md'));
  return {
    competencyText,
    competencySummary: summarizeCompetency(competencyText),
    memories,
    work,
    recentChat,
    courseStatus: status ? courseStatusExcerpt(status, 1500, src.now ? src.now() : Date.now()) : '',
  };
}

/**
 * Settings' agent.context.messages. The memories ride on a recall_memory call only in the conversational mode: a call that starts as a
 * mock interview has no recall_memory function, and a History call to a function the agent does not have is asking for trouble.
 */
export function buildContextMessages(ctx: StudentContext, opts: { withMemoryCall: boolean }): HistoryItem[] {
  const items: HistoryItem[] = [
    {
      type: 'History',
      function_calls: [{ id: 'ctx_competency', name: 'read_competency', client_side: true, arguments: '{}', response: ctx.competencySummary }],
    },
  ];
  if (opts.withMemoryCall && ctx.memories.length > 0) {
    items.push({
      type: 'History',
      function_calls: [
        { id: 'ctx_memory', name: 'recall_memory', client_side: true, arguments: JSON.stringify({ query: 'student context' }), response: ctx.memories.join('\n') },
      ],
    });
  }
  // The last lines of the page's chat are NOT put in as turns of this call: as History they were taken for what TAi had just said to this
  // student (three Raft summaries from earlier, "how can I help you with Raft today?"). The prompt's background block lists them, as background.
  return items;
}

// ---------------------------------------------------------------- the mock interview's assignment context

export interface InterviewContext {
  studentName: string;
  assignmentId: string;
  assignmentName: string;
  assignmentSpec: string;
  lectureContent: string;
  submissionText: string;
  codeExcerpts: string;
  weakConcepts: string[];
  verbalGaps: string[];
  misconceptions: string[];
  topic: string;
  /** What Canvas, GitHub and Piazza show of the student's week (the file's `weekBrief`, cleaned: week-brief.ts); null when the file has none or it is not a usable one. */
  week: WeekBriefView | null;
  /** Where it came from: the tool's file, or only COMPETENCY.md and the topic the student named. */
  source: 'file' | 'competency';
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? clip(value.replace(/\r/g, ''), max) : '';
}

function keepNewlines(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(CONTROL, ' ').replace(/\r/g, '');
  return clean.length <= max ? clean.trim() : clean.slice(0, max).trimEnd() + ' [...]';
}

function strings(value: unknown, maxItems: number, maxChars: number): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, maxItems).map((x) => clip(x, maxChars)) : [];
}

export interface InterviewContextRequest {
  groupDir: string;
  studentName: string;
  competencyText: string | null;
  assignmentId?: string;
  topic?: string;
  now: number;
  /** How old the tool's file may be and still count (default two hours). */
  maxAgeMs?: number;
  /** Only COMPETENCY.md and the topic, not the tool's file. */
  skipFile?: boolean;
}

/**
 * The interviewer's material. `fresh` says whether interview_context.json was usable (recent enough, and for the assignment asked for);
 * when it is not, the context is COMPETENCY.md and the topic, and the caller may ask the tool host to fetch the assignment.
 */
export function loadInterviewContext(req: InterviewContextRequest): { context: InterviewContext; fresh: boolean } {
  const profile = req.competencyText ? interviewProfile(req.competencyText) : { name: '', weakConcepts: [], verbalGaps: [], misconceptions: [] };
  const topic = clip(req.topic || '', 120);
  const base: InterviewContext = {
    studentName: req.studentName,
    assignmentId: req.assignmentId || '',
    // empty when nobody named it: the prompts say "their most recent assignment", the spoken lines ask which one
    assignmentName: topic,
    assignmentSpec: '',
    lectureContent: '',
    submissionText: '',
    codeExcerpts: '',
    weakConcepts: profile.weakConcepts.slice(0, 10),
    verbalGaps: profile.verbalGaps.slice(0, 10),
    misconceptions: profile.misconceptions.slice(0, 6),
    topic,
    week: null,
    source: 'competency',
  };
  const text = req.skipFile ? null : readText(path.join(req.groupDir, 'interview_context.json'), req.groupDir);
  if (!text) return { context: base, fresh: false };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { context: base, fresh: false };
  } catch {
    return { context: base, fresh: false };
  }
  const generated = Date.parse(String(raw.generatedAt ?? ''));
  const age = Number.isFinite(generated) ? req.now - generated : Infinity;
  const fileAssignment = str(raw.assignmentId, 40);
  // a file is for the assignment asked for: by its id, or, when only a topic was named, by sharing a word with it (a file left by the
  // last interview, on another assignment, was once taken for the one the student had just asked to practice)
  const forThis = req.assignmentId ? req.assignmentId === fileAssignment : !topic || sharesWord(topic, str(raw.assignmentName, 160));
  const fresh = age >= -5 * 60_000 && age <= (req.maxAgeMs ?? 2 * 3600_000) && forThis;
  if (!fresh) return { context: base, fresh: false };
  const weak = strings(raw.weakConcepts, 10, 120);
  const verbal = strings(raw.verbalGaps, 10, 120);
  const mis = strings(raw.misconceptions, 6, 300);
  return {
    fresh: true,
    context: {
      ...base,
      assignmentId: fileAssignment || base.assignmentId,
      assignmentName: str(raw.assignmentName, 160) && str(raw.assignmentName, 160) !== 'Unknown' ? str(raw.assignmentName, 160) : base.assignmentName,
      assignmentSpec: keepNewlines(raw.assignmentSpec, 2500),
      lectureContent: keepNewlines(raw.lectureContent, 5000),
      submissionText: keepNewlines(raw.submissionText, 3000),
      codeExcerpts: keepNewlines(raw.codeExcerpts, 4000),
      // the tool reads COMPETENCY.md from where only the admin's container has it; the host's own reading fills what it missed
      weakConcepts: weak.length ? weak : base.weakConcepts,
      verbalGaps: verbal.length ? verbal : base.verbalGaps,
      misconceptions: mis.length ? mis : base.misconceptions,
      // (the brief is for the assignment the file is for: it is the same file, so it has the file's freshness; its due times are told as they stand now)
      week: parseWeekBrief(raw.weekBrief, req.now),
      source: 'file',
    },
  };
}
