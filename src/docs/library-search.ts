/**
 * Finding a slide by what it says (docs/COURSE_DOCS.md): a search of the course library's titles and of the words of its pages. `buildIndex` and `searchLibrary` are PURE (the words go in, hits
 * come out: no file, no clock, nothing kept between calls); `LibrarySearcher` is the one piece that remembers, an index built in memory from the library's words files (a few thousand pages at most:
 * `LIBRARY_LIMITS` bounds the entries and a deck has at most 120 pages) and made again when the library changes.
 *
 * How a query is read: case, accents and punctuation do not matter (letters and digits only); a few words that say nothing about a topic ("the", "how", "slides") are dropped; what is left is compared as
 * stems (a plural, "-ing", "-ed", "-ion" and a final "e" are taken off both sides, so "replicate", "replicated" and "replication" meet). How a hit is scored: a deck whose TITLE has a word of the query is
 * above every deck that only has the words in its pages; among pages, rarer words count more, a page that has most of the words is a hit and one that has a word or two of a long query is not, and the
 * words in a row (as the query has them) are worth more. At most `LIBRARY_LIMITS.hits` hits, at most `perDeck` from one deck.
 *
 * What a hit says of the page is a SNIPPET: a stretch of the page's own words, taken from the page's text as it is (white space made single), starting a little before the first word that matched
 * and at most `snippetChars` characters long with "..." where it was cut. Nothing in it is made up or paraphrased; a page with no text has none.
 */
import { LIBRARY_LIMITS } from './types.js';
import type { LibraryEntry, LibraryHit } from './types.js';

/** What the index is built from: one deck, with the text of each of its pages (`pages[0]` is page 1). */
export interface SearchableDeck {
  id: string;
  title: string;
  week: number | null;
  pages: readonly string[];
}

interface IndexedPage {
  /** The page's text with its white space made single: what a snippet is cut from. */
  flat: string;
  stems: ReadonlySet<string>;
  /** Letters, digits and single spaces: for the words in a row. */
  norm: string;
}
interface IndexedDeck {
  id: string;
  title: string;
  week: number | null;
  titleStems: ReadonlySet<string>;
  titleNorm: string;
  pages: IndexedPage[];
}

export interface LibraryIndex {
  decks: IndexedDeck[];
  /** How many pages hold each stem: a word that is on every page says little. */
  frequency: ReadonlyMap<string, number>;
  pageCount: number;
}

/** What is kept of one page's text (the rest is not searched), and how many stems a page keeps. */
export const SEARCH_LIMITS = { pageChars: 8000, stemsPerPage: 600, queryWords: 8 } as const;

const STOP = new Set(
  [
    'a', 'an', 'the', 'of', 'in', 'on', 'to', 'is', 'are', 'was', 'were', 'be', 'it', 'its', 'this', 'that', 'these', 'those', 'and', 'or', 'for', 'with', 'about', 'from', 'by', 'at', 'as',
    'how', 'what', 'why', 'when', 'where', 'which', 'who', 'does', 'do', 'did', 'can', 'could', 'would', 'should', 'me', 'my', 'i', 'you', 'we', 'us', 'our', 'please', 'show', 'find', 'give',
    'slide', 'slides', 'deck', 'decks', 'lecture', 'lectures', 'page', 'pages', 'explain', 'tell',
  ].map((w) => w.toLowerCase()),
);

/** A soft hyphen is not a break between words (it is where a word may be split at the end of a line): it is taken out, not turned into a space. */
const SOFT_HYPHEN = new RegExp(String.fromCharCode(0xad), 'g');

/** Letters and digits only, lower case, accents folded, single spaces. */
export const normalize = (text: string): string =>
  text
    .replace(SOFT_HYPHEN, '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** A word as the stem both sides are compared by. */
export function stem(word: string): string {
  if (word.length <= 3 || /^\d+$/.test(word)) return word;
  let s = word;
  if (s.endsWith('ies') && s.length > 4) s = `${s.slice(0, -3)}y`;
  else if (s.endsWith('sses')) s = s.slice(0, -2);
  else if (/(?:ch|sh|x|z|s)es$/.test(s) && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('s') && !/(?:ss|us|is|os)$/.test(s)) s = s.slice(0, -1);
  for (let i = 0; i < 2; i++) {
    if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
    else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
    else if (s.length > 6 && s.endsWith('ion')) s = s.slice(0, -3);
    else break;
  }
  if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

const stemsOf = (norm: string, max: number): Set<string> => {
  const out = new Set<string>();
  for (const word of norm.split(' ')) {
    if (word.length === 0 || (word.length < 2 && !/^\d$/.test(word))) continue;
    out.add(stem(word));
    if (out.size >= max) break;
  }
  return out;
};

/** A page's text as the index keeps it. */
function indexPage(text: string): IndexedPage {
  const flat = text.replace(SOFT_HYPHEN, '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, SEARCH_LIMITS.pageChars);
  const norm = normalize(flat);
  return { flat, stems: stemsOf(norm, SEARCH_LIMITS.stemsPerPage), norm };
}

export function buildIndex(decks: readonly SearchableDeck[]): LibraryIndex {
  const frequency = new Map<string, number>();
  let pageCount = 0;
  const indexed = decks.map((deck): IndexedDeck => {
    const titleNorm = normalize(deck.title);
    const pages = deck.pages.slice(0, 500).map(indexPage);
    for (const p of pages) for (const s of p.stems) frequency.set(s, (frequency.get(s) ?? 0) + 1);
    pageCount += pages.length;
    return { id: deck.id, title: deck.title, week: deck.week, titleStems: stemsOf(titleNorm, 60), titleNorm, pages };
  });
  return { decks: indexed, frequency, pageCount };
}

/** The words of a query that say something about a topic, as stems (at most `queryWords`, each once). */
export function queryStems(query: unknown): { stems: string[]; norm: string } {
  const raw = typeof query === 'string' ? query.slice(0, LIBRARY_LIMITS.queryChars * 2) : '';
  const norm = normalize(raw);
  const stems: string[] = [];
  const kept: string[] = [];
  for (const word of norm.split(' ')) {
    if (word.length === 0 || STOP.has(word) || (word.length < 2 && !/^\d$/.test(word))) continue;
    kept.push(word);
    const s = stem(word);
    if (!stems.includes(s) && stems.length < SEARCH_LIMITS.queryWords) stems.push(s);
  }
  return { stems, norm: kept.join(' ') };
}

/** A stretch of `flat` of at most `max` characters that starts a little before `at` (not in the middle of a word), with "..." where the text goes on. */
export function snippetAround(flat: string, at: number, max: number = LIBRARY_LIMITS.snippetChars): string {
  if (flat.length <= max) return flat;
  const mark = '...';
  let start = Math.max(0, at - 40);
  if (start > 0) {
    // not in the middle of a word: from the next space (when it is before the match), else from the match
    const space = flat.indexOf(' ', start);
    start = space !== -1 && space < at ? space + 1 : at;
  }
  const head = start > 0 ? mark : '';
  let end = Math.min(flat.length, start + max - head.length - mark.length);
  if (end < flat.length) {
    // not in the middle of a word either: back to the last space after the match
    const space = flat.lastIndexOf(' ', end);
    if (space > at) end = space;
  }
  const tail = end < flat.length ? mark : '';
  let text = `${head}${flat.slice(start, end).trim()}${tail}`;
  if (text.length > max) text = `${text.slice(0, max - mark.length).trimEnd()}${mark}`;
  return text;
}

/** Where the first word that matches is in `flat` (reading order), or -1. */
function firstMatch(flat: string, stems: ReadonlySet<string>): number {
  for (const m of flat.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = normalize(m[0]);
    if (word && stems.has(stem(word))) return m.index ?? 0;
  }
  return -1;
}

interface Candidate {
  hit: LibraryHit;
  score: number;
  week: number;
}

/**
 * The hits for a query: best first, at most `limit` (LIBRARY_LIMITS.hits) and at most `perDeck` from one deck. A query with no word that says anything gives none.
 */
export function searchLibrary(index: LibraryIndex, query: unknown, limit: number = LIBRARY_LIMITS.hits): LibraryHit[] {
  const { stems, norm: phrase } = queryStems(query);
  if (stems.length === 0 || index.decks.length === 0) return [];
  const wanted = new Set(stems);
  const total = Math.max(1, index.pageCount);
  const weight = (s: string): number => 1 + Math.log(1 + total / (1 + (index.frequency.get(s) ?? 0)));
  const needed = Math.max(1, Math.ceil(stems.length / 2));
  const candidates: Candidate[] = [];

  for (const deck of index.decks) {
    const inTitle = stems.filter((s) => deck.titleStems.has(s)).length;
    const titleScore = inTitle === 0 ? 0 : 1000 + 100 * (inTitle / stems.length) + (phrase.length > 0 && deck.titleNorm.includes(phrase) ? 50 : 0);
    deck.pages.forEach((page, i) => {
      let hits = 0;
      let score = 0;
      for (const s of stems) {
        if (page.stems.has(s)) {
          hits++;
          score += weight(s);
        }
      }
      if (hits >= needed) {
        if (stems.length > 1 && phrase.length > 0 && page.norm.includes(phrase)) score += 2 * stems.length;
        const at = firstMatch(page.flat, wanted);
        candidates.push({ hit: { id: deck.id, title: deck.title, week: deck.week, page: i + 1, pages: deck.pages.length, snippet: snippetAround(page.flat, Math.max(0, at)) }, score: titleScore + score * (hits / stems.length), week: deck.week ?? 999 });
      } else if (i === 0 && titleScore > 0) {
        // (the title's own page: kept below when a page of the deck matches better)
        candidates.push({ hit: { id: deck.id, title: deck.title, week: deck.week, page: 1, pages: deck.pages.length, snippet: snippetAround(page.flat, 0) }, score: titleScore, week: deck.week ?? 999 });
      }
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.week - b.week || a.hit.title.localeCompare(b.hit.title) || a.hit.page - b.hit.page);
  const out: LibraryHit[] = [];
  const perDeck = new Map<string, number>();
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.hit.id}:${c.hit.page}`;
    if (seen.has(key) || (perDeck.get(c.hit.id) ?? 0) >= LIBRARY_LIMITS.perDeck) continue;
    seen.add(key);
    perDeck.set(c.hit.id, (perDeck.get(c.hit.id) ?? 0) + 1);
    out.push(c.hit);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- the index that remembers

/** What the searcher reads: the library's entries (the same array until the library changes) and the text of each page of one entry. */
export interface LibrarySource {
  library(): LibraryEntry[];
  /** The text of each page of the entry (index 0 is page 1), or null when it cannot be read. */
  pageTexts(id: string): string[] | null;
}

/**
 * The searcher keeps the index of the library as it was when it was built, and builds it again when the library is not the same any more (the source hands out the same array of entries until its index
 * file changes, so a comparison of the arrays is the whole question). A failure to read is an index of what could be read; searching never throws.
 */
export class LibrarySearcher {
  private built: { entries: LibraryEntry[]; index: LibraryIndex } | null = null;

  constructor(private readonly source: LibrarySource) {}

  private current(): LibraryIndex {
    const entries = this.source.library();
    if (this.built && this.built.entries === entries) return this.built.index;
    const decks: SearchableDeck[] = [];
    for (const entry of entries) {
      let pages: string[] | null = null;
      try {
        pages = this.source.pageTexts(entry.id);
      } catch {
        pages = null;
      }
      if (pages && pages.length > 0) decks.push({ id: entry.id, title: entry.title, week: entry.week, pages });
    }
    this.built = { entries, index: buildIndex(decks) };
    return this.built.index;
  }

  search(query: unknown): LibraryHit[] {
    try {
      return searchLibrary(this.current(), query);
    } catch {
      return [];
    }
  }

  /** Pages in the index now (tests, and the log). */
  size(): number {
    try {
      return this.current().pageCount;
    } catch {
      return 0;
    }
  }
}
