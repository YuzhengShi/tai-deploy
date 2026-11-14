import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHAT_OBJECT_ANSWER_CHARS, CHAT_OBJECT_LIMITS, _resetChatObjects, handleChatObject } from '../../../src/chat-objects/ipc-verb.js';
import {
  ASK_TO_PREDICT_DESCRIPTION,
  CHAT_CARDS_NUMBERS,
  CHAT_CARD_NOT_IN_CALL,
  CHAT_CARD_NOT_IN_TASK,
  CHAT_CARD_NOT_SENT,
  CHAT_CARD_UNCONFIRMED,
  CHAT_CARD_UNREADABLE,
  SHOW_CHART_DESCRIPTION,
  SHOW_TRACE_DESCRIPTION,
  askToPredict,
  showChart,
  showTrace,
} from '../src/chat-cards.js';
import type { AskToPredictArgs, ChatCardContext, ShowChartArgs, ShowTraceArgs } from '../src/chat-cards.js';
import { TOOL_LIMITS, ToolLimiter } from '../src/tool-limits.js';

// The container's tools show_chart, show_trace and ask_to_predict: they write the request the host's verb `chat_object` reads (src/chat-objects/ipc-verb.ts) and wait for the answer file. The number they repeat
// is a twin of the host's, and one test below fails when a copy differs; the last test runs the real host verb against the real tools.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cards-'));
  _resetChatObjects();
});
afterEach(() => {
  _resetChatObjects();
  fs.rmSync(dir, { recursive: true, force: true });
});

const MAIN = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n';
const chart: ShowChartArgs = { title: 'Latency by threads', kind: 'line', x_label: 'threads', y_label: 'latency', y_unit: 'ms', series: [{ name: 'gin', points: [[1, 12], [2, 15], [4, 31]] }], note: 'measured with run_go' };
const trace: ShowTraceArgs = { title: 'Raft election', actors: ['A', 'B'], events: [{ from: 'A', label: 'timeout' }, { from: 'A', to: 'B', label: 'RequestVote' }] };
const predict: AskToPredictArgs = { question: 'What does this print?', action: 'run', files: [{ path: 'main.go', content: MAIN }], choices: ['hi', 'nothing'] };

const answerFile = (id: string, body: unknown) => fs.writeFileSync(path.join(dir, `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body));

/** A clock that moves only when the wait sleeps. */
function clock(onSleep: (n: number) => void = () => undefined) {
  let at = 1_000_000;
  let sleeps = 0;
  return { now: () => at, sleep: async (ms: number) => { sleeps++; at += ms; onSleep(sleeps); }, sleeps: () => sleeps };
}
function context(over: Partial<ChatCardContext> = {}, onWrite: (data: Record<string, unknown>) => void = () => undefined) {
  const written: Array<Record<string, unknown>> = [];
  const used = { limit: 0 };
  const c = clock();
  const ctx: ChatCardContext = {
    scheduled: false,
    limit: () => (used.limit++, null),
    writeTask: (data) => {
      written.push(data);
      onWrite(data);
    },
    resultsDir: dir,
    wait: { now: c.now, sleep: c.sleep },
    ...over,
  };
  return { ctx, written, used, clock: c };
}

describe('the twins of the host\'s numbers and the limits', () => {
  it('are the host\'s: the cap on the answer, and a wait that is more than the host\'s watcher needs', () => {
    expect(CHAT_CARDS_NUMBERS.answerChars).toBe(CHAT_OBJECT_ANSWER_CHARS);
    expect(CHAT_CARDS_NUMBERS.requestWaitMs).toBeGreaterThanOrEqual(5_000);
  });

  it('count six charts, six sequences and four predictions in a conversation, and refuse the next in the limiter\'s sentence; the admin is never counted', () => {
    expect([TOOL_LIMITS.show_chart, TOOL_LIMITS.show_trace, TOOL_LIMITS.ask_to_predict]).toEqual([6, 6, 4]);
    expect(TOOL_LIMITS.ask_to_predict).toBeLessThanOrEqual(CHAT_OBJECT_LIMITS.perWindow);
    const limiter = new ToolLimiter(TOOL_LIMITS);
    expect(Array.from({ length: 4 }, () => limiter.check('ask_to_predict'))).toEqual(Array(4).fill(null));
    expect(limiter.check('ask_to_predict')).toBe('Rate limit exceeded for ask_to_predict: max 4 calls per session.');
    expect(Array.from({ length: 6 }, () => limiter.check('show_chart'))).toEqual(Array(6).fill(null));
    expect(limiter.check('show_chart')).toBe('Rate limit exceeded for show_chart: max 6 calls per session.');
    const admin = new ToolLimiter(TOOL_LIMITS, true);
    for (let i = 0; i < 50; i++) expect(admin.check('show_trace')).toBeNull();
  });
});

describe('what the tools tell the model', () => {
  it('say what each is for, what it is not for, and how to read the result, in the style of the other tools', () => {
    for (const d of [SHOW_CHART_DESCRIPTION, SHOW_TRACE_DESCRIPTION, ASK_TO_PREDICT_DESCRIPTION]) {
      for (const part of ['WHEN TO CALL:', 'NOT:', 'THE RESULT is', 'Not available in a scheduled task']) expect(d).toContain(part);
    }
  });

  it('keep a chart to numbers the model was given or measured, a sequence to a picture of how something works, and a prediction to a program the student has not seen', () => {
    expect(SHOW_CHART_DESCRIPTION).toMatch(/numbers they gave you or that run_go measured/);
    expect(SHOW_CHART_DESCRIPTION).toMatch(/Numbers you made up, or remember from somewhere: never draw those/);
    expect(SHOW_CHART_DESCRIPTION).toMatch(/say what the numbers are and where they came from/);
    expect(SHOW_CHART_DESCRIPTION).toMatch(/do not list the numbers back/);
    expect(SHOW_TRACE_DESCRIPTION).toMatch(/INSTEAD of writing the steps out/);
    expect(SHOW_TRACE_DESCRIPTION).toMatch(/render_diagram/);
    expect(SHOW_TRACE_DESCRIPTION).toMatch(/Previous, Next and Play/);
    expect(ASK_TO_PREDICT_DESCRIPTION).toMatch(/BEFORE it runs/);
    expect(ASK_TO_PREDICT_DESCRIPTION).toMatch(/A solution to a graded assignment/);
    expect(ASK_TO_PREDICT_DESCRIPTION).toMatch(/wait for their guess/);
    // the student's own press of Run runs it (once, as one of their runs); the guess and the output come back as a note; the model never runs the program itself
    expect(ASK_TO_PREDICT_DESCRIPTION).toContain('their press runs the program once in the sandbox, as one of their own runs, and you do not run it');
    expect(ASK_TO_PREDICT_DESCRIPTION).toContain('in lines that open with [The student sees], with their guess and what it printed: set them side by side and ask what they make of it');
    expect(ASK_TO_PREDICT_DESCRIPTION).toContain(`Running the card's program yourself with run_go: that spends one of their runs and skips "predict first"`);
    expect(ASK_TO_PREDICT_DESCRIPTION).toMatch(/Go only, no network, 20 seconds/);
  });

  it('stay short, because they go with every turn of the text agent', () => {
    for (const d of [SHOW_CHART_DESCRIPTION, SHOW_TRACE_DESCRIPTION, ASK_TO_PREDICT_DESCRIPTION]) expect(d.length).toBeLessThanOrEqual(1_300);
  });
});

describe('a call', () => {
  it('writes exactly one request, {type, requestId, request: {kind, args}, timestamp}, with the model\'s arguments untouched, and an id the host accepts', async () => {
    const { ctx, written } = context({}, (data) => answerFile(String(data.requestId), { ok: true, message: 'done' }));
    await showChart(chart, ctx);
    await showTrace(trace, ctx);
    await askToPredict(predict, ctx);
    expect(written).toHaveLength(3);
    expect(Object.keys(written[0]).sort()).toEqual(['request', 'requestId', 'timestamp', 'type']);
    expect(written.map((w) => w.type)).toEqual(['chat_object', 'chat_object', 'chat_object']);
    expect(written[0].request).toEqual({ kind: 'chart', args: chart });
    expect(written[1].request).toEqual({ kind: 'trace', args: trace });
    expect(written[2].request).toEqual({ kind: 'predict', args: predict });
    expect(String(written[0].requestId)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(new Set(written.map((w) => w.requestId)).size).toBe(3);
    expect(new Date(String(written[0].timestamp)).toISOString()).toBe(written[0].timestamp);
  });

  it('relays the host\'s answer: a card that was made is the sentence, one that was not is an error with the host\'s sentence', async () => {
    const ok = context({}, (d) => answerFile(String(d.requestId), { ok: true, message: 'Chart: x (1 series): it is in the chat now as a card.' }));
    expect(await showChart(chart, ok.ctx)).toEqual({ content: [{ type: 'text', text: 'Chart: x (1 series): it is in the chat now as a card.' }] });
    const no = context({}, (d) => answerFile(String(d.requestId), { ok: false, message: 'Not drawn: kind is line, bar or scatter (it was "pie").' }));
    expect(await showChart(chart, no.ctx)).toEqual({ content: [{ type: 'text', text: 'Not drawn: kind is line, bar or scatter (it was "pie").' }], isError: true });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps an answer up to the host\'s cap, and not past it', async () => {
    const a = context({}, (d) => answerFile(String(d.requestId), { ok: true, message: 'y'.repeat(CHAT_OBJECT_ANSWER_CHARS + 300) }));
    expect((await showTrace(trace, a.ctx)).content[0].text).toHaveLength(CHAT_OBJECT_ANSWER_CHARS);
  });

  it('says honestly that it could not confirm when the host does not answer in the time it waits, and that the card may or may not be there', async () => {
    const { ctx, clock: c } = context();
    expect(await showTrace(trace, ctx)).toEqual({ content: [{ type: 'text', text: CHAT_CARD_UNCONFIRMED }] });
    expect(CHAT_CARD_UNCONFIRMED).toMatch(/did not confirm it within 10 seconds, so the card may or may not be in the chat/);
    expect(c.sleeps() * 150).toBeGreaterThanOrEqual(CHAT_CARDS_NUMBERS.requestWaitMs);
  });

  it('says it could not read an answer that is there but is not one, and says so when the request could not be written, without waiting', async () => {
    const bad = context({}, (d) => answerFile(String(d.requestId), 'not json at all'));
    expect(await askToPredict(predict, bad.ctx)).toEqual({ content: [{ type: 'text', text: CHAT_CARD_UNREADABLE }], isError: true });
    const { ctx, clock: c } = context({
      writeTask: () => {
        throw new Error('EACCES');
      },
    });
    expect(await showChart(chart, ctx)).toEqual({ content: [{ type: 'text', text: CHAT_CARD_NOT_SENT }], isError: true });
    expect(c.sleeps()).toBe(0);
  });
});

describe('where they refuse by themselves', () => {
  it('refuse in a scheduled task before they count a use or write anything', async () => {
    const { ctx, written, used, clock: c } = context({ scheduled: true });
    for (const tool of [() => showChart(chart, ctx), () => showTrace(trace, ctx), () => askToPredict(predict, ctx)]) {
      expect(await tool()).toEqual({ content: [{ type: 'text', text: CHAT_CARD_NOT_IN_TASK }], isError: true });
    }
    expect(written).toEqual([]);
    expect(used.limit).toBe(0);
    expect(c.sleeps()).toBe(0);
  });

  it('refuse in a voice call\'s tool host (the call has its own functions) before they count a use or write anything', async () => {
    const { ctx, written, used } = context({ toolHost: true });
    expect(await showChart(chart, ctx)).toEqual({ content: [{ type: 'text', text: CHAT_CARD_NOT_IN_CALL }], isError: true });
    expect(await askToPredict(predict, ctx)).toEqual({ content: [{ type: 'text', text: CHAT_CARD_NOT_IN_CALL }], isError: true });
    expect(written).toEqual([]);
    expect(used.limit).toBe(0);
  });

  it('refuse a seventh chart in a conversation in the limiter\'s own words and write nothing', async () => {
    const limiter = new ToolLimiter(TOOL_LIMITS);
    const { ctx, written } = context({ limit: () => limiter.check('show_chart') }, (d) => answerFile(String(d.requestId), { ok: true, message: 'shown' }));
    for (let i = 0; i < 6; i++) expect((await showChart(chart, ctx)).isError).toBeUndefined();
    expect(await showChart(chart, ctx)).toEqual({ content: [{ type: 'text', text: 'Rate limit exceeded for show_chart: max 6 calls per session.' }], isError: true });
    expect(written).toHaveLength(6);
  });
});

describe('the registration in the MCP server (its text: the file starts a server when imported)', () => {
  const server = fs.readFileSync(new URL('../src/ipc-mcp-stdio.ts', import.meta.url), 'utf-8');
  const toolText = (name: string) => {
    const start = server.indexOf(`server.tool(\n  '${name}'`);
    const next = server.indexOf('server.tool(', start + 20);
    return start === -1 ? '' : server.slice(start, next === -1 ? undefined : next);
  };

  it('registers the three tools with their descriptions and the arguments of the contract, and passes them on as they are', () => {
    const expected: Record<string, { description: string; keys: string[]; fn: string }> = {
      show_chart: { description: 'SHOW_CHART_DESCRIPTION', keys: ['title', 'kind', 'x_label', 'y_label', 'x_unit', 'y_unit', 'categories', 'series', 'note'], fn: 'showChart' },
      show_trace: { description: 'SHOW_TRACE_DESCRIPTION', keys: ['title', 'actors', 'events', 'note'], fn: 'showTrace' },
      ask_to_predict: { description: 'ASK_TO_PREDICT_DESCRIPTION', keys: ['question', 'action', 'pkg', 'files', 'choices'], fn: 'askToPredict' },
    };
    for (const [name, want] of Object.entries(expected)) {
      const tool = toolText(name);
      expect(tool, name).not.toBe('');
      expect(tool).toContain(want.description);
      expect([...tool.matchAll(/^ {4}(\w+): z/gm)].map((m) => m[1])).toEqual(want.keys);
      expect(tool).not.toMatch(/\.default\(/);
      expect(tool).toContain(`async (args) => ${want.fn}(args, { scheduled: accessFlags.isScheduledTask, toolHost: process.env.TAI_MODE === 'tool-host', limit: () => checkRateLimit('${name}'), writeTask: (data) => void writeIpcFile(TASKS_DIR, data), resultsDir: RESULTS_DIR })`);
      expect(tool).not.toMatch(/askHost/);
    }
  });

  it('describes the points in words, as the voice function does, with no union and no tuple in the schema (no other tool of the server sends one, and the host\'s cleaner reads a number or a pair)', () => {
    const tool = toolText('show_chart');
    expect(tool).toContain("points: z.array(z.unknown()).describe('Numbers (y; x is the position in the list) or pairs [x, y]')");
    expect(tool).not.toMatch(/z\.(union|tuple|discriminatedUnion)/);
    const server = fs.readFileSync(new URL('../src/ipc-mcp-stdio.ts', import.meta.url), 'utf-8');
    expect(server).not.toMatch(/z\.(union|tuple|discriminatedUnion)/);
  });
});

describe('the real host verb against the real tools', () => {
  /** What the container's tools wait for: the host's verb writes the answer file the tool reads, and leaves its card. */
  function host() {
    const cards: unknown[] = [];
    const ctx = context({}, (data) => {
      handleChatObject(
        { folder: 's_ada', isMain: false, requestId: String(data.requestId), request: data.request, group: {} },
        {
          say: (id, ok, message) => answerFile(id, { ok, message }),
          audit: () => undefined,
          postObject: (_folder, obj) => void cards.push(obj),
          log: { warn: () => undefined },
        },
      );
    });
    return { ...ctx, cards };
  }

  it('makes a chart, a trace and a prediction card, and tells the model each is in the chat', async () => {
    const t = host();
    const a = await showChart(chart, t.ctx);
    const b = await showTrace(trace, t.ctx);
    const c = await askToPredict(predict, t.ctx);
    for (const r of [a, b, c]) {
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toMatch(/it is in the chat now as a card/);
    }
    expect(t.cards.map((o) => (o as { t: string }).t)).toEqual(['chart', 'trace', 'predict']);
    expect(t.cards[0]).toMatchObject({ xLabel: 'threads', yLabel: 'latency', yUnit: 'ms', note: 'measured with run_go' });
  });

  it('refuses what the gate refuses, with the first thing wrong, and leaves no card', async () => {
    const t = host();
    const r = await showTrace({ ...trace, events: [{ from: 'Z', label: 'lost' }] }, t.ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Not drawn: step 1: from is "Z", which is not one of the actors \(A, B\)/);
    expect(t.cards).toEqual([]);
  });
});
