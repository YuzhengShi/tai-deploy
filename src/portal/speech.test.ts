import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HistoryStore, SPEECH_EVENTS, clipSpeech, isStudentMessage } from './history.js';

describe('clipSpeech', () => {
  it('is the words of a turn on one line with the call they belong to', () => {
    expect(clipSpeech({ text: '  Do you\n hear   me?  ', call: 'SNnrAi' })).toEqual({ text: 'Do you hear me?', extra: { kind: 'speech', call: 'SNnrAi' } });
  });

  it('is a marker when it has an event, with no words, and only what the event carries', () => {
    expect(clipSpeech({ text: 'ignored', call: 'abc', event: 'start', mode: 'interviewer', seconds: 5 })).toEqual({ text: '', extra: { kind: 'speech', call: 'abc', event: 'start', mode: 'interviewer' } });
    expect(clipSpeech({ call: 'abc', event: 'mode', mode: 'listener' })).toEqual({ text: '', extra: { kind: 'speech', call: 'abc', event: 'mode', mode: 'listener' } });
    expect(clipSpeech({ call: 'abc', event: 'end', mode: 'listener', seconds: 497.4 })).toEqual({ text: '', extra: { kind: 'speech', call: 'abc', event: 'end', seconds: 497 } });
    expect(clipSpeech({ call: 'abc', event: 'end', seconds: -3 })?.extra.seconds).toBe(0);
    expect(clipSpeech({ call: 'abc', event: 'end', seconds: 9_999_999 })?.extra.seconds).toBe(86_400);
    expect(clipSpeech({ call: 'abc', event: 'start', mode: 'whatever' })?.extra).not.toHaveProperty('mode');
    expect(SPEECH_EVENTS).toEqual(['start', 'mode', 'end']);
  });

  it('is nothing when there are no words and no event, or no usable call id, and keeps the call id plain', () => {
    expect(clipSpeech({ text: '   ', call: 'abc' })).toBeNull();
    expect(clipSpeech({ text: 'hello' })).toBeNull();
    expect(clipSpeech({ text: 'hello', call: '../../x' })?.extra.call).toBe('x');
    expect(clipSpeech({ text: 'hello', call: '///' })).toBeNull();
    expect(clipSpeech({ text: 'hello', call: 'a'.repeat(100) })?.extra.call).toHaveLength(40);
    expect(clipSpeech({ text: 'hello', call: 'abc', event: 'nonsense' })?.text).toBe('hello');            // not an event: words
  });

  it('bounds a long turn', () => {
    const out = clipSpeech({ text: 'word '.repeat(1000), call: 'abc' })!;
    expect(out.text.length).toBeLessThanOrEqual(2000);
    expect(out.text.endsWith('…')).toBe(true);
  });
});

describe('the words of a call in a student\'s history', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-speech-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = 's_0123456789abcdef0123';

  function call(log: ReturnType<HistoryStore['forFolder']>, lines: number, id = 'call1') {
    log.append('assistant', '', new Date(), clipSpeech({ call: id, event: 'start', mode: 'conversational' })!.extra);
    for (let i = 0; i < lines; i++) log.append(i % 2 ? 'assistant' : 'user', `line ${i}`, new Date(), clipSpeech({ text: `line ${i}`, call: id })!.extra);
    log.append('assistant', '', new Date(), clipSpeech({ call: id, event: 'end', seconds: 60 })!.extra);
  }

  it('is a line like any other that is kept, numbered, and read back after a restart, and is not a message', () => {
    const log = new HistoryStore(dir).forFolder(folder);
    const said = log.append('user', 'Do you hear me?', new Date(), clipSpeech({ text: 'Do you hear me?', call: 'c1' })!.extra);
    expect(said).toMatchObject({ n: 1, role: 'user', text: 'Do you hear me?', kind: 'speech', call: 'c1' });
    expect(isStudentMessage(said)).toBe(false);                                   // not what their emoji, TAi's emoji or the run-starting logic looks for
    const again = new HistoryStore(dir).forFolder(folder);
    expect(again.tail(10)).toEqual([said]);
    expect(again.last).toBe(1);
    expect(again.latestUser(60_000, Date.now())).toBeUndefined();
  });

  it('does not use up the places of the last N lines: a long call leaves the chat before it on the first screen', () => {
    const log = new HistoryStore(dir).forFolder(folder);
    for (let i = 0; i < 12; i++) log.append(i % 2 ? 'assistant' : 'user', `chat ${i}`, new Date());
    call(log, 100);
    const tail = log.tail(10);
    expect(tail.filter((e) => e.kind !== 'speech').map((e) => e.text)).toEqual(['chat 2', 'chat 3', 'chat 4', 'chat 5', 'chat 6', 'chat 7', 'chat 8', 'chat 9', 'chat 10', 'chat 11']);
    expect(tail.filter((e) => e.kind === 'speech')).toHaveLength(20);             // the newest twice the places asked for, of the 102 lines of the call
    expect(tail).toHaveLength(30);                                                // three times the places, at most
    expect(tail[tail.length - 1]).toMatchObject({ kind: 'speech', event: 'end' });
    expect(tail.map((e) => e.n)).toEqual([...tail.map((e) => e.n)].sort((a, b) => a - b));
  });

  it('keeps the newest of a call that is longer than that, and shows all the chat there is when it is shorter than the places asked for', () => {
    const log = new HistoryStore(dir).forFolder(folder);
    call(log, 200);
    const tail = log.tail(10);
    expect(tail).toHaveLength(20);
    expect(tail[tail.length - 1]).toMatchObject({ event: 'end' });
    expect(tail[0].n).toBe(log.last - 19);
    const short = new HistoryStore(path.join(dir, 'other')).forFolder(folder);
    short.append('user', 'hello', new Date());
    call(short, 3);
    expect(short.tail(10).map((e) => e.text)).toEqual(['hello', '', 'line 0', 'line 1', 'line 2', '']);
    expect(short.tail(1).map((e) => e.text).filter(Boolean)).toEqual(['hello', 'line 2']);                 // one place for the chat, and the newest two lines of the call
  });

  it('is told to a poll like any line, in order with what was typed', () => {
    const log = new HistoryStore(dir).forFolder(folder);
    log.append('user', 'typed first', new Date());
    log.append('assistant', 'spoken', new Date(), clipSpeech({ text: 'spoken', call: 'c1' })!.extra);
    log.append('user', 'typed second', new Date());
    expect(log.since(0).map((e) => `${e.kind ?? 'text'}:${e.text}`)).toEqual(['text:typed first', 'speech:spoken', 'text:typed second']);
    expect(log.since(1).map((e) => e.text)).toEqual(['spoken', 'typed second']);
  });

  it('is not an activity of the list, and does not count for a thumb, an emoji or a tap on options', () => {
    const log = new HistoryStore(dir).forFolder(folder);
    call(log, 4);
    expect(log.activities(10).entries).toEqual([]);
    const options = log.append('assistant', 'Which?', new Date(), { choices: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }] });
    log.append('assistant', 'then, aloud', new Date(), clipSpeech({ text: 'then, aloud', call: 'c2' })!.extra);
    log.append('user', 'and a reply aloud', new Date(), clipSpeech({ text: 'and a reply aloud', call: 'c2' })!.extra);
    expect(log.choiceState(options.n)).toBe('open');                              // what is said aloud does not close the options
    expect(log.reactionsSinceLastMessage()).toEqual([]);
  });
});
