/**
 * `SentenceCutter`: the model's answer arrives as a stream of text pieces (one character or a whole paragraph at a time), and the mouth speaks one
 * sentence at a time. This cuts the stream into sentences as they complete, so the first sentence can be on its way to the synthesizer while the model is still
 * writing the second.
 *
 * Every decision depends only on the text itself (and, for two rules, on the text that follows, in which case the cutter waits for it), never on how the
 * text was split into pieces: feeding a text whole, one character at a time or in random pieces gives the same sentences. That is what makes it testable and
 * what keeps a slow network from changing what is said.
 *
 * A sentence ends at `.`, `?` or `!` (or the ellipsis character), together with any closing quotes and brackets after it, when whitespace follows. Not at:
 * the abbreviations of spoken answers ("e.g.", "Dr.", "et al."), a single capital initial ("J. Smith", "U.S."), "No." before a digit, a dot inside a number
 * or a name ("1.2", "v1.9.1", "main.go", "sync.Mutex": no space follows), or an ellipsis that goes on in lower case. A sentence of fewer than three words
 * ("Okay.") is not worth a request of its own and is joined to the next one, unless the stream has ended.
 *
 * Known limit: it cuts at terminators only. Text without them (list items on separate lines that have no full stops) waits for `end()`.
 */

const TERMINATORS = new Set(['.', '?', '!', '…']);
/** What may follow a terminator and still belong to its sentence: closing quotes and brackets, and the closing marks of Markdown emphasis. */
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '»', '›', '*', '_', '`']);
/** Marks that may open a word or a sentence and are not part of an abbreviation. */
const OPENERS = /^["'“‘(\[{*_`]+/;
const WHITESPACE = /\s/;
const HAS_WORD = /[\p{L}\p{N}]/u;
const INITIALS = /^(?:\p{Lu}\.)*\p{Lu}$/u;
/** A sentence of fewer words than this is joined to the next one. */
const MIN_WORDS = 3;
/** How far back to look for the word before a dot: no abbreviation is longer, and it keeps one long unbroken string from costing a scan each time. */
const LOOK_BACK = 40;

/** Lower case, without the final dot. "No" is not in the list: it is an abbreviation only before a digit. "al" is only after "et". */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'vs', 'etc', 'dr', 'mr', 'mrs', 'ms', 'prof', 'fig', 'figs', 'approx', 'cf', 'jr', 'sr', 'a.m', 'p.m', 'eq',
]);

function wordCount(text: string): number {
  let n = 0;
  for (const token of text.split(/\s+/)) if (HAS_WORD.test(token)) n++;
  return n;
}

/** The word right before position `at` (a dot), and the word before that one. */
function wordsBefore(s: string, at: number): { word: string; previous: string } {
  const floor = Math.max(0, at - LOOK_BACK);
  let start = at;
  while (start > floor && !WHITESPACE.test(s[start - 1])) start--;
  let gap = start;
  while (gap > floor && WHITESPACE.test(s[gap - 1])) gap--;
  let from = gap;
  while (from > floor && !WHITESPACE.test(s[from - 1])) from--;
  return { word: s.slice(start, at), previous: s.slice(from, gap) };
}

type Verdict = 'cut' | 'no' | 'wait';

export class SentenceCutter {
  /** The text not yet returned. It starts with a sentence that was too short to stand alone, if there is one. */
  private buf = '';
  /** Where the search for the next terminator goes on: everything before it has been judged. */
  private scan = 0;

  /** Adds text; returns the sentences that are complete now, trimmed. The text after the last cut stays until more arrives or `end()`. */
  push(text: string): string[] {
    if (!text) return [];
    this.buf += text;
    return this.drain(false);
  }

  /** The stream is over: what is left comes out as the last sentence (a short one too, alone), if it holds a letter or a digit. Ready for a new stream after. */
  end(): string[] {
    const out = this.drain(true);
    const rest = this.buf.trim();
    if (HAS_WORD.test(rest)) out.push(rest);
    this.buf = '';
    this.scan = 0;
    return out;
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const s = this.buf;
      const len = s.length;
      let i = this.scan;
      while (i < len && !TERMINATORS.has(s[i])) i++;
      if (i >= len) {
        this.scan = len;
        return out;
      }
      let e = i + 1;
      while (e < len && TERMINATORS.has(s[e])) e++; // "?!", "!!", "..." are one terminator
      if (e >= len) {
        this.scan = i; // the run may still grow
        return out;
      }
      let c = e;
      while (c < len && CLOSERS.has(s[c])) c++;
      if (c >= len) {
        this.scan = i; // more closing marks, or the space after them, may still come
        return out;
      }
      if (!WHITESPACE.test(s[c])) {
        this.scan = c; // "main.go", "1.2", "x.)y": no space, no boundary
        continue;
      }

      const verdict = this.judge(s, i, e, c, final);
      if (verdict === 'wait') {
        this.scan = i;
        return out;
      }
      if (verdict === 'no') {
        this.scan = c;
        continue;
      }
      const sentence = s.slice(0, c);
      if (wordCount(sentence) < MIN_WORDS) {
        this.scan = c; // too short to stand alone: keep it at the front and look for the end of the next one
        continue;
      }
      out.push(sentence.trim());
      let next = c;
      while (next < len && WHITESPACE.test(s[next])) next++;
      this.buf = s.slice(next);
      this.scan = 0;
    }
  }

  /** Is the terminator run `s[i..e)`, followed by closers up to `c` and then whitespace, the end of a sentence? */
  private judge(s: string, i: number, e: number, c: number, final: boolean): Verdict {
    const run = s.slice(i, e);
    if (run.includes('?') || run.includes('!')) return 'cut';

    let next = c; // the first character after the space(s): two rules need to see it
    while (next < s.length && WHITESPACE.test(s[next])) next++;

    if (run.length >= 2 || run.includes('…')) {
      // An ellipsis ends the sentence only when a new one clearly begins: a capital letter (after an opening quote or bracket, if there is one).
      if (next >= s.length) return final ? 'no' : 'wait';
      const after = s.slice(next, next + 6).replace(OPENERS, '');
      if (after === '') return final ? 'no' : 'wait';
      return /^\p{Lu}/u.test(after) ? 'cut' : 'no';
    }

    const { word, previous } = wordsBefore(s, i);
    const bare = word.replace(OPENERS, '');
    const lower = bare.toLowerCase();
    if (ABBREVIATIONS.has(lower)) return 'no';
    if (lower === 'al' && previous.toLowerCase() === 'et') return 'no';
    if (INITIALS.test(bare)) return 'no';
    if (lower === 'no') {
      if (next >= s.length) return final ? 'cut' : 'wait';
      return /[0-9]/.test(s[next]) ? 'no' : 'cut'; // "No. 5" is a number, "No. I mean" is an answer
    }
    return 'cut';
  }
}
