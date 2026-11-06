import { describe, expect, it } from 'vitest';

import { defaultEvaluation } from './evaluator.js';
import type { EvaluationResult } from './evaluator.js';
import { REVIEW_MAX, bandOf, meanScore, pickItems, plain, reviewItem } from './review.js';
import type { Weighed } from './review.js';

const scores = (accuracy: number, depth: number, verbal_clarity: number, problem_solving: number, more: Partial<EvaluationResult> = {}): EvaluationResult => ({
  ...defaultEvaluation(),
  accuracy,
  depth,
  verbal_clarity,
  problem_solving,
  ...more,
});

const args = { question_asked: 'Why does the leader need a majority?', student_answer_summary: 'so that two leaders cannot both commit', topic: 'Raft leader election' };

describe('how an answer went, in a word', () => {
  it('is a word of levelWord for every possible answer, and never says "not started" for anything but the lowest', () => {
    expect(bandOf(scores(1, 1, 1, 1))).toBe('not started');
    expect(bandOf(scores(2, 2, 2, 2))).toBe('just started');
    expect(bandOf(scores(2, 2, 3, 2))).toBe('just started');
    expect(bandOf(scores(2, 3, 3, 3))).toBe('getting there');
    expect(bandOf(scores(3, 3, 3, 3))).toBe('getting there');
    expect(bandOf(scores(4, 4, 4, 3))).toBe('getting there');
    expect(bandOf(scores(4, 4, 4, 4))).toBe('solid');
    expect(bandOf(scores(5, 5, 5, 5))).toBe('solid');
  });

  it('turns the mean of the four scores from 1..5 into 0..1, and the page\'s boundaries (0.4 and 0.7) fall between two means a quarter apart', () => {
    expect(meanScore(scores(2, 3, 3, 3))).toBe(2.75);
    // a mean of 2.6 is 0.4 and one of 3.8 is 0.7, and the means of four whole scores are multiples of a quarter: 2.5 is below the first, 2.75 above it
    expect(bandOf(scores(2, 3, 2, 3))).toBe('just started'); // 2.5 -> 0.375
    expect(bandOf(scores(2, 3, 3, 3))).toBe('getting there'); // 2.75 -> 0.4375
    expect(bandOf(scores(4, 4, 4, 3))).toBe('getting there'); // 3.75 -> 0.6875
    expect(bandOf(scores(5, 4, 4, 3))).toBe('solid'); // 4 -> 0.75
    expect(bandOf(scores(5, 5, 4, 1))).toBe('getting there'); // 3.75
    expect(bandOf(scores(5, 5, 4, 2))).toBe('solid'); // 4
  });

  it('is never a number', () => {
    for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) expect(bandOf(scores(a, b, a, b))).toMatch(/^[a-z ]+$/);
  });
});

describe('a sentence for the student to read', () => {
  it('is one line, cut at the limit, and nothing at all when it speaks of scores', () => {
    expect(plain('  one \n line  ')).toBe('one line');
    expect(plain('x'.repeat(500))).toHaveLength(240);
    expect(plain('x'.repeat(500), 50)).toHaveLength(50);
    for (const scored of ['You scored 4 out of 5 here.', 'That was a 4/5 answer.', 'Rating: good.', 'A solid grade.', 'You scored well.', 'It is 3 out of 5']) expect(plain(scored), scored).toBe('');
    expect(plain(undefined)).toBe('');
    expect(plain(42)).toBe('');
  });

  it('keeps what a stronger answer says: percent signs, "rate", fractions of nodes are the subject matter', () => {
    expect(plain('Say that 99.9% availability allows about nine hours of downtime a year.')).not.toBe('');
    expect(plain('Mention that a rate limiter shapes the load.')).not.toBe('');
    expect(plain('A quorum is 2/3 of the nodes here.')).not.toBe('');
  });
});

describe('the review item of an answer', () => {
  it('is the question, what they said, how it went in a word, a stronger answer and the topic', () => {
    const w = reviewItem(args, scores(4, 3, 4, 3, { said: 'They said a majority stops two leaders committing.', better: 'Add that any two majorities share a node, so a second leader would have to hear the first.' }))!;
    expect(w.item).toEqual({
      question: 'Why does the leader need a majority?',
      said: 'They said a majority stops two leaders committing.',
      band: 'getting there',
      better: 'Add that any two majorities share a node, so a second leader would have to hear the first.',
      topic: 'Raft leader election',
    });
    expect(w.mean).toBe(3.5);
  });

  it('says what they said in the interviewer\'s summary when the evaluator wrote no paraphrase, and what was missed when it wrote no better answer', () => {
    const w = reviewItem(args, scores(2, 2, 3, 2, { missed_concepts: ['quorum intersection', 'term numbers', 'split votes', 'a fourth'] }))!;
    expect(w.item.said).toBe('so that two leaders cannot both commit');
    expect(w.item.better).toBe('A stronger answer would also bring in quorum intersection, term numbers, split votes.');
    const none = reviewItem(args, scores(5, 5, 5, 5))!;
    expect(none.item.better).toBe('');
    expect(none.item.band).toBe('solid');
  });

  it('drops a sentence that speaks of scores, and falls back; an item with nothing the student said is no item', () => {
    const w = reviewItem(args, scores(4, 4, 4, 4, { said: 'You got 4/5.', better: 'Rating: strong, nothing to add.', missed_concepts: ['terms'] }))!;
    expect(w.item.said).toBe('so that two leaders cannot both commit');
    expect(w.item.better).toBe('A stronger answer would also bring in terms.');
    expect(reviewItem({ ...args, student_answer_summary: '' }, scores(3, 3, 3, 3))).toBeNull();
    expect(reviewItem({ ...args, student_answer_summary: 'scored 4 out of 5' }, scores(3, 3, 3, 3))).toBeNull();
    expect(reviewItem({ ...args, question_asked: '  ' }, scores(3, 3, 3, 3))).toBeNull();
    expect(reviewItem({}, scores(3, 3, 3, 3))).toBeNull();
  });

  it('keeps the question short and one line, and the topic shorter still', () => {
    const w = reviewItem({ ...args, question_asked: `${'Why '.repeat(100)}\nnow?`, topic: 't'.repeat(300) }, scores(3, 3, 3, 3))!;
    expect(w.item.question.length).toBeLessThanOrEqual(200);
    expect(w.item.question).not.toContain('\n');
    expect(w.item.topic.length).toBeLessThanOrEqual(80);
  });
});

describe('the items of the card', () => {
  const pool = (means: number[]): Weighed[] => means.map((mean, i) => ({ item: { question: `Q${i + 1}?`, said: 's', band: 'solid', better: '', topic: '' }, mean }));

  it('is every item, in the order asked, when there are no more than eight', () => {
    expect(pickItems(pool([5, 1, 3])).map((i) => i.question)).toEqual(['Q1?', 'Q2?', 'Q3?']);
    expect(pickItems(pool([3, 3, 3, 3, 3, 3, 3, 3]))).toHaveLength(8);
    expect(pickItems([])).toEqual([]);
    expect(REVIEW_MAX).toBe(8);
  });

  it('is the eight weakest, in the order asked, when there are more (the earlier of two equal ones first)', () => {
    const means = [5, 1, 4.5, 2, 5, 3, 3.5, 4, 2.5, 1.5, 4.75, 3];
    const picked = pickItems(pool(means)).map((i) => i.question);
    expect(picked).toHaveLength(8);
    // the four strongest (5, 5, 4.75, 4.5) are the ones left out
    expect(picked).toEqual(['Q2?', 'Q4?', 'Q6?', 'Q7?', 'Q8?', 'Q9?', 'Q10?', 'Q12?']);
    const ties = pickItems(pool([3, 3, 3, 3, 3, 3, 3, 3, 3, 3])).map((i) => i.question);
    expect(ties).toEqual(['Q1?', 'Q2?', 'Q3?', 'Q4?', 'Q5?', 'Q6?', 'Q7?', 'Q8?']);
  });

  it('is limited by the argument', () => {
    expect(pickItems(pool([5, 1, 3]), 2).map((i) => i.question)).toEqual(['Q2?', 'Q3?']);
  });
});
