/**
 * The preview of a reply while it is being written (TAI_PORTAL_STREAM, docs/STREAMING.md): what the student's page may show of the model's words
 * before the reply is whole. Two parts, both pure:
 *
 *   previewParts   the accumulated text of one assistant message goes through the filters the FINAL text goes through (formatOutbound, the closing
 *                  formula for a student, src/index.ts), and the preview is its stable prefix: whole sentences or paragraphs that are followed by the
 *                  first character of the next one, ending before the first thing that looks like a tag (`<internal`, `<choices`, half a tag). The
 *                  sentence that is still growing is never in it, which is also what keeps a fingerprint, a tag or an options block that is split
 *                  across two chunks from showing a single byte of itself: a partial one is always in the tail.
 *   PreviewTurn    the state of one chat's turn. The preview only ever GROWS (what is on screen must stay a prefix of what the final filters would
 *                  make of the text now), and anything unusual (a rewrite, a message number going back, a new message while words are still shown,
 *                  too much text, too many events, a line that did not parse) DROPS it: nothing is shown for the rest of the turn and the reply
 *                  arrives as it always did. Nothing here logs: the reason is a short word, never a word of the text.
 *
 * The filters that delete EARLIER text when a LATER marker arrives (`assistantfinal`, a `to=functions.` line, the planning-sentence rule, three
 * fingerprints replacing the whole output) cannot be known in advance; they are caught by the prefix check above, after the marker is there. Until
 * it is, the words shown are the model's own sentences before it, never a fingerprint, a tag or an option.
 */
import { trimClosingFormula } from './reply-shape.js';
import { formatOutbound } from './router.js';
import type { TextEvent } from './turn-status.js';

/** The most characters of one message the host will look at; a message that grows past it has no preview (the runner stops at 3,000). */
export const PREVIEW_MAX_INPUT = 4000;
/** The most text events of one turn: a runner that says more is not behaving. */
export const PREVIEW_MAX_EVENTS = 2000;

// --- the stable prefix ------------------------------------------------------------------------------------------------------------

const isTerminator = (c: number): boolean => c === 0x2e || c === 0x21 || c === 0x3f || c === 0x2026 || c === 0x3002 || c === 0xff01 || c === 0xff1f; // . ! ? … 。 ！ ？
const isCjkTerminator = (c: number): boolean => c === 0x3002 || c === 0xff01 || c === 0xff1f;
const isCloser = (c: number): boolean => c === 0x22 || c === 0x27 || c === 0x29 || c === 0x5d || c === 0x201d || c === 0x2019 || c === 0x300d || c === 0x300f || c === 0xff09; // " ' ) ] ” ’ 」 』 ）
const isSpace = (c: number): boolean =>
  c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;

/** What a full stop after these is not the end of a sentence: a list number or letter ("1.", "B."), an initial, and the usual abbreviations. */
const NOT_AN_END = /^(?:[A-Za-z]|\d{1,3}|e\.g|i\.e|vs|cf|Dr|Mr|Mrs|Ms|Prof|Fig|approx)$/;
const TAG_LIKE = /<[A-Za-z/!?]/;

/**
 * Where a sentence or a paragraph of `s` ends and the next one has begun (the index just after the last character of the first), ascending. One
 * pass: every character is looked at a few times at most, so 20,000 characters of dots, blank lines or backticks cost the same as prose. A cut inside
 * an open code span or fence (an odd number of backticks before it) is no cut.
 */
function cutPoints(s: string): number[] {
  const cuts: number[] = [];
  const n = s.length;
  let ticks = 0;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0x60) {
      ticks++;
      i++;
    } else if (c === 0x0a) {
      // a blank line, and then the first character of the next paragraph: what is before it is whole
      let j = i + 1;
      let blank = false;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === 0x0a) blank = true;
        else if (d !== 0x20 && d !== 0x09 && d !== 0x0d) break;
        j++;
      }
      if (blank && j < n && ticks % 2 === 0) cuts.push(i);
      i = j;
    } else if (isTerminator(c)) {
      let j = i + 1;
      while (j < n && isTerminator(s.charCodeAt(j))) j++;
      const run = j - i;
      while (j < n && isCloser(s.charCodeAt(j))) j++;
      const stop = j;
      let m = stop;
      while (m < n && isSpace(s.charCodeAt(m))) m++;
      if (m < n && (m > stop || isCjkTerminator(c)) && ticks % 2 === 0) {
        let abbreviation = false;
        if (run === 1 && c === 0x2e) {
          let b = i;
          while (b > 0 && i - b < 8 && !isSpace(s.charCodeAt(b - 1))) b--;
          abbreviation = NOT_AN_END.test(s.slice(b, i));
        }
        if (!abbreviation) cuts.push(stop);
      }
      i = Math.max(m, i + 1);
    } else {
      i++;
    }
  }
  return cuts;
}

/**
 * What the student may read of `full` (the reply as the final filters would make it if the message ended now): the text up to the last sentence or
 * paragraph that is followed by the start of another, and not past the first thing that looks like a tag. '' while there is none. For a student the
 * closing formula is taken off the end of what is shown, as it is off the end of the final.
 */
export function stablePrefix(full: string, trimClosing: boolean): string {
  const tag = TAG_LIKE.exec(full);
  const limit = tag ? tag.index : full.length;
  let best = -1;
  for (const cut of cutPoints(full)) if (cut <= limit) best = cut;
  if (best <= 0) return '';
  const prefix = full.slice(0, best).trimEnd();
  return trimClosing ? trimClosingFormula(prefix) : prefix;
}

/**
 * The reply as the final filters make it when the message ends now (src/index.ts: formatOutbound, then the closing formula off a student's reply),
 * and the part of it that may be shown. `trimClosing` is REPLY_RULE (the chat is a student's: the admin chat is never previewed).
 */
export function previewParts(accumulated: string, trimClosing: boolean): { full: string; prefix: string } {
  const filtered = formatOutbound(accumulated);
  const full = trimClosing ? trimClosingFormula(filtered) : filtered;
  return { full, prefix: stablePrefix(filtered, trimClosing) };
}

// --- one chat's turn --------------------------------------------------------------------------------------------------------------

export interface PreviewOptions {
  trimClosing: boolean;
  /** For a test; the host's limit is PREVIEW_MAX_INPUT. */
  maxInput?: number;
}

/**
 * What one chat's reply looks like on its way to the page. `apply` and `clear` answer the preview to show now (a string, '' for none), or undefined
 * when nothing changed.
 */
export class PreviewTurn {
  /** The number of the assistant message the runner is writing (it only goes up, over a container's whole life). */
  private n = 0;
  /** The current message was cleared (it went on to call a tool): nothing more of it is shown. */
  private closed = false;
  private text = '';
  private events = 0;
  /** What the page is showing now. */
  shown = '';
  dropped = false;
  /** Why it was dropped: a short word for the debug log, never a word of the text. */
  reason: string | undefined;

  constructor(private readonly options: PreviewOptions) {}

  apply(event: TextEvent): string | undefined {
    if (this.dropped) return undefined;
    if (event.type !== 'text') return this.drop('bad-line');
    if (++this.events > PREVIEW_MAX_EVENTS) return this.drop('too-many-events');
    const { n, text } = event;
    if (!Number.isInteger(n) || n < 1 || n < this.n) return this.drop('out-of-order');
    if (typeof text !== 'string' || text.length > (this.options.maxInput ?? PREVIEW_MAX_INPUT)) return this.drop('oversize');
    if (text.includes('�')) return this.drop('bad-characters');
    if (n > this.n) {
      if (this.shown !== '') return this.drop('new-message-while-shown');
      this.n = n;
      this.closed = false;
      this.text = '';
    }
    if (text === '') return this.clearMessage();                   // the runner's own clear: the message goes on to call a tool, or is too long
    if (this.closed) return this.drop('text-after-clear');
    if (!text.startsWith(this.text)) return this.drop('rewrite');
    this.text = text;
    const { full, prefix } = previewParts(text, this.options.trimClosing);
    // what is shown must stay what the final filters would make of the text so far, as far as it goes: a rule that took back earlier words ends it
    if (this.shown !== '' && !full.startsWith(this.shown)) return this.drop('rewrite');
    if (!full.startsWith(prefix)) return this.drop('not-a-prefix');
    if (prefix.length <= this.shown.length) return undefined;
    this.shown = prefix;
    return prefix;
  }

  /** A model request begins or a tool starts: the words written before it are not the reply. Nothing happens (nothing is told) when nothing is shown. */
  clear(): string | undefined {
    if (this.dropped) return undefined;
    return this.clearMessage();
  }

  private clearMessage(): string | undefined {
    this.closed = true;
    this.text = '';
    const had = this.shown !== '';
    this.shown = '';
    return had ? '' : undefined;
  }

  private drop(reason: string): string | undefined {
    this.dropped = true;
    this.reason = reason;
    this.text = '';
    const had = this.shown !== '';
    this.shown = '';
    return had ? '' : undefined;
  }
}
