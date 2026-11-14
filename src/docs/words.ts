/**
 * The words of a page (src/docs/types.ts PageWords) and what is done with them: checking what the renderer container wrote, the text of a range, the word nearest a click, and finding a phrase to
 * point at. Pure functions: no file, no clock. What comes out of the renderer is untrusted, so `validateWords` is the one door by which a words file enters the host.
 */
import { DOC_LIMITS } from './types.js';
import type { PageWords, PointResult } from './types.js';

const MAX_LINES = 2000;
const WORD_NOISE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const round4 = (n: number): number => Math.round(clamp01(n) * 10_000) / 10_000;

/** A word as it is kept: no control or direction characters, no white space inside, at most DOC_LIMITS.wordChars; '' when nothing is left. */
export function cleanWord(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(WORD_NOISE, '').replace(/\s+/g, '');
  return flat.length > DOC_LIMITS.wordChars ? flat.slice(0, DOC_LIMITS.wordChars) : flat;
}

/**
 * Lines from boxes alone, for a words file that has none (or bad ones): consecutive words whose vertical centre lies within the line's own height of the line's running
 * centre belong to the line.
 */
export function deriveLines(words: PageWords['words']): Array<[number, number]> {
  const lines: Array<[number, number]> = [];
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
  return lines.slice(0, MAX_LINES);
}

/**
 * A words file as the renderer wrote it, checked: at most DOC_LIMITS.wordsPerPage words, each `[x0, y0, x1, y1, text]` with the four numbers finite and inside the page (clamped to 0..1, four
 * decimals) and a word of at least one character; a box with its corners the wrong way round is made right. Lines are kept when they are index ranges in order, and made from the boxes when they are not.
 * null when it is not an object with a `words` array, or has more words than that.
 */
export function validateWords(raw: unknown): PageWords | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = (raw as Record<string, unknown>).words;
  if (!Array.isArray(input) || input.length > DOC_LIMITS.wordsPerPage) return null;
  const words: PageWords['words'] = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length < 5) continue;
    const nums = entry.slice(0, 4);
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const text = cleanWord(entry[4]);
    if (!text) continue;
    const [a, b, c, d] = nums as number[];
    words.push([round4(Math.min(a, c)), round4(Math.min(b, d)), round4(Math.max(a, c)), round4(Math.max(b, d)), text]);
  }
  let lines: Array<[number, number]> | null = null;
  const given = (raw as Record<string, unknown>).lines;
  if (Array.isArray(given) && given.length <= MAX_LINES && words.length === input.length) {
    const ok: Array<[number, number]> = [];
    let next = 0;
    let valid = true;
    for (const line of given) {
      if (!Array.isArray(line) || line.length < 2 || !Number.isInteger(line[0]) || !Number.isInteger(line[1])) {
        valid = false;
        break;
      }
      const [a, b] = line as [number, number];
      if (a < next || b < a || b >= words.length) {
        valid = false;
        break;
      }
      ok.push([a, b]);
      next = b + 1;
    }
    if (valid && ok.length > 0) lines = ok;
  }
  return { words, lines: lines ?? deriveLines(words) };
}

/** The words `from`..`to` (inclusive, clipped to the page) as one line of text. */
export function textOf(page: PageWords, from: number, to: number): string {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(page.words.length - 1, Math.max(from, to));
  const out: string[] = [];
  for (let i = a; i <= b; i++) out.push(page.words[i][4]);
  return out.join(' ');
}

/** The whole page as text: the words of a line with spaces, the lines with newlines. */
export function pageText(page: PageWords): string {
  return page.lines.map(([a, b]) => textOf(page, a, b)).join('\n');
}

/** The index of the word whose box is nearest the point (0 inside it), or null when none is within `maxDist` of the page's size. */
export function nearestWord(page: PageWords, x: number, y: number, maxDist = 0.05): number | null {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < page.words.length; i++) {
    const [x0, y0, x1, y1] = page.words[i];
    const dx = Math.max(x0 - x, 0, x - x1);
    const dy = Math.max(y0 - y, 0, y - y1);
    const d = Math.hypot(dx, dy);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best >= 0 && bestDist <= maxDist ? best : null;
}

/** One box for each line that the words `from`..`to` touch, a hair larger than the words so that a highlight is not cut at the glyphs. */
export function boxesFor(page: PageWords, from: number, to: number): Array<[number, number, number, number]> {
  const pad = 0.003;
  const boxes: Array<[number, number, number, number]> = [];
  for (const [a, b] of page.lines) {
    const first = Math.max(a, from);
    const last = Math.min(b, to);
    if (first > last) continue;
    let x0 = 1;
    let y0 = 1;
    let x1 = 0;
    let y1 = 0;
    for (let i = first; i <= last; i++) {
      const w = page.words[i];
      x0 = Math.min(x0, w[0]);
      y0 = Math.min(y0, w[1]);
      x1 = Math.max(x1, w[2]);
      y1 = Math.max(y1, w[3]);
    }
    boxes.push([round4(x0 - pad), round4(y0 - pad), round4(x1 + pad), round4(y1 + pad)]);
  }
  return boxes;
}

/** Letters and digits in lower case, the way a phrase and a page's words are compared: punctuation and spacing do not matter. */
export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

const MAX_PHRASE_TOKENS = 24;

/**
 * Where a phrase is on a page. First as the same words in a row (ignoring case, punctuation, and how the words are broken over lines or hyphens); failing that, the window of as many words
 * that has the most of the phrase's words in it, if that is at least three quarters of them (and the phrase has two words or more). null when it is not there.
 */
export function findPhrase(page: PageWords, phrase: string): PointResult | null {
  const wanted = tokens(phrase).slice(0, MAX_PHRASE_TOKENS);
  if (wanted.length === 0) return null;
  const flat: Array<{ tok: string; i: number }> = [];
  page.words.forEach((word, i) => {
    for (const tok of tokens(word[4])) flat.push({ tok, i });
  });
  const m = wanted.length;
  if (flat.length < m) return null;
  const result = (start: number, exact: boolean): PointResult => {
    const from = flat[start].i;
    const to = flat[start + m - 1].i;
    return { from, to, exact, boxes: boxesFor(page, from, to), text: textOf(page, from, to) };
  };
  for (let s = 0; s + m <= flat.length; s++) {
    let all = true;
    for (let k = 0; k < m; k++) {
      if (flat[s + k].tok !== wanted[k]) {
        all = false;
        break;
      }
    }
    if (all) return result(s, true);
  }
  if (m < 2) return null;
  let bestStart = -1;
  let bestScore = 0;
  for (let s = 0; s + m <= flat.length; s++) {
    const pool = new Map<string, number>();
    for (let k = 0; k < m; k++) pool.set(flat[s + k].tok, (pool.get(flat[s + k].tok) ?? 0) + 1);
    let hit = 0;
    for (const tok of wanted) {
      const have = pool.get(tok) ?? 0;
      if (have > 0) {
        hit++;
        pool.set(tok, have - 1);
      }
    }
    if (hit > bestScore) {
      bestScore = hit;
      bestStart = s;
    }
  }
  return bestStart >= 0 && bestScore / m >= 0.75 ? result(bestStart, false) : null;
}
