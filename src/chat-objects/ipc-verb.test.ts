import { beforeEach, describe, expect, it } from 'vitest';

import {
  CHAT_OBJECT_ANSWER_CHARS,
  CHAT_OBJECT_KIND_UNKNOWN,
  CHAT_OBJECT_LIMITS,
  CHAT_OBJECT_LIMIT_MESSAGE,
  CHAT_OBJECT_NOT_REGISTERED,
  CHAT_OBJECT_NO_CARD,
  CHAT_OBJECT_REQUEST_CHARS,
  CHAT_OBJECT_TOO_BIG,
  _resetChatObjects,
  handleChatObject,
} from './ipc-verb.js';
import type { ChatObjectVerbEnv, ChatObjectVerbInput } from './ipc-verb.js';

// The IPC verb `chat_object` (the container's show_chart, show_trace and ask_to_predict): one answer for every request, the student from the folder, the data through the gate, the card only through the
// host's postObject, a limit for each student, and nothing of the data in the log.

const MAIN = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n';
const chart = { title: 'Latency by threads', kind: 'line', x_label: 'threads', y_label: 'latency', y_unit: 'ms', series: [{ name: 'gin', points: [[1, 12], [2, 15], [4, 31]] }] };
const trace = { title: 'Raft election', actors: ['A', 'B', 'C'], events: [{ from: 'A', label: 'election timeout' }, { from: 'A', to: 'B', label: 'RequestVote', state: [{ actor: 'A', text: 'candidate, term 2' }] }] };
const predict = { question: 'What does this print?', action: 'run', pkg: '.', files: [{ path: 'main.go', content: MAIN }], choices: ['hi', 'nothing'] };

let now = 1_000_000;
beforeEach(() => {
  _resetChatObjects();
  now = 1_000_000;
});

function setup(over: Partial<ChatObjectVerbEnv> = {}) {
  const said: Array<{ id: string; ok: boolean; message: string }> = [];
  const audits: Array<{ op: string; fields: Record<string, unknown> }> = [];
  const posted: Array<{ folder: string; obj: any }> = [];
  const warns: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const env: ChatObjectVerbEnv = {
    say: (id, ok, message) => void said.push({ id, ok, message }),
    audit: (op, fields) => void audits.push({ op, fields }),
    postObject: (folder, obj) => void posted.push({ folder, obj }),
    log: { warn: (fields, message) => void warns.push({ fields, message }) },
    now: () => now,
    ...over,
  };
  const ask = (request: unknown, over: Partial<ChatObjectVerbInput> = {}) => handleChatObject({ folder: 's_ada', isMain: false, requestId: 'req-00000001', request, group: {}, ...over }, env);
  return { env, ask, said, audits, posted, warns };
}

describe('a card that is made', () => {
  it('is a chart in the chat, from the arguments through the gate, and the answer says so and what it is', () => {
    const t = setup();
    t.ask({ kind: 'chart', args: chart });
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0].folder).toBe('s_ada');
    expect(t.posted[0].obj).toMatchObject({ t: 'chart', title: 'Latency by threads', kind: 'line', xLabel: 'threads', yLabel: 'latency', yUnit: 'ms' });
    expect(t.said).toHaveLength(1);
    expect(t.said[0]).toMatchObject({ id: 'req-00000001', ok: true });
    expect(t.said[0].message).toMatch(/^Chart: Latency by threads \(1 series\): it is in the chat now as a card/);
    expect(t.said[0].message).toMatch(/do not list the numbers back/);
  });

  it('is a trace, and the model is told to let the student step through it', () => {
    const t = setup();
    t.ask({ kind: 'trace', args: trace });
    expect(t.posted[0].obj).toMatchObject({ t: 'trace', actors: ['A', 'B', 'C'] });
    expect(t.said[0]).toMatchObject({ ok: true });
    expect(t.said[0].message).toMatch(/^Sequence: Raft election \(2 steps\): it is in the chat now as a card with Previous, Next and Play/);
  });

  it('is a prediction card, and the model is told not to say what it prints', () => {
    const t = setup();
    t.ask({ kind: 'predict', args: predict });
    expect(t.posted[0].obj).toMatchObject({ t: 'predict', action: 'run', pkg: '.', choices: ['hi', 'nothing'] });
    expect(t.said[0].message).toMatch(/in the chat now as a card/);
    expect(t.said[0].message).toMatch(/Do not say what it prints/);
    expect(t.said[0].message).toMatch(/note with their guess and what it printed/);
    // their own press of Run runs it, once, as one of their runs; the model sets guess and output side by side and does not run the program itself
    expect(t.said[0].message).toContain('press Run themselves: that runs it once, as one of their own runs');
    expect(t.said[0].message).toContain('(in lines that open [The student sees])');
    expect(t.said[0].message).toContain('set them side by side and ask what they make of it');
    expect(t.said[0].message).toContain('do not run it yourself with run_go');
  });

  it('says what the gate left out, so that the model does not describe another card', () => {
    const t = setup();
    t.ask({ kind: 'trace', args: { ...trace, events: [...trace.events, { from: 'Z', label: 'lost' }] } });
    expect(t.said[0].ok).toBe(true);
    expect(t.said[0].message).toMatch(/Left out of the trace: 1 of 3 steps/);
    t.ask({ kind: 'chart', args: { ...chart, series: [{ name: 'a', points: [1, 'x', 3] }] } }, { requestId: 'req-00000002' });
    expect(t.said[1].message).toMatch(/Left out of the chart: 0 of 1 series and 1 of 3 points/);
  });

  it('keeps every answer within the number the container reads, even for the longest question', () => {
    const t = setup();
    t.ask({ kind: 'predict', args: { ...predict, question: 'q'.repeat(400), choices: ['a'] } });
    expect(t.said[0].message.length).toBeLessThanOrEqual(CHAT_OBJECT_ANSWER_CHARS);
    expect(t.said[0].message).toMatch(/options were not used/);
  });

  it('can be asked for by the admin chat, which has no registered group', () => {
    const t = setup();
    t.ask({ kind: 'chart', args: chart }, { group: undefined, isMain: true });
    expect(t.said[0].ok).toBe(true);
    expect(t.posted).toHaveLength(1);
  });
});

describe('a card that is refused', () => {
  it('says the first thing wrong, in the type\'s own words, and leaves no card', () => {
    const t = setup();
    t.ask({ kind: 'chart', args: { ...chart, kind: 'pie' } });
    t.ask({ kind: 'trace', args: { ...trace, events: [{ from: 'Z', label: 'x' }] } }, { requestId: 'req-00000002' });
    t.ask({ kind: 'predict', args: { ...predict, files: [{ path: '../main.go', content: MAIN }] } }, { requestId: 'req-00000003' });
    expect(t.posted).toEqual([]);
    expect(t.said.map((s) => s.ok)).toEqual([false, false, false]);
    expect(t.said[0].message).toMatch(/^Not drawn: kind is line, bar or scatter \(it was "pie"\)\. Fix it and call again, or say it in words\.$/);
    expect(t.said[1].message).toMatch(/Not drawn: step 1: from is "Z", which is not one of the actors \(A, B, C\)/);
    expect(t.said[2].message).toMatch(/Not drawn: the sandbox's check refused the program/);
    expect(t.said[2].message).not.toMatch(/Not run/);
  });

  it('refuses a kind it does not have, and a request that is not an object, and an object that smuggles another type in', () => {
    const t = setup();
    t.ask({ kind: 'doc', args: { doc: 'a'.repeat(32), title: 'x', pages: 3 } });
    t.ask('chart', { requestId: 'req-00000002' });
    t.ask(null, { requestId: 'req-00000003' });
    t.ask({ kind: 'chart', args: { t: 'doc', doc: 'a'.repeat(32), title: 'x', pages: 3 } }, { requestId: 'req-00000004' });
    expect(t.posted).toEqual([]);
    expect(t.said[0].message).toBe(CHAT_OBJECT_KIND_UNKNOWN);
    expect(t.said[1].message).toBe(CHAT_OBJECT_KIND_UNKNOWN);
    expect(t.said[2].message).toBe(CHAT_OBJECT_KIND_UNKNOWN);
    expect(t.said[3].ok).toBe(false);
  });

  it('refuses a request that is far too big without reading it', () => {
    const t = setup();
    t.ask({ kind: 'chart', args: { ...chart, series: [{ name: 'a', points: [1], pad: 'x'.repeat(CHAT_OBJECT_REQUEST_CHARS) }] } });
    expect(t.said[0]).toMatchObject({ ok: false, message: CHAT_OBJECT_TOO_BIG });
    expect(t.posted).toEqual([]);
  });

  it('refuses a chat that is not registered, and says nothing about whose it is', () => {
    const t = setup();
    t.ask({ kind: 'chart', args: chart }, { group: undefined });
    expect(t.said[0]).toMatchObject({ ok: false, message: CHAT_OBJECT_NOT_REGISTERED });
    expect(t.posted).toEqual([]);
    expect(t.warns).toHaveLength(1);
  });

  it('drops a request with no usable id, with a warning and no answer', () => {
    const t = setup();
    t.ask({ kind: 'chart', args: chart }, { requestId: null });
    expect(t.said).toEqual([]);
    expect(t.posted).toEqual([]);
    expect(t.warns[0].message).toMatch(/without a usable request id/);
  });
});

describe('a chat that does not take the card', () => {
  it('is told so, and is not told that the card is in the chat', () => {
    const t = setup({
      postObject: () => {
        throw new Error('the history refused it');
      },
    });
    t.ask({ kind: 'chart', args: chart });
    expect(t.said).toHaveLength(1);
    expect(t.said[0]).toMatchObject({ ok: false, message: CHAT_OBJECT_NO_CARD });
    expect(t.said[0].message).not.toMatch(/in the chat now/);
    expect(t.warns[0].message).toBe('chat_object: the card could not be left');
  });

  it('is the same when nothing is wired to take cards', () => {
    const t = setup({ postObject: undefined });
    t.ask({ kind: 'trace', args: trace });
    expect(t.said[0]).toMatchObject({ ok: false, message: CHAT_OBJECT_NO_CARD });
  });

  it('still counts the card, because the limit is on what was handed to the chat', () => {
    const t = setup({
      postObject: () => {
        throw new Error('no');
      },
    });
    for (let i = 0; i < CHAT_OBJECT_LIMITS.perWindow; i++) t.ask({ kind: 'chart', args: chart }, { requestId: `req-${String(i).padStart(8, '0')}` });
    t.ask({ kind: 'chart', args: chart }, { requestId: 'req-99999999' });
    expect(t.said.at(-1)).toMatchObject({ ok: false, message: CHAT_OBJECT_LIMIT_MESSAGE });
  });
});

describe('one answer, whatever happens', () => {
  it('is one answer when the answer cannot be written (nothing escapes), and the work is not repeated', () => {
    let tries = 0;
    const t = setup({
      say: () => {
        tries++;
        throw new Error('disk full');
      },
    });
    expect(() => t.ask({ kind: 'chart', args: chart })).not.toThrow();
    expect(tries).toBe(1);
    expect(t.posted).toHaveLength(1);
    expect(t.warns[0].message).toBe('chat_object: the answer could not be written');
  });

  it('is one answer when the audit log throws', () => {
    const t = setup({
      audit: () => {
        throw new Error('log gone');
      },
    });
    t.ask({ kind: 'trace', args: trace });
    expect(t.said).toHaveLength(1);
    expect(t.said[0].ok).toBe(true);
  });

  it('is one answer for anything a container may write, including values that are not JSON-shaped', () => {
    const t = setup();
    const circular: Record<string, unknown> = { title: 't' };
    circular.self = circular;
    const odd: unknown[] = [undefined, 5, [], { kind: 'chart' }, { kind: 'chart', args: null }, { kind: 'chart', args: 'x' }, { kind: 'trace', args: [] }, { kind: 'predict', args: circular }, { kind: 'chart', args: circular }];
    odd.forEach((request, i) => t.ask(request, { requestId: `req-${String(i).padStart(8, '0')}` }));
    expect(t.said).toHaveLength(odd.length);
    expect(t.said.every((s) => !s.ok)).toBe(true);
    expect(t.posted).toEqual([]);
  });
});

describe('what one student may be given', () => {
  it('is a number of cards an hour, whatever the container counts, and the window moves on', () => {
    const t = setup();
    for (let i = 0; i < CHAT_OBJECT_LIMITS.perWindow; i++) {
      now += 1000;
      t.ask({ kind: 'chart', args: chart }, { requestId: `req-${String(i).padStart(8, '0')}` });
    }
    expect(t.posted).toHaveLength(CHAT_OBJECT_LIMITS.perWindow);
    t.ask({ kind: 'trace', args: trace }, { requestId: 'req-99999999' });
    expect(t.said.at(-1)).toMatchObject({ ok: false, message: CHAT_OBJECT_LIMIT_MESSAGE });
    expect(t.posted).toHaveLength(CHAT_OBJECT_LIMITS.perWindow);
    now += CHAT_OBJECT_LIMITS.windowMs;
    t.ask({ kind: 'trace', args: trace }, { requestId: 'req-99999998' });
    expect(t.said.at(-1)!.ok).toBe(true);
  });

  it('is counted for each student: another student is not held up by this one', () => {
    const t = setup();
    for (let i = 0; i < CHAT_OBJECT_LIMITS.perWindow; i++) t.ask({ kind: 'chart', args: chart }, { requestId: `req-${String(i).padStart(8, '0')}` });
    t.ask({ kind: 'chart', args: chart }, { folder: 's_bo', requestId: 'req-99999999' });
    expect(t.said.at(-1)!.ok).toBe(true);
    expect(t.posted.at(-1)!.folder).toBe('s_bo');
  });

  it('does not count a refused card', () => {
    const t = setup();
    for (let i = 0; i < CHAT_OBJECT_LIMITS.perWindow + 5; i++) t.ask({ kind: 'chart', args: { ...chart, kind: 'pie' } }, { requestId: `req-${String(i).padStart(8, '0')}` });
    t.ask({ kind: 'chart', args: chart }, { requestId: 'req-99999999' });
    expect(t.said.at(-1)!.ok).toBe(true);
  });
});

describe('what is logged', () => {
  it('is the kind and how it ended, with the student\'s folder, and never the data', () => {
    const t = setup();
    t.ask({ kind: 'chart', args: chart });
    t.ask({ kind: 'predict', args: { ...predict, action: 'vet' } }, { requestId: 'req-00000002' });
    t.ask({ kind: 'trace', args: trace }, { requestId: 'req-00000003' });
    expect(t.audits.map((a) => a.op)).toEqual(['chat_object', 'chat_object', 'chat_object']);
    expect(t.audits.map((a) => [a.fields.kind, a.fields.ok, a.fields.reason ?? null])).toEqual([['chart', true, null], ['predict', false, 'refused'], ['trace', true, null]]);
    expect(t.audits[0].fields).toMatchObject({ sourceGroup: 's_ada', isMain: false });
    const everything = JSON.stringify([t.audits, t.warns]);
    for (const secret of ['Latency by threads', 'Raft election', 'RequestVote', 'fmt.Println', 'What does this print']) expect(everything).not.toContain(secret);
  });
});
