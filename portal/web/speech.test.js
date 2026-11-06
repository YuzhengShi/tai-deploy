// The pure parts of a voice call's place in the conversation: what a line of a call is, what a marker says, how long a call was, when a spoken
// bubble is folded, and how the "..." of a student who is speaking holds and goes. (The rows are DOM: the browser suite, portal/qa/portal_e2e.py,
// runs a fake call and looks at the thread, the drawer, a reload and a phone.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOLD_MS, LONG_CHARS, countSpoken, createSpeaking, durationText, eventOf, isSpeech, markerText, modeName, spokenOf, spokenSearchText } from './speech.js';

const say = (n, role, text, extra = {}) => ({ n, ts: '2026-11-03T10:00:00Z', role, text, kind: 'speech', call: 'abc123', ...extra });
const mark = (n, event, extra = {}) => ({ n, ts: '2026-11-03T10:00:00Z', role: 'assistant', text: '', kind: 'speech', call: 'abc123', event, ...extra });

describe('the lines of a call', () => {
  it('are speech lines: the words, and the markers that have an event', () => {
    expect(isSpeech(say(5, 'user', 'hello'))).toBe(true);
    expect(isSpeech({ n: 5, role: 'user', text: 'hello' })).toBe(false);
    expect(isSpeech({ n: 5, role: 'user', text: 'hello', kind: 'audio' })).toBe(false);
    expect(isSpeech(null)).toBe(false);
    expect(eventOf(mark(6, 'start', { mode: 'conversational' }))).toBe('start');
    expect(eventOf(mark(6, 'mode', { mode: 'interviewer' }))).toBe('mode');
    expect(eventOf(mark(6, 'end', { seconds: 480 }))).toBe('end');
    expect(eventOf(mark(6, 'pause'))).toBe('');
    expect(eventOf(say(5, 'user', 'hello'))).toBe('');
    expect(eventOf({ n: 5, role: 'assistant', text: '', event: 'start' })).toBe('');
  });

  it('are words to draw only when they have some, and a marker has none', () => {
    expect(spokenOf(say(5, 'user', 'my leader keeps changing'))).toEqual({ you: true, text: 'my leader keeps changing', long: false });
    expect(spokenOf(say(6, 'assistant', 'What happens next?'))).toEqual({ you: false, text: 'What happens next?', long: false });
    expect(spokenOf(say(7, 'user', '   '))).toBeNull();
    expect(spokenOf(mark(8, 'start'))).toBeNull();
    expect(spokenOf({ n: 9, role: 'user', text: 'typed' })).toBeNull();
  });

  it('are long over about 600 characters', () => {
    expect(spokenOf(say(5, 'assistant', 'x'.repeat(LONG_CHARS))).long).toBe(false);
    expect(spokenOf(say(5, 'assistant', 'x'.repeat(LONG_CHARS + 1))).long).toBe(true);
  });

  it('are searched by their words, and a marker is not found', () => {
    expect(spokenSearchText(say(5, 'user', 'about the Raft term'))).toBe('about the Raft term');
    expect(spokenSearchText(mark(6, 'start'))).toBe('');
    expect(spokenSearchText({ n: 7, role: 'user', text: 'typed' })).toBe('');
  });

  it('are counted by the words only, for a day in the drawer', () => {
    const lines = [{ n: 1, role: 'user', text: 'typed' }, mark(2, 'start'), say(3, 'assistant', 'hi'), say(4, 'user', 'hello'), say(5, 'user', ''), mark(6, 'end', { seconds: 30 })];
    expect(countSpoken(lines)).toBe(2);
    expect(countSpoken([])).toBe(0);
  });
});

describe('what a marker says', () => {
  it('names the kind of call at its start, with the time', () => {
    expect(markerText(mark(1, 'start', { mode: 'conversational' }), '3:42 PM')).toBe('Voice call · 3:42 PM');
    expect(markerText(mark(1, 'start', { mode: 'interviewer' }), '3:42 PM')).toBe('Mock interview · 3:42 PM');
    expect(markerText(mark(1, 'start', { mode: 'listener' }), '3:42 PM')).toBe('Talk it through · 3:42 PM');
    expect(markerText(mark(1, 'start', { mode: 'listener' }))).toBe('Talk it through');
  });

  it('says a switch, and a kind it does not know is a plain call', () => {
    expect(markerText(mark(2, 'mode', { mode: 'interviewer' }))).toBe('Switched to Mock interview');
    expect(markerText(mark(2, 'mode', { mode: 'listener' }))).toBe('Switched to Talk it through');
    expect(markerText(mark(2, 'mode', { mode: 'conversational' }))).toBe('Switched to Voice call');
    expect(markerText(mark(2, 'mode', { mode: 'something new' }))).toBe('Switched to Voice call');
    expect(modeName(undefined)).toBe('Voice call');
  });

  it('says how long the call was at its end', () => {
    expect(markerText(mark(3, 'end', { seconds: 480 }))).toBe('Call ended · 8 min');
    expect(markerText(mark(3, 'end', { seconds: 45 }))).toBe('Call ended · 45 s');
    expect(markerText(mark(3, 'end'))).toBe('Call ended');
    expect(markerText(mark(3, 'end', { seconds: 'soon' }))).toBe('Call ended');
  });

  it('says nothing for a line that is not a marker', () => {
    expect(markerText(say(4, 'user', 'hello'))).toBe('');
    expect(markerText(null)).toBe('');
  });
});

describe('how long a call was', () => {
  it('is seconds under a minute, minutes under an hour, then hours', () => {
    expect(durationText(0)).toBe('0 s');
    expect(durationText(59)).toBe('59 s');
    expect(durationText(59.6)).toBe('1 min');
    expect(durationText(60)).toBe('1 min');
    expect(durationText(90)).toBe('2 min');
    expect(durationText(3540)).toBe('59 min');
    expect(durationText(3600)).toBe('1 h');
    expect(durationText(3725)).toBe('1 h 2 min');
  });

  it('is nothing for what is not a length', () => {
    expect(durationText(undefined)).toBe('');
    expect(durationText(-5)).toBe('');
    expect(durationText(NaN)).toBe('');
    expect(durationText('x')).toBe('');
  });
});

describe('the "..." of a student who is speaking', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const log = [];
    const speaking = createSpeaking({ show: () => log.push('show'), hide: () => log.push('hide') });
    return { speaking, log };
  };

  it('comes up when the call says the student began to speak, once however often it says so', () => {
    const { speaking, log } = make();
    speaking.started();
    speaking.started();
    vi.advanceTimersByTime(1000);
    speaking.started();
    expect(log).toEqual(['show']);
    expect(speaking.visible()).toBe(true);
  });

  it('does not come up from the microphone or a late transcript alone', () => {
    const { speaking, log } = make();
    speaking.voice();
    speaking.heard();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(log).toEqual([]);
    expect(speaking.visible()).toBe(false);
  });

  it('goes four seconds after the last sign of speech, and every sign moves that on', () => {
    const { speaking, log } = make();
    speaking.started();
    vi.advanceTimersByTime(HOLD_MS - 500);
    speaking.voice();                                  // still talking
    vi.advanceTimersByTime(HOLD_MS - 500);
    expect(speaking.visible()).toBe(true);
    speaking.heard();                                  // the words are in, the line follows
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(speaking.visible()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(log).toEqual(['show', 'hide']);
    expect(speaking.visible()).toBe(false);
  });

  it('goes at once when the line arrives, or the call stops, and a later sentence brings it back', () => {
    const { speaking, log } = make();
    speaking.started();
    speaking.arrived();
    expect(log).toEqual(['show', 'hide']);
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(log).toEqual(['show', 'hide']);              // (the old timer does not hide it again)
    speaking.started();
    speaking.stop();
    speaking.stop();
    expect(log).toEqual(['show', 'hide', 'show', 'hide']);
    speaking.started();
    expect(speaking.visible()).toBe(true);
  });
});
