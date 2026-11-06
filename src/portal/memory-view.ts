/**
 * What TAi remembers of a student, as the page's "What TAi remembers" panel shows it: the notes TAi saved about them (the `memories` table
 * of the orchestrator's database; the student may take one back) and a plain-words reading of their COMPETENCY.md (where each topic stands
 * as words, never as scores, and none of the ids the file or Canvas hold). It is read for ONE student's folder, and the folder comes from the
 * session, never from a request.
 *
 * The database is behind `MemoryStore`, so the reading and the wording are tested without one (better-sqlite3 has no build on every machine
 * that runs the unit tests).
 */
import path from 'path';

import { GETTING_THERE_AT, parseMastery, parseMisconceptions, parseProfile, readText, SOLID_AT } from '../voice/competency.js';
import type { MasteryEntry } from '../voice/competency.js';
import { STUDENT_FOLDER } from './history.js';

/** A saved note, as the `memories` table holds it (the columns the panel needs). */
export interface MemoryRow {
  id: string;
  text: string;
  category: string;
  created_at: number;
}

/** A saved note as the page shows it. */
export interface MemoryItem {
  id: string;
  text: string;
  /** The category in words: "Preference", "Breakthrough". */
  label: string;
  /** When TAi saved it (ISO). */
  at: string;
}

export interface TopicNote {
  name: string;
  /** The student has explained it out loud (a call, a mock interview): the "verbal" scope of the file. */
  aloud: boolean;
}

/** COMPETENCY.md in plain words: where each topic stands, what is still a mix-up, what has worked. No scores. */
export interface ProgressView {
  solid: TopicNote[];
  gettingThere: TopicNote[];
  justStarted: TopicNote[];
  /** Topics with nothing recorded yet. */
  untouched: number;
  mixups: Array<{ belief: string; about: string }>;
  works: string[];
  style: string;
}

export interface MemoryView {
  memories: MemoryItem[];
  /** null: this student has no COMPETENCY.md yet. */
  progress: ProgressView | null;
}

/** What the portal's server needs of the memory (src/portal/server.ts): without it the page has no panel. */
export interface PortalMemory {
  view(folder: string): MemoryView;
  /** Takes one saved note of this student back: false when they have no such note. */
  forget(folder: string, id: string): boolean;
}

/** The notes of one student, and the one thing that may be done to them. */
export interface MemoryStore {
  /** Newest first, the ones that have not expired at `now`. */
  list(folder: string, now: number): MemoryRow[];
  remove(folder: string, id: string): boolean;
}

/** The part of a better-sqlite3 database the store uses. */
export interface MemoryDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): { changes: number } };
}

const TOPICS_PER_GROUP = 40;
const NOTES_SHOWN = 200;
const MIXUPS_SHOWN = 5;
const WORKS_SHOWN = 3;
const LINE_CHARS = 240;
/** An id a note may have (the database makes `mem-<ms>-<random>`): nothing else is looked for, whatever the request says. */
export const MEMORY_ID = /^[A-Za-z0-9_-]{4,80}$/;

const LABELS = new Map<string, string>([
  ['student_preference', 'Preference'],
  ['identity', 'About you'],
  ['decision', 'Decision'],
  ['misconception', 'Mix-up'],
  ['breakthrough', 'Breakthrough'],
  ['concept', 'Topic'],
  ['homework', 'Homework'],
  ['session', 'Recent'],
  ['checkpoint', 'Working note'],
  ['other', 'Note'],
]);

/** A note's category in words (the categories are the agent's, so anything it made up is a plain "Note"). */
export const memoryLabel = (category: string): string => LABELS.get(category) ?? 'Note';

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, LINE_CHARS);

/** The saved notes as the page shows them: newest first as given, none without words. */
export function memoryItems(rows: MemoryRow[]): MemoryItem[] {
  const items: MemoryItem[] = [];
  for (const row of rows) {
    const text = typeof row.text === 'string' ? row.text.replace(/\r\n/g, '\n').trim().slice(0, 600) : '';
    if (!text || typeof row.id !== 'string') continue;
    items.push({ id: row.id, text, label: memoryLabel(row.category), at: Number.isFinite(row.created_at) ? new Date(row.created_at).toISOString() : '' });
  }
  return items;
}

// ---------------------------------------------------------------- COMPETENCY.md in plain words

const topic = (entry: MasteryEntry): TopicNote => ({ name: oneLine(entry.name), aloud: entry.scope.includes('verbal') });

/** The day the file last has evidence for a topic ("2026-10-30"), '' for "never" or anything that is not a date. */
const evidenceDay = (entry: MasteryEntry): string => (/^\d{4}-\d{2}-\d{2}/.test(entry.last) ? entry.last.slice(0, 10) : '');

/** Newest evidence first, then the surer, then by name: what the student worked on last comes first. */
const newestFirst = (a: MasteryEntry, b: MasteryEntry): number =>
  evidenceDay(b).localeCompare(evidenceDay(a)) || b.confidence - a.confidence || a.name.localeCompare(b.name);

/** The lines under "### Approaches That Work" (what the file has learned about this student), up to the next heading; the template's examples and "None yet" are not lines. */
function approachesThatWork(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^###\s+Approaches That Work/i.test(l));
  if (start === -1) return [];
  const out: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    if (/^#{2,3}\s/.test(raw)) break;
    const line = raw.trim();
    if (!line || line.startsWith('<!--') || /^None yet/i.test(line)) continue;
    const approach = oneLine(line.replace(/^[-*]\s*/, '').split('|')[0]);
    if (approach) out.push(approach);
    if (out.length >= WORKS_SHOWN) break;
  }
  return out;
}

/**
 * The student's COMPETENCY.md as words: "solid" from 0.7 up, "getting there" from 0.4, "just started" below that (when anything at all is
 * recorded), and a count of the topics with nothing yet. Neither the scores nor the stability or the dates leave this function.
 */
export function progressView(text: string | null): ProgressView | null {
  if (!text || !text.trim()) return null;
  const entries = parseMastery(text);
  const touched = entries.filter((e) => e.confidence > 0 || e.scope.length > 0).sort(newestFirst);
  const between = (from: number, to: number) => touched.filter((e) => e.confidence >= from && e.confidence < to).slice(0, TOPICS_PER_GROUP).map(topic);
  return {
    solid: between(SOLID_AT, 1.01),
    gettingThere: between(GETTING_THERE_AT, SOLID_AT),
    justStarted: between(0, GETTING_THERE_AT),
    untouched: entries.length - touched.length,
    mixups: parseMisconceptions(text)
      .slice(0, MIXUPS_SHOWN)
      .map((m) => ({ belief: oneLine(m.belief), about: m.contradicts.startsWith('[') ? '' : oneLine(m.contradicts) })),
    works: approachesThatWork(text),
    style: oneLine(parseProfile(text).learningStyle),
  };
}

// ---------------------------------------------------------------- the two together

/** The panel's data for a student: their saved notes (from `store`) and their COMPETENCY.md (under `groupsDir/<folder>/`). */
export class StudentMemory implements PortalMemory {
  constructor(
    private readonly store: MemoryStore,
    private readonly groupsDir: string,
    private readonly now: () => number = Date.now,
    /** Called after a note was taken back, with the folder: the copies derived from the notes (memory_store.json) are rebuilt there. */
    private readonly afterForget: (folder: string) => void = () => undefined,
  ) {}

  view(folder: string): MemoryView {
    if (!STUDENT_FOLDER.test(folder)) return { memories: [], progress: null };
    return {
      memories: memoryItems(this.store.list(folder, this.now())),
      progress: progressView(readText(path.join(this.groupsDir, folder, 'COMPETENCY.md'), path.join(this.groupsDir, folder))),
    };
  }

  forget(folder: string, id: string): boolean {
    if (!STUDENT_FOLDER.test(folder) || !MEMORY_ID.test(id)) return false;
    const gone = this.store.remove(folder, id);
    if (gone) this.afterForget(folder);
    return gone;
  }
}

/** The notes in the orchestrator's database (`getDb` from src/db.ts): a student's own, and only by the folder the session names. */
export function sqliteMemoryStore(getDb: () => MemoryDb): MemoryStore {
  return {
    list: (folder, now) =>
      getDb()
        .prepare(
          `SELECT id, text, category, created_at FROM memories WHERE student_folder = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT ${NOTES_SHOWN}`,
        )
        .all(folder, now) as MemoryRow[],
    remove: (folder, id) => getDb().prepare('DELETE FROM memories WHERE id = ? AND student_folder = ?').run(id, folder).changes > 0,
  };
}
