/**
 * The `items` of an activity line: the questions of a mock interview, kept on the line for its card to list (portal/web/review.js). What a caller
 * hands over is cleaned here, because the line is written to the student's history and served to their page as it is: strings, bounded, words
 * only for the band (no scores), at most eight.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HistoryStore, cleanItems, clipActivity } from './history.js';

const item = (over: Record<string, unknown> = {}) => ({
  question: 'Why does the leader need a majority?',
  said: 'so two leaders cannot both commit',
  band: 'getting there',
  better: 'Say that any two majorities share a node, so a second leader would have to hear the first one.',
  topic: 'Raft leader election',
  ...over,
});

describe('cleanItems', () => {
  it('keeps a well-formed item as it is', () => {
    expect(cleanItems([item()])).toEqual([item()]);
  });

  it('is nothing for anything that is not an array, and drops what is not an object or has no question', () => {
    for (const bad of [undefined, null, 'items', 7, {}, { question: 'x' }]) expect(cleanItems(bad)).toEqual([]);
    expect(cleanItems([null, 'x', 3, [], item({ question: '' }), item({ question: '   ' }), item({ question: 42 }), item()])).toEqual([item()]);
  });

  it('keeps eight at most, the first eight', () => {
    const many = Array.from({ length: 12 }, (_, i) => item({ question: `Question ${i + 1}?` }));
    const kept = cleanItems(many);
    expect(kept).toHaveLength(8);
    expect(kept[0].question).toBe('Question 1?');
    expect(kept[7].question).toBe('Question 8?');
  });

  it('cuts every string to 240 characters with an ellipsis, on one line', () => {
    const long = 'word '.repeat(200);
    const [kept] = cleanItems([item({ question: long, said: long, better: long, topic: long })]);
    for (const field of ['question', 'said', 'better'] as const) {
      expect(kept[field]).toHaveLength(240);
      expect(kept[field].endsWith('…')).toBe(true);
    }
    expect(kept.topic.length).toBeLessThanOrEqual(120);
    const [flat] = cleanItems([item({ question: 'a\nb\r\n\tc\u0000d', said: '  spaced   out  ' })]);
    expect(flat.question).toBe('a b c d');
    expect(flat.said).toBe('spaced out');
  });

  it('makes a field that is not a string empty', () => {
    const [kept] = cleanItems([item({ said: { x: 1 }, better: 5, topic: ['a'], band: 3 })]);
    expect(kept).toEqual({ question: item().question, said: '', band: '', better: '', topic: '' });
  });

  it('keeps a band only when it is a word: a level word in lower case, never a number or a score', () => {
    for (const word of ['solid', 'getting there', 'just started', 'not started']) expect(cleanItems([item({ band: word })])[0].band).toBe(word);
    expect(cleanItems([item({ band: 'Solid' })])[0].band).toBe('solid');
    for (const score of ['4/5', '0.62', 'band 3', '3', '85%', '', '<b>solid</b>', 'a'.repeat(40)]) expect(cleanItems([item({ band: score })])[0].band, score).toBe('');
  });

  it('copies the fields it knows and nothing else (a line is served to the page as it is written)', () => {
    const [kept] = cleanItems([{ ...item(), score: 4, accuracy: 3, secret: 'x' }]);
    expect(Object.keys(kept).sort()).toEqual(['band', 'better', 'question', 'said', 'topic']);
  });
});

describe('an activity line with items', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-items-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('has no items key unless there are items: a line without them is the line it always was', () => {
    const plain = clipActivity({ type: 'interview', title: 'Mock interview · 12 min', text: 'Went through HW3', detail: 'We went through it.' });
    expect(plain).toEqual({ text: 'Went through HW3', extra: { kind: 'activity', type: 'interview', title: 'Mock interview · 12 min', detail: 'We went through it.' } });
    expect(plain!.extra).not.toHaveProperty('items');
    expect(clipActivity({ type: 'interview', title: 't', text: 'x', items: [] })!.extra).not.toHaveProperty('items');
    expect(clipActivity({ type: 'interview', title: 't', text: 'x', items: 'nonsense' })!.extra).not.toHaveProperty('items');
  });

  it('carries the cleaned items, the detail exactly as it was', () => {
    const detail = 'We practised HW3.\n\nPut in the chat: 1 thing.\n\nMock interview, HW3: adequate (clarity 4/5, accuracy 3/5, depth 3/5, process 3/5)';
    const clipped = clipActivity({ type: 'interview', title: 'Mock interview · 12 min', text: 'Went through HW3', detail, items: [item(), item({ band: '4/5', question: 'Second?' })] })!;
    expect(clipped.extra.detail).toBe(detail);
    expect(clipped.extra.items).toEqual([item(), item({ band: '', question: 'Second?' })]);
  });

  it('is written to the student\'s history and read back with its items, and an older line of the same kind has none', () => {
    const store = new HistoryStore(dir);
    const log = store.forFolder('s_0123456789abcdef0123');
    const older = clipActivity({ type: 'interview', title: 'Mock interview · 8 min', text: 'An older one' })!;
    log.append('assistant', older.text, new Date(), older.extra);
    const withItems = clipActivity({ type: 'interview', title: 'Mock interview · 12 min', text: 'A new one', items: [item()] })!;
    log.append('assistant', withItems.text, new Date(), withItems.extra);

    const again = new HistoryStore(dir).forFolder('s_0123456789abcdef0123');
    const { entries } = again.activities(10);
    expect(entries.map((e) => e.text)).toEqual(['A new one', 'An older one']);
    expect(entries[0].items).toEqual([item()]);
    expect(entries[1].items).toBeUndefined();
    expect(entries[1]).not.toHaveProperty('items');
  });
});
