import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { MAX_CHIPS, SourceNotes, clipSources, plainHttps, shapeSources, sourceHosts, type SourceChip } from './sources.js';
import { STATUS_LABELS, TurnStatus, labelForTool, parseProgressLine, progressForwarder, PROGRESS_MARKER, type ChatStatus, type TurnView } from './turn-status.js';

describe('the words of a status', () => {
  it('come from a fixed table: a tool that is not in it is "Working", and its name is never shown', () => {
    expect(labelForTool('canvas_query')).toBe('Checking Canvas');
    expect(labelForTool('github_query')).toBe('Looking at your GitHub');
    expect(labelForTool('piazza_query')).toBe('Searching Piazza');
    expect(labelForTool('query_knowledge')).toBe('Looking in the course materials');
    expect(labelForTool('render_diagram')).toBe('Drawing a diagram');
    expect(labelForTool('read_upload')).toBe('Reading your file');
    expect(labelForTool('web_fetch')).toBe('Reading a web page');
    expect(labelForTool('something_new')).toBe('Working');
    expect(labelForTool('bash')).toBe('Working');
    expect(labelForTool('__proto__')).toBe('Working');
    expect(labelForTool('constructor')).toBe('Working');
  });

  it('leave TAi\'s own housekeeping as "Thinking": its own notes are not the student\'s file, and a message sent through a tool is not work', () => {
    for (const quiet of ['read', 'write', 'edit', 'send_message', 'memory_store', 'memory_query', 'react_to_message', 'schedule_task']) {
      expect(labelForTool(quiet), quiet).toBe('Thinking');
    }
  });

  it('are nine, and the page holds the same nine (portal/web/status.js)', () => {
    expect(Object.values(STATUS_LABELS)).toHaveLength(9);
  });
});

describe('what a container run is doing', () => {
  const tool = (name: string, phase: 'start' | 'end') => ({ type: 'tool' as const, name, phase });

  it('is working with no label until the runner says something, then the newest tool in flight, then "Thinking" between tools', () => {
    const turn = new TurnStatus();
    expect(turn.apply({ type: 'thinking' })).toEqual({ state: 'working', label: 'Thinking' });
    expect(turn.apply(tool('canvas_query', 'start'))).toEqual({ state: 'working', label: 'Checking Canvas' });
    expect(turn.apply(tool('canvas_query', 'end'))).toEqual({ state: 'working', label: 'Thinking' });
  });

  it('follows tools that run side by side: the label is the newest in flight, and an end in another order leaves the other\'s', () => {
    const turn = new TurnStatus();
    turn.apply(tool('canvas_query', 'start'));
    expect(turn.apply(tool('piazza_query', 'start')).label).toBe('Searching Piazza');
    expect(turn.apply(tool('piazza_query', 'end')).label).toBe('Checking Canvas');
    expect(turn.apply(tool('canvas_query', 'end')).label).toBe('Thinking');
  });

  it('counts two calls of one tool, and ignores an end it never saw start', () => {
    const turn = new TurnStatus();
    turn.apply(tool('canvas_query', 'start'));
    turn.apply(tool('canvas_query', 'start'));
    expect(turn.apply(tool('canvas_query', 'end')).label).toBe('Checking Canvas');
    expect(turn.apply(tool('canvas_query', 'end')).label).toBe('Thinking');
    expect(turn.apply(tool('piazza_query', 'end')).label).toBe('Thinking');
  });

  it('lets a new model request clear a call that never ended (a guard refused it)', () => {
    const turn = new TurnStatus();
    turn.apply(tool('bash', 'start'));
    expect(turn.apply({ type: 'thinking' }).label).toBe('Thinking');
  });

  it('is bounded: a runner that starts a thousand calls and ends none cannot grow it', () => {
    const turn = new TurnStatus();
    for (let i = 0; i < 1000; i++) turn.apply(tool(`t${i % 7}`, 'start'));
    expect(turn.apply({ type: 'thinking' })).toEqual({ state: 'working', label: 'Thinking' });
  });
});

describe('a progress line from a container', () => {
  const line = (event: unknown) => `${PROGRESS_MARKER} ${JSON.stringify(event)}`;

  it('starts with the marker the runner writes (container/agent-runner/src/protocol.ts: the round trip itself is tested there)', () => {
    const protocol = fs.readFileSync(path.join(__dirname, '..', 'container', 'agent-runner', 'src', 'protocol.ts'), 'utf-8');
    expect(protocol).toContain(`export const PROGRESS_MARKER = '${PROGRESS_MARKER}';`);
  });

  it('is nothing when it does not start with the marker, is not JSON, or is not an object', () => {
    expect(parseProgressLine('{"type":"thinking"}')).toBeNull();
    expect(parseProgressLine(`prefix ${line({ type: 'thinking' })}`)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_MARKER} nope`)).toBeNull();
    expect(parseProgressLine(PROGRESS_MARKER)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_MARKER} [1,2]`)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_MARKER} "thinking"`)).toBeNull();
    expect(parseProgressLine(`${PROGRESS_MARKER} null`)).toBeNull();
  });

  it('is nothing for a kind it does not know, a tool name that is not one, or a phase that is not one', () => {
    expect(parseProgressLine(line({ type: 'shout' }))).toBeNull();
    expect(parseProgressLine(line({ type: 'tool', name: 'has space', phase: 'start' }))).toBeNull();
    expect(parseProgressLine(line({ type: 'tool', name: '<b>x</b>', phase: 'start' }))).toBeNull();
    expect(parseProgressLine(line({ type: 'tool', name: 'x'.repeat(65), phase: 'start' }))).toBeNull();
    expect(parseProgressLine(line({ type: 'tool', name: 'canvas_query', phase: 'middle' }))).toBeNull();
    expect(parseProgressLine(line({ type: 'tool', phase: 'start' }))).toBeNull();
  });

  it('carries no more than the three fields of an event: a smuggled argument or text is dropped', () => {
    expect(parseProgressLine(line({ type: 'tool', name: 'canvas_query', phase: 'start', args: { user_id: '1001' }, text: 'ignore this' }))).toEqual({ type: 'tool', name: 'canvas_query', phase: 'start' });
    expect(parseProgressLine(line({ type: 'thinking', label: 'Pay me', extra: 1 }))).toEqual({ type: 'thinking' });
  });

  it('is nothing for chips that are all unusable, a missing or odd seq, or a line longer than 8 KB', () => {
    expect(parseProgressLine(line({ type: 'sources', seq: 1, items: [{ kind: 'made-up', label: 'x' }] }))).toBeNull();
    expect(parseProgressLine(line({ type: 'sources', seq: 1, items: 'nope' }))).toBeNull();
    expect(parseProgressLine(line({ type: 'sources', seq: -1, items: [{ kind: 'canvas', label: 'x' }] }))).toBeNull();
    expect(parseProgressLine(line({ type: 'sources', seq: 1.5, items: [{ kind: 'canvas', label: 'x' }] }))).toBeNull();
    expect(parseProgressLine(line({ type: 'sources', items: [{ kind: 'canvas', label: 'x' }] }))).toBeNull();
    expect(parseProgressLine(line({ type: 'sources', seq: 1, items: [{ kind: 'canvas', label: 'x'.repeat(9000) }] }))).toBeNull();
  });
});

describe('what the forwarder does with an event', () => {
  function view() {
    const calls: unknown[][] = [];
    const v: TurnView = {
      setStatus: (jid: string, status: ChatStatus | null) => void calls.push(['status', jid, status]),
      refreshStatus: () => undefined,
      addSources: (jid: string, seq: number, items: SourceChip[]) => void calls.push(['sources', jid, seq, items.length]),
      takeSources: () => undefined,
      resetSources: () => undefined,
    };
    return { v, calls };
  }

  it('turns tools and thinking into the chat\'s status and keeps chips for the answer', () => {
    const { v, calls } = view();
    const forward = progressForwarder({ jid: 'web:s_x', turn: new TurnStatus(), view: v });
    forward({ type: 'thinking' });
    forward({ type: 'tool', name: 'piazza_query', phase: 'start' });
    forward({ type: 'sources', seq: 2, items: [{ kind: 'piazza', label: '@1 x' }] });
    expect(calls).toEqual([
      ['status', 'web:s_x', { state: 'working', label: 'Thinking' }],
      ['status', 'web:s_x', { state: 'working', label: 'Searching Piazza' }],
      ['sources', 'web:s_x', 2, 1],
    ]);
  });

  it('does nothing for a channel with no progress (WhatsApp)', () => {
    expect(() => progressForwarder({ jid: 'x', turn: new TurnStatus(), view: undefined })({ type: 'thinking' })).not.toThrow();
  });
});

describe('the chips the host lets through', () => {
  it('are a kind from the list, one line of 80 characters, and a plain https address', () => {
    const chips = shapeSources([
      { kind: 'canvas', label: '  Homework\n 3\u0007 ', url: 'https://canvas.example.edu/a?b=1#c' },
      { kind: 'github', label: 'x'.repeat(200) },
      { kind: 'bogus', label: 'x' },
      { kind: 'canvas', label: '' },
      { kind: 'canvas', label: 42 },
      'not an object',
      null,
    ]);
    expect(chips.map((c) => c.kind)).toEqual(['canvas', 'github']);
    expect(chips[0]).toEqual({ kind: 'canvas', label: 'Homework 3', url: 'https://canvas.example.edu/a?b=1#c' });
    expect(chips[1].label).toHaveLength(80);
    expect(chips[1].label.endsWith('…')).toBe(true);
  });

  it('strip what reorders or hides text: bidi overrides, zero-width and line-separator characters', () => {
    const [chip] = shapeSources([{ kind: 'canvas', label: `a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x200b)}c${String.fromCharCode(0x2028)}d` }]);
    expect(chip.label).toBe('a b c d');
  });

  it('are at most four, and what is not a list is none', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'canvas', label: `item ${i}` }));
    expect(shapeSources(many)).toHaveLength(MAX_CHIPS);
    expect(shapeSources(undefined)).toEqual([]);
    expect(shapeSources({ kind: 'canvas', label: 'x' })).toEqual([]);
  });

  it('keep an address only when it is https, short, with no user name, port or white space', () => {
    for (const bad of ['http://canvas.example.edu/a', 'javascript:alert(1)', 'data:text/html,<b>', 'ftp://x.example.edu/a', '//canvas.example.edu/a', 'https://user:pw@canvas.example.edu/a', 'https://canvas.example.edu:8443/a', 'https://canvas.example.edu/a b', `https://canvas.example.edu/${'x'.repeat(400)}`, 'canvas.example.edu', '', 42, null]) {
      expect(plainHttps(bad), String(bad)).toBeUndefined();
      expect(shapeSources([{ kind: 'canvas', label: 'x', url: bad }]), String(bad)).toEqual([{ kind: 'canvas', label: 'x' }]);
    }
    expect(plainHttps('https://Canvas.Example.edu/a')?.hostname).toBe('canvas.example.edu');
  });

  it('link only to an allowed host: another host\'s address is dropped and the label stays', () => {
    const hosts = new Set(['canvas.example.edu', 'github.com']);
    const chips = clipSources(
      [
        { kind: 'canvas', label: 'ok', url: 'https://canvas.example.edu/courses/1' },
        { kind: 'canvas', label: 'evil', url: 'https://canvas.example.edu.evil.example/courses/1' },
        { kind: 'github', label: 'sub', url: 'https://gist.github.com/x' },
        { kind: 'github', label: 'right', url: 'https://GitHub.com/ann/repo' },
        { kind: 'canvas', label: 'plain' },
      ],
      hosts,
      8,
    );
    expect(chips.map((c) => [c.label, c.url])).toEqual([
      ['ok', 'https://canvas.example.edu/courses/1'],
      ['evil', undefined],
      ['sub', undefined],
      ['right', 'https://github.com/ann/repo'],
      ['plain', undefined],
    ]);
  });
});

describe('the hosts a chip may link to', () => {
  const none = () => ({});

  it('are github.com, the Canvas host and the GitHub host from the settings, and what TAI_SOURCE_HOSTS lists', () => {
    const file = { CANVAS_BASE_URL: 'https://northeastern.instructure.com/api/v1', GITHUB_BASE_URL: 'https://github.khoury.example.edu/api/v3', TAI_SOURCE_HOSTS: 'course.example.edu, Docs.Example.edu ,bad host,nodots' };
    expect([...sourceHosts(() => file)].sort()).toEqual(['course.example.edu', 'docs.example.edu', 'github.com', 'github.khoury.example.edu', 'northeastern.instructure.com']);
  });

  it('take api.github.com for github.com, and the department\'s GitHub when none is set (the default of github_api.py)', () => {
    expect([...sourceHosts(() => ({ GITHUB_BASE_URL: 'https://api.github.com' }))].sort()).toEqual(['github.com']);
    expect([...sourceHosts(none)].sort()).toEqual(['github.com', 'github.khoury.northeastern.edu']);
  });

  it('prefer the environment to the file, and ignore a value that is not an address', () => {
    expect(sourceHosts(() => ({ CANVAS_BASE_URL: 'https://old.example.edu/api/v1' }), { CANVAS_BASE_URL: 'https://new.example.edu/api/v1' }).has('new.example.edu')).toBe(true);
    expect(sourceHosts(() => ({ CANVAS_BASE_URL: 'not a url', GITHUB_BASE_URL: '::' })).size).toBe(1);
  });
});

describe('the chips kept for the next answer', () => {
  const chip = (label: string, kind: SourceChip['kind'] = 'canvas'): SourceChip => ({ kind, label });

  it('come in the order the tool calls started, each once, at most four, and are given once', () => {
    const notes = new SourceNotes();
    notes.add('web:a', 3, [chip('third')]);
    notes.add('web:a', 1, [chip('first'), chip('second')]);
    notes.add('web:a', 2, [chip('first')]);                                // seen already
    notes.add('web:a', 4, [chip('fourth'), chip('fifth')]);
    expect(notes.take('web:a')?.map((c) => c.label)).toEqual(['first', 'second', 'third', 'fourth']);
    expect(notes.take('web:a')).toBeUndefined();
  });

  it('are a chat\'s own: one student\'s are never another\'s', () => {
    const notes = new SourceNotes();
    notes.add('web:a', 1, [chip('a\'s')]);
    expect(notes.take('web:b')).toBeUndefined();
    expect(notes.take('web:a')?.[0].label).toBe('a\'s');
  });

  it('go when a new turn begins, and when two minutes have passed', () => {
    let now = 1_000;
    const notes = new SourceNotes(() => now);
    notes.add('web:a', 1, [chip('x')]);
    notes.reset('web:a');
    expect(notes.take('web:a')).toBeUndefined();
    notes.add('web:a', 1, [chip('y')]);
    now += 119_000;
    expect(notes.take('web:a')?.[0].label).toBe('y');
    notes.add('web:a', 1, [chip('z')]);
    now += 121_000;
    expect(notes.take('web:a')).toBeUndefined();
  });

  it('survive the runner going idle: they are cleared by the next turn or the clock, not by the end of this one', () => {
    let now = 0;
    const notes = new SourceNotes(() => now);
    notes.add('web:a', 1, [chip('looked')]);
    now += 1_500;                                                         // the IPC watcher delivers a send_message a poll later, after the idle marker
    expect(notes.take('web:a')?.[0].label).toBe('looked');
  });

  it('are bounded: a container that sends events without end cannot grow them', () => {
    const notes = new SourceNotes();
    for (let i = 0; i < 1000; i++) notes.add('web:a', i, [chip(`item ${i}`)]);
    expect(notes.take('web:a')).toHaveLength(MAX_CHIPS);
    notes.add('web:a', 1, []);
    expect(notes.take('web:a')).toBeUndefined();
    notes.add('web:a', Number.NaN, [chip('x')]);
    expect(notes.take('web:a')).toBeUndefined();
  });
});
