import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildMcpServers } from '../src/mcp-servers.js';
import { envWithSecrets, type ContainerInput } from '../src/protocol.js';
import { ToolLimiter } from '../src/tool-limits.js';
import {
  ANSWER_MAX_CHARS,
  ANSWER_PREFIX,
  FAILED_PREFIX,
  READ_FILE_MAX_CHARS,
  READY_LINE,
  McpToolServer,
  capText,
  credentialValues,
  redact,
  resultText,
  runToolHost,
  type ExecFile,
  type LineSource,
  type McpCallResult,
  type ToolHostOptions,
  type ToolServer,
} from '../src/tool-host.js';

// --- a host to talk to ---------------------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The lines the host would send, one at a time; end() is the end of the input. */
class Feed implements LineSource {
  private readonly lines: Array<string | null> = [];
  private waiting: (() => void) | null = null;
  push(request: unknown): void {
    this.lines.push(typeof request === 'string' ? request : JSON.stringify(request));
    this.waiting?.();
  }
  end(): void {
    this.lines.push(null);
    this.waiting?.();
  }
  async nextLine(): Promise<string | null> {
    while (this.lines.length === 0) {
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
    return this.lines.shift()!;
  }
}

interface Answer {
  id: string | number;
  ok: boolean;
  text: string;
  error?: string;
}

/** What the tool host wrote to stdout, line by line. */
function stdout() {
  const lines: string[] = [];
  const answers = (): Answer[] => lines.filter((l) => l.startsWith(ANSWER_PREFIX)).map((l) => JSON.parse(l.slice(ANSWER_PREFIX.length)) as Answer);
  const until = async (condition: () => boolean, ms = 4000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`gave up waiting; stdout so far: ${JSON.stringify(lines)}`);
      await sleep(5);
    }
  };
  return { lines, answers, until, write: (line: string) => void lines.push(line) };
}

const text = (value: string): McpCallResult => ({ content: [{ type: 'text', text: value }] });
const untilAborted = (signal: AbortSignal) =>
  new Promise<McpCallResult>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));

type Tool = (args: Record<string, unknown>, signal: AbortSignal) => Promise<McpCallResult> | McpCallResult;

/** An MCP server that is in the test process: the tools are functions, and what happened to it is recorded. */
function fakeServer(tools: Record<string, Tool> = {}, behaviour: { connect?: () => Promise<void>; close?: () => Promise<void> } = {}) {
  const state = { connected: 0, closed: 0, calls: [] as Array<{ name: string; args: Record<string, unknown> }> };
  const server: ToolServer & typeof state = Object.assign(state, {
    async connect() {
      await (behaviour.connect ?? (async () => undefined))();
      state.connected++;
    },
    async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
      state.calls.push({ name, args });
      const tool = tools[name];
      if (!tool) throw new Error(`MCP error -32602: Tool ${name} not found`);
      return tool(args, signal);
    },
    async close() {
      state.closed++;
      await (behaviour.close ?? (async () => undefined))();
    },
  });
  return server;
}

const student: ContainerInput = { prompt: '', groupFolder: 'ann', chatJid: 'web:ann', isMain: false, canvasUserId: '42', githubUsername: 'ann-eval' };

let root: string; // a /workspace of the test's own: <root>/group/uploads
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toolhost-')));
  fs.mkdirSync(path.join(root, 'group', 'uploads'), { recursive: true });
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Start a tool host on fake input and output; `ask` sends a request and waits for its answer. */
async function start(servers: Record<string, ToolServer>, input: ContainerInput = student, options: ToolHostOptions = {}) {
  const feed = new Feed();
  const out = stdout();
  const done = runToolHost(input, feed, out.write, servers, { workspaceRoot: root, callTimeoutMs: 400, ...options });
  await out.until(() => out.lines.length > 0);
  const ask = async (request: Record<string, unknown>): Promise<Answer> => {
    feed.push(request);
    await out.until(() => out.answers().some((a) => a.id === request.id));
    return out.answers().find((a) => a.id === request.id)!;
  };
  return { feed, out, done, ask };
}

// --- the protocol -----------------------------------------------------------------------------------------------------------------

describe('tool host: the line protocol', () => {
  it('says ready once the servers are up, then answers a call as one line', async () => {
    const nanoclaw = fakeServer({ canvas_query: (args) => text(`assignments for ${JSON.stringify(args)}`) });
    const leanrag = fakeServer({ query_knowledge: () => text('a chunk of the course') });
    const host = await start({ nanoclaw, leanrag });
    expect(host.out.lines[0]).toBe(READY_LINE);
    expect(nanoclaw.connected).toBe(1);
    expect(leanrag.connected).toBe(1);

    const first = await host.ask({ id: '7', tool: 'canvas_query', args: { action: 'assignments' } });
    expect(first).toEqual({ id: '7', ok: true, text: 'assignments for {"action":"assignments"}' });
    expect(host.out.lines[1]).toBe(`${ANSWER_PREFIX}{"id":"7","ok":true,"text":"assignments for {\\"action\\":\\"assignments\\"}"}`);

    const second = await host.ask({ id: 8, server: 'leanrag', tool: 'query_knowledge', args: { query: 'raft' } });
    expect(second).toEqual({ id: 8, ok: true, text: 'a chunk of the course' }); // the id comes back as it was sent
    expect(leanrag.calls).toEqual([{ name: 'query_knowledge', args: { query: 'raft' } }]);
    expect(nanoclaw.calls).toHaveLength(1);

    host.feed.end();
    expect(await host.done).toBe(0);
  });

  it('answers a tool that reports an error with ok:false, the tool\'s text in text and in error', async () => {
    const nanoclaw = fakeServer({ canvas_query: () => ({ content: [{ type: 'text', text: 'Canvas not configured: CANVAS_API_TOKEN not set in .env' }], isError: true }) });
    const host = await start({ nanoclaw });
    const answer = await host.ask({ id: '1', tool: 'canvas_query', args: {} });
    expect(answer).toEqual({
      id: '1',
      ok: false,
      text: 'Canvas not configured: CANVAS_API_TOKEN not set in .env',
      error: 'Canvas not configured: CANVAS_API_TOKEN not set in .env',
    });
    host.feed.end();
    await host.done;
  });

  it('answers a call that cannot be made with ok:false and a message, never with nothing', async () => {
    const nanoclaw = fakeServer({ boom: () => Promise.reject(new Error('the server went away')) });
    const host = await start({ nanoclaw });
    expect(await host.ask({ id: 'a', tool: 'boom' })).toEqual({ id: 'a', ok: false, text: 'the server went away', error: 'the server went away' });
    expect(await host.ask({ id: 'b', tool: 'youtube_info', args: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) }); // a tool the server does not have
    expect(await host.ask({ id: 'c', server: 'nope', tool: 'x' })).toMatchObject({ ok: false, error: 'unknown server nope' });
    expect(await host.ask({ id: 'd', builtin: 'delete_everything' })).toMatchObject({ ok: false, error: 'unknown builtin delete_everything' });
    expect(await host.ask({ id: 'e' })).toMatchObject({ ok: false, error: 'a request needs a "tool" or a "builtin"' });
    expect(await host.ask({ id: 'f', tool: 'x', args: [1, 2] })).toMatchObject({ ok: false, error: 'args must be an object' });
    expect(await host.ask({ id: 'g', server: 7, tool: 'x' })).toMatchObject({ ok: false, error: 'server must be a name' });
    host.feed.end();
    await host.done;
  });

  it('ignores a line that is not a request and goes on', async () => {
    const nanoclaw = fakeServer({ echo: (args) => text(String(args.text)) });
    const host = await start({ nanoclaw });
    host.feed.push('this is not json');
    host.feed.push('{"tool":"echo"}'); // no id: nobody to answer
    host.feed.push('[1,2]');
    host.feed.push('   ');
    host.feed.push('null');
    expect(await host.ask({ id: 1, tool: 'echo', args: { text: 'still here' } })).toMatchObject({ ok: true, text: 'still here' });
    expect(host.out.answers()).toHaveLength(1);
    host.feed.end();
    await host.done;
  });

  it('handles calls at the same time: a quick call is answered while a slow one is still running', async () => {
    const nanoclaw = fakeServer({
      slow: async () => {
        await sleep(250);
        return text('slow done');
      },
      quick: () => text('quick done'),
    });
    const host = await start({ nanoclaw }, student, { callTimeoutMs: 2000 });
    host.feed.push({ id: 'slow', tool: 'slow' });
    host.feed.push({ id: 'quick', tool: 'quick' });
    await host.out.until(() => host.out.answers().length === 2);
    expect(host.out.answers().map((a) => a.id)).toEqual(['quick', 'slow']); // in the order they finished, each one whole line
    host.feed.end();
    await host.done;
  });

  it('answers "timeout" when a call takes longer than its time, and cancels it', async () => {
    let cancelled = false;
    const nanoclaw = fakeServer({
      hang: async (_args, signal) => {
        try {
          return await untilAborted(signal);
        } finally {
          cancelled = true;
        }
      },
    });
    const host = await start({ nanoclaw }, student, { callTimeoutMs: 150 });
    const started = Date.now();
    expect(await host.ask({ id: 't', tool: 'hang' })).toEqual({ id: 't', ok: false, text: 'timeout', error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1500);
    await host.out.until(() => cancelled);
    host.feed.end();
    await host.done;
  });

  it('gives a call more time when the request asks for it, up to a limit', async () => {
    const nanoclaw = fakeServer({
      wait: async (args) => {
        await sleep(Number(args.ms));
        return text('waited');
      },
    });
    const host = await start({ nanoclaw }, student, { callTimeoutMs: 100, maxCallTimeoutMs: 600 });
    expect(await host.ask({ id: 'default', tool: 'wait', args: { ms: 250 } })).toMatchObject({ ok: false, error: 'timeout' });
    expect(await host.ask({ id: 'asked', tool: 'wait', args: { ms: 250 }, timeoutMs: 500 })).toMatchObject({ ok: true, text: 'waited' });
    expect(await host.ask({ id: 'capped', tool: 'wait', args: { ms: 900 }, timeoutMs: 100_000 })).toMatchObject({ ok: false, error: 'timeout' }); // cut at 600
    host.feed.end();
    await host.done;
  });

  it('refuses calls beyond the number it will run at once', async () => {
    const nanoclaw = fakeServer({ hang: (_args, signal) => untilAborted(signal) });
    const host = await start({ nanoclaw }, student, { callTimeoutMs: 10_000, maxInFlight: 2 });
    host.feed.push({ id: 1, tool: 'hang' });
    host.feed.push({ id: 2, tool: 'hang' });
    expect(await host.ask({ id: 3, tool: 'hang' })).toMatchObject({ ok: false, error: 'too many calls in flight' });
    host.feed.end();
    await host.done;
  });

  it('writes nothing to stdout but protocol lines, each one a single line', async () => {
    const separator = String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + String.fromCharCode(0x85);
    const nanoclaw = fakeServer({
      lines: () => text(`one\ntwo\r\nthree${separator}four "quoted" \\ back`),
      fail: () => ({ content: [{ type: 'text', text: 'two\nlines' }], isError: true }),
    });
    const host = await start({ nanoclaw });
    const got = await host.ask({ id: 'l', tool: 'lines' });
    expect(got.text).toBe(`one\ntwo\r\nthree${separator}four "quoted" \\ back`); // what was sent is what is read
    await host.ask({ id: 'f', tool: 'fail' });
    await host.ask({ id: 'u', tool: 'unknown' });
    host.feed.end();
    await host.done;
    expect(host.out.lines.length).toBeGreaterThanOrEqual(4);
    for (const line of host.out.lines) {
      expect(line.startsWith('@@TOOLHOST')).toBe(true);
      expect(/[\n\r\u000b\u000c]/.test(line)).toBe(false);
      for (const code of [0x2028, 0x2029, 0x85]) expect(line.includes(String.fromCharCode(code))).toBe(false);
    }
  });

  it('cuts a very long answer', async () => {
    const nanoclaw = fakeServer({ big: () => text('x'.repeat(ANSWER_MAX_CHARS * 3)) });
    const host = await start({ nanoclaw });
    const answer = await host.ask({ id: 'big', tool: 'big' });
    expect(answer.ok).toBe(true);
    expect(answer.text.length).toBeLessThanOrEqual(ANSWER_MAX_CHARS);
    expect(answer.text).toMatch(/cut here/);
    host.feed.end();
    await host.done;
  });
});

describe('tool host: the limits of the tools that cost something, per call', () => {
  // The host keeps a tool host for the student's next call; the nanoclaw server's own counts ran on across calls (the fifth call of a
  // morning was refused "max 30 calls per session" at its first Canvas lookup). The tool host counts them, and starts again at "new-call".
  const canvas = () => fakeServer({ canvas_query: () => text('assignments'), piazza_query: () => text('posts') });

  it('refuses a tool that has used its calls, in the limit\'s own words, without reaching the server', async () => {
    const nanoclaw = canvas();
    const host = await start({ nanoclaw }, student, { limiter: new ToolLimiter({ canvas_query: 2, piazza_query: 1 }, false, 'voice call') });
    expect(await host.ask({ id: 1, tool: 'canvas_query' })).toMatchObject({ ok: true });
    expect(await host.ask({ id: 2, tool: 'canvas_query' })).toMatchObject({ ok: true });
    const third = await host.ask({ id: 3, tool: 'canvas_query' });
    expect(third).toMatchObject({ ok: false, error: 'Rate limit exceeded for canvas_query: max 2 calls per voice call.' });
    expect(nanoclaw.calls).toHaveLength(2);
    expect(await host.ask({ id: 4, tool: 'piazza_query' })).toMatchObject({ ok: true });     // each tool has its own count
    expect(await host.ask({ id: 5, tool: 'piazza_query' })).toMatchObject({ ok: false });
    host.feed.end();
    await host.done;
  });

  it('starts every count again when the host says a new call begins, and says ok to it', async () => {
    const nanoclaw = canvas();
    const host = await start({ nanoclaw }, student, { limiter: new ToolLimiter({ canvas_query: 1 }, false, 'voice call') });
    await host.ask({ id: 1, tool: 'canvas_query' });
    expect(await host.ask({ id: 2, tool: 'canvas_query' })).toMatchObject({ ok: false });
    expect(await host.ask({ id: 'n1', control: 'new-call' })).toEqual({ id: 'n1', ok: true, text: 'ok' });
    expect(await host.ask({ id: 3, tool: 'canvas_query' })).toMatchObject({ ok: true });
    expect(await host.ask({ id: 4, tool: 'canvas_query' })).toMatchObject({ ok: false });
    expect(nanoclaw.calls).toHaveLength(2);                                                // the reset let one more through, and only one
    host.feed.end();
    await host.done;
  });

  it('applies the deployment\'s numbers to a student\'s tool host by default, and none to the admin\'s', async () => {
    const student30 = await start({ nanoclaw: canvas() });
    for (let i = 1; i <= 30; i++) expect(await student30.ask({ id: i, tool: 'canvas_query' })).toMatchObject({ ok: true });
    expect(await student30.ask({ id: 31, tool: 'canvas_query' })).toMatchObject({ ok: false, error: 'Rate limit exceeded for canvas_query: max 30 calls per voice call.' });
    student30.feed.end();
    await student30.done;

    const admin = await start({ nanoclaw: canvas() }, { ...student, isMain: true });
    for (let i = 1; i <= 40; i++) expect(await admin.ask({ id: i, tool: 'canvas_query' })).toMatchObject({ ok: true });
    admin.feed.end();
    await admin.done;
  });

  it('lifts them by the same rule as the nanoclaw server (access.ts): a task flag alone, or a system flag alone, lifts nothing; both do', async () => {
    // `isScheduledTask` alone used to be enough, here and in the server: a student's agent can schedule a task
    for (const input of [{ ...student, isScheduledTask: true }, { ...student, isSystemTask: true }]) {
      const limited = await start({ nanoclaw: canvas() }, input);
      for (let i = 1; i <= 30; i++) expect(await limited.ask({ id: i, tool: 'canvas_query' })).toMatchObject({ ok: true });
      expect(await limited.ask({ id: 31, tool: 'canvas_query' })).toMatchObject({ ok: false, error: 'Rate limit exceeded for canvas_query: max 30 calls per voice call.' });
      limited.feed.end();
      await limited.done;
    }
    const system = await start({ nanoclaw: canvas() }, { ...student, isScheduledTask: true, isSystemTask: true });
    for (let i = 1; i <= 40; i++) expect(await system.ask({ id: i, tool: 'canvas_query' })).toMatchObject({ ok: true });
    system.feed.end();
    await system.done;
  });

  it('leaves the other servers alone, and a tool of nanoclaw that has no limit', async () => {
    const nanoclaw = fakeServer({ send_message: () => text('sent'), canvas_query: () => text('assignments') });
    const leanrag = fakeServer({ query_knowledge: () => text('a chunk') });
    const host = await start({ nanoclaw, leanrag }, student, { limiter: new ToolLimiter({ canvas_query: 1, query_knowledge: 1 }, false, 'voice call') });
    for (let i = 1; i <= 5; i++) {
      expect(await host.ask({ id: `m${i}`, tool: 'send_message' })).toMatchObject({ ok: true });
      expect(await host.ask({ id: `k${i}`, server: 'leanrag', tool: 'query_knowledge' })).toMatchObject({ ok: true }); // a leanrag tool by a name that is limited on nanoclaw
    }
    host.feed.end();
    await host.done;
  });

  const failing = () => ({ content: [{ type: 'text' as const, text: 'Piazza query failed: Sorry, too fast' }], isError: true });

  it('refuses a third identical failing lookup without sending it, and without using up one of the lookups the call is allowed', async () => {
    const nanoclaw = fakeServer({ piazza_query: failing, canvas_query: () => text('assignments') });
    const host = await start({ nanoclaw }, student, { limiter: new ToolLimiter({ piazza_query: 5 }, false, 'voice call') });
    const post = { action: 'get_post', params: { post_id: '882' } };
    expect(await host.ask({ id: 1, tool: 'piazza_query', args: post })).toMatchObject({ ok: false, error: 'Piazza query failed: Sorry, too fast' });
    expect(await host.ask({ id: 2, tool: 'piazza_query', args: post })).toMatchObject({ ok: false, error: 'Piazza query failed: Sorry, too fast' });
    for (let i = 3; i <= 12; i++) {
      expect(await host.ask({ id: i, tool: 'piazza_query', args: post })).toMatchObject({ ok: false });
      expect((await host.ask({ id: `again${i}`, tool: 'piazza_query', args: post })).error).toMatch(/^This exact piazza_query request has already failed 2 times/);
    }
    expect(nanoclaw.calls).toHaveLength(2);                                                // twelve asks, two of them sent
    // the refusals were not uses of the limit of 5: three more different lookups are still allowed, and the fourth is the sixth use
    for (let i = 0; i < 3; i++) expect((await host.ask({ id: `p${i}`, tool: 'piazza_query', args: { action: 'get_post', params: { post_id: String(900 + i) } } })).error).toBe('Piazza query failed: Sorry, too fast');
    expect((await host.ask({ id: 'p9', tool: 'piazza_query', args: { action: 'get_post', params: { post_id: '999' } } })).error).toMatch(/^Rate limit exceeded for piazza_query: max 5 calls per voice call/);
    host.feed.end();
    await host.done;
  });

  it('forgets what failed when a new call begins, leaves other tools and servers unguarded, and lets a lookup that works clear its failures', async () => {
    let works = false;
    const nanoclaw = fakeServer({
      piazza_query: () => (works ? text('posts') : failing()),
      send_message: () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }),
    });
    const host = await start({ nanoclaw }, student, { limiter: new ToolLimiter({}, false, 'voice call') });
    const args = { action: 'recent_posts' };
    await host.ask({ id: 1, tool: 'piazza_query', args });
    await host.ask({ id: 2, tool: 'piazza_query', args });
    expect((await host.ask({ id: 3, tool: 'piazza_query', args })).error).toMatch(/not sent again/);
    await host.ask({ id: 'n', control: 'new-call' });
    works = true;
    expect(await host.ask({ id: 4, tool: 'piazza_query', args })).toMatchObject({ ok: true, text: 'posts' });      // sent again in the new call
    works = false;
    await host.ask({ id: 5, tool: 'piazza_query', args });                                 // fails once; the success above cleared the count
    expect(await host.ask({ id: 6, tool: 'piazza_query', args })).toMatchObject({ ok: false, error: 'Piazza query failed: Sorry, too fast' });
    for (let i = 0; i < 6; i++) expect((await host.ask({ id: `s${i}`, tool: 'send_message', args: {} })).error).toBe('nope');   // not a tool that calls an outside service
    expect(nanoclaw.calls.filter((c) => c.name === 'send_message')).toHaveLength(6);
    host.feed.end();
    await host.done;
  });

  it('answers a control it does not know with an error, and goes on', async () => {
    const host = await start({ nanoclaw: canvas() });
    expect(await host.ask({ id: 'x', control: 'reboot' })).toMatchObject({ ok: false, error: 'unknown control reboot' });
    expect(await host.ask({ id: 'y', tool: 'canvas_query' })).toMatchObject({ ok: true });
    host.feed.end();
    await host.done;
  });
});

describe('tool host: starting and ending', () => {
  it('says failed, with the reason, when nanoclaw does not start, and exits 1', async () => {
    const nanoclaw = fakeServer({}, { connect: () => Promise.reject(new Error('spawn node ENOENT')) });
    const leanrag = fakeServer();
    const feed = new Feed();
    const out = stdout();
    const code = await runToolHost(student, feed, out.write, { nanoclaw, leanrag }, { workspaceRoot: root });
    expect(code).toBe(1);
    expect(out.lines).toEqual([`${FAILED_PREFIX}nanoclaw: spawn node ENOENT`]);
    expect(leanrag.closed).toBe(1); // what had started is closed again
  });

  it('says failed when nanoclaw is not there at all, or does not start in time', async () => {
    const feed = new Feed();
    const out = stdout();
    expect(await runToolHost(student, feed, out.write, { leanrag: fakeServer() }, { workspaceRoot: root })).toBe(1);
    expect(out.lines).toEqual([`${FAILED_PREFIX}nanoclaw: not configured`]);

    const slow = fakeServer({}, { connect: () => new Promise<void>(() => undefined) });
    const late = stdout();
    expect(await runToolHost(student, feed, late.write, { nanoclaw: slow }, { workspaceRoot: root, connectTimeoutMs: 80 })).toBe(1);
    expect(late.lines).toEqual([`${FAILED_PREFIX}nanoclaw: nanoclaw did not start within 0.08 s`]);
  });

  it('carries on without LeanRAG when only that server does not start, and says so to anyone who asks it', async () => {
    const nanoclaw = fakeServer({ echo: () => text('ok') });
    const leanrag = fakeServer({}, { connect: () => Promise.reject(new Error('No module named leanrag')) });
    const host = await start({ nanoclaw, leanrag });
    expect(host.out.lines[0]).toBe(READY_LINE);
    expect(await host.ask({ id: 'k', server: 'leanrag', tool: 'query_knowledge', args: {} })).toMatchObject({
      ok: false,
      error: 'server leanrag is not available: No module named leanrag',
    });
    expect(await host.ask({ id: 'e', tool: 'echo' })).toMatchObject({ ok: true });
    host.feed.end();
    await host.done;
  });

  it('closes the servers when the input ends, cancels what is running, and answers nothing more', async () => {
    let cancelled = false;
    const nanoclaw = fakeServer({
      hang: async (_args, signal) => {
        try {
          return await untilAborted(signal);
        } finally {
          cancelled = true;
        }
      },
    });
    const leanrag = fakeServer();
    const host = await start({ nanoclaw, leanrag }, student, { callTimeoutMs: 10_000 });
    host.feed.push({ id: 'running', tool: 'hang' });
    await host.out.until(() => nanoclaw.calls.length === 1);
    const started = Date.now();
    host.feed.end();
    expect(await host.done).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
    expect([nanoclaw.closed, leanrag.closed]).toEqual([1, 1]);
    await host.out.until(() => cancelled);
    expect(host.out.answers()).toEqual([]); // the host closed its end: nobody reads an answer
  });

  it('is out within its limits even when a server will not close', async () => {
    const stuck = fakeServer({}, { close: () => new Promise<void>(() => undefined) });
    const host = await start({ nanoclaw: stuck }, student, { closeTimeoutMs: 100 });
    const started = Date.now();
    host.feed.end();
    expect(await host.done).toBe(0);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('calls hardExit when closing takes longer than it may, and not otherwise', async () => {
    let exits = 0;
    const stuck = fakeServer({}, { close: () => sleep(400) });
    const feed = new Feed();
    const out = stdout();
    const done = runToolHost(student, feed, out.write, { nanoclaw: stuck }, { workspaceRoot: root, closeTimeoutMs: 2000, hardExitMs: 100, hardExit: () => void exits++ });
    await out.until(() => out.lines.length > 0);
    feed.end();
    await done;
    expect(exits).toBe(1);

    const quick = fakeServer();
    const feed2 = new Feed();
    const out2 = stdout();
    const done2 = runToolHost(student, feed2, out2.write, { nanoclaw: quick }, { workspaceRoot: root, hardExitMs: 100, hardExit: () => void exits++ });
    await out2.until(() => out2.lines.length > 0);
    feed2.end();
    await done2;
    await sleep(200);
    expect(exits).toBe(1);
  });

  it('ends when the signal fires, as it does at the end of the input', async () => {
    const nanoclaw = fakeServer();
    const stop = new AbortController();
    const host = await start({ nanoclaw }, student, { signal: stop.signal });
    stop.abort();
    expect(await host.done).toBe(0);
    expect(nanoclaw.closed).toBe(1);
  });
});

// --- credentials never leave ------------------------------------------------------------------------------------------------------

describe('tool host: no credential in an answer', () => {
  const secrets = {
    GITHUB_TOKEN: 'ghp_0123456789abcdefghij',
    CANVAS_API_TOKEN: '7~canvas-secret-value',
    PIAZZA_PASSWORD: 'correct horse battery',
    VOICE_INTERVIEW_SECRET: 'interview-signing-key',
    SHORT_TOKEN: 'abc', // too short to tell from a word
    VOICE_BASE_URL: 'https://voice.example.test', // not a credential: the interview link has it
    CANVAS_BASE_URL: 'https://canvas.example.test',
    GITHUB_ALLOWED_ORGS: 'cs6650-course',
  };
  const input: ContainerInput = { ...student, secrets };

  it('knows which values are credentials', () => {
    // by the name (a token, a password, a secret ...), at least 8 characters, the longest first so that one value cannot hide inside another
    expect(credentialValues(secrets)).toEqual(['ghp_0123456789abcdefghij', '7~canvas-secret-value', 'correct horse battery', 'interview-signing-key']);
    expect(credentialValues(undefined)).toEqual([]);
    expect(redact('a ghp_0123456789abcdefghij b ghp_0123456789abcdefghij', ['ghp_0123456789abcdefghij'])).toBe('a [redacted] b [redacted]');
  });

  it('blanks them out of results, errors and the reason of a failed start, and only them', async () => {
    const link = `${secrets.VOICE_BASE_URL}/interview/abc.def`;
    const nanoclaw = fakeServer({
      leaky: () => text(`token ${secrets.GITHUB_TOKEN}, and again ${secrets.GITHUB_TOKEN}; password ${secrets.PIAZZA_PASSWORD}`),
      leakyError: () => ({ content: [{ type: 'text', text: `request failed with Bearer ${secrets.CANVAS_API_TOKEN}` }], isError: true }),
      throws: () => Promise.reject(new Error(`could not log in with ${secrets.PIAZZA_PASSWORD}`)),
      link: () => text(`Mock interview ready\n\n${link}\n\nrepos of ${secrets.GITHUB_ALLOWED_ORGS} at ${secrets.CANVAS_BASE_URL} (${secrets.SHORT_TOKEN})`),
    });
    const host = await start({ nanoclaw }, input);
    expect((await host.ask({ id: 1, tool: 'leaky' })).text).toBe('token [redacted], and again [redacted]; password [redacted]');
    expect(await host.ask({ id: 2, tool: 'leakyError' })).toEqual({
      id: 2,
      ok: false,
      text: 'request failed with Bearer [redacted]',
      error: 'request failed with Bearer [redacted]',
    });
    expect((await host.ask({ id: 3, tool: 'throws' })).error).toBe('could not log in with [redacted]');
    const honest = await host.ask({ id: 4, tool: 'link' });
    expect(honest.text).toContain(`\n\n${link}\n\n`); // the interview link, on a line of its own, is not touched
    expect(honest.text).toContain(`${secrets.GITHUB_ALLOWED_ORGS} at ${secrets.CANVAS_BASE_URL} (${secrets.SHORT_TOKEN})`);
    host.feed.end();
    await host.done;
    for (const line of host.out.lines) for (const value of credentialValues(secrets)) expect(line.includes(value)).toBe(false);

    const refused = fakeServer({}, { connect: () => Promise.reject(new Error(`401 with token ${secrets.GITHUB_TOKEN}`)) });
    const out = stdout();
    await runToolHost(input, new Feed(), out.write, { nanoclaw: refused }, { workspaceRoot: root });
    expect(out.lines).toEqual([`${FAILED_PREFIX}nanoclaw: 401 with token [redacted]`]);
  });
});

// --- the helpers --------------------------------------------------------------------------------------------------------------------

describe('tool host: what a result says', () => {
  it('joins the text blocks, notes the others, falls back to the structured content', () => {
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
    expect(resultText({ content: [{ type: 'image' }, { type: 'text', text: 'a picture' }] })).toBe('[image content not shown]\na picture');
    expect(resultText({ content: [], structuredContent: { rows: 2 } })).toBe('{"rows":2}');
    expect(resultText({})).toBe('');
  });

  it('cuts a text to a limit, the note included', () => {
    expect(capText('short', 100)).toBe('short');
    const cut = capText('y'.repeat(500), 100);
    expect(cut.length).toBe(100);
    expect(cut).toMatch(/cut here/);
  });
});

// --- read_file ------------------------------------------------------------------------------------------------------------------------

describe('tool host: read_file', () => {
  const uploads = () => path.join(root, 'group', 'uploads');
  const put = (name: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(uploads(), name)), { recursive: true });
    fs.writeFileSync(path.join(uploads(), name), content);
    return path.join(uploads(), name);
  };

  async function reading(options: ToolHostOptions = {}) {
    const host = await start({ nanoclaw: fakeServer() }, student, options);
    const read = (p: unknown) => host.ask({ id: `r${Math.random()}`, builtin: 'read_file', args: { path: p } });
    return { host, read };
  }

  it('reads a text file by its name, by uploads/<name> and by its whole path, as it is', async () => {
    const file = put('notes.txt', 'line one\nline two\n');
    const { host, read } = await reading();
    for (const spelling of ['notes.txt', 'uploads/notes.txt', file]) {
      expect(await read(spelling), spelling).toMatchObject({ ok: true, text: 'line one\nline two\n' });
    }
    put('src/main.go', 'package main\n');
    expect(await read('src/main.go')).toMatchObject({ ok: true, text: 'package main\n' });
    put('empty.md', '');
    expect(await read('empty.md')).toMatchObject({ ok: true, text: '(empty.md is empty)' });
    host.feed.end();
    await host.done;
  });

  it('gives at most 20 000 characters, the note that it was cut included', async () => {
    put('long.txt', 'z'.repeat(READ_FILE_MAX_CHARS * 2));
    put('exactly.txt', 'q'.repeat(READ_FILE_MAX_CHARS));
    const { host, read } = await reading();
    const cut = await read('long.txt');
    expect(cut.ok).toBe(true);
    expect(cut.text.length).toBe(READ_FILE_MAX_CHARS);
    expect(cut.text).toMatch(/cut here/);
    expect((await read('exactly.txt')).text).toBe('q'.repeat(READ_FILE_MAX_CHARS)); // right at the limit: whole
    host.feed.end();
    await host.done;
  });

  it('refuses whatever is not a file the student attached', async () => {
    put('inside.txt', 'mine');
    fs.writeFileSync(path.join(root, 'group', 'secret.txt'), 'the group folder is not the uploads folder');
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
    put('.env', 'TOKEN=x');
    put('dir/inner.txt', 'x');
    const { host, read } = await reading();
    const only = /only the files the student attached/;
    expect(await read('../secret.txt')).toMatchObject({ ok: false, error: expect.stringMatching(only) });
    expect(await read('uploads/../secret.txt')).toMatchObject({ ok: false, error: expect.stringMatching(only) });
    expect(await read('../../outside.txt')).toMatchObject({ ok: false, error: expect.stringMatching(only) });
    expect(await read(path.join(root, 'outside.txt'))).toMatchObject({ ok: false, error: expect.stringMatching(only) });
    expect(await read(path.join(root, 'group', 'secret.txt'))).toMatchObject({ ok: false, error: expect.stringMatching(only) });
    expect(await read(path.join(uploads(), '..', 'secret.txt'))).toMatchObject({ ok: false, error: expect.stringMatching(only) });
    expect(await read('.')).toMatchObject({ ok: false });
    expect(await read('dir')).toMatchObject({ ok: false, error: 'dir is not a file' });
    expect(await read('.env')).toMatchObject({ ok: false, error: expect.stringMatching(/sensitive/) });
    expect(await read('missing.txt')).toMatchObject({ ok: false, error: expect.stringMatching(/no such file/) });
    expect(await read('')).toMatchObject({ ok: false, error: expect.stringMatching(/needs the path/) });
    expect(await read(undefined)).toMatchObject({ ok: false, error: expect.stringMatching(/needs the path/) });
    expect(await read('a\0b')).toMatchObject({ ok: false });
    host.feed.end();
    await host.done;
  });

  it('refuses a link that leads out of the uploads folder', async (ctx) => {
    fs.writeFileSync(path.join(root, 'group', 'private.txt'), 'not for the call');
    try {
      fs.symlinkSync(path.join(root, 'group', 'private.txt'), path.join(uploads(), 'link.txt'));
      fs.symlinkSync(path.join(root, 'group'), path.join(uploads(), 'linked-dir'), 'dir');
    } catch {
      ctx.skip(); // no permission to make links here (Windows without developer mode)
    }
    const { host, read } = await reading();
    expect(await read('link.txt')).toMatchObject({ ok: false, error: expect.stringMatching(/only the files the student attached/) });
    expect(await read('linked-dir/private.txt')).toMatchObject({ ok: false, error: expect.stringMatching(/only the files the student attached/) });
    host.feed.end();
    await host.done;
  });

  it('says so when there is no uploads folder at all', async () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toolhost-bare-')));
    try {
      const host = await start({ nanoclaw: fakeServer() }, student, { workspaceRoot: bare });
      expect(await host.ask({ id: 1, builtin: 'read_file', args: { path: 'x.txt' } })).toMatchObject({ ok: false, error: 'the student has not attached any files' });
      host.feed.end();
      await host.done;
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('does not read an image or a binary file as text', async () => {
    put('shot.PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
    put('blob.dat', Buffer.from([1, 2, 3, 0, 4, 5]));
    const { host, read } = await reading();
    expect(await read('shot.PNG')).toMatchObject({ ok: false, error: expect.stringMatching(/is an image/) });
    expect(await read('blob.dat')).toMatchObject({ ok: false, error: 'blob.dat is not a text file' });
    host.feed.end();
    await host.done;
  });

  it('reads a PDF through the venv\'s python, with the file as an argument and not in the script', async () => {
    const file = put('slides.pdf', '%PDF-1.7 not really');
    const runs: Array<{ file: string; args: string[] }> = [];
    const exec: ExecFile = async (command, args) => {
      runs.push({ file: command, args });
      return { stdout: '[page 1]\nRaft elects a leader.\n\n[page 2]\nLogs are replicated.', stderr: '' };
    };
    const { host, read } = await reading({ exec });
    expect(await read('slides.pdf')).toEqual(expect.objectContaining({ ok: true, text: '[page 1]\nRaft elects a leader.\n\n[page 2]\nLogs are replicated.' }));
    expect(runs).toHaveLength(1);
    expect(runs[0].file).toBe('/opt/leanrag/bin/python3');
    expect(runs[0].args[0]).toBe('-c');
    expect(runs[0].args[1]).toMatch(/pymupdf/);
    expect(runs[0].args[1]).not.toContain(path.basename(file)); // the path is data, not code
    expect(runs[0].args.slice(2)).toEqual([file, String(READ_FILE_MAX_CHARS)]);
    host.feed.end();
    await host.done;
  });

  it('reads an Office file through convert_office.py', async () => {
    const file = put('hw3.docx', 'PK not really');
    put('plan.xlsx', 'PK');
    put('talk.pptx', 'PK');
    const runs: Array<{ file: string; args: string[] }> = [];
    const exec: ExecFile = async (command, args) => {
      runs.push({ file: command, args });
      return { stdout: 'x'.repeat(READ_FILE_MAX_CHARS + 500), stderr: '' };
    };
    const { host, read } = await reading({ exec });
    const answer = await read('hw3.docx');
    expect(answer.ok).toBe(true);
    expect(answer.text.length).toBe(READ_FILE_MAX_CHARS);
    await read('plan.xlsx');
    await read('talk.pptx');
    expect(runs[0]).toEqual({ file: '/opt/leanrag/bin/python3', args: ['/opt/scripts/convert_office.py', file] });
    expect(runs.map((r) => path.extname(r.args[1]))).toEqual(['.docx', '.xlsx', '.pptx']);
    host.feed.end();
    await host.done;
  });

  it('says what went wrong when the conversion fails or finds nothing', async () => {
    put('broken.pdf', '%PDF');
    put('scan.pdf', '%PDF');
    put('bad.docx', 'PK');
    const exec: ExecFile = async (_command, args) => {
      if (String(args[args.length - 2]).endsWith('scan.pdf') || String(args[1]).endsWith('scan.pdf')) return { stdout: '  \n', stderr: '' };
      throw Object.assign(new Error('Command failed'), { stderr: 'Traceback (most recent call last):\n  File "<string>", line 7\nModuleNotFoundError: No module named \'fitz\'\n' });
    };
    const { host, read } = await reading({ exec });
    expect(await read('broken.pdf')).toMatchObject({ ok: false, error: expect.stringMatching(/could not read broken\.pdf: .*No module named 'fitz'/) });
    expect(await read('scan.pdf')).toMatchObject({ ok: false, error: 'no text found in scan.pdf (a scan, or only pictures?)' });
    expect(await read('bad.docx')).toMatchObject({ ok: false, error: expect.stringMatching(/could not read bad\.docx/) });
    host.feed.end();
    await host.done;
  });
});

// --- web_fetch ----------------------------------------------------------------------------------------------------------------------

describe('tool host: web_fetch', () => {
  const page = (body: string, type = 'text/html; charset=utf-8') => () => new Response(body, { status: 200, headers: { 'content-type': type } });
  /** A fetch that serves a table of URLs and records what was asked for. */
  function fakeFetch(table: Record<string, () => Response>) {
    const asked: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      const make = table[url];
      if (!make) throw new Error(`unexpected fetch of ${url}`);
      return make();
    }) as typeof fetch;
    return { impl, asked };
  }

  it('fetches a public page and answers as pi\'s web_fetch does: address, status and type, then the text', async () => {
    const f = fakeFetch({ 'http://93.184.216.34/docs': page('<h1>Raft</h1><p>leader election</p>') });
    const host = await start({ nanoclaw: fakeServer() }, student, { fetchImpl: f.impl });
    expect(await host.ask({ id: 1, builtin: 'web_fetch', args: { url: 'http://93.184.216.34/docs' } })).toEqual({
      id: 1,
      ok: true,
      text: 'http://93.184.216.34/docs (200, text/html)\n\nRaft\nleader election',
    });
    host.feed.end();
    await host.done;
  });

  it('passes max_chars on', async () => {
    const f = fakeFetch({ 'http://93.184.216.34/long': page('w'.repeat(5000), 'text/plain') });
    const host = await start({ nanoclaw: fakeServer() }, student, { fetchImpl: f.impl });
    const answer = await host.ask({ id: 1, builtin: 'web_fetch', args: { url: 'http://93.184.216.34/long', max_chars: 300 } });
    expect(answer.ok).toBe(true);
    expect(answer.text).toMatch(/4700 more characters not shown/);
    host.feed.end();
    await host.done;
  });

  it('stays out of the container\'s own network, whatever the address looks like, a redirect included', async () => {
    const f = fakeFetch({ 'http://93.184.216.34/go': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8099/' } }) });
    const host = await start({ nanoclaw: fakeServer() }, student, { fetchImpl: f.impl });
    for (const url of ['http://127.0.0.1:8099/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.1.2.3/x', 'http://2130706433/', 'http://tai-litellm:4000/', 'file:///workspace/group/.env', 'not a url']) {
      expect(await host.ask({ id: url, builtin: 'web_fetch', args: { url } }), url).toMatchObject({ ok: false, error: expect.stringMatching(/internal|private|only http|not a valid URL/) });
    }
    expect(await host.ask({ id: 'redirect', builtin: 'web_fetch', args: { url: 'http://93.184.216.34/go' } })).toMatchObject({ ok: false, error: expect.stringMatching(/internal\/private/) });
    expect(f.asked).toEqual(['http://93.184.216.34/go']); // nothing else was ever requested
    host.feed.end();
    await host.done;
  });

  it('needs a url', async () => {
    const host = await start({ nanoclaw: fakeServer() });
    expect(await host.ask({ id: 1, builtin: 'web_fetch', args: {} })).toMatchObject({ ok: false, error: 'web_fetch needs a url' });
    expect(await host.ask({ id: 2, builtin: 'web_fetch' })).toMatchObject({ ok: false, error: 'web_fetch needs a url' });
    host.feed.end();
    await host.done;
  });

  it('allows 15 fetches in the life of the tool host, as pi\'s guard does per answer', async () => {
    const f = fakeFetch({ 'http://93.184.216.34/': page('ok') });
    const host = await start({ nanoclaw: fakeServer() }, student, { fetchImpl: f.impl });
    for (let i = 1; i <= 15; i++) expect((await host.ask({ id: i, builtin: 'web_fetch', args: { url: 'http://93.184.216.34/' } })).ok, `call ${i}`).toBe(true);
    expect(await host.ask({ id: 16, builtin: 'web_fetch', args: { url: 'http://93.184.216.34/' } })).toMatchObject({ ok: false, error: expect.stringMatching(/rate limit/) });
    host.feed.end();
    await host.done;
  });

  it('lets the admin\'s container fetch from its own network, as pi does', async () => {
    const f = fakeFetch({ 'http://127.0.0.1:8099/': page('local', 'text/plain') });
    const host = await start({ nanoclaw: fakeServer() }, { ...student, isMain: true }, { fetchImpl: f.impl });
    expect(await host.ask({ id: 1, builtin: 'web_fetch', args: { url: 'http://127.0.0.1:8099/' } })).toMatchObject({ ok: true, text: expect.stringContaining('local') });
    host.feed.end();
    await host.done;
  });
});

// --- with the real MCP SDK and a real server process ----------------------------------------------------------------------------------

// Where the MCP SDK is installed (the container's node_modules; the repository's root install has none) the tool host is run against a
// real MCP server in a child process: the stub next to this file.
const sdk = await (async () => {
  try {
    const load = (name: string) => import(/* @vite-ignore */ name);
    await Promise.all([load('@modelcontextprotocol/sdk/client/index.js'), load('@modelcontextprotocol/sdk/client/stdio.js'), load('zod')]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!sdk)('tool host: against a real MCP server over stdio', { timeout: 30_000 }, () => {
  const stub = fileURLToPath(new URL('./stub-mcp-server.mjs', import.meta.url));
  const groupDir = () => path.join(root, 'group');
  const real = (env: Record<string, string> = {}) => new McpToolServer('nanoclaw', { command: process.execPath, args: [stub], env }, groupDir());

  it('answers calls, reports a failing tool, an unknown tool and a slow one', async () => {
    const host = await start({ nanoclaw: real() }, student, { callTimeoutMs: 1500, connectTimeoutMs: 15_000 });
    expect(host.out.lines[0]).toBe(READY_LINE);
    expect(await host.ask({ id: 'e', tool: 'echo', args: { text: 'hello' } })).toEqual({ id: 'e', ok: true, text: 'echo: hello' });
    const failed = await host.ask({ id: 'f', tool: 'fail', args: { reason: 'because' } });
    expect(failed).toEqual({ id: 'f', ok: false, text: 'failed on purpose: because', error: 'failed on purpose: because' });
    expect(await host.ask({ id: 'u', tool: 'youtube_info', args: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/youtube_info/) });
    expect(await host.ask({ id: 'bad', tool: 'echo', args: { text: 5 } })).toMatchObject({ ok: false }); // the server's own schema check
    expect(await host.ask({ id: 'p', tool: 'picture' })).toMatchObject({ ok: true, text: '[image content not shown]\na picture' });
    expect(await host.ask({ id: 'late', tool: 'slow', args: { ms: 3000 }, timeoutMs: 200 })).toEqual({ id: 'late', ok: false, text: 'timeout', error: 'timeout' });
    host.feed.end();
    expect(await host.done).toBe(0);
    expect(host.out.lines.every((l) => l.startsWith('@@TOOLHOST'))).toBe(true);
  });

  it('answers calls at the same time', async () => {
    const host = await start({ nanoclaw: real() }, student, { callTimeoutMs: 5000, connectTimeoutMs: 15_000 });
    host.feed.push({ id: 'slow', tool: 'slow', args: { ms: 400, text: 'late' } });
    host.feed.push({ id: 'quick', tool: 'echo', args: { text: 'early' } });
    await host.out.until(() => host.out.answers().length === 2);
    expect(host.out.answers().map((a) => a.id)).toEqual(['quick', 'slow']);
    host.feed.end();
    await host.done;
  });

  it('starts the server with the container\'s environment and its own settings over it, in the group folder', async () => {
    process.env['TOOLHOST_PROBE'] = 'from the container';
    process.env['TOOLHOST_BOTH'] = 'container';
    try {
      const host = await start({ nanoclaw: real({ TOOLHOST_BOTH: 'server', NANOCLAW_GITHUB_USERNAME: 'ann-eval' }) }, student, { connectTimeoutMs: 15_000 });
      expect(await host.ask({ id: 1, tool: 'env', args: { name: 'TOOLHOST_PROBE' } })).toMatchObject({ text: 'from the container' });
      expect(await host.ask({ id: 2, tool: 'env', args: { name: 'TOOLHOST_BOTH' } })).toMatchObject({ text: 'server' });
      expect(await host.ask({ id: 3, tool: 'env', args: { name: 'NANOCLAW_GITHUB_USERNAME' } })).toMatchObject({ text: 'ann-eval' });
      expect(fs.realpathSync((await host.ask({ id: 4, tool: 'cwd' })).text)).toBe(groupDir());
      host.feed.end();
      await host.done;
    } finally {
      delete process.env['TOOLHOST_PROBE'];
      delete process.env['TOOLHOST_BOTH'];
    }
  });

  it('starts the server as buildMcpServers describes it: the identity binding, and only the credentials that server is given', async () => {
    const input: ContainerInput = { ...student, secrets: { GITHUB_TOKEN: 'ghp_0123456789abcdefghij', TAI_LLM_API_KEY: 'sk-the-models-key-0123' } };
    const specs = buildMcpServers(stub, input, envWithSecrets(input, process.env));
    const host = await start({ nanoclaw: new McpToolServer('nanoclaw', specs.nanoclaw, groupDir()) }, input, { connectTimeoutMs: 15_000 });
    const value = async (name: string) => (await host.ask({ id: name, tool: 'env', args: { name } })).text;
    expect(await value('NANOCLAW_GITHUB_USERNAME')).toBe('ann-eval');
    expect(await value('NANOCLAW_CANVAS_USER_ID')).toBe('42');
    expect(await value('NANOCLAW_GROUP_FOLDER')).toBe('ann');
    expect(await value('NANOCLAW_IS_MAIN')).toBe('0');
    expect(await value('GITHUB_TOKEN')).toBe('[redacted]'); // the server has it (as the agent's server does), and what it says is blanked
    expect(await value('TAI_LLM_API_KEY')).toBe('(unset)'); // the model's key is not the tools' business
    host.feed.end();
    await host.done;
  });

  it('blanks out a credential the server prints', async () => {
    const input: ContainerInput = { ...student, secrets: { CANVAS_API_TOKEN: '7~very-secret-canvas-token' } };
    const host = await start({ nanoclaw: real() }, input, { connectTimeoutMs: 15_000 });
    const answer = await host.ask({ id: 1, tool: 'echo', args: { text: 'the token is 7~very-secret-canvas-token, really' } });
    expect(answer.text).toBe('echo: the token is [redacted], really');
    host.feed.end();
    await host.done;
  });

  it('closes the server process when the input ends, well inside 5 s', async () => {
    const host = await start({ nanoclaw: real() }, student, { connectTimeoutMs: 15_000 });
    const pid = Number((await host.ask({ id: 'pid', tool: 'pid' })).text);
    expect(pid).toBeGreaterThan(0);
    const started = Date.now();
    host.feed.end();
    expect(await host.done).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    const gone = async () => {
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          return true;
        }
        await sleep(50);
      }
      return false;
    };
    expect(await gone()).toBe(true);
  });

  it('says failed when the server cannot be started', async () => {
    const broken = new McpToolServer('nanoclaw', { command: process.execPath, args: [path.join(root, 'no-such-server.mjs')], env: {} });
    const out = stdout();
    const code = await runToolHost(student, new Feed(), out.write, { nanoclaw: broken }, { workspaceRoot: root, connectTimeoutMs: 15_000 });
    expect(code).toBe(1);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].startsWith(`${FAILED_PREFIX}nanoclaw: `)).toBe(true);
    expect(out.lines[0]).toMatch(/Cannot find module/); // what the server said as it died is in the reason
  });
});
