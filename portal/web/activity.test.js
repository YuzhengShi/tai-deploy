// The pure parts of the activity list: what a history line is as a card, the heading of a day, the time on a card. (The card and the sheet are DOM:
// the browser suite, portal/qa/portal_e2e.py, opens them, reads them, pages through them and takes a call to its place in the conversation.)
import { describe, expect, it } from 'vitest';

import { TYPES, cardOf, clockText, dayHeading, firstSentence, groupByDay } from './activity.js';

/** A moment in the machine's own time zone: the page says "yesterday" by the reader's calendar. */
const at = (year, month, day, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute).getTime();
const iso = (ms) => new Date(ms).toISOString();

describe('the first sentence of a text', () => {
  it('is the words up to the first full stop, question mark or exclamation mark, on one line', () => {
    expect(firstSentence('We talked about Raft.\nThen about Paxos.')).toBe('We talked about Raft.');
    expect(firstSentence('Did you get it? Yes.')).toBe('Did you get it?');
    expect(firstSentence('  one   line\nonly  ')).toBe('one line only');
    expect(firstSentence('')).toBe('');
    expect(firstSentence(undefined)).toBe('');
  });

  it('is cut at a word with an ellipsis when it is longer than the limit, and never longer', () => {
    const long = `${'consensus '.repeat(30)}ends here.`;
    const cut = firstSentence(long, 60);
    expect(cut.length).toBeLessThanOrEqual(60);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/consen…$/);
    expect(firstSentence('x'.repeat(200), 50)).toHaveLength(50);
  });

  it('does not end a sentence in the middle of "4.5"', () => {
    expect(firstSentence('It scored 4.5 out of 5. Good.')).toBe('It scored 4.5 out of 5.');
  });
});

describe('what a history line is as a card', () => {
  it('is its title, its one line and its detail, for an activity line', () => {
    const card = cardOf({ n: 7, ts: '2026-11-02T20:00:00Z', role: 'assistant', kind: 'activity', type: 'talk', title: 'Talk it through · 6 min', text: 'You talked Raft elections through', detail: 'Strong: the random timeouts.\r\nNext: ties.' });
    expect(card).toEqual({ n: 7, ts: '2026-11-02T20:00:00Z', type: 'talk', title: 'Talk it through · 6 min', text: 'You talked Raft elections through', detail: 'Strong: the random timeouts.\nNext: ties.', legacy: false });
  });

  it('knows the kinds of line it has an icon and a title for', () => {
    expect(TYPES).toEqual(['voice', 'talk', 'interview', 'memory', 'reminder', 'progress', 'course']);
  });

  it('is a plain card for a note TAi kept: its title ("Remembered") and its line, and nothing to open without a detail', () => {
    const card = cardOf({ n: 1, ts: 'x', role: 'assistant', kind: 'activity', type: 'memory', title: 'Remembered', text: 'Prefers problem-first explanations' });
    expect(card).toMatchObject({ type: 'memory', title: 'Remembered', text: 'Prefers problem-first explanations', detail: '' });
  });

  it('has no detail when the line has none, and a title of its own kind when the line has none', () => {
    const card = cardOf({ n: 2, ts: 'x', role: 'assistant', kind: 'activity', type: 'reminder', title: '', text: 'Start HW7 tomorrow at 9 am' });
    expect(card).toMatchObject({ type: 'reminder', title: 'Reminder', detail: '' });
  });

  it('is a card of its own kind for a step of progress: its title, its one line, nothing to open', () => {
    const card = cardOf({ n: 11, ts: '2026-11-02T20:00:00Z', role: 'assistant', kind: 'activity', type: 'progress', title: 'Progress updated', text: 'Raft leader election: just started → getting there' });
    expect(card).toEqual({ n: 11, ts: '2026-11-02T20:00:00Z', type: 'progress', title: 'Progress updated', text: 'Raft leader election: just started → getting there', detail: '', legacy: false });
    expect(cardOf({ n: 12, ts: 'x', role: 'assistant', kind: 'activity', type: 'progress', text: 'HW3: getting there → solid' })).toMatchObject({ type: 'progress', title: 'Progress updated' });
  });

  it('is a card of its own kind for a change in the course: the title it came with, its one line, and the detail when there is one', () => {
    const plain = cardOf({ n: 13, ts: '2026-11-02T20:00:00Z', role: 'assistant', kind: 'activity', type: 'course', title: 'Due soon', text: 'Midterm Mastery Part 2 · due Mon Nov 9, 9:00 AM PST' });
    expect(plain).toEqual({ n: 13, ts: '2026-11-02T20:00:00Z', type: 'course', title: 'Due soon', text: 'Midterm Mastery Part 2 · due Mon Nov 9, 9:00 AM PST', detail: '', legacy: false });
    const longer = cardOf({ n: 14, ts: 'x', role: 'assistant', kind: 'activity', type: 'course', title: 'New announcement', text: 'Office hours move to Thursday', detail: 'Office hours move to Thursday, 4 pm.\r\nSame room.' });
    expect(longer).toMatchObject({ type: 'course', detail: 'Office hours move to Thursday, 4 pm.\nSame room.' });
    expect(cardOf({ n: 15, ts: 'x', role: 'assistant', kind: 'activity', type: 'course', text: 'A new file' })).toMatchObject({ type: 'course', title: 'Course update' });
  });

  it('has a title of its own, for each kind, when the line has none', () => {
    const titles = TYPES.map((type) => cardOf({ n: 1, ts: 'x', role: 'assistant', kind: 'activity', type, title: '', text: 'a line' }).title);
    expect(new Set(titles).size).toBe(TYPES.length);
    expect(titles).not.toContain('Activity');
  });

  it('is a plain card for a kind this page does not know', () => {
    expect(cardOf({ n: 3, ts: 'x', role: 'assistant', kind: 'activity', type: 'sync', title: 'Synced', text: 'Canvas' })).toMatchObject({ type: 'note', title: 'Synced' });
    expect(cardOf({ n: 3, ts: 'x', role: 'assistant', kind: 'activity', text: 'No kind at all' })).toMatchObject({ type: 'note', title: 'Activity' });
  });

  it('is a card titled "Voice call" for an old call summary, with its first sentence as the line and the whole summary as the detail', () => {
    const whole = 'Voice session, 4 min: we talked through Raft elections and split votes. Next time: log replication.\nCOMPETENCY.md: Raft 0.4 → 0.55';
    const card = cardOf({ n: 9, ts: '2026-10-30T10:00:00Z', role: 'assistant', kind: 'voice', text: whole });
    expect(card).toMatchObject({ n: 9, type: 'voice', title: 'Voice call', text: 'We talked through Raft elections and split votes.', detail: whole, legacy: true });
  });

  it('keeps the whole of an old summary that has no prefix, and cuts a long first sentence', () => {
    expect(cardOf({ n: 1, ts: 'x', role: 'assistant', kind: 'voice', text: 'You talked about elections.' })).toMatchObject({ text: 'You talked about elections.', detail: 'You talked about elections.' });
    const long = cardOf({ n: 1, ts: 'x', role: 'assistant', kind: 'voice', text: `Voice session, 2 min: ${'a long sentence without an end '.repeat(10)}` });
    expect(long.text.length).toBeLessThanOrEqual(110);
    expect(long.text.endsWith('…')).toBe(true);
  });

  it('is nothing for a line that is not one: a message, the student\'s own line, nothing', () => {
    expect(cardOf({ n: 1, ts: 'x', role: 'assistant', text: 'hello' })).toBeNull();
    expect(cardOf({ n: 1, ts: 'x', role: 'user', kind: 'activity', type: 'voice', title: 't', text: 't' })).toBeNull();
    expect(cardOf({ n: 1, ts: 'x', role: 'assistant', kind: 'image', text: 'x' })).toBeNull();
    expect(cardOf(null)).toBeNull();
    expect(cardOf('text')).toBeNull();
  });
});

describe('the heading of a day', () => {
  const now = at(2026, 11, 2, 15, 30);

  it('says Today and Yesterday by the reader\'s calendar, even for hours ago', () => {
    expect(dayHeading(at(2026, 11, 2, 0, 5), now)).toBe('Today');
    expect(dayHeading(at(2026, 11, 1, 23, 59), now)).toBe('Yesterday');
    expect(dayHeading(at(2026, 11, 1, 23, 59), at(2026, 11, 2, 0, 10))).toBe('Yesterday');
    expect(dayHeading(now + 3_600_000, now)).toBe('Today');
  });

  it('gives a date as "Mon, Oct 27" after that (in the reader\'s own words), with the year only when it is not this one', () => {
    const date = dayHeading(at(2026, 10, 27, 9), now);
    expect(date).toBe(new Date(at(2026, 10, 27, 9)).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }));
    expect(date).toMatch(/27/);
    expect(date).not.toMatch(/2026|Today|Yesterday/);
    expect(dayHeading(at(2025, 12, 24, 9), now)).toMatch(/2025/);
  });
});

describe('the time on a card', () => {
  it('is the time of day, with am and pm in lower case and without dots (the reader\'s locale may write "p.m.")', () => {
    const afternoon = clockText(at(2026, 11, 2, 15, 5));
    expect(afternoon === '3:05 pm' || afternoon === '15:05').toBe(true);
    expect(clockText(at(2026, 11, 2, 0, 26))).toMatch(/^(12:26 am|00:26|0:26)$/);
    expect(afternoon).not.toMatch(/[AP]M|\./);
  });
});

describe('cards by day', () => {
  const now = at(2026, 11, 2, 15, 30);
  const card = (n, ms) => ({ n, ts: iso(ms) });

  it('starts a group at every change of day, newest first as given', () => {
    const groups = groupByDay([card(5, at(2026, 11, 2, 14)), card(4, at(2026, 11, 2, 9)), card(3, at(2026, 11, 1, 20)), card(2, at(2026, 10, 27, 8)), card(1, at(2026, 10, 27, 7))], now);
    expect(groups.map((g) => g.heading).slice(0, 2)).toEqual(['Today', 'Yesterday']);
    expect(groups[2].heading).toBe(dayHeading(at(2026, 10, 27, 8), now));
    expect(groups[2].heading).toMatch(/27/);
    expect(groups.map((g) => g.cards.map((c) => c.n))).toEqual([[5, 4], [3], [2, 1]]);
  });

  it('is nothing for nothing', () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});
