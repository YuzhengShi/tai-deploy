/**
 * Which document a name means (docs/DOCUMENTS.md): the text agent's `show_document({ name })`, and anything else that is given a name by a model (the voice side's `show_document` has the
 * same need), asks this one place. A name is the title of one of the student's prepared documents, or the name of a document among the files they attached; the model's string is never joined
 * to a path as it is: it is cleaned (the folders the agent sees uploads under are taken off, a name with a separator or a leading dot is not a file name at all) and then only compared
 * with names the HOST listed itself (`listUploadDocuments`, `DocsApi.list`, `DocsApi.library`), so what comes out is always a name from one of those two lists.
 *
 * Order of the match: a file name exactly (any case), a title exactly, then a title that contains the words, then a file name that contains them; when several match the same way the answer
 * is "none" with a hint that lists them, never a guess. `hint` is a sentence for a model that says what there is.
 */
import fs from 'node:fs';
import path from 'node:path';

import { oneLine } from '../chat-objects/text.js';
import { DOC_LIMITS } from './types.js';
import type { CanvasFileInfo, CanvasFilesResult, DocMeta } from './types.js';

/** Where the agent sees a student's attached files (src/portal/uploads.ts messageFor), and what it may write in front of a name. */
const PATH_PREFIXES = ['/workspace/group/uploads/', 'workspace/group/uploads/', 'uploads/', './uploads/', './'];
/** A name the upload store can have made (src/portal/uploads.ts safeUploadName): one segment of letters, digits and `._-`, not starting with a dot, at most 80 characters. */
const UPLOAD_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/;
/** The files the renderer takes by their names: a PDF, a PowerPoint, Word or Excel file (what a file is is decided from its bytes, never from this). */
const DOCUMENT_NAME = /\.(?:pdf|pptx|docx|xlsx)$/i;
const MAX_LISTED_FILES = 100;
const MAX_NAME_CHARS = 200;

/**
 * The documents a model may name for this student: their own prepared documents first, then the course library's (a library entry is a document with the origin `course`; the same for every student).
 * A fake service that has no library (or one that throws) is a student with no library: nothing here throws.
 */
export function nameableDocs(docs: { list(folder: string): DocMeta[]; library?: () => DocMeta[] }, folder: string): DocMeta[] {
  let own: DocMeta[] = [];
  try {
    own = docs.list(folder);
  } catch {
    own = [];
  }
  let shared: DocMeta[] = [];
  try {
    shared = typeof docs.library === 'function' ? docs.library() : [];
  } catch {
    shared = [];
  }
  const seen = new Set(own.map((d) => d.id));
  return [...own, ...shared.filter((d) => !seen.has(d.id))];
}

export type DocChoice =
  | { kind: 'upload'; name: string }
  | { kind: 'existing'; id: string; title: string }
  | { kind: 'canvas'; id: number; name: string }
  /** `several`: more than one fit, so the model is to ask which (the course's Canvas files are not looked at then: nothing matched nothing). */
  | { kind: 'none'; hint: string; several?: boolean };

/** Whether a name is one safe path segment of the kind the upload store makes. */
export const isUploadName = (name: string): boolean => UPLOAD_NAME.test(name) && !name.includes('..');

/** The model's string as a name to look for: one line, the agent's upload folders taken off the front; null when nothing is left or it is not a name. */
export function cleanDocName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let name = oneLine(raw, MAX_NAME_CHARS);
  for (let again = true; again; ) {
    again = false;
    for (const prefix of PATH_PREFIXES) {
      if (name.toLowerCase().startsWith(prefix)) {
        name = name.slice(prefix.length).trimStart();
        again = true;
      }
    }
  }
  return name.length > 0 ? name : null;
}

/** The documents among a student's attached files (PDF, PowerPoint, Word and Excel files), by the names the host finds in the folder itself (regular files only, names the upload store could have made). */
export function listUploadDocuments(uploadsDir: string): string[] {
  try {
    const names: string[] = [];
    for (const name of fs.readdirSync(uploadsDir)) {
      if (names.length >= MAX_LISTED_FILES) break;
      if (!DOCUMENT_NAME.test(name) || !isUploadName(name)) continue;
      try {
        if (fs.lstatSync(path.join(uploadsDir, name)).isFile()) names.push(name);
      } catch {
        /* gone since it was listed */
      }
    }
    return names.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Letters and digits only, lower case, single spaces: how a name and a title are compared (the extension of a file name is not part of it). */
const norm = (text: string): string => text.toLowerCase().replace(DOCUMENT_NAME, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** What a name is looked for among: `canvas` are the course's files on Canvas that a student may open, and only a host that has them gives them (src/docs/canvas-source.ts). */
export interface ResolveHave {
  titles: readonly DocMeta[];
  uploads: readonly string[];
  canvas?: readonly Pick<CanvasFileInfo, 'id' | 'name'>[];
}

export function resolveDocName(rawName: unknown, have: ResolveHave): DocChoice {
  const q = cleanDocName(rawName);
  const none = (): DocChoice => ({ kind: 'none', hint: noMatchHint(q, have) });
  if (q === null) return none();
  const wanted = norm(q);
  if (wanted.length === 0) return none();

  const fileExact = have.uploads.find((u) => u.toLowerCase() === q.toLowerCase());
  if (fileExact && isUploadName(fileExact)) return { kind: 'upload', name: fileExact };

  const titleExact = have.titles.filter((t) => norm(t.title) === wanted);
  if (titleExact.length >= 1) return pickTitle(titleExact, q, have);

  const titleHas = have.titles.filter((t) => norm(t.title).includes(wanted));
  if (titleHas.length === 1) return { kind: 'existing', id: titleHas[0].id, title: titleHas[0].title };
  if (titleHas.length > 1) return { kind: 'none', several: true, hint: `Several prepared documents match that name: ${quoted(titleHas.map((t) => t.title))}. Ask which one they mean.` };

  const fileHas = have.uploads.filter((u) => isUploadName(u) && norm(u).includes(wanted));
  if (fileHas.length === 1) return { kind: 'upload', name: fileHas[0] };
  if (fileHas.length > 1) return { kind: 'none', several: true, hint: `Several of the files they attached match that name: ${fileHas.slice(0, 8).join(', ')}. Ask which one they mean.` };

  // the course's files on Canvas come last: what the student has and the professor's decks are what they most likely mean (a Canvas file that is one of those decks is that deck: docs.ts)
  const canvas = have.canvas ?? [];
  const canvasExact = canvas.filter((c) => norm(c.name) === wanted);
  if (canvasExact.length >= 1) {
    const newest = [...canvasExact].sort((a, b) => b.id - a.id)[0];
    return { kind: 'canvas', id: newest.id, name: newest.name };
  }
  const canvasHas = canvas.filter((c) => norm(c.name).includes(wanted));
  if (canvasHas.length === 1) return { kind: 'canvas', id: canvasHas[0].id, name: canvasHas[0].name };
  if (canvasHas.length > 1) return { kind: 'none', several: true, hint: `Several files of the course on Canvas match that name: ${quoted(canvasHas.map((c) => c.name))}. Ask which one they mean.` };
  return none();
}

/** Two documents with the same title (the same file prepared twice under two names): the newest. */
function pickTitle(matches: readonly DocMeta[], q: string, have: ResolveHave): DocChoice {
  const newest = [...matches].sort((a, b) => b.createdAt - a.createdAt)[0];
  return newest ? { kind: 'existing', id: newest.id, title: newest.title } : { kind: 'none', hint: noMatchHint(q, have) };
}

const quoted = (titles: readonly string[]): string => titles.slice(0, 8).map((t) => JSON.stringify(oneLine(t, DOC_LIMITS.titleChars))).join(', ');

function noMatchHint(q: string | null, have: ResolveHave): string {
  const parts: string[] = [];
  if (have.titles.length > 0) parts.push(`Prepared documents: ${quoted(have.titles.map((t) => t.title))}.`);
  if (have.uploads.length > 0) parts.push(`Files they attached: ${have.uploads.slice(0, 8).join(', ')}.`);
  if (have.canvas && have.canvas.length > 0) parts.push(`Files of the course on Canvas (some of them): ${quoted(have.canvas.map((c) => c.name))}.`);
  const what = parts.length > 0 ? parts.join(' ') : 'They have no prepared documents and have attached no document.';
  return `${q === null ? 'No name was given.' : 'Nothing matches that name.'} ${what} Ask them which one they mean, or to attach the file.`;
}

/**
 * The choice for a name, in the two steps both callers (the text agent's verb and the voice function) need: what the student has, the library and their attached files first; and only when NOTHING
 * matched (not when several did: then the model asks) the course's files on Canvas, from the host's cached listing (`canvasFiles`, DocsApi). `note` is a sentence for the model when Canvas could not be
 * looked at, to put after a "nothing matches" hint. Never throws.
 */
export async function chooseDoc(
  rawName: unknown,
  titles: readonly DocMeta[],
  uploads: readonly string[],
  canvasFiles?: () => Promise<CanvasFilesResult>,
): Promise<{ choice: DocChoice; note: string }> {
  const local = resolveDocName(rawName, { titles, uploads });
  if (local.kind !== 'none' || local.several || typeof canvasFiles !== 'function') return { choice: local, note: '' };
  let listed: CanvasFilesResult | null = null;
  try {
    listed = await canvasFiles();
  } catch {
    listed = null;
  }
  if (listed && listed.ok) return { choice: resolveDocName(rawName, { titles, uploads, canvas: listed.files }), note: '' };
  return { choice: local, note: listed && !listed.ok ? ` ${listed.message}` : '' };
}
