/**
 * The course's Canvas files, for the viewer (docs/COURSE_DOCS.md, "Canvas files"): a student says "open the Day 4 slides" or "show me the homework spec" and TAi may put a file of the course on their screen
 * even when the professor's decks were not added to the course library. The HOST lists the course's files and downloads the one asked for, with the token of the operator's own Canvas account; the token
 * never enters a container, and what a model gives is only a NAME that the host compares with its own listing (src/docs/resolve.ts): the id, the address and the bytes are the host's.
 *
 * The rules of the operator's `course-docs canvas` command hold here, because both use src/docs/canvas-files.ts: the token goes to Canvas' own host only (a download that Canvas sends somewhere else is asked for
 * without it, and only on a host that is Canvas' own), at most 20 MB, a PDF or a zip by its first bytes, and a file Canvas hides or locks for students, or has not released yet, or no longer offers, is not in the
 * listing at all: a student gets what they could open in Canvas themselves, and nothing the instructor's token alone can see. (The listing is the same for every student; it is kept for ten minutes.)
 *
 * Nothing here throws, and nothing that carries an address or the token is ever logged or returned: only names, sizes, kinds and what went wrong in words.
 */
import { downloadCanvasFile, hostsOf, listCanvasFiles } from './canvas-files.js';
import type { CanvasFile, Download } from './canvas-files.js';
import { DOC_LIMITS } from './types.js';
import type { CanvasFileInfo, CanvasFilesResult } from './types.js';

export interface CanvasSettings {
  /** `https://<host>/api/v1`. */
  base: string;
  token: string;
  /** The course's id (digits). */
  course: string;
}

export interface CanvasSource {
  /**
   * The files a student may open, by name. `{ ok: true, files: [] }` when Canvas is not set up on this host (there is nothing to list); `{ ok: false }` with a sentence for a model when Canvas did not answer.
   * Kept for CANVAS_LIST_TTL_MS (a failure for CANVAS_FAIL_TTL_MS), one request at a time.
   */
  list(): Promise<CanvasFilesResult>;
  /** The bytes of one file of that listing (by its id). Never throws. */
  download(id: number): Promise<Download>;
}

export interface CanvasSourceDeps {
  /** The settings, read at each use (the host's `.env`, src/env.ts readEnvFile), so that a token stored later applies without a restart; null when Canvas is not set up. */
  settings: () => CanvasSettings | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: { warn(fields: Record<string, unknown>, message: string): void };
}

export const CANVAS_LIST_TTL_MS = 10 * 60_000;
export const CANVAS_FAIL_TTL_MS = 30_000;
/** The listing is waited for at most this long (a model is waiting for it, or a student on a call). */
export const CANVAS_LIST_WALL_MS = 12_000;
export const CANVAS_DOWNLOAD_WALL_MS = 40_000;

export const CANVAS_DOWN = 'Canvas did not answer just now, so the course files could not be looked at. Say so in one short sentence.';
export const CANVAS_NO_FILE = 'That Canvas file is not there any more, or not one the student can open. Say so in one short sentence and offer the names you were given.';
export const CANVAS_DOWNLOAD_FAILED = 'Canvas did not give that file just now. Say so in one short sentence and try again in a minute.';

interface Cached {
  key: string;
  at: number;
  ttl: number;
  result: CanvasFilesResult;
  files: CanvasFile[];
  hosts: Set<string>;
}

const infoOf = (f: CanvasFile): CanvasFileInfo => ({ id: f.id, name: f.name, kind: f.kind, size: f.size });

export function createCanvasSource(deps: CanvasSourceDeps): CanvasSource {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let cache: Cached | null = null;
  let inFlight: Promise<Cached> | null = null;

  /** Where the files are, as the cache knows them: the same address and course, so that a changed setting is a new listing. */
  const keyOf = (s: CanvasSettings | null): string => (s ? `${s.base}|${s.course}` : '');

  async function refresh(settings: CanvasSettings | null, key: string): Promise<Cached> {
    if (!settings) return { key, at: now(), ttl: CANVAS_FAIL_TTL_MS, result: { ok: true, files: [] }, files: [], hosts: new Set() };
    const listing = await listCanvasFiles({ base: settings.base, token: settings.token, course: settings.course, fetchImpl, maxBytes: DOC_LIMITS.sourceBytes, wallMs: CANVAS_LIST_WALL_MS, now });
    if (!listing.ok) {
      // the sentence is for the operator (it may say what to store): the log has it, the model is only told Canvas did not answer
      try {
        deps.log?.warn({ why: listing.message.slice(0, 200) }, 'canvas: the course files could not be listed');
      } catch {
        /* a log must never fail a listing */
      }
      return { key, at: now(), ttl: CANVAS_FAIL_TTL_MS, result: { ok: false, message: CANVAS_DOWN }, files: [], hosts: new Set() };
    }
    // only what a student could open in Canvas themselves (the listing marks the rest with a reason, and it is left out), newest ids last, by name
    const files = listing.files.filter((f) => !f.skip).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    return { key, at: now(), ttl: CANVAS_LIST_TTL_MS, result: { ok: true, files: files.map(infoOf) }, files, hosts: hostsOf(files) };
  }

  async function current(): Promise<Cached> {
    let settings: CanvasSettings | null = null;
    try {
      settings = deps.settings();
    } catch {
      settings = null;
    }
    const key = keyOf(settings);
    if (cache && cache.key === key && now() - cache.at < cache.ttl) return cache;
    if (!inFlight) {
      inFlight = refresh(settings, key)
        .catch((): Cached => ({ key, at: now(), ttl: CANVAS_FAIL_TTL_MS, result: { ok: false, message: CANVAS_DOWN }, files: [], hosts: new Set() }))
        .then((made) => {
          cache = made;
          return made;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    async list() {
      return (await current()).result;
    },

    async download(id) {
      try {
        const listed = await current();
        if (!listed.result.ok) return { ok: false, message: CANVAS_DOWN };
        const file = listed.files.find((f) => f.id === id);
        if (!file) return { ok: false, message: CANVAS_NO_FILE };
        const settings = deps.settings();
        if (!settings || keyOf(settings) !== listed.key) return { ok: false, message: CANVAS_DOWN };
        const got = await downloadCanvasFile({ base: settings.base, token: settings.token, course: settings.course, fetchImpl, maxBytes: DOC_LIMITS.sourceBytes, wallMs: CANVAS_DOWNLOAD_WALL_MS, now }, file, listed.hosts);
        if (!got.ok) {
          try {
            deps.log?.warn({ why: got.message.slice(0, 200) }, 'canvas: a course file could not be downloaded');
          } catch {
            /* a log must never fail a download */
          }
          return { ok: false, message: CANVAS_DOWNLOAD_FAILED };
        }
        return got;
      } catch {
        return { ok: false, message: CANVAS_DOWNLOAD_FAILED };
      }
    },
  };
}
