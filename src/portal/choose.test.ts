import { describe, expect, it } from 'vitest';

import { tapOn } from './choose.js';
import type { HistoryEntry } from './history.js';

const line = (extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  n: 7,
  ts: '2026-11-03T00:00:00.000Z',
  role: 'assistant',
  text: 'Which of these is true of a Raft term?',
  choices: [
    { label: 'A', text: 'Every heartbeat starts a new term' },
    { label: 'B', text: 'A term has at most one leader' },
    { label: 'C', text: 'The term number can go down after a failure' },
  ],
  quiz: true,
  secret: { key: 1, why: 'Terms only go up.' },
  ...extra,
});

describe('tapOn', () => {
  it('is the letter and the option as the student would type it, and right when it is the one TAi marked', () => {
    const tap = tapOn(line(), 1)!;
    expect(tap.text).toBe('B. A term has at most one leader');
    expect(tap.correct).toBe(true);
    expect(tap.note).toBe(
      '[The student answered your multiple-choice question "Which of these is true of a Raft term?". The options were: A) Every heartbeat starts a new term; B) A term has at most one leader; C) The term number can go down after a failure. ' +
        'They chose B, "A term has at most one leader". That is the answer you marked. Your note on it: Terms only go up.]\n',
    );
  });

  it('is wrong, and says which one TAi marked, when it is another', () => {
    const tap = tapOn(line(), 2)!;
    expect(tap.correct).toBe(false);
    expect(tap.note).toContain('They chose C, "The term number can go down after a failure". The answer you marked was B, "A term has at most one leader".');
  });

  it('gives no verdict when TAi marked nothing, and names no options when it was only a question', () => {
    const quiz = tapOn(line({ secret: undefined }), 0)!;
    expect(quiz.correct).toBeUndefined();
    expect(quiz.note).not.toContain('marked');
    expect(quiz.note).toContain('answered your multiple-choice question');
    const ask = tapOn(line({ quiz: undefined, secret: undefined, text: 'Which part is confusing?' }), 0)!;
    expect(ask.note).toBe('[The student picked an option on your question "Which part is confusing?". They chose A, "Every heartbeat starts a new term".]\n');
    expect(ask.correct).toBeUndefined();
  });

  it('says the marked answer did not hold up, and gives no verdict, when the host dropped it after a check', () => {
    const tap = tapOn(line({ secret: { why: 'Terms only go up.', doubt: true } }), 0)!;
    expect(tap.correct).toBeUndefined();
    expect(tap.note).toContain('The answer you marked did not hold up when other models checked it');
    expect(tap.note).toContain('judge their pick on its merits');
    expect(tap.note).toContain('Your note on it: Terms only go up.');
    expect(tap.note).not.toContain('That is the answer you marked');
    expect(tapOn(line({ secret: { key: 1, why: 'x' } }), 0)!.note).not.toContain('did not hold up');
  });

  it('is nothing for an option that is not there, and for a line with no options', () => {
    expect(tapOn(line(), 3)).toBeNull();
    expect(tapOn(line(), -1)).toBeNull();
    expect(tapOn(line({ choices: undefined }), 0)).toBeNull();
  });

  it('is one line that begins as the host\'s other notes do, so the reply budget does not count it as the student\'s words', () => {
    const tap = tapOn(line({ text: 'He said "wait"\nand\nleft', secret: { key: 0, why: 'multi\nline "note"' } }), 2)!;
    expect(tap.note.endsWith(']\n')).toBe(true);
    expect(tap.note.slice(0, -1)).not.toMatch(/\n/);
    expect(tap.note.startsWith('[The student ')).toBe(true);
    expect(tap.note).not.toMatch(/"wait"/);                       // quotation marks inside become apostrophes: the note's own quotes stay unambiguous
  });

  it('keeps a long question, option and note within bounds', () => {
    const long = 'word '.repeat(200);
    const tap = tapOn(line({ text: long, choices: [{ label: 'A', text: long }, { label: 'B', text: 'b' }], secret: { key: 1, why: long } }), 0)!;
    expect(tap.note.length).toBeLessThan(1200);
  });
});
