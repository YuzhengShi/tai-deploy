/**
 * The student's thumbs on TAi's replies (POST api/feedback): what a request may say, and how the agent hears of it. A thumb is a line of its
 * own in the history (`kind: 'feedback'`, like an emoji): not a message, so no bubble, no time stamp, nothing in the pill, the drawer or the
 * search, nothing a call's context picks up, and it never starts an agent run. The agent hears of the thumbs the student has given since their
 * last message with their next one, for TAi only. The humanness report reads the same lines from the history files.
 */
import type { FeedbackNote, FeedbackTag, Rating } from './history.js';

/** What a thumb down may say was wrong: the page's four reasons. */
export const FEEDBACK_TAGS: readonly FeedbackTag[] = ['long', 'robotic', 'wrong', 'other'];

export interface FeedbackRequest {
  to: number;
  /** '' takes the student's thumb back. */
  rating: Rating | '';
  tag?: FeedbackTag;
}

/**
 * A request body as a request, or null when it is not one: `to` is the number of a message, `rating` is "up", "down" or "" (take it back),
 * and a `tag` belongs to a thumb down only (a thumb up or a taken-back thumb with a reason is a client that is confused, not one to guess at).
 */
export function feedbackRequest(body: Record<string, unknown>): FeedbackRequest | null {
  const to = typeof body.to === 'number' && Number.isInteger(body.to) && body.to > 0 ? body.to : 0;
  const rating = body.rating;
  if (!to || (rating !== 'up' && rating !== 'down' && rating !== '')) return null;
  if (body.tag === undefined) return { to, rating };
  if (rating !== 'down' || typeof body.tag !== 'string' || !(FEEDBACK_TAGS as readonly string[]).includes(body.tag)) return null;
  return { to, rating, tag: body.tag as FeedbackTag };
}

/** What the agent is told, as a clause: "was too long". Without a reason (or with "other") the thumb itself is all there is to say. */
const SAID: Record<FeedbackTag, string> = {
  long: 'was too long',
  robotic: 'sounded robotic',
  wrong: 'was wrong or misleading',
  other: '',
};

/** One thumb, as a line ahead of the student's next message: `[The student said your earlier message was too long: "Raft elects a…"]`. */
export function feedbackLine(note: FeedbackNote): string {
  const about = note.call ? 'your voice call' : 'your earlier message';
  const quoted = note.excerpt ? `: "${note.excerpt}"` : '';
  if (note.rating === 'up') return `[The student liked ${about}${quoted}]`;
  const said = note.tag ? SAID[note.tag] : '';
  return said ? `[The student said ${about} ${said}${quoted}]` : `[The student gave ${about} a thumbs down${quoted}]`;
}

/** The lines for every thumb in `notes`, one to a line and each ended by a newline, so they can go straight in front of the student's words. */
export function feedbackLines(notes: FeedbackNote[]): string {
  return notes.map((note) => `${feedbackLine(note)}\n`).join('');
}
