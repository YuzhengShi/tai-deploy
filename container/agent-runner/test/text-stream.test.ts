/**
 * The words of the reply as the runner says them while the model writes (progress.ts, docs/STREAMING.md): only with TAI_PORTAL_STREAM, throttled,
 * cumulative, taken back when the message goes on to call a tool, silent after a tool that says the answer itself, and never a line more than before
 * when the flag is off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEXT_EVENT_PREFIX, parseProgressLine } from '../../../src/turn-status.js';        // the host's reader of what this runner writes (a test only)
import { ProgressReporter, TEXT_CAP, TEXT_INTERVAL_MS } from '../src/progress.js';
import { PROGRESS_MARKER, writeProgress, type ProgressEvent } from '../src/protocol.js';

function reporter(options: { stream?: boolean; enabled?: boolean } = {}) {
  const events: ProgressEvent[] = [];
  const clock = { now: 1_000 };
  const r = new ProgressReporter({ write: (event) => events.push(event), now: () => clock.now, ...options });
  return { r, events, clock };
}

/** One message as pi streams it: it starts, its text arrives in deltas `gap` ms apart, it ends. */
function writeMessage(r: ProgressReporter, clock: { now: number }, deltas: string[], gap = TEXT_INTERVAL_MS): void {
  r.messageStart();
  for (const delta of deltas) {
    r.textDelta(delta);
    clock.now += gap;
  }
  r.messageEnd();
}

const texts = (events: ProgressEvent[]) => events.filter((e): e is Extract<ProgressEvent, { type: 'text' }> => e.type === 'text');

describe('the reporter with streaming off (the default)', () => {
  it('says nothing of the words, whatever happens: the lines are exactly what they were before', () => {
    for (const options of [{}, { stream: false }, { stream: undefined }]) {
      const { r, events, clock } = reporter(options);
      r.beginTurn();
      r.thinking();
      writeMessage(r, clock, ['Hello there. ', 'How are you? ', 'Fine.']);
      r.toolCallStart();
      r.toolStart('1', 'mcp__nanoclaw__send_message', { text: 'x' });
      r.toolEnd('1', 'ok', false);
      expect(events).toEqual([
        { type: 'thinking' },
        { type: 'tool', name: 'send_message', phase: 'start' },
        { type: 'tool', name: 'send_message', phase: 'end' },
      ]);
    }
  });

  it('says nothing for a scheduled task even with the flag: no student is looking', () => {
    const { r, events, clock } = reporter({ stream: true, enabled: false });
    writeMessage(r, clock, ['Hello there. ', 'How are you? ']);
    expect(events).toEqual([]);
  });
});

describe('the reporter with streaming on', () => {
  it('says the whole text so far, at most every 150 ms: the first words at once, the rest in a few lines', () => {
    const { r, events, clock } = reporter({ stream: true });
    r.messageStart();
    r.textDelta('Hel');                         // at 1000: the first, at once
    clock.now += 40;
    r.textDelta('lo there. ');                  // 40 ms later: held
    clock.now += 40;
    r.textDelta('How are ');                    // 80 ms: held
    clock.now += 100;
    r.textDelta('you?');                        // 180 ms after the first: said, with everything so far
    clock.now += 10;
    r.textDelta(' Fine.');                      // 10 ms: held (and never said: the final carries it)
    expect(texts(events)).toEqual([
      { type: 'text', n: 1, text: 'Hel' },
      { type: 'text', n: 1, text: 'Hello there. How are you?' },
    ]);
    expect(TEXT_INTERVAL_MS).toBe(150);
  });

  it('numbers the messages from 1 and never starts again, across turns: the host must never see the number go back', () => {
    const { r, events, clock } = reporter({ stream: true });
    r.beginTurn();
    writeMessage(r, clock, ['One. ']);
    writeMessage(r, clock, ['Two. ']);
    r.beginTurn();
    writeMessage(r, clock, ['Three. ']);
    expect(texts(events).map((e) => e.n)).toEqual([1, 2, 3]);
  });

  it('takes the words back when the message goes on to call a tool, and says no more of that message', () => {
    const { r, events, clock } = reporter({ stream: true });
    r.messageStart();
    r.textDelta('Let me check Canvas. ');
    clock.now += 200;
    r.toolCallStart();                           // the arguments of the call may take seconds to be written: taken back now
    r.textDelta('and a late word');
    expect(events).toEqual([
      { type: 'text', n: 1, text: 'Let me check Canvas. ' },
      { type: 'text', n: 1, text: '' },
    ]);
  });

  it('has nothing to take back when nothing was said, and the next message streams as usual', () => {
    const { r, events, clock } = reporter({ stream: true });
    r.messageStart();
    r.toolCallStart();                           // a message that is only a call
    r.messageEnd();
    clock.now += 500;
    writeMessage(r, clock, ['The answer is here. ']);
    expect(events).toEqual([{ type: 'text', n: 2, text: 'The answer is here. ' }]);
  });

  for (const tool of ['mcp__nanoclaw__send_message', 'mcp__nanoclaw__render_diagram', 'mcp__nanoclaw__generate_teaching_image']) {
    it(`is silent for the rest of the turn after ${tool.split('__')[2]}, which says the answer itself, and speaks again for the next turn`, () => {
      const { r, events, clock } = reporter({ stream: true });
      r.beginTurn();
      r.messageStart();
      r.textDelta('Here you go. ');
      clock.now += 200;
      r.toolCallStart();                                                          // (pi: the call is streamed, the message ends, then the tool runs)
      r.messageEnd();
      r.toolStart('1', tool, {});
      writeMessage(r, clock, ['Sent it above. ', 'Anything else? ']);          // the closing words the host will not send
      expect(texts(events)).toEqual([{ type: 'text', n: 1, text: 'Here you go. ' }, { type: 'text', n: 1, text: '' }]);
      clock.now += 500;
      r.beginTurn();
      writeMessage(r, clock, ['A new turn. ']);
      expect(texts(events).slice(2)).toEqual([{ type: 'text', n: 3, text: 'A new turn. ' }]);
    });
  }

  it('is not silenced by a lookup tool: only the tools that say the answer themselves', () => {
    const { r, events, clock } = reporter({ stream: true });
    r.beginTurn();
    r.toolStart('1', 'mcp__nanoclaw__canvas_query', { action: 'upcoming' });
    r.toolEnd('1', '[]', false);
    writeMessage(r, clock, ['Nothing is due soon. ']);
    expect(texts(events)).toEqual([{ type: 'text', n: 1, text: 'Nothing is due soon. ' }]);
  });

  it('gives up on a message that grows past the cap: it takes back what it said, and says no more of it', () => {
    const { r, events, clock } = reporter({ stream: true });
    r.messageStart();
    r.textDelta('Short start. ');
    clock.now += 200;
    r.textDelta('x'.repeat(TEXT_CAP));
    r.textDelta('more');
    expect(events).toEqual([{ type: 'text', n: 1, text: 'Short start. ' }, { type: 'text', n: 1, text: '' }]);
  });

  it('opens a message by itself when the harness sent no start (the number still goes up)', () => {
    const { r, events } = reporter({ stream: true });
    r.textDelta('No start event came. ');
    expect(events).toEqual([{ type: 'text', n: 1, text: 'No start event came. ' }]);
  });

  it('never throws and never blocks the turn: a failing writer is a lost line', () => {
    const r = new ProgressReporter({ stream: true, write: () => { throw new Error('closed pipe'); } });
    expect(() => {
      r.messageStart();
      r.textDelta('Hello there. ');
      r.toolCallStart();
    }).not.toThrow();
  });
});

describe('the line on stdout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['TAI_MODE'];
  });

  function line(event: ProgressEvent): string {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeProgress(event);
    const written = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    return written.join('\n');
  }

  it('starts the way the host\'s log filter looks for, and the host reads it only from a container that streams', () => {
    const text = 'He said "go".\nThen \\ left. 🎉 日本語 end';
    const written = line({ type: 'text', n: 3, text });
    expect(written.startsWith(TEXT_EVENT_PREFIX)).toBe(true);
    expect(written.startsWith(PROGRESS_MARKER)).toBe(true);
    expect(written.includes('\n')).toBe(false);                   // one line, whatever the text has in it
    expect(parseProgressLine(written, { text: true })).toEqual({ type: 'text', n: 3, text });
    expect(parseProgressLine(written)).toBeNull();                // a host that did not ask for them skips the line
    expect(parseProgressLine(written, { text: false })).toBeNull();
  });

  it('fits a line of the protocol (8 KB) at the cap even when every character needs escaping', () => {
    const written = line({ type: 'text', n: 1, text: '"'.repeat(TEXT_CAP) });
    expect(written.length).toBeLessThan(8192);
    expect(parseProgressLine(written, { text: true })?.type).toBe('text');
  });

  it('is nothing at all in a voice call\'s tool host: its stdout is the host\'s protocol', () => {
    process.env['TAI_MODE'] = 'tool-host';
    expect(line({ type: 'text', n: 1, text: 'hello' })).toBe('');
  });
});
