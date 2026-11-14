/**
 * The documents service (docs/DOCUMENTS.md): `createDocs(deps)` is the DocsApi (src/docs/types.ts) that the portal's routes, the text agent's IPC verb and the voice side use. `open` takes a
 * file the student attached (or bytes the host holds, or a document that is kept already) and answers with a prepared document or with a sentence a model can say, in this order:
 *
 *   (a) the source is read: an upload with the group folder as the root (src/safe-fs.ts readBytesSafe, as src/sandbox/stage.ts reads an attached file), at most DOC_LIMITS.sourceBytes
 *   (b) the KIND is decided from the first bytes (a PDF begins `%PDF-`, a PowerPoint, Word or Excel file is a zip, `PK\3\4`; a name is never believed); anything else is refused in words. The host never
 *       opens a zip: the renderer container reads its entry names and decides whether it is a deck, a document or a workbook, or none of them (docs/COURSE_DOCS.md)
 *   (c) the same file prepared before is the same document: SHA-256 of the bytes against what the student has (free: no render, no count)
 *   (d) the renderer's image is there  (e) one at a time for a student  (f) the student's renders: 6 in ten minutes, 20 a day (renders only: opening a kept document is free; the store's quota is the real bound)
 *   (g) the host-wide gate: 2 renders at once, 4 waiting for at most 15 s  (h) the render, in a container (src/docs/render.ts)  (i) the store (src/docs/store.ts: quota, atomic write)
 *
 * It never throws. What a model is told for a refusal is a sentence of the host's own; what is logged is the kind of source and how it ended (never a name, a title or the bytes).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { oneLine } from '../chat-objects/text.js';
import { isChatFolder } from '../portal/history.js';
import { createGate } from '../sandbox/runner.js';
import type { DockerClient, HostUser } from '../sandbox/docker.js';
import type { SandboxLog } from '../sandbox/types.js';
import { readBytesSafe } from '../safe-fs.js';
import type { CanvasSource } from './canvas-source.js';
import { LibrarySearcher } from './library-search.js';
import { RENDER_FAILED, RENDER_NOT_SET_UP, createRenderer } from './render.js';
import type { Renderer } from './render.js';
import { isUploadName } from './resolve.js';
import { DocStore } from './store.js';
import { DOC_ID, DOC_LIMITS } from './types.js';
import type { CanvasFilesResult, DocMeta, DocOpenResult, DocSource, DocsApi, PageWords } from './types.js';

/** The admin chat's folder: not rate-limited (it is the owner's own). */
const ADMIN_FOLDER = 'main';
const TEN_MINUTES_MS = 600_000;
const DAY_MS = 86_400_000;
/** The reaper runs every minute (src/index.ts); what is past its thirty days is looked for this often. */
const SWEEP_EVERY_MS = 10 * 60_000;

/** How many renders may run at once on the host, how many may wait behind them and for how long. */
export const DOC_GATE = { concurrent: 2, waiting: 4, waitMs: 30_000 } as const;

const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

export const DOCS_OFF = RENDER_NOT_SET_UP;
export const DOCS_BUSY = 'The document service is busy preparing other documents right now. Say so in a short sentence and try again in a minute.';
export const DOCS_STUDENT_BUSY = 'A document is being prepared for this student already. Say so in a short sentence and wait for it before asking for another.';
export const DOCS_RATE_10MIN = `Not opened: ${DOC_LIMITS.opensPer10Min} new documents in ten minutes is the most for one student, and that many were prepared. Say so in a short sentence and try again in a few minutes (a document that is prepared already opens at once).`;
export const DOCS_RATE_DAY = `Not opened: ${DOC_LIMITS.opensPerDay} new documents a day is the most for one student, and that many were prepared. Say so in a short sentence and try again tomorrow (a document that is prepared already opens at once).`;
export const DOCS_EMPTY = 'That file is empty, so there is nothing to show. Say so in a short sentence.';
export const DOCS_NOT_A_PDF = 'That file is not a PDF or a PowerPoint, Word or Excel file, so the viewer cannot show it. Say so in a short sentence and suggest a PDF, or a .pptx, .docx or .xlsx file.';
export const DOCS_OLD_OFFICE =
  'That looks like an older Office file (.ppt, .doc or .xls) or one that is protected with a password, and the viewer cannot read either. Say so in a short sentence and suggest saving it as .pptx, .docx or .xlsx without a password, or exporting a PDF.';
export const DOCS_TOO_BIG_FILE = `That file is bigger than the ${mb(DOC_LIMITS.sourceBytes)} MB the viewer takes. Say so in a short sentence and suggest a smaller file or a few pages of it.`;
export const DOCS_NO_ROOM = `The pages of that file together are more than the ${mb(DOC_LIMITS.perStudentBytes)} MB the viewer keeps for one student. Say so in a short sentence and suggest a shorter file.`;
export const DOCS_NO_UPLOAD = 'There is no such file among the ones the student attached (or it is not an ordinary file). Say so in a short sentence and ask them to attach it again.';
export const DOCS_NO_DOC = 'The student has no such prepared document (it may have been removed after not being opened for 30 days, or to make room for newer ones). Say so in a short sentence and ask them to attach the file again.';
export const DOCS_NOT_A_STUDENT = 'This chat has no documents.';
export const DOCS_CANVAS_NO_FILE = 'That Canvas file is not there any more, or not one the student can open. Say so in one short sentence and offer the names you were given.';
export const DOCS_CANVAS_DOWN = 'Canvas did not answer just now, so the course files could not be looked at. Say so in one short sentence.';
export const DOCS_CANVAS_RATE_10MIN = `Not opened: ${DOC_LIMITS.opensPer10Min} files from Canvas in ten minutes is the most for one student, and that many were fetched. Say so in a short sentence and try again in a few minutes (a file that was opened already opens again at once).`;
export const DOCS_CANVAS_RATE_DAY = `Not opened: ${DOC_LIMITS.opensPerDay} files from Canvas a day is the most for one student, and that many were fetched. Say so in a short sentence and try again tomorrow (a file that was opened already opens again at once).`;

export interface DocsLog extends SandboxLog {}

export interface DocsDeps {
  /** The directory the service owns: the renderer's run directories (`run-<id>`), data/docs. */
  dir: string;
  /** The orchestrator's store directory: kept documents are in `<storeDir>/portal/docs`, the course library in `<storeDir>/course-docs`. */
  storeDir: string;
  /** Where a student's attached files are (groups/<folder>/uploads). */
  uploadsDir: (folder: string) => string;
  log: DocsLog;
  /** The course's Canvas files (src/docs/canvas-source.ts): without it `canvasFiles` and `openCanvasFile` are not there, and a name that is not the student's own is simply not found. */
  canvas?: CanvasSource;
  // test seams
  docker?: DockerClient;
  image?: string;
  hostUser?: HostUser;
  now?: () => number;
  renderer?: Renderer;
  store?: DocStore;
}

const failure = (reason: Extract<DocOpenResult, { ok: false }>['reason'], message: string): DocOpenResult => ({ ok: false, reason, message });

/** A title from a file name: without its extension, underscores as spaces, one line; `given` wins when it says anything. */
export function titleFrom(name: string, given?: string): string {
  const fromGiven = oneLine(given, DOC_LIMITS.titleChars);
  if (fromGiven) return fromGiven;
  const stem = name.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/_+/g, ' ');
  return oneLine(stem, DOC_LIMITS.titleChars) || 'Document';
}

/** Whether a file begins with the signature of the old Office container (.doc, .ppt, .xls, and a password-protected .docx or .pptx, which is one too): a first-bytes check, nothing is opened. */
export const looksLikeOldOffice = (bytes: Buffer): boolean => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

/** What a file is, from its first bytes: a PDF, a zip (a PowerPoint, Word or Excel file is one: the renderer container decides which, or that it is none of them), or something else. */
export function kindOfBytes(bytes: Buffer): 'pdf' | 'office' | 'other' {
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'office';
  return 'other';
}

export function createDocs(deps: DocsDeps): DocsApi {
  const now = deps.now ?? Date.now;
  const log = deps.log;
  const canvas = deps.canvas;
  const store = deps.store ?? new DocStore(deps.storeDir, { now, log });
  const renderer = deps.renderer ?? createRenderer({ dir: deps.dir, log, docker: deps.docker, image: deps.image, hostUser: deps.hostUser, now });
  const gate = createGate(DOC_GATE.concurrent, DOC_GATE.waiting);
  const searcher = new LibrarySearcher(store);
  /** The students who have a render going: one at a time for each. */
  const busyFolders = new Set<string>();
  /** When each student's renders began (in memory: the store's quota is the real bound). */
  const renders = new Map<string, number[]>();
  let lastSweep = 0;
  /** When each student's Canvas downloads happened (in memory: only a real download counts, not a file that was opened already), and the document each of a student's Canvas files made (`<id>:<size>`). */
  const canvasDownloads = new Map<string, number[]>();
  const canvasOpened = new Map<string, Map<string, string>>();

  const countSince = (folder: string, sinceMs: number): number => (renders.get(folder) ?? []).filter((t) => t >= sinceMs).length;
  /** The sentence for a student who has used their renders, or null. The day is looked at first: waiting ten minutes will not help then. */
  function limited(folder: string): string | null {
    if (folder === ADMIN_FOLDER) return null;
    const t = now();
    if (countSince(folder, t - DAY_MS) >= DOC_LIMITS.opensPerDay) return DOCS_RATE_DAY;
    if (countSince(folder, t - TEN_MINUTES_MS) >= DOC_LIMITS.opensPer10Min) return DOCS_RATE_10MIN;
    return null;
  }
  function record(folder: string): void {
    const t = now();
    const list = (renders.get(folder) ?? []).filter((x) => x >= t - DAY_MS);
    list.push(t);
    renders.set(folder, list);
  }

  /** The existing document as an answer: marked as opened, at page 1. */
  function again(folder: string, meta: DocMeta): DocOpenResult {
    store.touch(folder, meta.id, true);
    return { ok: true, doc: meta, page: 1 };
  }

  async function prepare(folder: string, bytes: Buffer, name: string, title: string | undefined, origin: DocMeta['origin']): Promise<DocOpenResult> {
    if (bytes.length === 0) return failure('bad-file', DOCS_EMPTY);
    if (bytes.length > DOC_LIMITS.sourceBytes) return failure('too-big', DOCS_TOO_BIG_FILE);
    const kind = kindOfBytes(bytes);
    if (kind === 'other') return failure('bad-file', looksLikeOldOffice(bytes) ? DOCS_OLD_OFFICE : DOCS_NOT_A_PDF);

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const known = store.findBySource(folder, sha256);
    if (known) return again(folder, known);
    // a Canvas file that the operator put in the course library already (the same bytes) is that deck: nothing is prepared again for the student, and no render is counted
    if (origin === 'canvas') {
      const shared = store.findLibraryBySource(sha256);
      if (shared) return { ok: true, doc: shared, page: 1 };
    }

    if (!(await renderer.ready())) return failure('off', DOCS_OFF);
    if (busyFolders.has(folder)) return failure('busy', DOCS_STUDENT_BUSY);
    const early = limited(folder);
    if (early) return failure('limit', early);

    busyFolders.add(folder);
    let release: (() => void) | null = null;
    try {
      release = await gate.acquire(DOC_GATE.waitMs);
      if (!release) return failure('busy', DOCS_BUSY);
      // looked at again and recorded in the same breath (no wait between them): two requests at the edge cannot both pass
      const second = limited(folder);
      if (second) return failure('limit', second);
      record(folder);

      const rendered = await renderer.render(bytes, { kind });
      if (!rendered.ok) return failure(rendered.reason, rendered.message);
      const rb = rendered.readback;
      const stored = store.commit({
        folder,
        title: titleFrom(name, title),
        origin,
        pages: rb.pages.map((p) => ({ image: p.image, ext: p.info.ext, words: p.words as PageWords })),
        ...(rb.pagesInFile !== undefined ? { pagesInFile: rb.pagesInFile } : rb.cutByRoom ? { pagesInFile: rb.drawn } : {}),
        aspect: rb.aspect,
        source: { sha256, name },
      });
      if (!stored.ok) return stored.reason === 'too-big' ? failure('too-big', DOCS_NO_ROOM) : failure('failed', RENDER_FAILED);
      log.info(
        {
          folder,
          origin,
          bytes: bytes.length,
          pages: stored.meta.pages,
          pagesInFile: stored.meta.pagesInFile,
          cut: stored.cutPages || rb.cutByRoom,
          evicted: stored.evicted,
          ms: rendered.timing.totalMs,
          startMs: rendered.timing.startMs,
          runMs: rendered.timing.runMs,
          memoryBytes: rendered.timing.memoryBytes,
          convertMs: rendered.timing.convertMs,
          kind,
        },
        'docs: a document was prepared',
      );
      return { ok: true, doc: stored.meta, page: 1 };
    } finally {
      release?.();
      busyFolders.delete(folder);
    }
  }

  /** The upload's bytes, read with the group folder as the root; a refusal in words when there are none. */
  function readUpload(folder: string, name: string): { bytes: Buffer } | { refusal: DocOpenResult } {
    if (!isUploadName(name)) return { refusal: failure('not-found', DOCS_NO_UPLOAD) };
    const uploadsDir = deps.uploadsDir(folder);
    const file = path.join(uploadsDir, name);
    const bytes = readBytesSafe(file, DOC_LIMITS.sourceBytes, path.dirname(uploadsDir));
    if (bytes) return { bytes };
    // (null is both "not there" and "too big": the first is a missing file, the second a file that is there and bigger than the limit)
    try {
      const info = fs.lstatSync(file, { throwIfNoEntry: false });
      if (info?.isFile() && info.size > DOC_LIMITS.sourceBytes) return { refusal: failure('too-big', DOCS_TOO_BIG_FILE) };
    } catch {
      /* not there */
    }
    return { refusal: failure('not-found', DOCS_NO_UPLOAD) };
  }

  /** The sentence for a student who has fetched their share of Canvas files, or null. The day is looked at first, as for renders. */
  function canvasLimited(folder: string): string | null {
    const t = now();
    const list = (canvasDownloads.get(folder) ?? []).filter((x) => x >= t - DAY_MS);
    canvasDownloads.set(folder, list);
    if (list.length >= DOC_LIMITS.opensPerDay) return DOCS_CANVAS_RATE_DAY;
    if (list.filter((x) => x >= t - TEN_MINUTES_MS).length >= DOC_LIMITS.opensPer10Min) return DOCS_CANVAS_RATE_10MIN;
    return null;
  }

  /**
   * A file of the course's Canvas as the student's own document (origin `canvas`). The id is one of the host's own listing (src/docs/canvas-source.ts: only what a student could open in Canvas), the host downloads it
   * (the token never leaves the host) and it is prepared like any file: the same limits, the same renderer, the same quota. The same file again is the same document, with no second download.
   */
  async function openCanvas(who: { folder: string }, id: number): Promise<DocOpenResult> {
    const folder = who?.folder;
    if (typeof folder !== 'string' || !isChatFolder(folder)) return failure('not-found', DOCS_NOT_A_STUDENT);
    if (!canvas) return failure('off', DOCS_OFF);
    if (!Number.isSafeInteger(id)) return failure('not-found', DOCS_CANVAS_NO_FILE);
    const listed = await canvas.list();
    if (!listed.ok) return failure('failed', listed.message);
    const info = listed.files.find((f) => f.id === id);
    if (!info) return failure('not-found', DOCS_CANVAS_NO_FILE);
    const key = `${info.id}:${info.size}`;
    const madeBefore = canvasOpened.get(folder)?.get(key);
    const kept = madeBefore ? store.meta(folder, madeBefore) : null;
    if (kept) return again(folder, kept);
    if (busyFolders.has(folder)) return failure('busy', DOCS_STUDENT_BUSY);
    const limit = canvasLimited(folder);
    if (limit) return failure('limit', limit);
    const got = await canvas.download(id);
    if (!got.ok) return failure('failed', got.message);
    canvasDownloads.set(folder, [...(canvasDownloads.get(folder) ?? []), now()]);
    const result = await prepare(folder, got.bytes, info.name, undefined, 'canvas');
    if (result.ok) {
      const made = canvasOpened.get(folder) ?? new Map<string, string>();
      made.set(key, result.doc.id);
      canvasOpened.set(folder, made);
      if (canvasOpened.size > 500) canvasOpened.clear();
    }
    return result;
  }

  async function openInner(who: { folder: string }, source: DocSource): Promise<DocOpenResult> {
    const folder = who?.folder;
    if (typeof folder !== 'string' || !isChatFolder(folder)) return failure('not-found', DOCS_NOT_A_STUDENT);
    if (source.kind === 'existing') {
      const meta = typeof source.id === 'string' && DOC_ID.test(source.id) ? store.meta(folder, source.id) : null;
      return meta ? again(folder, meta) : failure('not-found', DOCS_NO_DOC);
    }
    if (source.kind === 'upload') {
      if (typeof source.name !== 'string') return failure('not-found', DOCS_NO_UPLOAD);
      const read = readUpload(folder, source.name);
      if ('refusal' in read) return read.refusal;
      return prepare(folder, read.bytes, source.name, source.title, 'upload');
    }
    if (source.kind === 'bytes') {
      if (!Buffer.isBuffer(source.bytes)) return failure('bad-file', DOCS_EMPTY);
      return prepare(folder, source.bytes, typeof source.name === 'string' ? source.name : '', source.title, source.origin);
    }
    return failure('bad-file', DOCS_NOT_A_PDF);
  }

  const api: DocsApi = {
    async open(who, source) {
      const began = now();
      let result: DocOpenResult;
      try {
        result = await openInner(who, source);
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'docs: an open failed unexpectedly');
        result = failure('failed', RENDER_FAILED);
      }
      try {
        log.info({ folder: who?.folder, source: source?.kind, ok: result.ok, ...(result.ok ? { pages: result.doc.pages } : { reason: result.reason }), ms: now() - began }, 'docs: open');
      } catch {
        /* a log must never fail an open */
      }
      return result;
    },
    meta: (folder, id) => store.meta(folder, id),
    words: (folder, id, page) => store.words(folder, id, page),
    text: (folder, id, page) => store.text(folder, id, page),
    pageFile: (folder, id, page) => store.pageFile(folder, id, page),
    list: (folder) => store.list(folder),
    library: () => store.library(),
    searchLibrary: (query) => searcher.search(query),
    ready: () => renderer.ready(),
    async reap() {
      let removed = 0;
      try {
        removed += await renderer.reap();
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'docs: the reaper failed');
      }
      try {
        const t = now();
        if (lastSweep === 0 || t - lastSweep >= SWEEP_EVERY_MS) {
          lastSweep = t;
          removed += store.sweep();
        }
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'docs: the sweep failed');
      }
      return removed;
    },
  };

  if (canvas) {
    api.canvasFiles = (): Promise<CanvasFilesResult> => canvas.list().catch((): CanvasFilesResult => ({ ok: false, message: DOCS_CANVAS_DOWN }));
    api.openCanvasFile = async (who, id) => {
      const began = now();
      let result: DocOpenResult;
      try {
        result = await openCanvas(who, id);
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'docs: a Canvas file open failed unexpectedly');
        result = failure('failed', RENDER_FAILED);
      }
      try {
        log.info({ folder: who?.folder, source: 'canvas', ok: result.ok, ...(result.ok ? { pages: result.doc.pages } : { reason: result.reason }), ms: now() - began }, 'docs: open');
      } catch {
        /* a log must never fail an open */
      }
      return result;
    };
  }
  return api;
}
