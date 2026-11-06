/**
 * When a student asks to be taught, one sentence of 15 words is not an answer. In the owner's call of 2026-11-02 (20:31) "Can you teach me?"
 * got "Sure. What part...?", "Anything." got "Got it. Let's start with the basics." and nothing else, and every sentence of the lesson after
 * that came only when the student said "okay": the prompt said one sentence per turn, and the speech governor (speech-governor.ts) cut
 * what the model wrote to two sentences and 40 words. Teaching has its own room: while the student has asked to be taught or explained to
 * (in this turn or one of the last few), one answer may be a short explanation. Pure functions, so the rule can be tested.
 */
import type { GovernorOptions } from './speech-governor.js';

/** What one answer may say while TAi is teaching: a short explanation, the first sentence whole, and still nothing after a question. */
export const TEACH_LIMITS: Partial<GovernorOptions> = { maxSentences: 5, maxWords: 85, firstSentenceWords: 45 };

/** How many of the student's last turns still count as asking to be taught: "teach me", then "anything", then "okay", "okay". */
export const TEACH_TURNS = 6;

/** The student asking to be taught or to have something explained. */
export const TEACH_REQUEST =
  /\b(?:teach (?:me|us)|(?:can|could|would|will) you (?:please )?(?:teach|explain|walk me|go (?:over|through))|explain|walk (?:me|us) through|go (?:over|through) (?:it|that|this|the)|tell me (?:more |how |all )?about|tell me how|how (?:does|do|is|are|would|can|did) \w+|why (?:does|do|is|are|did|would) \w+|go (?:on|deeper|ahead)|keep going|continue|more detail|in (?:more )?detail|start (?:from|with) (?:the )?(?:beginning|basics|top|first))\b/i;

/**
 * The student asking for SEVERAL things: ideas, options, proposals, "a few", "which ones", a rundown. In the owner's call of 2026-11-03 20:31 "give me a
 * few project proposals" got "Here's a quick rundown of the interesting ones." and nothing after it, then one project, then "Nope, there are a few
 * more." (the governor cut a written list of four to its first item), and finally "all the proposals are in the chat": the answer to such a request
 * is the first few, said, with the rest in the chat. It gets the same room as a lesson.
 */
export const LIST_REQUEST =
  /\b(?:give|show|tell|name|list|send)\s+(?:me|us)\b[^.?!]{0,30}\b(?:few|some|several|couple|all|ideas|options|examples|projects|proposals|ones|choices|names|topics)\b|\b(?:some|a few|several|a couple of)\b[^.?!]{0,40}\b(?:ideas|options|examples|projects|proposals|ones|choices|topics)\b|\b(?:other|more|any)\s+(?:\w+\s+)?(?:ideas|options|projects|proposals|choices)\b|\bwhat\s+(?:are|were)\s+(?:the|some)\b|\bwhich\s+(?:ones|projects|proposals|topics|options)\b|\b(?:interesting|good|best|popular)\s+(?:ones|projects|proposals|options|ideas)\b|\b(?:rundown|overview|recap|summari[sz]e)\b|^\W*(?:okay|ok|yes|yeah|sure|please)?\W*tell me\W*$/i;

/** The student's last `max` turns, newest first: what they typed or said, never the host's own notes to the model. */
export function lastStudentLines(messages: unknown, max: number, isNote: (text: string) => boolean = () => false): string[] {
  if (!Array.isArray(messages)) return [];
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < max; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (m?.role !== 'user') continue;
    const text = (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => (p as { text?: unknown })?.text ?? '').join('') : '').trim();
    if (text && !isNote(text)) out.push(text);
  }
  return out;
}

/**
 * Whether the student asked to be taught, or asked for several things, in one of their last few turns, so that what TAi says now may be an
 * explanation or the first few of a list.
 */
export function teachingNow(messages: unknown, isNote: (text: string) => boolean = () => false): boolean {
  return lastStudentLines(messages, TEACH_TURNS, isNote).some((line) => TEACH_REQUEST.test(line) || LIST_REQUEST.test(line));
}
