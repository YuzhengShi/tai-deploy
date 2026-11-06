/**
 * What a mock interview leaves the student to practise from. The shadow evaluator scores every answer for the interviewer (evaluator.ts); the
 * session also keeps, for each scored answer, a review item: the question, a paraphrase of what they said, how it went in a WORD, one sentence
 * on a stronger answer and the topic. When the call ends at most eight of them go onto the interview's activity line (`items`, src/portal/
 * history.ts) and the page's card lists them, each with a "Practise this" button (portal/web/review.js).
 *
 * Three rules shape it, all from the owner's decisions: students see words and never scores (the band is a `levelWord`, and a sentence that
 * carries a score is dropped, not shown); an item is made only from an answer that was really scored (a gateway that failed gives the
 * neutral evaluation, and a card that says "getting there" about an answer nobody weighed would be a lie); and what is kept of the student's
 * words is a paraphrase, never a transcript.
 */
import type { ActivityItem } from '../portal/history.js';
import { levelWord } from './competency.js';
import type { EvaluationResult } from './evaluator.js';

export type ReviewItem = ActivityItem;

/** A review item with the mean of its four scores (1 to 5), kept only to choose the weakest when there are more than fit. It is never shown or stored. */
export interface Weighed {
  item: ReviewItem;
  mean: number;
}

/** The most questions the card lists. */
export const REVIEW_MAX = 8;
/** The most the session keeps while an interview goes on (a long interview asks ten or twelve). */
export const REVIEW_KEEP = 40;

const QUESTION_CHARS = 200;
const SENTENCE_CHARS = 240;
const TOPIC_CHARS = 80;

/**
 * A text that reads as the rubric's score or a grade: "4/5", "3 out of 5" (the rubric is 1 to 5), "score", "scored", "rating", "grade". Such a
 * sentence is not shown to a student. Not a percent sign or "rate": "99.9% available" and "a rate limiter" are what a stronger answer says.
 * It costs a false hit now and then ("3 out of 5 nodes"): the sentence is dropped and the item falls back to the concepts that were missed.
 */
const SCORELIKE = /\b[0-5](?:\.\d+)?\s*(?:\/|out of)\s*5\b|\bscor(?:e|es|ed)\b|\brating\b|\bgrade[ds]?\b/i;

function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

/** A sentence for the student to read: one line, at most `max` characters, or '' when it speaks of scores (it is dropped whole, not edited). */
export function plain(value: unknown, max = SENTENCE_CHARS): string {
  const line = oneLine(value, max);
  return line && !SCORELIKE.test(line) ? line : '';
}

/** The mean of the four scores of an evaluation, 1 to 5. */
export function meanScore(e: EvaluationResult): number {
  return (e.accuracy + e.depth + e.verbal_clarity + e.problem_solving) / 4;
}

/**
 * How an answer went, in the words the page uses for where a concept stands (levelWord): the mean of the four scores mapped from 1..5 onto
 * 0..1, so that four ones are "not started", a plain adequate answer (3) is "getting there", and a 4 or better is "solid". (The mean divided
 * by five would never say "not started": the lowest possible answer would be 0.2.)
 */
export function bandOf(e: EvaluationResult): string {
  return levelWord((meanScore(e) - 1) / 4);
}

/**
 * The item for one scored answer, or null when it has no question or nothing the student said. `args` are those of evaluate_answer (the
 * interviewer's own words for the question, a summary of the answer and the topic); `said` is the evaluator's paraphrase when it wrote one and
 * the interviewer's summary when not. The stronger answer is the evaluator's sentence; failing that, the concepts it found missing.
 */
export function reviewItem(args: Record<string, unknown>, e: EvaluationResult): Weighed | null {
  const question = oneLine(args.question_asked, QUESTION_CHARS);
  if (!question) return null;
  const said = plain(e.said) || plain(args.student_answer_summary);
  if (!said) return null;
  const missed = e.missed_concepts.map((c) => oneLine(c, 60)).filter(Boolean).slice(0, 3);
  const better = plain(e.better) || (missed.length ? plain(`A stronger answer would also bring in ${missed.join(', ')}.`) : '');
  return { item: { question, said, band: bandOf(e), better, topic: oneLine(args.topic, TOPIC_CHARS) }, mean: meanScore(e) };
}

/**
 * At most `max` items for the card, in the order they were asked: all of them when there are no more than that, else the weakest (the lowest
 * mean; the earlier of two equal ones), because those are what is worth practising.
 */
export function pickItems(pool: readonly Weighed[], max = REVIEW_MAX): ReviewItem[] {
  if (pool.length <= max) return pool.map((w) => w.item);
  const keep = new Set(
    pool
      .map((w, at) => ({ at, mean: w.mean }))
      .sort((a, b) => a.mean - b.mean || a.at - b.at)
      .slice(0, max)
      .map((w) => w.at),
  );
  return pool.filter((_, at) => keep.has(at)).map((w) => w.item);
}
