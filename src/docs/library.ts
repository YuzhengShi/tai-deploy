/**
 * The operator's side of the course library (docs/COURSE_DOCS.md): `createLibraryAdmin` adds a deck, lists the library and removes a deck. The orchestrator never calls it (it only reads the library);
 * the `course-docs` commands of tai_live.sh do, through src/docs/course-docs.ts, on the host. A file goes through the same renderer container as a student's (the host never opens it), and what comes back
 * is kept by the store as one more directory of the library and one more row of its index.
 *
 * A library entry is course material that the operator chose to show every student; it is the operator's to keep clear of solutions to graded assignments: nothing here can tell, and nothing here
 * looks at what a deck says. The same source file (its SHA-256) is not added twice, a title is unique in the library (so that `show_document` can always name it), and the files are at most the size of a student's.
 */
import { createHash } from 'node:crypto';

import { kindOfBytes, looksLikeOldOffice, titleFrom } from './docs.js';
import { cleanWeek, weekFrom } from './library-index.js';
import type { Renderer, RenderTiming } from './render.js';
import type { DocStore, LibraryRenameInput } from './store.js';
import { DOC_LIMITS } from './types.js';
import type { LibraryEntry, PageWords } from './types.js';

export interface LibraryAddInput {
  bytes: Buffer;
  /** The file's name (it becomes the title when none is given, and the week when it says one). */
  name: string;
  title?: string;
  /** A week the operator or Canvas' module said; when absent the name is looked at. */
  week?: number | null;
}

export type LibraryAddResult =
  | { ok: true; status: 'added'; entry: LibraryEntry; timing: RenderTiming }
  | { ok: true; status: 'already'; entry: LibraryEntry }
  | { ok: false; message: string };

export interface LibraryAdmin {
  add(input: LibraryAddInput): Promise<LibraryAddResult>;
  list(): LibraryEntry[];
  /** Removes a deck by its id (or the start of it: at least six characters that name one deck). Whether it did, with the deck's title. */
  remove(idOrPrefix: string): { ok: true; title: string } | { ok: false; message: string };
  /** Changes a deck's title and/or week (by its id, or the start of it: as for `remove`). Answers with the deck as it is now and the title and week it had. `changed` is false when nothing differed. */
  rename(
    idOrPrefix: string,
    change: LibraryRenameInput,
  ): { ok: true; entry: LibraryEntry; before: { title: string; week: number | null }; changed: boolean } | { ok: false; message: string };
}

/** What the host's sentences for a model say first, without the instruction to the model that follows them: for a person at a terminal. */
export const forOperator = (message: string): string => message.replace(/\s+Say so in (?:a|one) short sentence.*$/s, '').replace(/\s+/g, ' ').trim();

export function createLibraryAdmin(deps: { store: DocStore; renderer: Renderer; log?: { warn(fields: Record<string, unknown>, message: string): void } }): LibraryAdmin {
  const { store, renderer } = deps;
  /** The one deck that an id (or the start of one: at least six characters) names, or what is wrong with it. */
  const pick = (idOrPrefix: string): { ok: true; entry: LibraryEntry } | { ok: false; message: string } => {
    const wanted = typeof idOrPrefix === 'string' ? idOrPrefix.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{6,32}$/.test(wanted)) return { ok: false, message: 'give the id of a deck (tai_live.sh course-docs list), or at least its first six characters' };
    const matches = store.library().filter((e) => e.id.startsWith(wanted));
    if (matches.length === 0) return { ok: false, message: 'no deck of the library has that id' };
    if (matches.length > 1) return { ok: false, message: 'more than one deck starts with that: give more of the id' };
    return { ok: true, entry: matches[0] };
  };
  return {
    list: () => store.library(),

    async add(input) {
      const bytes = input.bytes;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, message: 'the file is empty' };
      if (bytes.length > DOC_LIMITS.sourceBytes) return { ok: false, message: `the file is over ${Math.round(DOC_LIMITS.sourceBytes / (1024 * 1024))} MB` };
      const kind = kindOfBytes(bytes);
      if (kind === 'other') return { ok: false, message: looksLikeOldOffice(bytes) ? 'an older Office file (.ppt, .doc, .xls) or one with a password: save it as .pptx, .docx or .xlsx, or export a PDF' : 'not a PDF, PowerPoint, Word or Excel file' };

      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const known = store.findLibraryBySource(sha256);
      if (known) return { ok: true, status: 'already', entry: known };

      const title = titleFrom(input.name, input.title);
      const week = input.week === undefined ? weekFrom(input.name) : cleanWeek(input.week);
      if (!(await renderer.ready())) return { ok: false, message: 'the renderer image is not built: tai_live.sh doc build' };
      const rendered = await renderer.render(bytes, { kind });
      if (!rendered.ok) return { ok: false, message: forOperator(rendered.message) };
      const rb = rendered.readback;
      const stored = store.commitLibrary({
        title,
        week,
        sourceName: input.name,
        sha256,
        pages: rb.pages.map((p) => ({ image: p.image, ext: p.info.ext, words: p.words as PageWords })),
        ...(rb.pagesInFile !== undefined ? { pagesInFile: rb.pagesInFile } : rb.cutByRoom ? { pagesInFile: rb.drawn } : {}),
        aspect: rb.aspect,
      });
      if (stored.ok) return { ok: true, status: 'added', entry: stored.entry, timing: rendered.timing };
      if (stored.reason === 'same-file') return { ok: true, status: 'already', entry: stored.entry };
      return { ok: false, message: stored.message };
    },

    remove(idOrPrefix) {
      const found = pick(idOrPrefix);
      if (!found.ok) return found;
      const entry = found.entry;
      return store.removeLibrary(entry.id) ? { ok: true, title: entry.title } : { ok: false, message: 'the deck could not be removed' };
    },

    rename(idOrPrefix, change) {
      const found = pick(idOrPrefix);
      if (!found.ok) return found;
      const r = store.renameLibrary(found.entry.id, change);
      return r.ok ? { ok: true, entry: r.entry, before: r.before, changed: r.changed } : { ok: false, message: r.message };
    },
  };
}
