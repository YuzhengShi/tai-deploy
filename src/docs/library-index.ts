/**
 * The course library's index (docs/COURSE_DOCS.md): `<store>/course-docs/index.json`, one row for each deck the operator added, kept next to the decks' own directories (`<id>/`, the same layout as a
 * student's document). The operator's `course-docs` commands write it (src/docs/library.ts); the orchestrator only reads it. A row says which deck is which: its id, title, week (a number or none),
 * the name of the file it was made from, the pages, and the SHA-256 of that file (so that the same file is not added twice). Whatever is read is checked field by field, and a row that does not pass is
 * dropped: the file is the operator's, but it is also a file on disk that something else may have damaged.
 */
import { oneLine } from '../chat-objects/text.js';
import { DOC_ID, DOC_LIMITS, LIBRARY_LIMITS } from './types.js';

export const INDEX_FILE = 'index.json';
/** What an index file may weigh when it is read (a hundred rows are about 30 KB). */
export const INDEX_MAX_BYTES = 256 * 1024;

export interface LibraryRow {
  id: string;
  title: string;
  week: number | null;
  sourceName: string;
  sha256: string;
  pages: number;
  pagesInFile?: number;
  bytes: number;
  createdAt: number;
}

const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** A week number, or null when there is none (or it is not one the course has). */
export const cleanWeek = (v: unknown): number | null => (whole(v, 1, LIBRARY_LIMITS.maxWeek) ? v : null);

/**
 * The week a name says it is, or null: "Week 5", "week5", "Wk 05", "W5" (not "HW5": a letter in front of the W means it is part of another word). The first one counts.
 */
export function weekFrom(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = /(?:^|[^A-Za-z0-9])(?:week|wk|w)[\s._-]{0,2}0?(\d{1,2})(?![0-9])/i.exec(text.slice(0, 300));
  return m ? cleanWeek(Number(m[1])) : null;
}

/** One row as the file holds it, or null. */
export function cleanRow(raw: unknown): LibraryRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !DOC_ID.test(r.id)) return null;
  if (typeof r.title !== 'string' || r.title.trim().length === 0 || r.title.length > DOC_LIMITS.titleChars) return null;
  if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) return null;
  if (!whole(r.pages, 1, DOC_LIMITS.pages)) return null;
  if (typeof r.bytes !== 'number' || !Number.isFinite(r.bytes) || r.bytes < 0) return null;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt) || r.createdAt < 0) return null;
  const row: LibraryRow = {
    id: r.id,
    title: oneLine(r.title, DOC_LIMITS.titleChars),
    week: cleanWeek(r.week),
    sourceName: typeof r.sourceName === 'string' ? oneLine(r.sourceName, 200) : '',
    sha256: r.sha256,
    pages: r.pages,
    bytes: r.bytes,
    createdAt: r.createdAt,
  };
  if (whole(r.pagesInFile, r.pages + 1, 1_000_000)) row.pagesInFile = r.pagesInFile;
  return row.title.length > 0 ? row : null;
}

/** The rows of an index file's JSON text: the ones that pass, each id once, at most LIBRARY_LIMITS.entries. An index that is not one is no rows. */
export function parseLibraryIndex(text: string): LibraryRow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(list)) return [];
  const rows: LibraryRow[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, LIBRARY_LIMITS.entries * 2)) {
    const row = cleanRow(item);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    if (rows.length >= LIBRARY_LIMITS.entries) break;
  }
  return rows;
}

export function serializeLibraryIndex(rows: readonly LibraryRow[]): string {
  return `${JSON.stringify({ v: 1, entries: rows }, null, 1)}\n`;
}

/** Titles compared the way a person would: letters and digits only, lower case. */
export const titleKey = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
