/**
 * The host's side of the reply preview (src/turn-status.ts, docs/STREAMING.md): the flag, the reading of a text line (only from a container that was
 * started with the flag), the log filter, and what the forwarder does with the events, with the flag off and on.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  PROGRESS_MARKER,
  TEXT_EVENT_PREFIX,
  TurnStatus,
  parseProgressLine,
  portalStreamOn,
  progressForwarder,
  withoutTextEvents,
  type ProgressEvent,
  type TurnView,
} from './turn-status.js';

const line = (body: unknown) => `${PROGRESS_MARKER} ${typeof body === 'string' ? body : JSON.stringify(body)}`;

describe('the flag', () => {
  it('is on only for exactly "1" in the orchestrator\'s environment', () => {
    expect(portalStreamOn({ TAI_PORTAL_STREAM: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes', 'on', ' 1', '1 ', '2']) expect(portalStreamOn({ TAI_PORTAL_STREAM: value }), String(value)).toBe(false);
    expect(portalStreamOn({})).toBe(false);
  });
});

describe('a text line', () => {
  const event = { type: 'text', n: 2, text: 'Raft elects a leader. And' };

  it('is an event only from a container that was started with the flag', () => {
    expect(parseProgressLine(line(event), { text: true })).toEqual(event);
    expect(parseProgressLine(line(event))).toBeNull();
    expect(parseProgressLine(line(event), { text: false })).toBeNull();
    expect(parseProgressLine(line('{"type":"text","n":2,"text":'), {})).toBeNull();            // not even an error: the line is not an event at all
  });

  it('is an empty text too: it takes the message back', () => {
    expect(parseProgressLine(line({ type: 'text', n: 2, text: '' }), { text: true })).toEqual({ type: 'text', n: 2, text: '' });
  });

  it('is an error, which ends the turn\'s preview, when it does not parse, is too long, or is not what the runner writes', () => {
    const bad: unknown[] = [
      '{"type":"text","n":2,"text":"cut off',
      { type: 'text', n: 0, text: 'x' },
      { type: 'text', n: 1.5, text: 'x' },
      { type: 'text', n: '2', text: 'x' },
      { type: 'text', n: 2e9, text: 'x' },
      { type: 'text', n: 2 },
      { type: 'text', n: 2, text: 7 },
      { type: 'text', n: 2, text: 'a half character � here' },                          // a chunk cut inside a multi-byte character
      { type: 'text', n: 2, text: 'x'.repeat(9000) },                                         // a line over 8 KB
      '{"type":"text"}',
    ];
    for (const body of bad) expect(parseProgressLine(line(body), { text: true }), JSON.stringify(body).slice(0, 60)).toEqual({ type: 'textError' });
    for (const body of bad) expect(parseProgressLine(line(body)), JSON.stringify(body).slice(0, 60)).toBeNull();             // with the flag off: skipped like any line
  });

  it('is not an error when it is some other kind of line, or only starts like one', () => {
    expect(parseProgressLine(line('{"type":"textual","n":1}'), { text: true })).toBeNull();
    expect(parseProgressLine(line({ type: 'thinking' }), { text: true })).toEqual({ type: 'thinking' });
    expect(parseProgressLine('not a progress line', { text: true })).toBeNull();
    expect(parseProgressLine(line('[1,2]'), { text: true })).toBeNull();
  });

  it('leaves the other kinds of line exactly as they were read, whatever the option', () => {
    for (const body of [{ type: 'thinking' }, { type: 'tool', name: 'canvas_query', phase: 'start' }, { type: 'tool', name: 'bad name', phase: 'start' }]) {
      expect(parseProgressLine(line(body), { text: true })).toEqual(parseProgressLine(line(body)));
    }
  });
});

describe('what a log keeps of a container\'s stdout', () => {
  it('is everything but the text lines', () => {
    const out = [
      `${PROGRESS_MARKER} {"type":"thinking"}`,
      `${TEXT_EVENT_PREFIX},"n":1,"text":"Hello there. And"}`,
      '---NANOCLAW_OUTPUT_START---',
      '{"status":"success","result":"Hello there."}',
      '---NANOCLAW_OUTPUT_END---',
      `${TEXT_EVENT_PREFIX},"n":1,"text":"Hello there. And so"}`,
      '',
    ].join('\n');
    expect(withoutTextEvents(out)).toBe([`${PROGRESS_MARKER} {"type":"thinking"}`, '---NANOCLAW_OUTPUT_START---', '{"status":"success","result":"Hello there."}', '---NANOCLAW_OUTPUT_END---', ''].join('\n'));
    expect(withoutTextEvents(out)).not.toContain('And so');
  });

  it('is the very string it was given when there is no text line (a container without the flag is logged as it always was)', () => {
    const out = `${PROGRESS_MARKER} {"type":"thinking"}\n---NANOCLAW_OUTPUT_START---\n{}\n---NANOCLAW_OUTPUT_END---\n`;
    expect(withoutTextEvents(out)).toBe(out);
    expect(withoutTextEvents('')).toBe('');
  });
});

describe('the forwarder', () => {
  function view(withPreview: boolean) {
    const calls: string[] = [];
    const v: TurnView = {
      setStatus: (_jid, status) => calls.push(`status ${status ? status.label : 'none'}`),
      refreshStatus: () => undefined,
      addSources: () => calls.push('sources'),
      takeSources: () => undefined,
      resetSources: () => undefined,
      ...(withPreview
        ? {
            previewEvent: (_jid: string, e: { type: string }) => calls.push(`preview ${e.type}`),
            previewClear: () => calls.push('clear'),
          }
        : {}),
    };
    return { v, calls };
  }
  const drive = (events: ProgressEvent[], options: { withPreview: boolean; muted?: () => boolean }) => {
    const { v, calls } = view(options.withPreview);
    const forward = progressForwarder({ jid: 'web:s_x', turn: new TurnStatus(), view: v, muted: options.muted });
    for (const e of events) forward(e);
    return calls;
  };
  const turn: ProgressEvent[] = [
    { type: 'thinking' },
    { type: 'text', n: 1, text: 'Let me look. And' },
    { type: 'tool', name: 'canvas_query', phase: 'start' },
    { type: 'tool', name: 'canvas_query', phase: 'end' },
    { type: 'thinking' },
    { type: 'text', n: 2, text: 'Homework 6 is due. And' },
    { type: 'textError' },
  ];

  it('hands text to the preview, and clears it when a request begins or a tool starts (not when a tool ends)', () => {
    expect(drive(turn, { withPreview: true })).toEqual(['clear', 'status Thinking', 'preview text', 'clear', 'status Checking Canvas', 'status Thinking', 'clear', 'status Thinking', 'preview text', 'preview textError']);
  });

  it('only clears while the answer is going out another way (the send tool\'s marker): the words are not previewed', () => {
    expect(drive(turn, { withPreview: true, muted: () => true })).toEqual(['clear', 'status Thinking', 'clear', 'clear', 'status Checking Canvas', 'status Thinking', 'clear', 'status Thinking', 'clear', 'clear']);
  });

  it('is not asked about the marker for anything but text', () => {
    const muted = vi.fn(() => false);
    drive([{ type: 'thinking' }, { type: 'tool', name: 'bash', phase: 'start' }, { type: 'sources', seq: 1, items: [{ kind: 'canvas', label: 'Homework 6' }] }], { withPreview: true, muted });
    expect(muted).not.toHaveBeenCalled();
  });

  it('does what it always did for a view that has no preview (WhatsApp, an older channel): the same calls, in the same order, and text is dropped', () => {
    expect(drive(turn, { withPreview: false })).toEqual(['status Thinking', 'status Checking Canvas', 'status Thinking', 'status Thinking']);
  });

  it('is the same calls as before the preview existed for a turn with no text in it, with the flag off: the status calls and nothing else', () => {
    const noText = turn.filter((e) => e.type !== 'text' && e.type !== 'textError');
    expect(drive(noText, { withPreview: false })).toEqual(['status Thinking', 'status Checking Canvas', 'status Thinking', 'status Thinking']);
  });
});
