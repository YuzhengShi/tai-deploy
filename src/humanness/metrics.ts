/**
 * What makes a reply read like a bot, counted: pure functions over the text of a reply, a list of replies, or a list of numbers.
 * The shapes are the ones the owner's own reading of TAi's chat and calls kept finding (2026-11-02): a lecture for a five-word question,
 * bullet points and bold labels in a chat, a closing formula or an offer at the end of every message, a question at the end of every
 * message, the same two opening words again and again. docs/HUMANNESS.md says how to read the numbers.
 */
import { measure } from '../reply-shape.js';

export interface ReplyShape {
  words: number;
  bullets: boolean;
  bold: boolean;
  headings: boolean;
  /** The last sentence is a closing formula ("let me know if...") or an offer ("would you like me to...?"). */
  closer: boolean;
  questions: number;
  endsWithQuestion: boolean;
  links: number;
  code: boolean;
}

const FORMULA = /(?:let me know\b|feel free\b|hope (?:this|that) helps|happy to help|don['’]?t hesitate|need (?:anything|any help)\b|anything else\b)/i;
const OFFER = /(?:would you like|do you want me to|want me to|shall i|should i)\b/i;

/** The last `n` sentences of a text without its code blocks. */
export function lastSentences(text: string, n = 2): string {
  const flat = text.replace(/```[\s\S]*?```/g, ' ').trim();
  return flat.split(/(?<=[.!?…？！])\s+/).slice(-n).join(' ');
}

export function replyShape(text: string): ReplyShape {
  const noCode = text.replace(/```[\s\S]*?```/g, ' ');
  const { count, cjk } = measure(text);
  const tail = lastSentences(text, 1);
  return {
    words: cjk ? Math.round(count / 2) : count,
    bullets: /^\s*(?:[*•-]|\d+[.)])\s+\S/m.test(noCode),
    bold: /\*\*[^*\n]+\*\*/.test(noCode),
    headings: /^\s{0,3}#{1,6}\s+\S/m.test(noCode),
    closer: FORMULA.test(tail) || (OFFER.test(tail) && /[?？]\s*$/.test(tail)),
    questions: (noCode.match(/[?？]/g) ?? []).length,
    endsWithQuestion: /[?？]\s*$/.test(noCode.trim()),
    links: (text.match(/https?:\/\/\S+/g) ?? []).length,
    code: /```/.test(text),
  };
}

export interface Stats {
  n: number;
  mean: number;
  median: number;
  p90: number;
  max: number;
}

export function stats(xs: number[]): Stats {
  if (xs.length === 0) return { n: 0, mean: 0, median: 0, p90: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, median: at(0.5), p90: at(0.9), max: s[s.length - 1] };
}

/** Share of `xs` that are true, 0 when there are none. */
export function rate(xs: boolean[]): number {
  return xs.length === 0 ? 0 : xs.filter(Boolean).length / xs.length;
}

/** The first two words of a message, in lower case without punctuation: what a reader notices when every reply starts the same way. */
function opener(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(' ');
}

/** Of the last `window` replies, the share whose opening two words another of them also opens with (0 when there are fewer than four). */
export function openerRepeats(texts: string[], window = 30): number {
  const recent = texts.slice(-window).map(opener).filter(Boolean);
  if (recent.length < 4) return 0;
  const counts = new Map<string, number>();
  for (const o of recent) counts.set(o, (counts.get(o) ?? 0) + 1);
  const repeated = [...counts.values()].filter((c) => c > 1).reduce((a, b) => a + b, 0);
  return repeated / recent.length;
}

/** The short utterances said more than once, most often first ("one sec." four times in a call is a script, not a person). */
export function repeatedLines(texts: string[], maxWords = 6): Array<{ text: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const key = t.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key && (key.match(/\S+/g) ?? []).length <= maxWords) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c > 1).map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count);
}

export interface ShapeSummary {
  n: number;
  words: Stats;
  overBudget: number;
  bullets: number;
  bold: number;
  headings: number;
  closer: number;
  endsWithQuestion: number;
  manyQuestions: number;
  manyLinks: number;
  openerRepeat: number;
}

/** `limit`: the word count above which a reply counts as long (60: the persona's own hard cap for a reply that was not asked to be deep). */
export function summarizeShapes(texts: string[], limit = 60): ShapeSummary {
  const shapes = texts.map(replyShape);
  return {
    n: shapes.length,
    words: stats(shapes.map((s) => s.words)),
    overBudget: rate(shapes.map((s) => s.words > limit)),
    bullets: rate(shapes.map((s) => s.bullets)),
    bold: rate(shapes.map((s) => s.bold)),
    headings: rate(shapes.map((s) => s.headings)),
    closer: rate(shapes.map((s) => s.closer)),
    endsWithQuestion: rate(shapes.map((s) => s.endsWithQuestion)),
    manyQuestions: rate(shapes.map((s) => s.questions > 1)),
    manyLinks: rate(shapes.map((s) => s.links > 1)),
    openerRepeat: openerRepeats(texts),
  };
}
