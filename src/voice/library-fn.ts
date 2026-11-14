/**
 * find_course_document for a call (docs/COURSE_DOCS.md, docs/CHAT_OBJECTS.md section 5): a host function in the conversation, no tool host and no container. It searches the course library (the decks
 * the operator added for every student: src/docs/library.ts) for the words the model gives and answers with the slides that matched: their titles, weeks, pages and a stretch of each page's own words, as
 * quoted data (src/docs/library-answer.ts). Opening one is `show_document` with a title and page from the list (the library's titles are named by it for every student).
 *
 * The interviewer and the talk-through have none (functions.ts dispatch and session.ts allowed() refuse it). A call may search `COURSE_SEARCHES` times (counted next to the viewer's state, which the
 * session keeps across function calls). Nothing here throws: a failure is an answer the model can say in a sentence.
 */
import { oneLine } from '../chat-objects/text.js';
import { NO_QUERY, OPEN_IT_VOICE, cleanQuery, slidesAnswer } from '../docs/library-answer.js';
import { DOC_LIMITS } from '../docs/types.js';
import type { LibraryHit } from '../docs/types.js';
import type { FunctionDef, FunctionEnv } from './functions.js';

/** What one call may search for (a bound with a test). */
export const COURSE_SEARCHES = 12;

export const FIND_COURSE_DOCUMENT_DEF: FunctionDef = {
  name: 'find_course_document',
  description:
    "Search the course decks (the professor's slides) for a topic: the slides that mention it, with titles, weeks and pages.\n\n" +
    'WHEN TO CALL:\n- Nothing is open, they ask about something the course covered and a slide would help\n- A page is open, what they ask is not on it, and they said yes to a slide\n\n' +
    'CORRECT PATTERN:\n1. Call it with a few topic words\n2. show_document with a title and page it lists\n\n' +
    'WRONG PATTERN:\n- Searching for what is on the page they have open ("the second bullet", "how do we scale?"): answer from its quoted text and point_at\n- Saying a slide says something the result did not show',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'A few words about the topic (e.g. "leader election")' } },
    required: ['query'],
  },
};

const counted = new WeakMap<object, number>();
const error = (message: string): string => JSON.stringify({ error: message });

// ---------------------------------------------------------------- the page they have open

/** Words too common to say that a page is about a topic. */
const COMMON = new Set(['the', 'and', 'for', 'are', 'was', 'how', 'what', 'why', 'does', 'did', 'you', 'your', 'with', 'that', 'this', 'from', 'about', 'into', 'have', 'has', 'can', 'not', 'but', 'its', 'their', 'then', 'than', 'who', 'when', 'where', 'which', 'will', 'would', 'could', 'should', 'slide', 'slides', 'page', 'explain', 'teach', 'show', 'tell', 'second', 'first', 'third', 'bullet', 'point']);
const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** A word is its start, a little short of its end, so that "scale" and "scalability", or "principle" and "principles", are the same word here. */
const stemOf = (word: string): string => (word.length >= 8 ? word.slice(0, word.length - 2) : word.length >= 5 ? word.slice(0, word.length - 1) : word);

/** How many of the topic words of `query` (each once) the text of a page has. */
export function wordsOnPage(query: string, pageText: string): { matched: number; total: number } {
  const page = wordsOf(pageText);
  const want = [...new Set(wordsOf(query).filter((w) => w.length >= 3 && !COMMON.has(w)))];
  return { matched: want.filter((w) => page.some((p) => p.startsWith(stemOf(w)))).length, total: want.length };
}

/**
 * What the model reads between a search and the `show_document` it is about to call, when the student has a page open: that page is where they are looking, and what they asked is likely on it
 * ("the second bullet", "how do we scale?" on an agenda page): answer from it and point at it, and open another slide only when they ask. Null when nothing is open. Never throws.
 */
export function openPageHint(env: FunctionEnv, query: string): string | null {
  try {
    const open = env.views?.get(env.folder)?.view.doc;
    const docs = env.docs;
    if (!open || !docs) return null;
    const meta = docs.meta(env.folder, open.id);
    if (!meta) return null;
    const page = Math.max(1, Math.min(open.page, meta.pages));
    const title = `"${oneLine(meta.title, DOC_LIMITS.titleChars)}"`;
    const { matched, total } = wordsOnPage(query, docs.text(env.folder, open.id, page) ?? '');
    if (total > 0 && matched >= Math.min(2, total) && matched * 2 >= total) {
      return `Those words are on the page they have open (page ${page} of ${title}): point_at them there and answer from the quoted text of their screen. Do not open another slide for them.`;
    }
    return `They have page ${page} of ${title} open. Do not open one of these slides unless they asked for a slide ("show me", "is there a slide on...") or said yes to an offer of one; otherwise answer from the quoted text of their screen and point_at the words, or offer the slide in one short sentence.`;
  } catch {
    return null;
  }
}

/** The pages a search listed, for each deck (by id), best match first, each page once. */
function listingOf(hits: readonly LibraryHit[]): Map<string, number[]> {
  const listed = new Map<string, number[]>();
  for (const hit of hits) {
    const pages = listed.get(hit.id) ?? [];
    if (!pages.includes(hit.page)) pages.push(hit.page);
    listed.set(hit.id, pages);
  }
  return listed;
}

export function findCourseDocument(args: Record<string, unknown>, env: FunctionEnv): string {
  try {
    const docs = env.docs;
    if (!docs) return error('the course library is not set up on this server yet: say so in one short sentence and use the course knowledge and the Canvas look-ups instead');
    const query = cleanQuery(args.query);
    if (query.length === 0) return error(NO_QUERY);
    const key = env.screenState;
    const used = key ? (counted.get(key) ?? 0) : 0;
    if (used >= COURSE_SEARCHES) return error(`this call has searched the course decks ${COURSE_SEARCHES} times already: say what you know, or ask what they want to look at`);
    if (key) counted.set(key, used + 1);
    const empty = docs.library().length === 0;
    const hits = empty ? [] : docs.searchLibrary(query);
    // the pages this search listed, for each deck: a deck opened next without a page is offered the page that fits (screen.ts showDocument)
    if (key) key.listed = listingOf(hits);
    const answer = slidesAnswer(hits, empty, undefined, OPEN_IT_VOICE);
    env.log.info({ folder: env.folder, found: answer.found }, 'voice: the course decks were searched');
    const open = openPageHint(env, query);
    return JSON.stringify({ found: answer.found, ...(answer.block ? { slides: answer.block } : {}), ...(open ? { open_page: open } : {}), note: answer.note });
  } catch (err) {
    env.log.warn({ folder: env.folder, err: err instanceof Error ? err.message : String(err) }, 'voice: the search of the course decks failed');
    return error('that did not work; say so briefly and carry on');
  }
}
