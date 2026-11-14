/**
 * What the host keeps of prepared documents (docs/DOCUMENTS.md, docs/CHAT_OBJECTS.md section 4):
 *
 *   <store>/portal/docs/<folder>/<id>/        a student's own: <folder> is their chat folder (isChatFolder), <id> is 32 random hex digits (DOC_ID), the only thing that becomes a path segment
 *     meta.json                                DocMeta
 *     p001.png|jpg ...                         one image of each page (PNG or JPEG: sniffed from the bytes whenever it is served, never taken from a name)
 *     w001.json ...                            PageWords of each page, written by the host from words it validated
 *     source.json                              { sha256, name }: what the document was made from, so that the same file is not rendered twice (never in DocMeta)
 *     opened                                   an empty file whose modification time is the last time the document was opened (the clock of the 30 days)
 *   <store>/course-docs/<id>/                  the course library: the same layout, shared by every student, read-only for them (the operator's `course-docs add` fills it); looked at second, ids unique across both
 *   <store>/course-docs/index.json             the library's index (src/docs/library-index.ts): id, title, week, source name, pages and the SHA-256 of each deck's source file
 *
 * Everything is written by the host from bytes it checked (src/docs/readback.ts): a document is made in `<folder>/.tmp-<id>/` and appears with ONE rename, so a reader never sees half of one.
 * A student may keep DOC_LIMITS.perStudentDocs documents and perStudentBytes: when a new one does not fit, the ones opened longest ago go first, and a document too big for the whole
 * room is cut to the pages that fit (its meta says how many the file had). A document nobody opened for keepDays is removed by `sweep`. Reads go through src/safe-fs.ts readBytesSafe (a link, a
 * FIFO or a file bigger than it should be is "no file"). A folder or id that does not pass its pattern, or a document of another student, is simply not found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { oneLine } from '../chat-objects/text.js';
import { isChatFolder } from '../portal/history.js';
import { readBytesSafe, writeFileAtomicSafe } from '../safe-fs.js';
import { INDEX_FILE, INDEX_MAX_BYTES, cleanWeek, parseLibraryIndex, serializeLibraryIndex, titleKey } from './library-index.js';
import type { LibraryRow } from './library-index.js';
import { sniffType } from './readback.js';
import { DOC_ID, DOC_LIMITS, DOC_ORIGINS, LIBRARY_LIMITS } from './types.js';
import type { DocMeta, DocOrigin, DocReader, LibraryEntry, PageWords } from './types.js';
import { pageText, validateWords } from './words.js';

const META = 'meta.json';
const SOURCE = 'source.json';
const MARKER = 'opened';
const TMP_PREFIX = '.tmp-';
const META_BYTES = 8192;
const WORDS_READ_BYTES = 1024 * 1024;
const DAY_MS = 86_400_000;
/** A document made half way (a crash between the first file and the rename) is a directory with a name that starts with this; it is removed after this long. */
const STALE_TMP_MS = 10 * 60_000;
/** A directory with an id for a name and no readable meta: left alone for an hour, then removed. */
const STALE_ORPHAN_MS = 60 * 60_000;
/** A document that is served is marked as used at most this often. */
const TOUCH_EVERY_MS = 10 * 60_000;
const MAX_LISTED = 100;

export interface StoredPage {
  image: Buffer;
  ext: 'png' | 'jpg';
  words: PageWords;
}

export interface CommitInput {
  folder: string;
  title: string;
  origin: DocOrigin;
  pages: StoredPage[];
  /** The pages the file has, when more than `pages`. */
  pagesInFile?: number;
  aspect?: number;
  source?: { sha256: string; name?: string };
}

export type CommitResult = { ok: true; meta: DocMeta; evicted: number; cutPages: boolean } | { ok: false; reason: 'too-big' | 'failed' };

export interface LibraryCommitInput {
  title: string;
  week: number | null;
  /** The name of the file the deck was made from. */
  sourceName: string;
  sha256: string;
  pages: StoredPage[];
  pagesInFile?: number;
  aspect?: number;
}

export type LibraryCommitResult =
  | { ok: true; entry: LibraryEntry }
  | { ok: false; reason: 'same-file'; entry: LibraryEntry }
  | { ok: false; reason: 'same-title' | 'full' | 'too-big' | 'failed'; message: string };

export interface LibraryRenameInput {
  /** The new title (one line, at most DOC_LIMITS.titleChars); absent leaves it as it is. */
  title?: string;
  /** The new week (1 to LIBRARY_LIMITS.maxWeek), or `null` for none; absent leaves it as it is. */
  week?: number | null;
}

export type LibraryRenameResult =
  | { ok: true; entry: LibraryEntry; /** the title and week the deck had before */ before: { title: string; week: number | null }; changed: boolean }
  | { ok: false; reason: 'not-found' | 'same-title' | 'bad-input' | 'failed'; message: string };

export interface DocStoreOptions {
  now?: () => number;
  /** Tests: the ids (default: 128 random bits). */
  newId?: () => string;
  log?: { warn(fields: Record<string, unknown>, message: string): void };
}

const pad = (n: number): string => String(n).padStart(3, '0');
const isDir = (p: string): boolean => {
  try {
    const info = fs.lstatSync(p);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
};

/** A DocMeta from what meta.json holds, field by field, or null. Whatever is there beyond the fields is dropped. */
export function cleanMeta(raw: unknown, id: string): DocMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  if (r.id !== id || typeof r.title !== 'string' || r.title.length === 0 || r.title.length > DOC_LIMITS.titleChars) return null;
  if (!whole(r.pages, 1, DOC_LIMITS.pages)) return null;
  const origin = DOC_ORIGINS.find((o) => o === r.origin);
  if (!origin || typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt) || r.createdAt < 0) return null;
  if (typeof r.bytes !== 'number' || !Number.isFinite(r.bytes) || r.bytes < 0) return null;
  const meta: DocMeta = { id, title: r.title, pages: r.pages, origin, createdAt: r.createdAt, bytes: r.bytes };
  if (whole(r.pagesInFile, r.pages + 1, 1_000_000)) meta.pagesInFile = r.pagesInFile;
  if (typeof r.aspect === 'number' && Number.isFinite(r.aspect) && r.aspect >= 0.05 && r.aspect <= 20) meta.aspect = r.aspect;
  return meta;
}

/** The kind of image a file is, from its first bytes (opened as a regular file without following a link); null for anything else. */
function sniffFile(file: string): 'image/png' | 'image/jpeg' | null {
  let fd: number | undefined;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    if (!fs.fstatSync(fd).isFile()) return null;
    const head = Buffer.alloc(16);
    const n = fs.readSync(fd, head, 0, 16, 0);
    return sniffType(head.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

export class DocStore implements DocReader {
  /** `<store>/portal/docs`: the students' own. */
  readonly root: string;
  /** `<store>/course-docs`: the library. */
  readonly courseRoot: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: NonNullable<DocStoreOptions['log']>;
  private readonly touched = new Map<string, number>();
  private libraryCache: { sig: string; entries: LibraryEntry[] } | null = null;

  constructor(storeDir: string, options: DocStoreOptions = {}) {
    this.root = path.join(storeDir, 'portal', 'docs');
    this.courseRoot = path.join(storeDir, 'course-docs');
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => randomBytes(16).toString('hex'));
    this.log = options.log ?? { warn: () => undefined };
  }

  // ---------------------------------------------------------------- reads

  /** The directory of a document the student may see: their own, else the library's. null: neither (or a name that is not an id or a folder). */
  private locate(folder: string, id: string): { dir: string; own: boolean } | null {
    if (!isChatFolder(folder) || typeof id !== 'string' || !DOC_ID.test(id)) return null;
    const own = path.join(this.root, folder, id);
    if (isDir(own)) return { dir: own, own: true };
    const shared = path.join(this.courseRoot, id);
    return isDir(shared) ? { dir: shared, own: false } : null;
  }

  private readMeta(dir: string, id: string): DocMeta | null {
    const bytes = readBytesSafe(path.join(dir, META), META_BYTES, dir);
    if (!bytes) return null;
    try {
      return cleanMeta(JSON.parse(bytes.toString('utf8')), id);
    } catch {
      return null;
    }
  }

  meta(folder: string, id: string): DocMeta | null {
    const found = this.locate(folder, id);
    return found ? this.readMeta(found.dir, id) : null;
  }

  words(folder: string, id: string, page: number): PageWords | null {
    const found = this.locate(folder, id);
    const meta = found ? this.readMeta(found.dir, id) : null;
    if (!found || !meta || !Number.isInteger(page) || page < 1 || page > meta.pages) return null;
    const bytes = readBytesSafe(path.join(found.dir, `w${pad(page)}.json`), WORDS_READ_BYTES, found.dir);
    if (!bytes) return { words: [], lines: [] }; // a page with no words file has no words (a scan)
    try {
      return validateWords(JSON.parse(bytes.toString('utf8'))) ?? { words: [], lines: [] };
    } catch {
      return { words: [], lines: [] };
    }
  }

  text(folder: string, id: string, page: number): string | null {
    const words = this.words(folder, id, page);
    return words ? pageText(words) : null;
  }

  /** The page image's file and its type, sniffed from its bytes; null when there is no such page. A document that is served is marked as used. */
  pageFile(folder: string, id: string, page: number): { file: string; type: 'image/png' | 'image/jpeg' } | null {
    const found = this.locate(folder, id);
    const meta = found ? this.readMeta(found.dir, id) : null;
    if (!found || !meta || !Number.isInteger(page) || page < 1 || page > meta.pages) return null;
    for (const ext of ['png', 'jpg']) {
      const file = path.join(found.dir, `p${pad(page)}.${ext}`);
      const type = sniffFile(file);
      if (type) {
        if (found.own) this.touch(folder, id);
        return { file, type };
      }
    }
    return null;
  }

  /** The student's own documents, newest first. */
  list(folder: string): DocMeta[] {
    return this.own(folder)
      .map((d) => d.meta)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_LISTED);
  }

  private own(folder: string): Array<{ dir: string; meta: DocMeta; lastUse: number }> {
    if (!isChatFolder(folder)) return [];
    const studentDir = path.join(this.root, folder);
    let names: string[];
    try {
      names = fs.readdirSync(studentDir);
    } catch {
      return [];
    }
    const out: Array<{ dir: string; meta: DocMeta; lastUse: number }> = [];
    for (const id of names) {
      if (!DOC_ID.test(id)) continue;
      const dir = path.join(studentDir, id);
      if (!isDir(dir)) continue;
      const meta = this.readMeta(dir, id);
      if (meta) out.push({ dir, meta, lastUse: this.lastUse(dir, meta) });
    }
    return out;
  }

  private lastUse(dir: string, meta: DocMeta): number {
    try {
      return Math.max(meta.createdAt, fs.lstatSync(path.join(dir, MARKER)).mtimeMs);
    } catch {
      return meta.createdAt;
    }
  }

  /** The student's document that was made from a file with this SHA-256 (src/docs/docs.ts), or null. */
  findBySource(folder: string, sha256: string): DocMeta | null {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
    for (const d of this.own(folder).sort((a, b) => b.meta.createdAt - a.meta.createdAt)) {
      const bytes = readBytesSafe(path.join(d.dir, SOURCE), 1024, d.dir);
      if (!bytes) continue;
      try {
        if ((JSON.parse(bytes.toString('utf8')) as { sha256?: unknown }).sha256 === sha256) return d.meta;
      } catch {
        /* not a source file */
      }
    }
    return null;
  }

  usage(folder: string): { docs: number; bytes: number } {
    const mine = this.own(folder);
    return { docs: mine.length, bytes: mine.reduce((sum, d) => sum + d.meta.bytes, 0) };
  }

  // ---------------------------------------------------------------- the library (docs/COURSE_DOCS.md)

  /** Changes when the index file changes (its inode, size and modification time), '' when there is none: what tells the cached entries from stale ones. */
  private librarySignature(): string {
    try {
      const info = fs.lstatSync(path.join(this.courseRoot, INDEX_FILE));
      return info.isFile() ? `${info.ino}:${info.size}:${info.mtimeMs}` : '';
    } catch {
      return '';
    }
  }

  private libraryRows(): LibraryRow[] {
    const bytes = readBytesSafe(path.join(this.courseRoot, INDEX_FILE), INDEX_MAX_BYTES, this.courseRoot);
    return bytes ? parseLibraryIndex(bytes.toString('utf8')) : [];
  }

  /**
   * The library's entries, by week (none last) and then title. The same array comes back until the index file changes, so that whatever is built from it (the search index) can tell by comparing the
   * arrays whether the library is the same. A row whose directory or meta is not there is left out. Never throws.
   */
  library(): LibraryEntry[] {
    try {
      const sig = this.librarySignature();
      if (this.libraryCache && this.libraryCache.sig === sig) return this.libraryCache.entries;
      const entries: LibraryEntry[] = [];
      if (sig !== '') {
        for (const row of this.libraryRows()) {
          const dir = path.join(this.courseRoot, row.id);
          const meta = isDir(dir) ? this.readMeta(dir, row.id) : null;
          if (!meta) continue;
          entries.push({ ...meta, origin: 'course', week: row.week, sourceName: row.sourceName, sha256: row.sha256 });
        }
        entries.sort((a, b) => (a.week ?? 999) - (b.week ?? 999) || a.title.localeCompare(b.title));
      }
      this.libraryCache = { sig, entries };
      return entries;
    } catch {
      return [];
    }
  }

  /** The library entry with this SHA-256 of its source file, or null. */
  findLibraryBySource(sha256: string): LibraryEntry | null {
    return /^[0-9a-f]{64}$/.test(sha256) ? (this.library().find((e) => e.sha256 === sha256) ?? null) : null;
  }

  /** The text of each page of a library entry (index 0 is page 1), or null when there is no such entry. A page with no words file is an empty string. */
  pageTexts(id: string): string[] | null {
    if (typeof id !== 'string' || !DOC_ID.test(id)) return null;
    const dir = path.join(this.courseRoot, id);
    const meta = isDir(dir) ? this.readMeta(dir, id) : null;
    if (!meta) return null;
    const texts: string[] = [];
    for (let page = 1; page <= meta.pages; page++) {
      const bytes = readBytesSafe(path.join(dir, `w${pad(page)}.json`), WORDS_READ_BYTES, dir);
      let text = '';
      if (bytes) {
        try {
          const words = validateWords(JSON.parse(bytes.toString('utf8')));
          text = words ? pageText(words) : '';
        } catch {
          text = '';
        }
      }
      texts.push(text);
    }
    return texts;
  }

  // ---------------------------------------------------------------- writes

  /** Marks one of the student's own documents as opened now (at most every ten minutes unless `force`). Never throws. */
  touch(folder: string, id: string, force = false): void {
    try {
      const found = this.locate(folder, id);
      if (!found || !found.own) return;
      const key = `${folder}/${id}`;
      const t = this.now();
      if (!force && t - (this.touched.get(key) ?? 0) < TOUCH_EVERY_MS) return;
      this.touched.set(key, t);
      const marker = path.join(found.dir, MARKER);
      fs.closeSync(fs.openSync(marker, 'a', 0o644));
      fs.utimesSync(marker, t / 1000, t / 1000);
      if (this.touched.size > 2000) this.touched.clear();
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, 'docs: a document could not be marked as opened');
    }
  }

  private taken(folder: string, id: string): boolean {
    return fs.existsSync(path.join(this.root, folder, id)) || fs.existsSync(path.join(this.courseRoot, id));
  }

  /**
   * Keeps a prepared document for a student: cuts the pages to the room one student has, makes room by removing the documents opened longest ago, writes the files into a directory of its own
   * and renames it into place. Never throws.
   */
  commit(input: CommitInput): CommitResult {
    try {
      if (!isChatFolder(input.folder) || input.pages.length === 0 || input.pages.length > DOC_LIMITS.pages) return { ok: false, reason: 'failed' };
      const encoded = input.pages.map((p) => ({ ...p, wordsJson: Buffer.from(JSON.stringify({ words: p.words.words, lines: p.words.lines }), 'utf8') }));
      // the pages that fit the room of one student, from the first
      let kept = 0;
      let bytes = 0;
      for (const p of encoded) {
        const size = p.image.length + p.wordsJson.length;
        if (bytes + size > DOC_LIMITS.perStudentBytes) break;
        bytes += size;
        kept++;
      }
      if (kept === 0) return { ok: false, reason: 'too-big' };
      const pages = encoded.slice(0, kept);
      const cutPages = kept < encoded.length;

      // make room: the documents opened longest ago go first
      const mine = this.own(input.folder).sort((a, b) => a.lastUse - b.lastUse);
      let docs = mine.length;
      let used = mine.reduce((sum, d) => sum + d.meta.bytes, 0);
      let evicted = 0;
      for (const d of mine) {
        if (docs + 1 <= DOC_LIMITS.perStudentDocs && used + bytes <= DOC_LIMITS.perStudentBytes) break;
        if (this.removeDir(input.folder, d.meta.id)) {
          docs--;
          used -= d.meta.bytes;
          evicted++;
        }
      }
      if (docs + 1 > DOC_LIMITS.perStudentDocs || used + bytes > DOC_LIMITS.perStudentBytes) return { ok: false, reason: 'failed' };

      let id = this.newId();
      for (let tries = 0; (!DOC_ID.test(id) || this.taken(input.folder, id)) && tries < 5; tries++) id = this.newId();
      if (!DOC_ID.test(id) || this.taken(input.folder, id)) return { ok: false, reason: 'failed' };

      const studentDir = path.join(this.root, input.folder);
      fs.mkdirSync(studentDir, { recursive: true, mode: 0o700 });
      const tmp = path.join(studentDir, `${TMP_PREFIX}${id}`);
      fs.mkdirSync(tmp, { mode: 0o700 });
      try {
        pages.forEach((p, i) => {
          fs.writeFileSync(path.join(tmp, `p${pad(i + 1)}.${p.ext}`), p.image, { flag: 'wx', mode: 0o644 });
          fs.writeFileSync(path.join(tmp, `w${pad(i + 1)}.json`), p.wordsJson, { flag: 'wx', mode: 0o644 });
        });
        const meta: DocMeta = {
          id,
          title: input.title,
          pages: pages.length,
          origin: input.origin,
          createdAt: this.now(),
          bytes,
          ...(cutPages || (input.pagesInFile !== undefined && input.pagesInFile > pages.length) ? { pagesInFile: Math.max(input.pagesInFile ?? 0, encoded.length) } : {}),
          ...(input.aspect !== undefined && input.aspect >= 0.05 && input.aspect <= 20 ? { aspect: input.aspect } : {}),
        };
        if (input.source) fs.writeFileSync(path.join(tmp, SOURCE), JSON.stringify({ sha256: input.source.sha256, ...(input.source.name ? { name: input.source.name.slice(0, 200) } : {}) }), { flag: 'wx', mode: 0o644 });
        fs.writeFileSync(path.join(tmp, META), JSON.stringify(meta), { flag: 'wx', mode: 0o644 });
        fs.renameSync(tmp, path.join(studentDir, id));
        return { ok: true, meta, evicted, cutPages };
      } catch (err) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw err;
      }
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, 'docs: a document could not be kept');
      return { ok: false, reason: 'failed' };
    }
  }

  // ---------------------------------------------------------------- the library's writes (the operator's `course-docs` commands: src/docs/library.ts; the orchestrator never calls these)

  /** Whether the id is in use anywhere: the library, or any student's own documents (ids are unique across both). */
  private takenAnywhere(id: string): boolean {
    if (fs.existsSync(path.join(this.courseRoot, id))) return true;
    try {
      for (const folder of fs.readdirSync(this.root)) {
        if (isChatFolder(folder) && fs.existsSync(path.join(this.root, folder, id))) return true;
      }
    } catch {
      /* no student has a document yet */
    }
    return false;
  }

  /** Runs `work` with the index to itself: a directory made as the lock (atomic), one left by a run that died is taken over after five minutes. */
  private withLibraryLock<T>(work: () => T): T {
    fs.mkdirSync(this.courseRoot, { recursive: true, mode: 0o755 });
    const lock = path.join(this.courseRoot, '.lock');
    for (let attempt = 0; ; attempt++) {
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let age = 0;
        try {
          age = this.now() - fs.lstatSync(lock).mtimeMs;
        } catch {
          continue;
        }
        if (age > 5 * 60_000) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
        if (attempt >= 3) throw new Error('the library is being changed by another command');
        const until = Date.now() + 500;
        while (Date.now() < until) {
          /* a short wait for the other command */
        }
      }
    }
    try {
      return work();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  /**
   * Adds a deck to the library: the same files as a student's document, written into `.tmp-<id>/` and renamed into place, then one row in the index (written through a temporary file and a rename). The same
   * source file, a title the library has, more entries or bytes than the library may hold, are refusals in words. Never throws.
   */
  commitLibrary(input: LibraryCommitInput): LibraryCommitResult {
    try {
      const title = input.title.trim();
      if (title.length === 0 || title.length > DOC_LIMITS.titleChars || !/^[0-9a-f]{64}$/.test(input.sha256) || input.pages.length === 0 || input.pages.length > DOC_LIMITS.pages) {
        return { ok: false, reason: 'failed', message: 'the deck cannot be added: its title, source or pages are not usable' };
      }
      const encoded = input.pages.map((p) => ({ ...p, wordsJson: Buffer.from(JSON.stringify({ words: p.words.words, lines: p.words.lines }), 'utf8') }));
      const bytes = encoded.reduce((sum, p) => sum + p.image.length + p.wordsJson.length, 0);
      return this.withLibraryLock((): LibraryCommitResult => {
        const rows = this.libraryRows();
        const same = rows.find((r) => r.sha256 === input.sha256);
        if (same) {
          const existing = this.library().find((e) => e.id === same.id);
          if (existing) return { ok: false, reason: 'same-file', entry: existing };
        }
        if (rows.some((r) => titleKey(r.title) === titleKey(title))) return { ok: false, reason: 'same-title', message: `the library has a deck titled "${title}" already: give this one a title of its own` };
        if (rows.length >= LIBRARY_LIMITS.entries) return { ok: false, reason: 'full', message: `the library holds ${LIBRARY_LIMITS.entries} decks at most: remove one first` };
        const used = rows.reduce((sum, r) => sum + r.bytes, 0);
        if (used + bytes > LIBRARY_LIMITS.bytes) return { ok: false, reason: 'too-big', message: `the library would pass ${Math.round(LIBRARY_LIMITS.bytes / (1024 * 1024))} MB: remove a deck first` };

        let id = this.newId();
        for (let tries = 0; (!DOC_ID.test(id) || this.takenAnywhere(id)) && tries < 5; tries++) id = this.newId();
        if (!DOC_ID.test(id) || this.takenAnywhere(id)) return { ok: false, reason: 'failed', message: 'the deck could not be given an id' };

        const tmp = path.join(this.courseRoot, `${TMP_PREFIX}${id}`);
        fs.mkdirSync(tmp, { mode: 0o755 });
        const createdAt = this.now();
        try {
          encoded.forEach((p, i) => {
            fs.writeFileSync(path.join(tmp, `p${pad(i + 1)}.${p.ext}`), p.image, { flag: 'wx', mode: 0o644 });
            fs.writeFileSync(path.join(tmp, `w${pad(i + 1)}.json`), p.wordsJson, { flag: 'wx', mode: 0o644 });
          });
          const meta: DocMeta = {
            id,
            title,
            pages: encoded.length,
            origin: 'course',
            createdAt,
            bytes,
            ...(input.pagesInFile !== undefined && input.pagesInFile > encoded.length ? { pagesInFile: input.pagesInFile } : {}),
            ...(input.aspect !== undefined && input.aspect >= 0.05 && input.aspect <= 20 ? { aspect: input.aspect } : {}),
          };
          fs.writeFileSync(path.join(tmp, SOURCE), JSON.stringify({ sha256: input.sha256, name: input.sourceName.slice(0, 200) }), { flag: 'wx', mode: 0o644 });
          fs.writeFileSync(path.join(tmp, META), JSON.stringify(meta), { flag: 'wx', mode: 0o644 });
          fs.renameSync(tmp, path.join(this.courseRoot, id));
          const row: LibraryRow = {
            id,
            title,
            week: cleanWeek(input.week),
            sourceName: input.sourceName.replace(/\s+/g, ' ').trim().slice(0, 200),
            sha256: input.sha256,
            pages: encoded.length,
            bytes,
            createdAt,
            ...(meta.pagesInFile !== undefined ? { pagesInFile: meta.pagesInFile } : {}),
          };
          try {
            writeFileAtomicSafe(path.join(this.courseRoot, INDEX_FILE), serializeLibraryIndex([...rows, row]), this.courseRoot);
          } catch (err) {
            fs.rmSync(path.join(this.courseRoot, id), { recursive: true, force: true });
            throw err;
          }
          this.libraryCache = null;
          const entry = this.library().find((e) => e.id === id);
          return entry ? { ok: true, entry } : { ok: false, reason: 'failed', message: 'the deck was written but could not be read back' };
        } catch (err) {
          fs.rmSync(tmp, { recursive: true, force: true });
          throw err;
        }
      });
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, 'docs: a deck could not be added to the library');
      return { ok: false, reason: 'failed', message: `the deck could not be added: ${(err as Error).message.slice(0, 120)}` };
    }
  }

  /** Takes a deck out of the library: its row first (so that nothing lists it), then its directory. Whether there was such a deck. Never throws. */
  removeLibrary(id: string): boolean {
    try {
      if (typeof id !== 'string' || !DOC_ID.test(id)) return false;
      return this.withLibraryLock(() => {
        const rows = this.libraryRows();
        if (!rows.some((r) => r.id === id)) return false;
        writeFileAtomicSafe(path.join(this.courseRoot, INDEX_FILE), serializeLibraryIndex(rows.filter((r) => r.id !== id)), this.courseRoot);
        this.libraryCache = null;
        fs.rmSync(path.join(this.courseRoot, id), { recursive: true, force: true });
        return true;
      });
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, 'docs: a deck could not be removed from the library');
      return false;
    }
  }

  /**
   * Changes a deck's title and/or week. The title is kept in two places that must agree: the deck's own meta.json (what a card, the viewer and `show_document` show) and its row of the index (what the rule
   * "a title is unique" reads), so both are written, the meta first and the row second, and the meta is put back when the row cannot be written. A title is refused when another deck has it (letters and
   * digits only, any case). Under the same lock as the other writes; nothing else of the deck is touched, so a card that already holds the old title keeps it. Never throws.
   */
  renameLibrary(id: string, change: LibraryRenameInput): LibraryRenameResult {
    try {
      if (typeof id !== 'string' || !DOC_ID.test(id)) return { ok: false, reason: 'not-found', message: 'no deck of the library has that id' };
      const wantsTitle = change.title !== undefined;
      const title = wantsTitle ? oneLine(change.title, DOC_LIMITS.titleChars) : '';
      if (wantsTitle && title.length === 0) return { ok: false, reason: 'bad-input', message: 'the title is empty' };
      const wantsWeek = change.week !== undefined;
      const week = wantsWeek ? cleanWeek(change.week) : null;
      if (wantsWeek && change.week !== null && week === null) return { ok: false, reason: 'bad-input', message: `the week is a number from 1 to ${LIBRARY_LIMITS.maxWeek}, or none` };
      return this.withLibraryLock((): LibraryRenameResult => {
        const rows = this.libraryRows();
        const row = rows.find((r) => r.id === id);
        const dir = path.join(this.courseRoot, id);
        const meta = row && isDir(dir) ? this.readMeta(dir, id) : null;
        if (!row || !meta) return { ok: false, reason: 'not-found', message: 'no deck of the library has that id' };
        if (wantsTitle && rows.some((r) => r.id !== id && titleKey(r.title) === titleKey(title))) {
          return { ok: false, reason: 'same-title', message: `the library has a deck titled "${title}" already: give this one a title of its own` };
        }
        const nextTitle = wantsTitle ? title : row.title;
        const nextWeek = wantsWeek ? week : row.week;
        const metaChanges = meta.title !== nextTitle;
        const rowChanges = row.title !== nextTitle || row.week !== nextWeek;
        if (metaChanges) writeFileAtomicSafe(path.join(dir, META), JSON.stringify({ ...meta, title: nextTitle }), this.courseRoot);
        if (rowChanges) {
          try {
            writeFileAtomicSafe(path.join(this.courseRoot, INDEX_FILE), serializeLibraryIndex(rows.map((r) => (r.id === id ? { ...r, title: nextTitle, week: nextWeek } : r))), this.courseRoot);
          } catch (err) {
            if (metaChanges) {
              try {
                writeFileAtomicSafe(path.join(dir, META), JSON.stringify(meta), this.courseRoot);
              } catch {
                /* the first error is the one that is told */
              }
            }
            throw err;
          }
        }
        const changed = metaChanges || rowChanges;
        if (changed) this.libraryCache = null;
        const entry = this.library().find((e) => e.id === id);
        if (!entry) return { ok: false, reason: 'failed', message: 'the deck was changed but could not be read back' };
        return { ok: true, entry, before: { title: row.title, week: row.week }, changed };
      });
    } catch (err) {
      this.log.warn({ error: (err as Error).message }, 'docs: a deck of the library could not be renamed');
      return { ok: false, reason: 'failed', message: `the deck could not be changed: ${(err as Error).message.slice(0, 120)}` };
    }
  }

  /** Removes one of the student's own documents (never the library's). Whether it is gone. */
  private removeDir(folder: string, id: string): boolean {
    if (!isChatFolder(folder) || !DOC_ID.test(id)) return false;
    const dir = path.join(this.root, folder, id);
    try {
      if (!isDir(dir)) return true;
      fs.rmSync(dir, { recursive: true, force: true });
      this.touched.delete(`${folder}/${id}`);
      return !fs.existsSync(dir);
    } catch {
      return false;
    }
  }

  /** Removes what is past `keepDays` since it was last opened, directories left half made, and directories with an id and no meta. The number removed. Never throws; the library is never touched. */
  sweep(): number {
    let removed = 0;
    const t = this.now();
    try {
      for (const folder of fs.readdirSync(this.root)) {
        if (!isChatFolder(folder)) continue;
        const studentDir = path.join(this.root, folder);
        if (!isDir(studentDir)) continue;
        for (const name of fs.readdirSync(studentDir)) {
          const dir = path.join(studentDir, name);
          if (!isDir(dir)) continue;
          try {
            const age = t - fs.lstatSync(dir).mtimeMs;
            if (name.startsWith(TMP_PREFIX)) {
              if (age > STALE_TMP_MS) {
                fs.rmSync(dir, { recursive: true, force: true });
                removed++;
              }
              continue;
            }
            if (!DOC_ID.test(name)) continue;
            const meta = this.readMeta(dir, name);
            const expired = meta ? t - this.lastUse(dir, meta) > DOC_LIMITS.keepDays * DAY_MS : age > STALE_ORPHAN_MS;
            if (expired && this.removeDir(folder, name)) removed++;
          } catch (err) {
            this.log.warn({ error: (err as Error).message }, 'docs: the sweep could not look at a directory');
          }
        }
      }
    } catch {
      /* no store yet: nothing to remove */
    }
    return removed;
  }
}
