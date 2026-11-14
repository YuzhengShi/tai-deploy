/**
 * The host's side of the container tool `find_course_document` (docs/COURSE_DOCS.md): the IPC verb `course_doc_find`, kept apart from src/ipc.ts (which imports the database) so that its rules are tested
 * without one. The model of src/chat-objects/ipc-verb.ts: nothing here takes long (a search of an index in memory), so the answer is written before the function returns, and there is no timer.
 *
 * Every request gets exactly one answer (`results/<requestId>.json`, which the container's tool waits for): the slides that matched, with their titles, weeks, pages and a stretch of each page's own words
 * as quoted data (src/docs/library-answer.ts), or a sentence that none matched, or that the library has no decks. The request is `{ query }`; the student is the folder of the IPC directory the file was
 * in: nothing in the file names a student, and the library is the same for every student. What is logged is that a search happened and how many slides it found, never the words of the query.
 */
import { LIBRARY_ANSWER_CHARS, NO_QUERY, cleanQuery, slidesAnswer } from './library-answer.js';
import { RENDER_NOT_SET_UP } from './render.js';
import type { DocsApi } from './types.js';

export { LIBRARY_ANSWER_CHARS };

export const COURSE_DOC_NOT_REGISTERED = 'Not searched: this chat is not registered, so there is no student to search for.';
export const COURSE_DOC_FAILED = 'The search of the course decks failed (not their question). Say so in one short sentence and go on without it.';

export interface CourseDocVerbInput {
  /** The folder of the IPC directory the file was in (never read from the file). */
  folder: string;
  isMain: boolean;
  /** The request's id when it has a usable one (src/ipc.ts REQUEST_ID), else null. */
  requestId: string | null;
  /** What the file says the request is: `{ query }`, checked here, nothing else of it is used. */
  request: unknown;
  /** The registered group of that folder, the host's own record. */
  group?: object;
}

export interface CourseDocVerbEnv {
  /** The host's documents service (src/index.ts); without it the viewer and the library are off and every request says so. */
  docs?: DocsApi;
  /** Writes the answer for the container that asked (src/ipc.ts answer(), with LIBRARY_ANSWER_CHARS). It may throw: that is caught. */
  say: (requestId: string, ok: boolean, message: string) => void;
  /** One line for the audit log (that a search happened and how many slides it found: never the query). Best effort. */
  audit: (operation: string, fields: Record<string, unknown>) => void;
  log: { warn(fields: Record<string, unknown>, message: string): void };
}

/** Answers one request. Never throws; a request with no usable id gets no answer (there is nowhere to write one). */
export function handleCourseDocFind(input: CourseDocVerbInput, env: CourseDocVerbEnv): void {
  const { folder, requestId } = input;
  if (requestId === null) {
    env.log.warn({ folder }, 'course_doc_find without a usable request id: dropped');
    return;
  }
  const say = (ok: boolean, message: string): void => {
    try {
      env.say(requestId, ok, message.slice(0, LIBRARY_ANSWER_CHARS));
    } catch (err) {
      env.log.warn({ folder, err: err instanceof Error ? err.message : String(err) }, 'course_doc_find: the answer could not be written');
    }
  };
  try {
    if (!env.docs) return say(false, RENDER_NOT_SET_UP);
    if (!input.group && !input.isMain) {
      env.log.warn({ folder }, 'course_doc_find from a chat that is not registered: refused');
      return say(false, COURSE_DOC_NOT_REGISTERED);
    }
    const body = input.request && typeof input.request === 'object' && !Array.isArray(input.request) ? (input.request as Record<string, unknown>) : {};
    const query = cleanQuery(body.query);
    if (query.length === 0) return say(false, NO_QUERY);
    const empty = env.docs.library().length === 0;
    const answer = slidesAnswer(empty ? [] : env.docs.searchLibrary(query), empty);
    try {
      env.audit('course_doc_find', { sourceGroup: folder, isMain: input.isMain, found: answer.found, library: empty ? 'empty' : 'has decks' });
    } catch {
      /* the log is a convenience: it never changes what the container is told */
    }
    say(true, answer.block ? `${answer.note}\n${answer.block}` : answer.note);
  } catch (err) {
    env.log.warn({ folder, err: err instanceof Error ? err.message : String(err) }, 'course_doc_find: the search failed');
    say(false, COURSE_DOC_FAILED);
  }
}
