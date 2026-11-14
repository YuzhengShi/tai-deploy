/**
 * The three kinds of fact TAi keeps of a student's WORK (docs/STUDENT_STATE.md): the repository that holds their code for an assignment (`repo`), where the last
 * session stopped (`thread`) and a concrete problem they ran into (`issue`). They are rows of the `memories` table (src/memory.ts upsertWorkFact / listWorkFacts), written by
 * the HOST only, read by the text agent, the voice call and the page's "What TAi remembers". This file is the contract between those: the shapes, the keys, the caps and, above
 * all, the bounding of the text, because most of it is a model's paraphrase of what a student wrote, and goes back into prompts. It is pure: no database, no clock, no files.
 */

export const WORK_CATEGORIES = ['repo', 'thread', 'issue'] as const;
export type WorkCategory = (typeof WORK_CATEGORIES)[number];

export const isWorkCategory = (value: unknown): value is WorkCategory => typeof value === 'string' && (WORK_CATEGORIES as readonly string[]).includes(value);

export interface WorkFact {
  category: WorkCategory;
  /** `repo:hw2`, `repo:3507937`, `thread:raft-timeouts`, `issue:cache-deadlock`: one row per key, the newest write wins. */
  key: string;
  /** `repo` only: the repository name, no owner (the account is the host's binding). */
  value?: string;
  /** One line, 160 characters at most, already bounded (boundWorkText). */
  text: string;
}

/** A fact as the database holds it: `at` is when it was written or last renewed (ms since the epoch). */
export interface StoredWorkFact extends WorkFact {
  at: number;
}

/** The most rows of each kind a student has; past it the oldest goes. */
export const WORK_CAPS: Readonly<Record<WorkCategory, number>> = { repo: 20, thread: 3, issue: 12 };
export const WORK_TEXT_MAX = 160;
/** A repository name as GitHub spells one (no owner, no slash). */
export const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const KEY = /^(repo|thread|issue):[a-z0-9][a-z0-9-]{0,59}$/;

/** Whether `key` is a well-formed key of `category` (`repo:` for a repo, and so on). */
export const isWorkKey = (category: WorkCategory, key: unknown): key is string => typeof key === 'string' && KEY.test(key) && key.startsWith(`${category}:`);

// ---------------------------------------------------------------- bounding text

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
/** Hashes, tokens, ids: a run of 12 or more hex digits or of 7 or more digits has no business in a note about a student's work. */
const LONG_RUN = /\b(?:[0-9a-f]{12,}|\d{7,})\b/gi;

/**
 * Text that may be stored and read back into a prompt: one line, the characters that frame or break a prompt taken out (angle brackets, backticks, the characters that hide or reorder text), no links, no
 * e-mail addresses, no long digit or hex runs, no leading list or quote marks, at most `max` characters. '' for anything that is not text or has no word in it.
 */
export function boundWorkText(raw: unknown, max = WORK_TEXT_MAX): string {
  if (typeof raw !== 'string') return '';
  const text = raw
    .slice(0, max * 8 + 64)
    .replace(CONTROL, ' ')
    .replace(URL_LIKE, ' ')
    .replace(EMAIL_LIKE, ' ')
    .replace(LONG_RUN, ' ')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s>*#-]+/, '')
    .trim();
  if (!/[A-Za-z]{2}/.test(text)) return '';
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

/** A key part: lowercase letters, digits and single hyphens, at most `max` characters; '' when nothing is left. */
export function slugOf(text: unknown, max = 40): string {
  if (typeof text !== 'string') return '';
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug;
}

/** "Homework 2: MapReduce..." -> "hw2", "Homework 1b: Rocking AWS" -> "hw1b", "HW7: Cost savings" -> "hw7"; '' for an assignment that is not a numbered homework. */
export function homeworkSlug(name: unknown): string {
  if (typeof name !== 'string') return '';
  const m = /\b(?:homework|hw)\s*#?\s*(\d{1,2})\s*([a-z])?\b/i.exec(name);
  return m ? `hw${Number(m[1])}${(m[2] || '').toLowerCase()}` : '';
}

// ---------------------------------------------------------------- keys and facts

/** The key a repository is kept under: the homework number when the name has one (it is the same assignment next term, with another id), else the Canvas id; null when neither is usable. */
export function repoKey(assignmentId: unknown, assignmentName: unknown): string | null {
  const hw = homeworkSlug(assignmentName);
  if (hw) return `repo:${hw}`;
  const id = typeof assignmentId === 'string' ? assignmentId.trim() : '';
  return /^\d{1,15}$/.test(id) ? `repo:${id}` : null;
}

/** Both keys an assignment may have been kept under (the homework number first), for reading. */
export function repoKeys(assignmentId: unknown, assignmentName: unknown): string[] {
  const keys: string[] = [];
  const hw = homeworkSlug(assignmentName);
  if (hw) keys.push(`repo:${hw}`);
  const id = typeof assignmentId === 'string' ? assignmentId.trim() : '';
  if (/^\d{1,15}$/.test(id)) keys.push(`repo:${id}`);
  return keys;
}

/** "Their code for Homework 2: MapReduce, Terraform, and Docker is in their repository name." Null when the repository is not a name GitHub could have or there is no key. */
export function repoFact(assignmentId: unknown, assignmentName: unknown, repo: unknown): WorkFact | null {
  const key = repoKey(assignmentId, assignmentName);
  if (!key || typeof repo !== 'string' || !REPO_NAME.test(repo)) return null;
  const label = boundWorkText(assignmentName, 70) || (key.startsWith('repo:hw') ? `homework ${key.slice(7)}` : 'this assignment');
  const text = boundWorkText(`Their code for ${label} is in their repository ${repo}.`);
  return text ? { category: 'repo', key, value: repo, text } : null;
}

/** "Nov 6" in the course's Pacific time. */
export function dayLabel(ms: number): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }).format(ms);
  } catch {
    return '';
  }
}

/** Where a session stopped: one row per topic ("Left open on Nov 6: ..."); null when there is no sentence or no topic to key it by. */
export function threadFact(topic: unknown, sentence: unknown, at: number): WorkFact | null {
  const slug = slugOf(boundWorkText(topic, 80)) || 'last-session';
  const body = boundWorkText(sentence, 130);
  if (!body) return null;
  const day = dayLabel(at);
  const text = boundWorkText(`${day ? `Left open on ${day}: ` : 'Left open: '}${body}`);
  return text ? { category: 'thread', key: `thread:${slug}`, text } : null;
}

/** A problem in their work: one row per problem ("... (Nov 6)"); the key is the problem's own words, so the same problem described again replaces its row. */
export function issueFact(problem: unknown, at: number): WorkFact | null {
  const body = boundWorkText(problem, 140);
  const slug = slugOf(body, 48);
  if (!body || !slug) return null;
  const day = dayLabel(at);
  const text = boundWorkText(day ? `${body} (${day})` : body);
  return text ? { category: 'issue', key: `issue:${slug}`, text } : null;
}

// ---------------------------------------------------------------- reading

/** A well-formed fact of a row's columns (the database's, or the export file's): anything else is null. The text is bounded again: whatever wrote the row, a prompt gets bounded text. */
export function workFactOf(row: { category?: unknown; key?: unknown; value?: unknown; text?: unknown; created_at?: unknown; at?: unknown }): StoredWorkFact | null {
  if (!isWorkCategory(row.category) || !isWorkKey(row.category, row.key)) return null;
  const text = boundWorkText(row.text);
  if (!text) return null;
  let value: string | undefined;
  if (row.category === 'repo') {
    if (typeof row.value !== 'string' || !REPO_NAME.test(row.value)) return null;
    value = row.value;
  }
  const at = Number(row.at ?? row.created_at);
  return { category: row.category, key: row.key, ...(value ? { value } : {}), text, at: Number.isFinite(at) ? at : 0 };
}

/** The work facts in the text of a `memory_store.json` export (`{memories: [...]}`), newest first; [] for anything that is not one. */
export function workFactsFromExport(json: string | null | undefined): StoredWorkFact[] {
  if (!json) return [];
  try {
    const store = JSON.parse(json) as { memories?: unknown };
    const rows = Array.isArray(store?.memories) ? (store.memories as Array<Record<string, unknown>>) : [];
    return rows.map((r) => (r && typeof r === 'object' ? workFactOf(r) : null)).filter((f): f is StoredWorkFact => f !== null).sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/**
 * The facts a prompt should carry, in order: the repository of the assignment in question (its keys, or else the two newest repositories), then the newest open thread, then the newest issues,
 * at most `max` in all. Facts are given newest first.
 */
export function pickWork(facts: readonly StoredWorkFact[], opts: { max?: number; repoKeys?: readonly string[] } = {}): StoredWorkFact[] {
  const max = Math.max(0, opts.max ?? 6);
  const repos = facts.filter((f) => f.category === 'repo');
  const wanted = opts.repoKeys?.length ? repos.filter((f) => opts.repoKeys!.includes(f.key)) : repos.slice(0, 2);
  const picked = [...wanted.slice(0, 2), ...facts.filter((f) => f.category === 'thread').slice(0, 2), ...facts.filter((f) => f.category === 'issue').slice(0, 3)];
  return picked.slice(0, max);
}

/** The words that tell a model what these lines are: from earlier sessions, perhaps out of date, to ask about and never to assert. */
export const WORK_NOTE = 'These notes are from earlier sessions and may be out of date: use them to ask ("last time you ran into ..., how did it end?"), never to assert, never to correct them with it, and never to say a score or a grade.';
