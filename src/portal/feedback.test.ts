/** The student's thumbs on TAi's replies: what a request may say, and the lines the agent is told. (The endpoint is in features.test.ts.) */
import { describe, expect, it } from 'vitest';

import { FEEDBACK_TAGS, feedbackLine, feedbackLines, feedbackRequest } from './feedback.js';
import type { FeedbackNote } from './history.js';

describe('a thumb as a request', () => {
  it('takes a thumb up, a thumb down with or without its reason, and taking a thumb back', () => {
    expect(feedbackRequest({ to: 4, rating: 'up' })).toEqual({ to: 4, rating: 'up' });
    expect(feedbackRequest({ to: 4, rating: 'down' })).toEqual({ to: 4, rating: 'down' });
    expect(feedbackRequest({ to: 4, rating: 'down', tag: 'long' })).toEqual({ to: 4, rating: 'down', tag: 'long' });
    expect(feedbackRequest({ to: 4, rating: '' })).toEqual({ to: 4, rating: '' });
    for (const tag of FEEDBACK_TAGS) expect(feedbackRequest({ to: 1, rating: 'down', tag }), tag).toEqual({ to: 1, rating: 'down', tag });
    expect(FEEDBACK_TAGS).toEqual(['long', 'robotic', 'wrong', 'other']);
  });

  it('is not a request when the message is not a whole number of at least 1', () => {
    for (const to of [0, -1, 1.5, '2', null, undefined, Number.NaN, Infinity, [], {}]) expect(feedbackRequest({ to, rating: 'up' }), String(to)).toBeNull();
    expect(feedbackRequest({ rating: 'up' })).toBeNull();
  });

  it('is not a request when the rating is anything but up, down or empty', () => {
    for (const rating of ['UP', 'thumbs up', 'good', 1, true, null, undefined, [], {}, ' up']) expect(feedbackRequest({ to: 2, rating }), String(rating)).toBeNull();
    expect(feedbackRequest({ to: 2 })).toBeNull();
  });

  it('takes a reason only with a thumb down, and only one of the four', () => {
    for (const rating of ['up', '']) expect(feedbackRequest({ to: 2, rating, tag: 'long' }), `${rating} with a reason`).toBeNull();
    for (const tag of ['', 'short', 'LONG', 'long ', 7, null, [], {}, '<b>']) expect(feedbackRequest({ to: 2, rating: 'down', tag }), String(tag)).toBeNull();
  });
});

describe('what the agent is told of a thumb', () => {
  const note = (extra: Partial<FeedbackNote>): FeedbackNote => ({ to: 3, rating: 'down', excerpt: 'Raft elects a leader', call: false, ...extra });

  it('says what was wrong in the student\'s own terms, with the start of the message', () => {
    expect(feedbackLine(note({ tag: 'long' }))).toBe('[The student said your earlier message was too long: "Raft elects a leader"]');
    expect(feedbackLine(note({ tag: 'robotic' }))).toBe('[The student said your earlier message sounded robotic: "Raft elects a leader"]');
    expect(feedbackLine(note({ tag: 'wrong' }))).toBe('[The student said your earlier message was wrong or misleading: "Raft elects a leader"]');
  });

  it('says only that it was a thumb down when there is no reason, or the reason is "something else"', () => {
    expect(feedbackLine(note({}))).toBe('[The student gave your earlier message a thumbs down: "Raft elects a leader"]');
    expect(feedbackLine(note({ tag: 'other' }))).toBe('[The student gave your earlier message a thumbs down: "Raft elects a leader"]');
  });

  it('says a thumb up was liked', () => {
    expect(feedbackLine(note({ rating: 'up' }))).toBe('[The student liked your earlier message: "Raft elects a leader"]');
  });

  it('is about the call when the message is a call\'s summary', () => {
    expect(feedbackLine(note({ rating: 'up', call: true, excerpt: 'Voice session, 4 min: we talked about elections.' }))).toBe('[The student liked your voice call: "Voice session, 4 min: we talked about elections."]');
    expect(feedbackLine(note({ tag: 'robotic', call: true }))).toBe('[The student said your voice call sounded robotic: "Raft elects a leader"]');
    expect(feedbackLine(note({ call: true }))).toBe('[The student gave your voice call a thumbs down: "Raft elects a leader"]');
  });

  it('leaves the quotation out when there is nothing to quote', () => {
    expect(feedbackLine(note({ excerpt: '', tag: 'long' }))).toBe('[The student said your earlier message was too long]');
    expect(feedbackLine(note({ excerpt: '', rating: 'up' }))).toBe('[The student liked your earlier message]');
  });

  it('puts each line on a line of its own, ready to go in front of the student\'s words', () => {
    expect(feedbackLines([])).toBe('');
    expect(feedbackLines([note({ rating: 'up' }), note({ tag: 'long' })])).toBe(
      '[The student liked your earlier message: "Raft elects a leader"]\n[The student said your earlier message was too long: "Raft elects a leader"]\n',
    );
  });
});
