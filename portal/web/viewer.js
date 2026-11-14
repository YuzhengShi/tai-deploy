// The document viewer (docs/CHAT_OBJECTS.md, "The viewer"; docs/VIEWER.md): a pane beside the conversation (a sheet on narrower screens) that shows the pages of a prepared document as
// the images the server made, lets the student pick words or a spot on a page, shows what TAi points at, and reports all of it through the shared view state (view-state.js).
//
// The page never parses a document and never draws anything a model wrote: a page is an <img> of the server's image, the words come from the server's words file (every number and
// string of it checked again here), and the selection, the point and TAi's boxes are boxes in percentages of the page's own box, so zoom never moves them. The geometry mirrors
// src/docs/words.ts (PageWords: boxes are fractions 0..1, words in reading order); the pure functions are exported and tested (viewer.test.js), the DOM is a thin layer over them.
import { registerViewer } from './objects.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const DOC_ID = /^[0-9a-f]{32}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PAGES = 120;                 // what the server keeps of a document (DOC_LIMITS.pages) and what a view may name
export const MAX_WORDS = 4000;                // words of a page (DOC_LIMITS.wordsPerPage)
export const MAX_SELECTION_WORDS = 600;       // the most words one selection names (the server refuses more)
export const HIGHLIGHT_MS = 8000;             // how long the boxes TAi draws stay
export const ZOOMS = ['fit', '100', '150'];
export const STORE_KEY = 'tai.viewer';        // the document and page that a reload opens again
export const ZOOM_KEY = 'tai.viewer.zoom';
export const SETTLE_MS = 250;                 // a page turned to right after another is asked for (with its words and neighbours) only after it has stayed this long: turning quickly through pages asks only for the page the student stops at
export const MIN_POINT_MS = 500;              // a point that has less than this left of its time when its page is ready is not drawn
export const JOB_EVERY_MS = 1500;             // a document that is being prepared is asked after this often ...
export const JOB_LIMIT_MS = 190_000;          // ... for this long: an Office file's render has 30 s of queue, 150 s of clock and a guard (src/docs/render.ts, src/docs/ipc-verb.ts); a PDF's is shorter
const IMAGE_PX = 1100;                        // the longest side of a page image (DOC_LIMITS.imagePx)
const DEFAULT_ASPECT = 0.773;                 // a letter page, until the page's own shape is known
const DRAG_PX = 4;                            // a press that moves less than this is a click
const QUOTE_CHARS = 1200;
const MAX_BOXES = 40;
const WORD_CHARS = 40;
const WORD_NOISE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round4 = (value) => Math.round(clamp(value, 0, 1) * 10_000) / 10_000;

/** Text for one line of the page: control and direction characters gone, white space collapsed, cut at `max` characters. */
export function oneLine(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(WORD_NOISE, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A page number as the viewer may show it: a whole number from 1 to the document's last page (to MAX_PAGES while the page count is not known); anything else is page 1. */
export function clampPage(page, pages) {
  const last = Number.isInteger(pages) && pages >= 1 ? Math.min(pages, MAX_PAGES) : MAX_PAGES;
  const n = Math.round(Number(page));
  return Number.isFinite(n) ? clamp(n, 1, last) : 1;
}

// ---------------------------------------------------------------- what the server sends of a document

/**
 * The document's meta (GET api/doc/meta, a DocMeta of src/docs/types.ts, bare or inside `meta`), checked: the id must be the one asked for, at least one page, a title on one line.
 * `aspect` is the shape of the first page, width over height (null when the server gave none or something unlikely). null when it is no document.
 */
export function readMeta(data, wanted) {
  const meta = isObject(data) && isObject(data.meta) ? data.meta : data;
  if (!isObject(meta)) return null;
  const id = typeof meta.id === 'string' ? meta.id : wanted;
  if (typeof id !== 'string' || !DOC_ID.test(id) || (wanted && id !== wanted)) return null;
  if (!Number.isInteger(meta.pages) || meta.pages < 1) return null;
  const aspect = finite(meta.aspect) && meta.aspect >= 0.05 && meta.aspect <= 20 ? meta.aspect : null;
  return { id, title: oneLine(meta.title, 120) || 'Document', pages: Math.min(meta.pages, MAX_PAGES), aspect, origin: ['upload', 'canvas', 'course'].includes(meta.origin) ? meta.origin : null };
}

/** A word as it is kept: no control or direction characters, no white space inside, at most WORD_CHARS characters ('' when nothing is left). */
export function cleanWord(raw) {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(WORD_NOISE, '').replace(/\s+/g, '');
  return flat.length > WORD_CHARS ? flat.slice(0, WORD_CHARS) : flat;
}

/** Lines from boxes alone: consecutive words whose vertical centre lies within the line's own height of the line's running centre (the same rule as src/docs/words.ts deriveLines). */
export function deriveLines(words) {
  const lines = [];
  let start = 0;
  let centre = 0;
  let height = 0;
  for (let i = 0; i < words.length; i++) {
    const [, y0, , y1] = words[i];
    const c = (y0 + y1) / 2;
    const h = Math.max(y1 - y0, 0.004);
    if (i === 0) {
      centre = c;
      height = h;
      continue;
    }
    if (Math.abs(c - centre) > Math.max(height, h)) {
      lines.push([start, i - 1]);
      start = i;
      centre = c;
      height = h;
    } else {
      centre = (centre + c) / 2;
      height = Math.max(height, h);
    }
  }
  if (words.length > 0) lines.push([start, words.length - 1]);
  return lines;
}

/**
 * A page's words (GET api/doc/words, a PageWords of src/docs/types.ts, bare or inside `words`), checked as the host checks them: at most MAX_WORDS words of `[x0, y0, x1, y1, text]` with the four
 * numbers finite and clamped to the page, corners the right way round, a word of at least one character. The lines are kept when they tile the words exactly, in order, and made from the
 * boxes when they do not. null when it is not a words file.
 */
export function readWords(data) {
  const raw = isObject(data) && isObject(data.words) ? data.words : data;
  if (!isObject(raw) || !Array.isArray(raw.words) || raw.words.length > MAX_WORDS) return null;
  const words = [];
  for (const entry of raw.words) {
    if (!Array.isArray(entry) || entry.length < 5) continue;
    const [a, b, c, d, text] = entry;
    if (![a, b, c, d].every(finite)) continue;
    const word = cleanWord(text);
    if (!word) continue;
    words.push([round4(Math.min(a, c)), round4(Math.min(b, d)), round4(Math.max(a, c)), round4(Math.max(b, d)), word]);
  }
  let lines = null;
  if (Array.isArray(raw.lines) && words.length === raw.words.length && raw.lines.length <= 2000) {
    const tiled = [];
    let next = 0;
    let valid = true;
    for (const line of raw.lines) {
      if (!Array.isArray(line) || !Number.isInteger(line[0]) || !Number.isInteger(line[1]) || line[0] !== next || line[1] < line[0] || line[1] >= words.length) {
        valid = false;
        break;
      }
      tiled.push([line[0], line[1]]);
      next = line[1] + 1;
    }
    if (valid && next === words.length && tiled.length > 0) lines = tiled;
  }
  return { words, lines: lines || deriveLines(words) };
}

// ---------------------------------------------------------------- words, lines and boxes (the browser's side of src/docs/words.ts)

/** The words `from`..`to` (inclusive, clipped to the page) as one line of text. */
export function textOf(page, from, to) {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(page.words.length - 1, Math.max(from, to));
  const out = [];
  for (let i = a; i <= b; i++) out.push(page.words[i][4]);
  return out.join(' ');
}

/** The words of a selection as the message box quotes them: one line, at most QUOTE_CHARS characters. */
export function quoteOf(page, from, to) {
  const text = textOf(page, from, to);
  return text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS).trimEnd()}…` : text;
}

/** The whole page as text: the words of a line with spaces, the lines with newlines. */
export function pageText(page) {
  return page.lines.map(([a, b]) => textOf(page, a, b)).join('\n');
}

/** The box that holds the words a..b: [x0, y0, x1, y1]. */
export function lineBox(page, [a, b]) {
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (let i = a; i <= b; i++) {
    const w = page.words[i];
    x0 = Math.min(x0, w[0]);
    y0 = Math.min(y0, w[1]);
    x1 = Math.max(x1, w[2]);
    y1 = Math.max(y1, w[3]);
  }
  return [x0, y0, x1, y1];
}

/** One box for each line that the words `from`..`to` touch, a hair larger than the words so that a highlight is not cut at the glyphs (as src/docs/words.ts boxesFor). */
export function boxesFor(page, from, to) {
  const pad = 0.003;
  const boxes = [];
  for (const [a, b] of page.lines) {
    const first = Math.max(a, from);
    const last = Math.min(b, to);
    if (first > last) continue;
    const [x0, y0, x1, y1] = lineBox(page, [first, last]);
    boxes.push([round4(x0 - pad), round4(y0 - pad), round4(x1 + pad), round4(y1 + pad)]);
  }
  return boxes;
}

/** The index of the word whose box is nearest the point (0 inside it), or null when none is within `maxDist` of the page's size (as src/docs/words.ts nearestWord). */
export function nearestWord(page, x, y, maxDist = 0.05) {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < page.words.length; i++) {
    const [x0, y0, x1, y1] = page.words[i];
    const d = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best >= 0 && bestDist <= maxDist ? best : null;
}

/**
 * The word a point falls on, the way a text caret finds it: the line the point is on or nearest to (within `maxDist` of the page's height; across counts for little, so a press in
 * the margin, or in the white space after a short line, finds the line beside it), then the word on that line the point is over, or the nearer neighbour; before the first word the
 * first, after the last the last. null when no line is near enough.
 */
export function wordAtPoint(page, x, y, maxDist = 0.05) {
  let line = -1;
  let best = Infinity;
  for (let i = 0; i < page.lines.length; i++) {
    const [x0, y0, x1, y1] = lineBox(page, page.lines[i]);
    const down = Math.max(y0 - y, 0, y - y1);
    if (down > maxDist) continue;
    const score = down + Math.max(x0 - x, 0, x - x1) * 0.05;
    if (score < best) {
      best = score;
      line = i;
    }
  }
  if (line < 0) return null;
  const [a, b] = page.lines[line];
  let pick = a;
  let gap = Infinity;
  for (let i = a; i <= b; i++) {
    const w = page.words[i];
    const g = Math.max(w[0] - x, 0, x - w[2]);
    if (g < gap) {
      gap = g;
      pick = i;
      if (g === 0) break;
    }
  }
  return pick;
}

/** The words from `start` to `end` in order and no more than MAX_SELECTION_WORDS of them: the word where the drag began always stays, the far end is cut. */
export function orderRange(start, end) {
  let from = Math.min(start, end);
  let to = Math.max(start, end);
  if (to - from >= MAX_SELECTION_WORDS) {
    if (end >= start) to = from + MAX_SELECTION_WORDS - 1;
    else from = to - MAX_SELECTION_WORDS + 1;
  }
  return { from, to };
}

/**
 * The words a drag picks out: from the word under where it began to the word under where it ended, in reading order, as a text selection does (lines in between are whole). A drag that
 * ends in the white space beyond the text still counts for the word at the other end. null when neither end is near any text (a page with no words included).
 */
export function selectionFromDrag(page, start, end) {
  if (!page || page.words.length === 0) return null;
  const a = wordAtPoint(page, start.x, start.y);
  const b = wordAtPoint(page, end.x, end.y);
  if (a === null && b === null) return null;
  return orderRange(a ?? b, b ?? a);
}

/** The words that stand under boxes TAi drew (a word is under a box when its centre is), in reading order, as a short text for a screen reader. */
export function textUnderBoxes(page, boxes, maxChars = 240) {
  const slack = 0.004;
  const parts = [];
  for (const [x0, y0, x1, y1] of boxes) {
    const inside = [];
    for (const w of page.words) {
      const cx = (w[0] + w[2]) / 2;
      const cy = (w[1] + w[3]) / 2;
      if (cx >= x0 - slack && cx <= x1 + slack && cy >= y0 - slack && cy <= y1 + slack) inside.push(w[4]);
    }
    if (inside.length > 0) parts.push(inside.join(' '));
  }
  const text = parts.join(' … ');
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

// ---------------------------------------------------------------- geometry on the screen

/** A pointer's place on the page's box as fractions 0..1 (clamped), whatever size the box is drawn at: the same spot has the same fractions at every zoom. */
export function toFraction(clientX, clientY, rect) {
  const width = rect.width > 0 ? rect.width : 1;
  const height = rect.height > 0 ? rect.height : 1;
  return { x: round4((clientX - rect.left) / width), y: round4((clientY - rect.top) / height) };
}

const pct = (n) => `${Math.round(clamp(n, 0, 1) * 10_000) / 100}%`;

/** A box as the percentages the overlay positions it with (so it follows the page at any zoom without being worked out again). */
export function boxStyle(box) {
  const [x0, y0, x1, y1] = box;
  return { left: pct(x0), top: pct(y0), width: pct(Math.max(0, x1 - x0)), height: pct(Math.max(0, y1 - y0)) };
}

export const pointStyle = (x, y) => ({ left: pct(x), top: pct(y) });

/** The width of a page image in pixels at 100%: what the renderer makes of its shape (the longest side is IMAGE_PX). */
export function naturalWidthOf(aspect) {
  const a = finite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
  return Math.round(a >= 1 ? IMAGE_PX : IMAGE_PX * a);
}

/** The CSS width of the page box for a zoom: the width of the pane for "fit", the image's own width for 100%, one and a half times that for 150%. */
export function pageWidth(zoom, natural) {
  if (zoom === '100') return `${Math.round(natural)}px`;
  if (zoom === '150') return `${Math.round(natural * 1.5)}px`;
  return '100%';
}

/** The zoom a step of plus (1) or minus (-1) leads to; the ends stay where they are. */
export function nextZoom(zoom, step) {
  const at = ZOOMS.indexOf(zoom);
  return ZOOMS[clamp((at < 0 ? 0 : at) + step, 0, ZOOMS.length - 1)];
}

/** The boxes TAi pointed at, checked: at most MAX_BOXES, four numbers each, inside the page, corners the right way round, with some size. */
export function cleanBoxes(raw) {
  if (!Array.isArray(raw)) return [];
  const boxes = [];
  for (const box of raw) {
    if (!Array.isArray(box) || box.length < 4 || !box.slice(0, 4).every(finite)) continue;
    const [a, b, c, d] = box;
    const x0 = round4(Math.min(a, c));
    const y0 = round4(Math.min(b, d));
    const x1 = round4(Math.max(a, c));
    const y1 = round4(Math.max(b, d));
    if (x1 - x0 > 0 && y1 - y0 > 0) boxes.push([x0, y0, x1, y1]);
    if (boxes.length >= MAX_BOXES) break;
  }
  return boxes;
}

// ---------------------------------------------------------------- what the viewer reports (the parts of the shared view state it owns)

/** A page is shown: the view's `doc`, and no selection or point (those were on another page). */
export const viewForPage = (doc, page) => ({ doc: { id: doc, page }, sel: null, point: null });
/** The viewer closed: nothing of the document is in the view any more. */
export const viewForClose = () => ({ doc: null, sel: null, point: null });
/** Words were selected: the range; a spot clicked earlier is no longer what the student is looking at. */
export const viewForSelection = (doc, page, range) => ({ sel: { doc, page, from: range.from, to: range.to }, point: null });
/** A click on a page (fractions): the spot; a selection made earlier is dropped. */
export const viewForPoint = (doc, page, x, y) => ({ point: { doc, page, x, y }, sel: null });

// ---------------------------------------------------------------- what is kept across a reload

/** What a reload opens again (localStorage's text, checked): the document, the page, the tab; null when there is nothing usable. */
export function parseStored(raw) {
  if (typeof raw !== 'string') return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.doc !== 'string' || !DOC_ID.test(value.doc)) return null;
  return { doc: value.doc, page: Number.isInteger(value.page) && value.page >= 1 && value.page <= MAX_PAGES ? value.page : 1, tab: value.tab === 'text' ? 'text' : 'page' };
}

export const serializeStored = ({ doc, page, tab }) => JSON.stringify({ doc, page, tab });
export const parseZoom = (raw) => (ZOOMS.includes(raw) ? raw : 'fit');

// ---------------------------------------------------------------- what the call's socket says (`show`, `point`, `doc_state`: src/voice/session.ts)

/** One of the three messages as the viewer uses it, or null when it is not one or is not usable. The page and the boxes are clamped, the words are one line. */
export function parseScreenMessage(raw) {
  if (!isObject(raw)) return null;
  if (raw.type === 'doc_state') {
    if (raw.state !== 'preparing' && raw.state !== 'failed') return null;
    return { type: 'doc_state', state: raw.state, title: oneLine(raw.title, 120), message: oneLine(raw.message, 300) };
  }
  if (raw.type !== 'show' && raw.type !== 'point') return null;
  if (typeof raw.doc !== 'string' || !DOC_ID.test(raw.doc)) return null;
  if (raw.type === 'show') {
    const pages = Number.isInteger(raw.pages) && raw.pages >= 1 ? Math.min(raw.pages, MAX_PAGES) : null;
    return { type: 'show', doc: raw.doc, page: clampPage(raw.page, pages), title: oneLine(raw.title, 120), pages };
  }
  const boxes = cleanBoxes(raw.boxes);
  return boxes.length > 0 ? { type: 'point', doc: raw.doc, page: clampPage(raw.page), boxes } : null;
}

/**
 * What to do with a `point` (boxes TAi draws on a page): `here` is the document and page on screen ({ id, page } or null), `opening` the document and page a `show` has asked for and that are not
 * on screen yet (or null). 'draw' when the page it names is on screen; 'wait' when a `show` for it is on its way (the host sends `show` and `point` a few milliseconds apart, so the boxes are kept
 * until that page is displayed); 'ignore' for anything else: a point never opens a document or turns to a page, only a `show` does.
 */
export function pointPlan(here, opening, message) {
  if (here && here.id === message.doc && here.page === message.page) return 'draw';
  if (opening && opening.id === message.doc && opening.page === message.page) return 'wait';
  return 'ignore';
}

/** What is left of the time a point is shown (HIGHLIGHT_MS from when it arrived) when its page is ready; 0 when that is not worth drawing. */
export function pointTimeLeft(arrivedAt, now, total = HIGHLIGHT_MS) {
  const left = total - (now - arrivedAt);
  return left >= MIN_POINT_MS ? left : 0;
}

/** Whether a page is turned to right after another one (within SETTLE_MS of it): a run of turns, in which only the page the student stops at is worth asking for. */
export const turnedQuickly = (lastTurnAt, now, settle = SETTLE_MS) => lastTurnAt > 0 && now - lastTurnAt < settle;

// ---------------------------------------------------------------- opening a document the student attached (POST api/doc/open, GET api/doc/job)

const PROBLEMS = {
  off: 'Opening documents is switched off right now.',
  busy: 'TAi is busy preparing other documents. Try again in a minute.',
  limit: 'You have opened a lot of documents lately. Try again in a few minutes.',
  'bad-file': 'TAi cannot open that file.',
  'too-big': 'That file is too big to open here.',
  'not-found': 'TAi could not find that file.',
  failed: 'TAi could not prepare that document.',
};
const JOB_ERRORS = new Set(Object.keys(PROBLEMS));

/** A refusal in plain words: the server's own sentence when it sent one, else the words for its code, else for the status (never a code). */
export function problemWords(status, data) {
  const message = isObject(data) ? oneLine(data.message, 300) : '';
  if (message) return message;
  const code = isObject(data) ? data.error : undefined;
  if (typeof code === 'string' && PROBLEMS[code]) return PROBLEMS[code];
  if (status === 401) return 'Your session ended. Sign in again.';
  if (status === 429) return 'You are opening documents quickly. Wait a moment, then try again.';
  if (status === 0) return 'I cannot be reached right now. Check your connection.';
  return 'That document could not be opened. Try again in a moment.';
}

/** What a document that cannot be opened says: a 404 is a document that has expired (they are kept for 30 days), anything else is a refusal in plain words. */
export const metaProblem = (status, data) => (status === 404 ? 'This document is no longer available.' : problemWords(status, data));

/** The answer of POST api/doc/open: ready (200), preparing (202, with the job to ask after), or a problem in words. */
export function openAnswer(status, data) {
  if (status === 200 && isObject(data) && typeof data.doc === 'string' && DOC_ID.test(data.doc) && (data.state === undefined || data.state === 'ready')) {
    return { kind: 'ready', doc: data.doc, page: clampPage(data.page) };
  }
  if (status === 202 && isObject(data) && typeof data.job === 'string' && JOB_ID.test(data.job)) return { kind: 'preparing', job: data.job };
  return { kind: 'error', message: problemWords(status, data) };
}

/**
 * The answer of GET api/doc/job: ready (200, as `open` answers it), still waiting, or a problem in words. A job that ended badly answers as `open` does, with the reason as `error`, a sentence as
 * `message` and a status of its own (502 it did not work, 503 busy or off, 413 too big ...): that is its last word. A dropped connection, a busy server (5xx with no reason) and the server's
 * own rate limit are waited out.
 */
export function jobAnswer(status, data) {
  if (status === 200 && isObject(data)) {
    if (data.state === 'ready' && typeof data.doc === 'string' && DOC_ID.test(data.doc)) return { kind: 'ready', doc: data.doc, page: clampPage(data.page) };
    if (data.state === 'preparing' || data.state === 'queued' || data.state === 'running') return { kind: 'waiting' };
    return { kind: 'error', message: problemWords(status, data) };
  }
  if (status === 404) return { kind: 'error', message: (isObject(data) && oneLine(data.message, 300)) || 'TAi lost track of that file. Try Open again.' };
  if (isObject(data) && JOB_ERRORS.has(data.error)) return { kind: 'error', message: problemWords(status, data) };
  if (status === 0 || status === 429 || status >= 500) return { kind: 'waiting' };
  return { kind: 'error', message: problemWords(status, data) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks after a job every `everyMs` until it is ready or has failed, for at most `limitMs`. `get(job)` answers `{ status, data }`; `onWaiting(ms)` is told how long it has been; `cancelled()`
 * stops it. Answers the job's last word: `{ kind: 'ready' | 'error' | 'timeout' | 'cancelled', ... }`.
 */
export async function pollJob({ job, get, wait = sleep, now = Date.now, everyMs = JOB_EVERY_MS, limitMs = JOB_LIMIT_MS, onWaiting = () => undefined, cancelled = () => false }) {
  const began = now();
  for (;;) {
    await wait(everyMs);
    if (cancelled()) return { kind: 'cancelled' };
    const reply = await get(job);
    if (cancelled()) return { kind: 'cancelled' };
    const answer = jobAnswer(reply.status, reply.data);
    if (answer.kind !== 'waiting') return answer;
    const waited = now() - began;
    if (waited >= limitMs) return { kind: 'timeout', message: 'This is taking longer than expected. Try Open again in a minute.' };
    onWaiting(waited);
  }
}

/** A file chip that may offer Open: a PDF the student attached (a file of kind document whose name ends .pdf). */
export const isPdfFile = (file) => !!file && file.kind === 'document' && typeof file.name === 'string' && /\.pdf$/i.test(file.name);

/** A presentation or a document the student attached (a file of kind document whose name ends .pptx, .docx or .xlsx): the host's renderer reads these too, and decides what a file is from its bytes. */
export const isOfficeFile = (file) => !!file && file.kind === 'document' && typeof file.name === 'string' && /\.(?:pptx|docx|xlsx)$/i.test(file.name);

/** Whether a file chip offers Open: a PDF, a presentation or a document. */
export const isOpenable = (file) => isPdfFile(file) || isOfficeFile(file);

/** The body of POST api/doc/open for file `index` of message `n`; null when either is not a whole number yet (a message that has not been numbered). */
export function openRequest(n, index) {
  return Number.isInteger(n) && n >= 1 && Number.isInteger(index) && index >= 0 ? { n, index } : null;
}

// ---------------------------------------------------------------- the call's socket helpers live in voice.js (sendViewOver, SCREEN_TYPES); the DOM below

const GLYPHS = {
  left: ['M15 5l-7 7 7 7'],
  right: ['M9 5l7 7-7 7'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
};

function glyph(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of GLYPHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const keep = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private window or blocked storage: the viewer works without */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* as above */
    }
  },
};

let controller = null;

/**
 * Called once by app.js with what the viewer needs: `root` (the #viewer element), `view` (the shared view state), `api` (the page's fetch helper: `{ status, data }`), `el`, `icon`,
 * `toast`, `quote(text)` (puts words in the message box as a quotation), `inCall()` and `features()` (what GET api/me said).
 */
export function initViewer(deps) {
  if (!deps || !deps.root || typeof document === 'undefined') {
    registerViewer({});
    return null;
  }
  controller = createViewer(deps);
  registerViewer({ open: controller.open, screen: controller.screen, current: controller.current, enabled: controller.enabled });
  return controller;
}

/**
 * An Open button on the chip of a PDF, a presentation or a document the student attached. The message's number is read when the button is pressed (a message that was just sent has none until the page hears it back),
 * from `info.n` (a number, or a function that answers one) or else from the row the chip is in. Does nothing for a file that is none of those, while the viewer is off, or before it is set up.
 */
export function offerOpen(chip, info) {
  return controller && info && isOpenable(info) ? controller.offerOpen(chip, info) : null;
}

function createViewer(deps) {
  const { root, view, api, el, toast, quote } = deps;
  const features = () => (typeof deps.features === 'function' && deps.features()) || {};
  const enabled = () => features().viewer === true;
  const app = root.parentElement;
  const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const s = {
    open: false,
    doc: null,           // the document that is shown: { id, title, pages, aspect }
    shown: false,        // a page of it is on screen
    page: 1,
    zoom: parseZoom(keep.get(ZOOM_KEY)),
    tab: 'page',
    ready: false,        // the page's image has loaded
    words: new Map(),    // page -> its words, or null for a page that has none
    inflight: new Map(),
    shapes: new Map(),   // page -> { aspect, width } of the image once it is known
    ahead: [],           // images fetched ahead (held so that they finish loading)
    spans: [],           // the Text tab's word elements, by word index
    marked: null,        // the range of the Text tab that carries the selection's mark
    sel: null,           // { page, from, to }
    point: null,         // { page, x, y }
    tai: null,           // { page, boxes, timer }
    status: null,        // { kind, timer }
    seq: 0,              // opens that were asked for: an answer to an older one is dropped
    opening: null,       // the document and page a `show` has asked for and that are not on screen yet: { id, page }
    waiting: null,       // a `point` that came before its page was ready: { doc, page, boxes, at }
    settle: 0,           // the timer that asks for a page once it has stayed a moment
    settlePage: 0,       // the page that timer is for (0: none)
    turnedAt: 0,         // when a page was last turned to (0: none yet for this document)
    opener: null,
    restored: false,
    imgSrc: '',
    retries: 0,
  };

  // ---- the pane's parts

  const button = (className, label, ...kids) => {
    const node = el('button', className);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    node.append(...kids);
    return node;
  };
  const back = button('vw-back', 'Back to the chat', glyph('left'), el('span', '', 'Back to the chat'));
  const title = el('h2', 'vw-title', 'Document');
  const close = button('vw-btn vw-close', 'Close the viewer', glyph('close'));
  close.title = 'Close';
  const prev = button('vw-btn vw-prev', 'Previous page', glyph('left'));
  const next = button('vw-btn vw-next', 'Next page', glyph('right'));
  const pages = el('span', 'vw-pages', 'Page 1');
  const zoomButtons = ZOOMS.map((zoom) => {
    const node = button('', { fit: 'Fit page to width', 100: 'Zoom to 100%', 150: 'Zoom to 150%' }[zoom]);
    node.textContent = zoom === 'fit' ? 'Fit' : `${zoom}%`;
    node.dataset.zoom = zoom;
    return node;
  });
  const zoomGroup = el('div', 'vw-seg');
  zoomGroup.setAttribute('role', 'group');
  zoomGroup.setAttribute('aria-label', 'Zoom');
  zoomGroup.append(...zoomButtons);
  const tabButtons = [['page', 'Page'], ['text', 'Text']].map(([tab, label]) => {
    const node = button('', tab === 'text' ? "Show the page's text" : 'Show the page');
    node.textContent = label;
    node.dataset.tab = tab;
    return node;
  });
  const tabGroup = el('div', 'vw-seg');
  tabGroup.setAttribute('role', 'group');
  tabGroup.setAttribute('aria-label', 'Show');
  tabGroup.append(...tabButtons);
  const nav = el('div', 'vw-nav');
  nav.append(prev, pages, next);
  const bar = el('div', 'vw-bar');
  bar.append(nav, tabGroup, zoomGroup);
  const top = el('div', 'vw-top');
  top.append(back, title, close);
  const head = el('header', 'vw-head');
  head.append(top, bar);

  const statusLine = el('p', 'vw-status');
  statusLine.setAttribute('role', 'status');
  statusLine.hidden = true;

  const img = el('img', 'vw-img');
  img.draggable = false;
  img.decoding = 'async';
  img.alt = '';
  const over = el('div', 'vw-over');
  over.setAttribute('aria-hidden', 'true');
  const failure = el('div', 'vw-fail');
  failure.hidden = true;
  const failText = el('p', '', 'This page could not be loaded.');
  const retry = button('vw-ask', '');
  retry.textContent = 'Try again';
  failure.append(failText, retry);
  const pageBox = el('div', 'vw-page');
  pageBox.dataset.state = 'loading';
  pageBox.append(img, over, failure);
  const scroll = el('div', 'vw-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.append(pageBox);
  const textPanel = el('div', 'vw-text');
  textPanel.tabIndex = 0;
  textPanel.setAttribute('role', 'region');
  textPanel.hidden = true;
  const emptyText = el('p', 'vw-empty-text');
  emptyText.setAttribute('role', 'status');
  const emptyClose = button('vw-ask', '');
  emptyClose.textContent = 'Close';
  const empty = el('div', 'vw-empty');
  empty.hidden = true;
  empty.append(emptyText, emptyClose);
  const body = el('div', 'vw-body');
  body.append(scroll, textPanel, empty);

  const selCount = el('span', 'vw-selbar-text');
  selCount.setAttribute('aria-live', 'polite');
  const ask = button('vw-ask', 'Ask TAi about this');
  ask.textContent = 'Ask TAi about this';
  const clearSel = button('vw-btn', 'Clear the selection', glyph('close'));
  const selBar = el('div', 'vw-selbar');
  selBar.hidden = true;
  selBar.append(selCount, ask, clearSel);

  const live = el('span', 'sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');

  root.textContent = '';
  root.append(head, statusLine, body, selBar, live);

  // ---- small things

  function say(text) {
    live.textContent = '';
    setTimeout(() => {
      live.textContent = text;
    }, 30);
  }

  function setStatus(kind, text, ms) {
    clearTimeout(s.status && s.status.timer);
    statusLine.textContent = text;
    statusLine.dataset.kind = kind;
    statusLine.hidden = false;
    s.status = { kind, timer: setTimeout(clearStatus, ms) };
  }

  function clearStatus() {
    if (s.status) clearTimeout(s.status.timer);
    s.status = null;
    statusLine.hidden = true;
    statusLine.textContent = '';
  }

  const pageUrl = (id, page) => `api/doc/page?d=${id}&p=${page}`;
  const wordsHere = () => (s.doc ? s.words.get(s.page) || null : null);

  function persist() {
    if (s.doc && s.shown) keep.set(STORE_KEY, serializeStored({ doc: s.doc.id, page: s.page, tab: s.tab }));
  }

  // ---- the pane and where it sits (a column beside the conversation, or a sheet above the message box)

  const narrow = typeof matchMedia === 'function' ? matchMedia('(max-width: 999px)') : null;

  function covering() {
    // while a sheet covers the conversation, what is under it is not reachable by keyboard or screen reader either
    const on = s.open && !!narrow && narrow.matches;
    for (const node of app.querySelectorAll('.topbar, .scroller')) node.inert = on;
  }

  function measureDock() {
    const dock = app.querySelector('.dock');
    if (dock) root.style.setProperty('--vw-dock', `${dock.offsetHeight}px`);
  }

  function showPane() {
    if (s.open) return;
    s.open = true;
    root.hidden = false;
    app.classList.add('with-viewer');
    measureDock();
    covering();
  }

  function hidePane() {
    s.open = false;
    root.hidden = true;
    app.classList.remove('with-viewer');
    covering();
  }

  function dockWatch() {
    const dock = app.querySelector('.dock');
    if (dock && typeof ResizeObserver === 'function') new ResizeObserver(() => s.open && measureDock()).observe(dock);
    if (narrow && typeof narrow.addEventListener === 'function') narrow.addEventListener('change', () => (measureDock(), covering()));
  }

  // ---- what the header says

  function drawHeader() {
    const doc = s.doc;
    root.dataset.mode = doc && s.shown ? 'doc' : 'empty';
    title.textContent = doc ? doc.title : 'Document';
    title.title = doc ? doc.title : '';
    const known = doc && doc.pages;
    pages.textContent = known ? `Page ${s.page} of ${doc.pages}` : 'Page …';
    prev.setAttribute('aria-disabled', String(!known || s.page <= 1));
    next.setAttribute('aria-disabled', String(!known || s.page >= doc.pages));
    for (const node of zoomButtons) node.setAttribute('aria-pressed', String(node.dataset.zoom === s.zoom));
    for (const node of tabButtons) node.setAttribute('aria-pressed', String(node.dataset.tab === s.tab));
    scroll.setAttribute('aria-label', doc ? `${doc.title}, page ${s.page} of ${doc.pages}` : 'Document page');
    textPanel.setAttribute('aria-label', doc ? `Text of page ${s.page}` : 'Text of the page');
    scroll.hidden = s.tab !== 'page' || !s.shown;
    textPanel.hidden = s.tab !== 'text' || !s.shown;
  }

  /** The pane says something instead of a page (a document that is being opened, one that is gone), with a way to close it. */
  function showEmpty(text) {
    s.shown = false;
    emptyText.textContent = text;
    empty.hidden = false;
    drawHeader();
    scroll.hidden = true;
    textPanel.hidden = true;
    selBar.hidden = true;
  }

  // ---- the page's size and image

  function sizePage() {
    const doc = s.doc;
    const shape = s.shapes.get(s.page);
    const aspect = (shape && shape.aspect) || (doc && doc.aspect) || DEFAULT_ASPECT;
    pageBox.style.setProperty('--vw-aspect', String(aspect));
    const natural = shape ? shape.width : naturalWidthOf(aspect);
    pageBox.style.width = pageWidth(s.zoom, natural);
  }

  function learnShape(page, image) {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) s.shapes.set(page, { aspect: image.naturalWidth / image.naturalHeight, width: image.naturalWidth });
  }

  function prefetch(page) {
    const doc = s.doc;
    if (!doc || page < 1 || page > doc.pages || s.shapes.has(page)) return;
    const image = new Image();
    image.decoding = 'async';
    image.addEventListener('load', () => learnShape(page, image));
    image.src = pageUrl(doc.id, page);
    s.ahead.push(image);
    if (s.ahead.length > 6) s.ahead.shift();
  }

  img.addEventListener('load', () => {
    if (img.getAttribute('src') !== s.imgSrc) return;
    s.ready = true;
    learnShape(s.page, img);
    sizePage();
    pageBox.dataset.state = 'ready';
    failure.hidden = true;
    renderOverlay();
  });
  img.addEventListener('error', () => {
    if (img.getAttribute('src') !== s.imgSrc) return;
    s.ready = false;
    pageBox.dataset.state = 'failed';
    failure.hidden = false;
  });
  retry.addEventListener('click', () => {
    if (!s.doc) return;
    s.retries += 1;
    s.ready = false;
    pageBox.dataset.state = 'loading';
    failure.hidden = true;
    s.imgSrc = `${pageUrl(s.doc.id, s.page)}&r=${s.retries}`;
    img.setAttribute('src', s.imgSrc);
  });

  // ---- the words of a page

  function loadWords(page) {
    const doc = s.doc;
    if (!doc) return Promise.resolve(null);
    if (s.words.has(page)) return Promise.resolve(s.words.get(page));
    if (s.inflight.has(page)) return s.inflight.get(page);
    const id = doc.id;
    const promise = api(`api/doc/words?d=${id}&p=${page}`).then((reply) => {
      s.inflight.delete(page);
      const found = reply.status === 200 ? readWords(reply.data) : null;
      // a page with no text is a words file with no words (a scan): that is remembered. Any other answer, or one that is not a words file, is a failure, and is asked for again next time
      if (found && s.doc && s.doc.id === id) s.words.set(page, found);
      return found;
    });
    s.inflight.set(page, promise);
    return promise;
  }

  function wordsArrived(page) {
    if (!s.doc || s.page !== page) return;
    if (s.tab === 'text') renderText();
    renderOverlay();
    drawSelBar();
  }

  // ---- drawing on the page: the selection, the spot, TAi's boxes

  function boxNode(className, box) {
    const node = el('div', className);
    const style = boxStyle(box);
    node.style.left = style.left;
    node.style.top = style.top;
    node.style.width = style.width;
    node.style.height = style.height;
    return node;
  }

  /** `preview`: the range a drag in progress would select (drawn before it is reported). */
  function renderOverlay(preview) {
    over.textContent = '';
    const words = wordsHere();
    const range = preview !== undefined ? preview : s.sel && s.sel.page === s.page ? s.sel : null;
    if (range && words) for (const box of boxesFor(words, range.from, range.to)) over.append(boxNode('vw-box vw-box-sel', box));
    if (s.point && s.point.page === s.page) {
      const pin = el('div', 'vw-pin');
      const style = pointStyle(s.point.x, s.point.y);
      pin.style.left = style.left;
      pin.style.top = style.top;
      over.append(pin);
    }
    if (s.tai && s.tai.page === s.page) for (const box of s.tai.boxes) over.append(boxNode('vw-box vw-box-tai', box));
  }

  function clearTai() {
    if (!s.tai) return;
    clearTimeout(s.tai.timer);
    s.tai = null;
    renderOverlay();
  }

  function showTai(page, boxes, ms = HIGHLIGHT_MS) {
    if (s.tai) clearTimeout(s.tai.timer);
    s.tai = { page, boxes, timer: setTimeout(clearTai, ms) };
    renderOverlay();
    const first = over.querySelector('.vw-box-tai');
    if (first && s.tab === 'page' && typeof first.scrollIntoView === 'function') first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
    loadWords(page).then((words) => {
      if (!s.tai || s.tai.page !== page) return;
      const text = words ? textUnderBoxes(words, boxes) : '';
      say(text ? `TAi is pointing at: ${text}` : `TAi is pointing at part of page ${page}.`);
    });
  }

  // ---- the Text tab

  function renderText() {
    textPanel.textContent = '';
    s.spans = [];
    s.marked = null;
    if (!s.doc) return;
    if (!s.words.has(s.page)) {
      textPanel.append(el('p', 'vw-note', s.inflight.has(s.page) || s.settlePage === s.page ? 'Loading the text…' : 'The text of this page could not be loaded.'));
      return;
    }
    const words = s.words.get(s.page);
    if (!words || words.words.length === 0) {
      textPanel.append(el('p', 'vw-note', 'This page has no text that TAi can read. Switch to Page and click on a spot to point at it.'));
      return;
    }
    for (const [a, b] of words.lines) {
      const line = el('div', 'vw-line');
      for (let i = a; i <= b; i++) {
        if (i > a) line.append(document.createTextNode(' '));
        const span = el('span', 'vw-word', words.words[i][4]);
        span.dataset.i = String(i);
        s.spans[i] = span;
        line.append(span);
      }
      textPanel.append(line);
    }
    markText();
  }

  /** The words of the current selection carry a mark in the Text tab too, so the tab shows what TAi has been told. */
  function markText() {
    if (s.marked) for (let i = s.marked.from; i <= s.marked.to; i++) if (s.spans[i]) s.spans[i].classList.remove('vw-sel');
    s.marked = null;
    if (!s.sel || s.sel.page !== s.page) return;
    for (let i = s.sel.from; i <= s.sel.to; i++) if (s.spans[i]) s.spans[i].classList.add('vw-sel');
    s.marked = { from: s.sel.from, to: s.sel.to };
  }

  /** The selection the browser made in the Text tab, as word indexes: the first and the last word it touches. null when it cannot be told (nothing then is reported). */
  function wordsOfSelection() {
    const selection = typeof getSelection === 'function' ? getSelection() : null;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!textPanel.contains(range.commonAncestorContainer)) return null;
    let from = -1;
    let to = -1;
    for (let i = 0; i < s.spans.length; i++) {
      const span = s.spans[i];
      if (span && range.intersectsNode(span)) {
        if (from < 0) from = i;
        to = i;
      }
    }
    if (from < 0) return null;
    // a range that begins at the very end of a word, or ends at the very start of one, does not select that word
    const start = range.startContainer;
    const end = range.endContainer;
    if (from < to && start.nodeType === 3 && s.spans[from].contains(start) && range.startOffset >= start.length) from += 1;
    if (from < to && end.nodeType === 3 && s.spans[to].contains(end) && range.endOffset <= 0) to -= 1;
    return orderRange(from, to);
  }

  let selectTimer = 0;
  document.addEventListener('selectionchange', () => {
    if (!s.open || s.tab !== 'text' || !s.shown) return;
    clearTimeout(selectTimer);
    selectTimer = setTimeout(() => {
      const selection = typeof getSelection === 'function' ? getSelection() : null;
      if (!selection || selection.rangeCount === 0 || !textPanel.contains(selection.getRangeAt(0).commonAncestorContainer)) return;   // someone else's selection
      const range = wordsOfSelection();
      if (range) setSelection(range);
      else if (s.sel) setSelection(null);       // a selection that cannot be told is not reported, and one reported before is no longer true
    }, 120);
  });

  // ---- the selection and the spot

  function drawSelBar() {
    const here = s.sel && s.sel.page === s.page && wordsHere();
    selBar.hidden = !here || !s.shown;
    if (here) {
      const n = s.sel.to - s.sel.from + 1;
      selCount.textContent = `${n} word${n === 1 ? '' : 's'} selected`;
    }
  }

  function setSelection(range) {
    if (!range) {
      if (!s.sel) return;
      s.sel = null;
      view.set({ sel: null });
    } else {
      if (s.sel && s.sel.page === s.page && s.sel.from === range.from && s.sel.to === range.to) return;
      s.sel = { page: s.page, from: range.from, to: range.to };
      s.point = null;
      view.set(viewForSelection(s.doc.id, s.page, range));
    }
    renderOverlay();
    markText();
    drawSelBar();
  }

  function setPoint(x, y) {
    s.point = { page: s.page, x, y };
    s.sel = null;
    view.set(viewForPoint(s.doc.id, s.page, x, y));
    renderOverlay();
    markText();
    drawSelBar();
  }

  ask.addEventListener('click', () => {
    const words = wordsHere();
    if (s.sel && words && typeof quote === 'function') quote(quoteOf(words, s.sel.from, s.sel.to));
  });
  clearSel.addEventListener('click', () => {
    if (typeof getSelection === 'function' && textPanel.contains(getSelection().anchorNode)) getSelection().removeAllRanges();
    setSelection(null);
    scroll.focus({ preventScroll: true });
  });

  // ---- the pointer on the page: a click is a spot, a drag is words (mouse and pen; a finger scrolls, and a tap is a click)

  let drag = null;
  pageBox.addEventListener('selectstart', (event) => event.preventDefault());
  pageBox.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !s.ready || !s.doc) return;
    const touch = event.pointerType === 'touch';
    drag = { id: event.pointerId, from: toFraction(event.clientX, event.clientY, pageBox.getBoundingClientRect()), x: event.clientX, y: event.clientY, moved: false, touch, range: null, words: wordsHere() };
    if (!touch) {
      event.preventDefault();
      try {
        pageBox.setPointerCapture(event.pointerId);
      } catch {
        /* a pointer that is gone */
      }
    }
    scroll.focus({ preventScroll: true });
  });
  pageBox.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id || drag.touch) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_PX) return;
    drag.moved = true;
    drag.range = drag.words ? selectionFromDrag(drag.words, drag.from, toFraction(event.clientX, event.clientY, pageBox.getBoundingClientRect())) : null;
    renderOverlay(drag.range);
  });
  const endDrag = (event, cancelled) => {
    if (!drag || event.pointerId !== drag.id) return;
    const done = drag;
    drag = null;
    try {
      pageBox.releasePointerCapture(event.pointerId);
    } catch {
      /* not captured */
    }
    if (cancelled) return renderOverlay();
    if (done.moved && !done.touch) {
      if (done.range) setSelection(done.range);
      else renderOverlay();                    // a drag that started and ended away from any text selects nothing
    } else if (s.ready && s.doc) {
      setPoint(done.from.x, done.from.y);
    }
  };
  pageBox.addEventListener('pointerup', (event) => endDrag(event, false));
  pageBox.addEventListener('pointercancel', (event) => endDrag(event, true));

  // ---- showing a page

  function showPage(page, { keepIfSame = true } = {}) {
    const doc = s.doc;
    if (!doc) return;
    const next = clampPage(page, doc.pages);
    const same = s.shown && next === s.page;
    s.page = next;
    s.shown = true;
    empty.hidden = true;
    // boxes that were kept for a page that is not this one are for a page the student has left
    if (s.waiting && (s.waiting.doc !== doc.id || s.waiting.page !== next)) s.waiting = null;
    if (same && keepIfSame) {
      drawHeader();
      applyWaiting();
      return;
    }
    s.sel = null;
    s.point = null;
    if (s.tai) {
      clearTimeout(s.tai.timer);
      s.tai = null;
    }
    s.ready = false;
    pageBox.dataset.state = 'loading';
    failure.hidden = true;
    s.retries = 0;
    s.imgSrc = '';
    img.alt = `Page ${next} of ${doc.pages}. The text of the page is in the Text tab.`;
    sizePage();
    renderOverlay();
    drawHeader();
    drawSelBar();
    markText();
    view.set(viewForPage(doc.id, next));
    persist();
    requestPage(next);
    if (s.tab === 'text') renderText();
    if (scroll.scrollTo) scroll.scrollTo(0, 0);
    textPanel.scrollTop = 0;
    say(`Page ${next} of ${doc.pages}`);
    applyWaiting();
  }

  /**
   * Asks for what a page needs: its picture, its words, and the pictures of the pages beside it. A page turned to after a pause is asked for at once; a page turned to right after another (within SETTLE_MS) waits
   * until the student has stayed on it for that long, and its picture is shown at once only when the browser has it already. Each page costs the server a few requests from the student's allowance (the chat's own
   * polling draws on the same one), so turning quickly through a document asks only for the page the student stops at.
   */
  function requestPage(page) {
    clearTimeout(s.settle);
    const now = Date.now();
    const quick = turnedQuickly(s.turnedAt, now);
    s.turnedAt = now;
    const show = () => {
      s.imgSrc = pageUrl(s.doc.id, page);
      img.setAttribute('src', s.imgSrc);
    };
    const more = () => {
      prefetch(page + 1);
      prefetch(page - 1);
      loadWords(page).then(() => wordsArrived(page));
    };
    if (!quick) {
      s.settlePage = 0;
      show();
      more();
      return;
    }
    if (s.shapes.has(page)) show();
    s.settlePage = page;
    s.settle = setTimeout(() => {
      s.settlePage = 0;
      if (!s.doc || s.page !== page) return;
      if (!s.imgSrc) show();
      more();
    }, SETTLE_MS);
  }

  /** Boxes that came before their page was ready are drawn now, for what is left of their time. */
  function applyWaiting() {
    const kept = s.waiting;
    s.waiting = null;
    if (!kept || !s.doc || s.doc.id !== kept.doc || s.page !== kept.page) return;
    const left = pointTimeLeft(kept.at, Date.now());
    if (left <= 0) return;
    if (s.tab !== 'page') setTab('page');
    showTai(kept.page, kept.boxes, left);
  }

  function go(page) {
    if (!s.doc || !s.shown) return;
    const target = clampPage(page, s.doc.pages);
    if (target !== s.page) showPage(target);
  }

  function setZoom(zoom) {
    if (!ZOOMS.includes(zoom) || zoom === s.zoom) return;
    s.zoom = zoom;
    keep.set(ZOOM_KEY, zoom);
    sizePage();
    drawHeader();
    // a page wider than the pane opens in the middle, not at its left edge
    scroll.scrollLeft = Math.max(0, (scroll.scrollWidth - scroll.clientWidth) / 2);
  }

  function setTab(tab) {
    if (tab === s.tab || (tab !== 'page' && tab !== 'text')) return;
    s.tab = tab;
    if (tab === 'text') {
      const page = s.page;
      const pending = loadWords(page);
      renderText();
      pending.then(() => wordsArrived(page));
    }
    drawHeader();
    persist();
    (tab === 'text' ? textPanel : scroll).focus({ preventScroll: true });
  }

  // ---- opening and closing

  /** Opens a document at a page: the meta first (which says how many pages and how big they are), then the page. Answers when the page is on screen or it is clear it will not be. */
  async function openDoc(id, page, { title: knownTitle = '', quiet = false, focus = false, fromTai = false } = {}) {
    if (!enabled() || typeof id !== 'string' || !DOC_ID.test(id)) return false;
    const mine = ++s.seq;
    // the place to go back to on close: what had the focus when the student asked (a button of the page), not the viewer's own parts and not nothing; a second open keeps the first's
    const active = document.activeElement;
    if (focus && active && active !== document.body && !root.contains(active)) s.opener = active;
    if (s.doc && s.doc.id === id && s.shown) {
      if (fromTai && s.tab !== 'page') setTab('page');
      showPane();
      showPage(page);
      if (focus) scroll.focus({ preventScroll: true });
      return true;
    }
    s.opening = { id, page: Number(page) };
    if (!quiet) {
      showPane();
      if (!s.shown) {
        s.doc = null;
        showEmpty(knownTitle ? `Opening ${knownTitle}…` : 'Opening the document…');
        title.textContent = knownTitle || 'Document';
      } else {
        setStatus('preparing', knownTitle ? `Opening ${knownTitle}…` : 'Opening the document…', 30_000);
      }
    }
    const reply = await api(`api/doc/meta?d=${id}`);
    if (mine !== s.seq) return false;
    s.opening = null;
    const meta = reply.status === 200 ? readMeta(reply.data, id) : null;
    if (!meta) {
      s.waiting = null;
      const gone = reply.status === 404;
      if (quiet) {
        if (gone) keep.remove(STORE_KEY);
        return false;
      }
      const words = metaProblem(reply.status, reply.data);
      if (s.shown) {
        setStatus('failed', words, 12_000);          // the document that is open stays, and says what went wrong with the other
      } else {
        s.doc = null;
        showEmpty(words);
        say(words);
      }
      return false;
    }
    if (!s.doc || s.doc.id !== meta.id) {
      s.turnedAt = 0;
      s.words.clear();
      s.inflight.clear();
      s.shapes.clear();
      s.ahead = [];
      s.spans = [];
      s.marked = null;
    }
    s.doc = meta;
    s.shown = false;
    showPane();
    clearStatus();
    if (fromTai && s.tab !== 'page') s.tab = 'page';
    showPage(page, { keepIfSame: false });
    if (focus) scroll.focus({ preventScroll: true });
    if (fromTai) say(`TAi opened ${meta.title}, page ${s.page} of ${meta.pages}.`);
    return true;
  }

  function closeViewer({ restoreFocus = true, forget = true } = {}) {
    if (!s.open) return;
    s.seq += 1;
    s.opening = null;
    s.waiting = null;
    clearTimeout(s.settle);
    s.settlePage = 0;
    s.turnedAt = 0;
    hidePane();
    clearTai();
    clearStatus();
    s.doc = null;
    s.shown = false;
    s.sel = null;
    s.point = null;
    s.words.clear();
    s.inflight.clear();
    s.shapes.clear();
    s.ahead = [];
    s.ready = false;
    img.removeAttribute('src');
    s.imgSrc = '';
    over.textContent = '';
    view.set(viewForClose());
    if (forget) keep.remove(STORE_KEY);
    const opener = s.opener;
    s.opener = null;
    if (restoreFocus) {
      // back to where it came from; with nothing to go back to, the message box (but not on a phone: its keyboard would cover the conversation)
      const typing = typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches;
      const target = opener && opener.isConnected && typeof opener.focus === 'function' ? opener : typing ? document.getElementById('input') : null;
      if (target && typeof target.focus === 'function') target.focus();
    }
  }

  /** A `point`: drawn when its page is on screen, kept when a `show` for it is on its way, ignored otherwise (it never opens a document or turns a page). */
  function pointAt(m) {
    const plan = pointPlan(s.doc && s.shown ? { id: s.doc.id, page: s.page } : null, s.opening, m);
    if (plan === 'draw') {
      if (s.tab !== 'page') setTab('page');
      showTai(m.page, m.boxes);
    } else if (plan === 'wait') {
      s.waiting = { doc: m.doc, page: m.page, boxes: m.boxes, at: Date.now() };
    }
  }

  function docState(m) {
    if (m.state === 'preparing') {
      const words = m.title ? `Preparing ${m.title}…` : 'Preparing the document…';
      if (!s.open) {
        showPane();
        showEmpty(words);
        title.textContent = m.title || 'Document';
      } else {
        setStatus('preparing', words, 120_000);
      }
      say(words);
      return;
    }
    const words = m.message || 'TAi could not open that document.';
    // a document that is open shows what went wrong in its own header; a pane that was only waiting for one goes, and the words go to the toast
    if (s.open && s.shown) {
      setStatus('failed', words, 12_000);
    } else {
      if (s.open) closeViewer({ restoreFocus: false, forget: false });
      toast(words);
    }
    say(words);
  }

  // ---- the keyboard and the buttons

  root.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    const stop = () => event.preventDefault();
    // a key that is held down turns one page, zooms one step: its repeats do nothing
    if (event.repeat && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', '+', '=', '-', '_'].includes(event.key)) return stop();
    switch (event.key) {
      case 'ArrowLeft':
      case 'PageUp':
        if (event.shiftKey) return;         // a selection being extended in the Text tab
        stop();
        return go(s.page - 1);
      case 'ArrowRight':
      case 'PageDown':
        if (event.shiftKey) return;
        stop();
        return go(s.page + 1);
      case '+':
      case '=':
        stop();
        return setZoom(nextZoom(s.zoom, 1));
      case '-':
      case '_':
        stop();
        return setZoom(nextZoom(s.zoom, -1));
      case 'Escape':
        stop();
        return closeViewer();
      default:
    }
  });
  const press = (node, action) => node.addEventListener('click', () => node.getAttribute('aria-disabled') !== 'true' && action());
  press(prev, () => go(s.page - 1));
  press(next, () => go(s.page + 1));
  press(close, () => closeViewer());
  press(back, () => closeViewer());
  press(emptyClose, () => closeViewer());
  for (const node of zoomButtons) press(node, () => setZoom(node.dataset.zoom));
  for (const node of tabButtons) press(node, () => setTab(node.dataset.tab));

  // ---- a reload opens the last document again; signing out forgets it

  function restore() {
    const saved = parseStored(keep.get(STORE_KEY));
    if (!saved || !enabled()) return;
    s.tab = saved.tab;
    openDoc(saved.doc, saved.page, { quiet: true });
  }

  function watchSignIn() {
    const react = () => {
      const state = app.dataset.state;
      if (state === 'chat' && !s.restored) {
        s.restored = true;
        restore();
      } else if (state === 'gate') {
        s.restored = false;
        closeViewer({ restoreFocus: false });
        keep.remove(STORE_KEY);
      }
    };
    if (typeof MutationObserver === 'function') new MutationObserver(react).observe(app, { attributes: true, attributeFilter: ['data-state'] });
    react();
  }

  // ---- an Open button on the chip of a PDF the student attached

  function offerOpenOn(chip, info) {
    if (!chip || typeof chip.append !== 'function' || !enabled() || (chip.querySelector && chip.querySelector('.file-open'))) return null;
    const open = el('button', 'file-open');
    open.type = 'button';
    open.textContent = 'Open';
    open.setAttribute('aria-label', `Open ${info.name} in the viewer`);
    let busy = false;
    const messageNumber = () => {
      if (typeof info.n === 'function') return Number(info.n());
      if (info.n !== undefined && info.n !== null) return Number(info.n);
      const row = chip.closest && chip.closest('.row');
      return Number(row && row.dataset && row.dataset.n);
    };
    const rest = () => {
      busy = false;
      open.textContent = 'Open';
      open.removeAttribute('aria-disabled');
    };
    open.addEventListener('click', async () => {
      if (busy) return;
      const body = openRequest(messageNumber(), Number(info.index));
      if (!body) return toast('TAi is still receiving that message. Try again in a moment.');
      busy = true;
      open.textContent = 'Opening…';
      open.setAttribute('aria-disabled', 'true');
      const reply = await api('api/doc/open', { method: 'POST', body });
      const first = openAnswer(reply.status, reply.data);
      let answer = first;
      if (first.kind === 'preparing') {
        open.textContent = 'Preparing…';
        toast(`Preparing ${info.name}. This can take a moment.`, 6000);
        answer = await pollJob({ job: first.job, get: (job) => api(`api/doc/job?j=${encodeURIComponent(job)}`), onWaiting: () => undefined });
      }
      rest();
      if (answer.kind === 'ready') openDoc(answer.doc, answer.page, { focus: true });
      else if (answer.kind === 'error' || answer.kind === 'timeout') toast(answer.message);
    });
    chip.append(open);
    return open;
  }

  dockWatch();
  watchSignIn();

  return {
    enabled,
    /** The viewer's open(docId, page): true when the viewer is there to open it (it opens in the background; the page appears when the server has answered). */
    open: (id, page) => {
      if (!enabled() || typeof id !== 'string' || !DOC_ID.test(id)) return false;
      openDoc(id, page, { focus: true });
      return true;
    },
    current: () => (s.open && s.doc && s.shown ? { doc: s.doc.id, page: s.page } : null),
    /** The call's `show`, `point` and `doc_state` messages. */
    screen: (message) => {
      if (!enabled()) return;
      const m = parseScreenMessage(message);
      if (!m) return;
      if (m.type === 'doc_state') docState(m);
      else if (m.type === 'show') openDoc(m.doc, m.page, { title: m.title, fromTai: true });
      else pointAt(m);
    },
    offerOpen: offerOpenOn,
  };
}
