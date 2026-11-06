// The pure parts of the voice note's bubble: the clock, the waveform's bars, where a click on the bar lands. (The bubble itself, its player and
// the recorder are DOM and audio: the browser suite, portal/qa/portal_e2e.py, drives them with a real recording.)
import { describe, expect, it } from 'vitest';

import { BARS, NOTE_PEAKS, barHeights, clock, fractionAt, isShortNote, peaksFromLevels } from './notes.js';

describe('the clock', () => {
  it('shows seconds as minutes and seconds', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(12.9)).toBe('0:12');
    expect(clock(60)).toBe('1:00');
    expect(clock(179.99)).toBe('2:59');
    expect(clock(180)).toBe('3:00');
    expect(clock(-5)).toBe('0:00');
    expect(clock(undefined)).toBe('0:00');
    expect(clock(Number.NaN)).toBe('0:00');
  });
});

describe('the waveform sent with a recording', () => {
  it('takes the loudest reading of each stretch and makes the loudest bar 100', () => {
    const levels = [0, 0.1, 0.2, 0.05, 0.4, 0.4, 0.1, 0];
    const peaks = peaksFromLevels(levels, 4);
    expect(peaks).toEqual([25, 50, 100, 25]);
    expect(Math.max(...peaks)).toBe(100);
  });

  it('draws a quiet recording as a recording, not as a line', () => {
    const peaks = peaksFromLevels([0.001, 0.002, 0.001, 0.003], 4);
    expect(peaks.every((v) => v >= 0 && v <= 100)).toBe(true);
    expect(peaksFromLevels(new Array(20).fill(0), 4)).toEqual([0, 0, 0, 0]);
  });

  it('is as long as asked, whatever the number of readings, and nothing when there are none', () => {
    expect(peaksFromLevels(Array.from({ length: 300 }, (_, i) => (i % 7) / 7)).length).toBe(NOTE_PEAKS);
    expect(peaksFromLevels(Array.from({ length: 5 }, () => 0.5)).length).toBe(NOTE_PEAKS);        // fewer readings than bars: each reading is a bar, the rest repeat
    expect(peaksFromLevels([])).toEqual([]);
    expect(peaksFromLevels(undefined)).toEqual([]);
  });
});

describe('the bars that are drawn', () => {
  it('pools the peaks of a recording to the bars of the bubble, none lower than a sliver', () => {
    const bars = barHeights(Array.from({ length: 48 }, (_, i) => (i === 10 ? 100 : 0)));
    expect(bars.length).toBe(BARS);
    expect(Math.max(...bars)).toBe(1);
    expect(Math.min(...bars)).toBeGreaterThanOrEqual(0.12);
  });

  it('gives a note that came with no waveform the same pattern every time it is opened, and another to another note', () => {
    const a = barHeights([], BARS, 41);
    expect(barHeights(undefined, BARS, 41)).toEqual(a);
    expect(barHeights([], BARS, 42)).not.toEqual(a);
    expect(a.every((v) => v >= 0.14 && v <= 1)).toBe(true);
    expect(new Set(a.map((v) => v.toFixed(2))).size).toBeGreaterThan(8);                           // it varies: it does not look like a bar chart of one value
  });
});

describe('a click on the seek bar', () => {
  it('lands where the pointer is, between the start and the end', () => {
    expect(fractionAt(150, 100, 200)).toBe(0.25);
    expect(fractionAt(100, 100, 200)).toBe(0);
    expect(fractionAt(300, 100, 200)).toBe(1);
    expect(fractionAt(40, 100, 200)).toBe(0);
    expect(fractionAt(900, 100, 200)).toBe(1);
    expect(fractionAt(5, 0, 0)).toBe(0);
  });
});

describe('the words under a note', () => {
  it('shows a short transcript at first and leaves a long one behind "Show text"', () => {
    expect(isShortNote('How does Raft pick a leader?')).toBe(true);
    expect(isShortNote('x'.repeat(140))).toBe(true);
    expect(isShortNote('x'.repeat(141))).toBe(false);
    expect(isShortNote('')).toBe(true);
  });
});
