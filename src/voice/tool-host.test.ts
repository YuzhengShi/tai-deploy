import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DockerToolHost, TOOL_HOST_READY_TIMEOUT_MS, scrubOutput, toolHostReadyTimeoutMs } from './tool-host.js';
import type { VoiceLog } from './types.js';

/** A child process whose stdio the test drives: what the host writes is read from `written`, the container's lines are pushed. */
function fakeChild() {
  const proc = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (s?: string) => boolean; killed: string[] };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = [];
  proc.kill = (s?: string) => {
    proc.killed.push(s || 'SIGTERM');
    setImmediate(() => proc.emit('exit', null));
    return true;
  };
  const written: Array<Record<string, unknown>> = [];
  let partial = '';
  proc.stdin.on('data', (chunk: Buffer) => {
    partial += chunk.toString();
    let nl: number;
    while ((nl = partial.indexOf('\n')) !== -1) {
      written.push(JSON.parse(partial.slice(0, nl)));
      partial = partial.slice(nl + 1);
    }
  });
  proc.stdin.on('finish', () => setImmediate(() => proc.emit('exit', 0)));
  return { proc, written, say: (line: string) => proc.stdout.write(line + '\n') };
}

function hostWith(child: ReturnType<typeof fakeChild>, removed: string[] = [], opts: { readyTimeoutMs?: number; callTimeoutMs?: number } = {}) {
  return new DockerToolHost({
    spawn: async () => ({ process: child.proc as unknown as ChildProcess, containerName: 'tailive-voice-s_x-1' }),
    remove: async (name) => {
      removed.push(name);
    },
    exitWaitMs: 200,
    ...opts,
  });
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('the docker tool host', () => {
  it('waits for ready, sends one JSON line per call and matches answers by id, in any order', async () => {
    const child = fakeChild();
    const removed: string[] = [];
    const th = hostWith(child, removed);
    const starting = th.start();
    await flush();
    child.say('npm notice something unrelated');
    child.say('@@TOOLHOST ready@@');
    await starting;
    expect(th.alive).toBe(true);
    const a = th.call('canvas_query', { action: 'upcoming', params: {} });
    const b = th.call('query_knowledge', { question: 'raft' }, { server: 'leanrag' });
    const c = th.builtin('web_fetch', { url: 'https://example.com' });
    await flush();
    expect(child.written).toEqual([
      { id: '1', server: 'nanoclaw', tool: 'canvas_query', args: { action: 'upcoming', params: {} } },
      { id: '2', server: 'leanrag', tool: 'query_knowledge', args: { question: 'raft' } },
      { id: '3', builtin: 'web_fetch', args: { url: 'https://example.com' } },
    ]);
    child.say('@@TOOLHOST@@ {"id":"3","ok":true,"text":"page"}');
    child.say('@@TOOLHOST@@ {"id":"1","ok":false,"error":"Canvas not configured","text":"Canvas not configured"}');
    child.say('@@TOOLHOST@@ not json');
    child.say('@@TOOLHOST@@ {"id":"2","ok":true,"text":"Raft is..."}');
    expect(await a).toEqual({ ok: false, text: 'Canvas not configured' });
    expect(await b).toEqual({ ok: true, text: 'Raft is...' });
    expect(await c).toEqual({ ok: true, text: 'page' });
    await th.close();
    expect(removed).toEqual(['tailive-voice-s_x-1']);
    expect(th.alive).toBe(false);
    expect(await th.call('canvas_query', {})).toEqual({ ok: false, text: 'the tool host is not running' });
  });

  it('asks the container for a longer call when told, and waits a little longer itself', async () => {
    const child = fakeChild();
    const th = hostWith(child);
    const starting = th.start();
    await flush();
    child.say('@@TOOLHOST ready@@');
    await starting;
    void th.call('start_mock_interview', { assignment_id: '7' }, { timeoutMs: 115_000 });
    void th.call('x', {}, { timeoutMs: 999_999 });
    await flush();
    expect(child.written[0]).toEqual({ id: '1', server: 'nanoclaw', tool: 'start_mock_interview', args: { assignment_id: '7' }, timeoutMs: 115_000 });
    expect(child.written[1].timeoutMs).toBe(120_000);
    await th.close();
  });

  it('times a call out, and fails the pending calls when the container dies', async () => {
    const child = fakeChild();
    const th = hostWith(child, [], { callTimeoutMs: 100 });
    const starting = th.start();
    await flush();
    child.say('@@TOOLHOST ready@@');
    await starting;
    expect(await th.call('slow', {})).toEqual({ ok: false, text: 'timeout' });
    const pending = th.call('other', {});
    await flush();
    child.proc.emit('exit', 137);
    expect(await pending).toEqual({ ok: false, text: 'the tool host stopped' });
    expect(th.alive).toBe(false);
  });

  it('rejects start on a failed line, an early exit, or no ready in time', async () => {
    const failing = fakeChild();
    const removed: string[] = [];
    const t1 = hostWith(failing, removed);
    const s1 = t1.start();
    await flush();
    failing.say('@@TOOLHOST failed@@ nanoclaw did not start');
    await expect(s1).rejects.toThrow(/nanoclaw did not start/);

    const dying = fakeChild();
    const t2 = hostWith(dying);
    const s2 = t2.start();
    await flush();
    dying.proc.emit('exit', 1);
    await expect(s2).rejects.toThrow(/exited/);

    const silent = fakeChild();
    const t3 = hostWith(silent, removed, { readyTimeoutMs: 50 });
    await expect(t3.start()).rejects.toThrow(/not ready in time/);
    await flush();
    expect(removed.length).toBeGreaterThanOrEqual(1);
  });

  it('tears down a container whose call ended while it was still being started', async () => {
    const child = fakeChild();
    const removed: string[] = [];
    let stdinEnded = false;
    child.proc.stdin.on('finish', () => (stdinEnded = true));
    const th = new DockerToolHost({
      spawn: () => new Promise((resolve) => setTimeout(() => resolve({ process: child.proc as unknown as ChildProcess, containerName: 'tailive-voice-s_x-2' }), 50)),
      remove: async (name) => {
        removed.push(name);
      },
      exitWaitMs: 200,
    });
    const starting = th.start();
    await new Promise((r) => setTimeout(r, 10));
    await th.close(); // the spawn is still under way
    await expect(starting).rejects.toThrow(/closed/);
    expect(stdinEnded).toBe(true);
    expect(removed).toEqual(['tailive-voice-s_x-2']);
    await th.close();
    expect(removed).toEqual(['tailive-voice-s_x-2']); // once
  });

  it('a spawn that fails is a rejected start, not a crash', async () => {
    const th = new DockerToolHost({ spawn: async () => Promise.reject(new Error('docker: not found')), remove: async () => undefined });
    await expect(th.start()).rejects.toThrow(/docker: not found/);
    expect(th.alive).toBe(false);
  });

  it('refreshes the files the container reads when the host is kept for another call, and a refresh that fails is only logged', async () => {
    const child = fakeChild();
    let refreshed = 0;
    let fail = false;
    const warnings: string[] = [];
    const th = new DockerToolHost({
      spawn: async () => ({
        process: child.proc as unknown as ChildProcess,
        containerName: 'tailive-voice-s_x-3',
        refresh: () => {
          refreshed++;
          if (fail) throw new Error('disk full');
        },
      }),
      remove: async () => undefined,
      exitWaitMs: 200,
      log: { debug: () => undefined, info: () => undefined, warn: (_o, m) => void warnings.push(String(m)), error: () => undefined },
    });
    th.refresh(); // before the container exists there is nothing to refresh
    expect(refreshed).toBe(0);
    const starting = th.start();
    await flush();
    child.say('@@TOOLHOST ready@@');
    await starting;
    th.refresh();
    expect(refreshed).toBe(1);
    fail = true;
    th.refresh();
    expect(refreshed).toBe(2);
    expect(warnings.some((w) => w.includes('could not be refreshed'))).toBe(true);
    await th.close();
  });

  it('tells the container that a new call begins when a kept host is refreshed, so the per-call tool limits start again, and its answer disturbs nothing', async () => {
    const child = fakeChild();
    const th = hostWith(child);
    th.refresh(); // no container yet: nothing is written
    expect(child.written).toEqual([]);
    const starting = th.start();
    await flush();
    child.say('@@TOOLHOST ready@@');
    await starting;
    expect(child.written).toEqual([]); // a host that has just been started is a new call already: no line for it

    th.refresh();
    await flush();
    expect(child.written).toEqual([{ id: 'new-call-1', control: 'new-call' }]);
    child.say('@@TOOLHOST@@ {"id":"new-call-1","ok":true,"text":"ok"}'); // nobody waits for it: it is ignored
    await flush();

    const call = th.call('canvas_query', { action: 'upcoming', params: {} });
    await flush();
    const asked = child.written[1];
    expect(asked).toMatchObject({ tool: 'canvas_query' });
    child.say(`@@TOOLHOST@@ {"id":"${asked.id}","ok":true,"text":"fine"}`);
    expect(await call).toEqual({ ok: true, text: 'fine' });
    expect(asked.id).not.toBe('new-call-1'); // the ids of the two kinds of line do not collide

    th.refresh();
    await flush();
    expect(child.written.at(-1)).toMatchObject({ control: 'new-call' });
    await th.close();
    th.refresh(); // closed: nothing is written, nothing throws
  });
});

/** A log that keeps what it is told, by level. */
function recorder() {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> = [];
  const log: VoiceLog = {
    debug: () => undefined,
    info: (obj, msg) => void lines.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => void lines.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => void lines.push({ level: 'error', obj, msg }),
  };
  return { lines, log };
}

describe('the docker tool host: how long a start gets, and what it says when it does not work out', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // setImmediate stays real: the fake child's streams and its exit use it
  const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const settleStreams = async () => {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(0);
  };
  const hostOf = (child: ReturnType<typeof fakeChild>, name: string, removed: string[], opts: { readyTimeoutMs?: number; log?: VoiceLog } = {}) =>
    new DockerToolHost({
      spawn: async () => ({ process: child.proc as unknown as ChildProcess, containerName: name }),
      remove: async (n) => void removed.push(n),
      exitWaitMs: 200,
      ...opts,
    });

  it('gives a container the time its own start and its wait for its servers take: ready at 35 s is a ready host (30 s used to close it)', async () => {
    fakeClock();
    const child = fakeChild();
    const removed: string[] = [];
    const { lines, log } = recorder();
    const th = hostOf(child, 'tailive-voice-s_x-1', removed, { log });
    let outcome = 'pending';
    const starting = th.start().then(
      () => (outcome = 'ready'),
      (err: Error) => (outcome = `failed: ${err.message}`),
    );
    await settleStreams();
    await vi.advanceTimersByTimeAsync(35_000); // 8 s of docker start, the 20 s a server stalled, the 3.5 s to close it, and the rest
    expect(outcome).toBe('pending');
    expect(removed).toEqual([]);
    child.say('@@TOOLHOST ready@@');
    await settleStreams();
    await starting;
    expect(outcome).toBe('ready');
    expect(th.alive).toBe(true);
    expect(removed).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    // one line for how long the container took from the start (the call's own line cannot say it for a host started ahead of the call)
    const ready = lines.find((l) => l.msg === 'voice tool host: container ready');
    expect(ready?.obj).toMatchObject({ container: 'tailive-voice-s_x-1', ms: 35_000 });
  });

  it('gives up at the budget (60 s by default), closes the container, and says what it had printed: the server that stalled', async () => {
    fakeClock();
    expect(TOOL_HOST_READY_TIMEOUT_MS).toBe(60_000);
    const child = fakeChild();
    const removed: string[] = [];
    const th = hostOf(child, 'tailive-voice-s_x-2', removed);
    let outcome = 'pending';
    const starting = th.start().then(
      () => (outcome = 'ready'),
      (err: Error) => (outcome = err.message),
    );
    await settleStreams();
    child.proc.stderr.write('[agent-runner] Tool host for group: s_x\n[agent-runner] LeanRAG registered: /workspace/leanrag/graph.pkl\n');
    child.proc.stderr.write('[mcp-stdio] GITHUB_TOKEN: set, key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD\n');
    await settleStreams();
    await vi.advanceTimersByTimeAsync(59_900);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(200);
    await starting;
    expect(outcome).toMatch(/^the tool host was not ready in time \(60 s\)/);
    expect(outcome).toContain('Tool host for group: s_x');
    expect(outcome).toContain('LeanRAG registered');
    expect(outcome).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD'); // nothing that looks like a credential reaches a log line
    expect(outcome).toContain('<redacted>');
    await vi.advanceTimersByTimeAsync(300);
    expect(removed).toEqual(['tailive-voice-s_x-2']);
    expect(th.alive).toBe(false);
  });

  it('says so when the container printed nothing at all, and when it exits before it is ready', async () => {
    fakeClock();
    const silent = fakeChild();
    const t1 = hostOf(silent, 'tailive-voice-s_x-3', [], { readyTimeoutMs: 15_000 });
    let silentOutcome = '';
    const s1 = t1.start().catch((err: Error) => void (silentOutcome = err.message));
    await settleStreams();
    await vi.advanceTimersByTimeAsync(15_001);
    await s1;
    expect(silentOutcome).toMatch(/not ready in time \(15 s\) \(the container printed nothing\)/);

    const dying = fakeChild();
    const t2 = hostOf(dying, 'tailive-voice-s_x-4', []);
    let dyingOutcome = '';
    const s2 = t2.start().catch((err: Error) => void (dyingOutcome = err.message));
    await settleStreams();
    dying.proc.stderr.write('Error: Cannot find module /app/dist/tool-host.js\n');
    await settleStreams();
    dying.proc.emit('exit', 1);
    await s2;
    expect(dyingOutcome).toMatch(/exited \(1\) before it was ready/);
    expect(dyingOutcome).toContain('Cannot find module');
  });

  it('warns when the container says ready but one of its servers did not come up (it waited 20 s for it and went on without): the call has no course knowledge, and nothing else says so', async () => {
    fakeClock();
    const child = fakeChild();
    const { lines, log } = recorder();
    const th = hostOf(child, 'tailive-voice-s_x-5', [], { log });
    const starting = th.start();
    await settleStreams();
    await vi.advanceTimersByTimeAsync(26_000);
    // the container printed its reason before its ready line; stdout and stderr are two pipes, so the ready line may come first
    child.say('@@TOOLHOST ready@@');
    await settleStreams();
    child.proc.stderr.write('[agent-runner] MCP server leanrag did not start: leanrag did not start within 20 s\n[agent-runner] Tool host ready: nanoclaw\n');
    await settleStreams();
    await starting;
    expect(th.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    const warned = lines.filter((l) => l.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0].msg).toBe('voice tool host: ready, but a server of its did not start');
    expect(warned[0].obj).toMatchObject({ container: 'tailive-voice-s_x-5', ms: 26_000 });
    expect(String((warned[0].obj.output as string[])[0])).toContain('MCP server leanrag did not start');
    expect(lines.some((l) => l.msg === 'voice tool host: container ready')).toBe(false);
  });

  it('keeps what the container printed while it started, and nothing it prints for its calls once ready has been looked at (that is what the student asked)', async () => {
    fakeClock();
    const child = fakeChild();
    const th = hostOf(child, 'tailive-voice-s_x-6', []);
    const starting = th.start();
    await settleStreams();
    child.proc.stderr.write('[agent-runner] Tool host for group: s_x\n');
    child.say('@@TOOLHOST ready@@');
    await settleStreams();
    await starting;
    await vi.advanceTimersByTimeAsync(400);
    child.proc.stderr.write("query_knowledge: question='how does raft elect a leader' difficulty=auto\n");
    await settleStreams();
    const kept = (th as unknown as { recent: string[] }).recent;
    expect(kept).toEqual(['[agent-runner] Tool host for group: s_x']);
  });

  it('reads TAI_VOICE_TOOLHOST_READY_SEC: 10 to 300 s, anything else is the default', () => {
    expect(toolHostReadyTimeoutMs({})).toBe(60_000);
    expect(toolHostReadyTimeoutMs({ TAI_VOICE_TOOLHOST_READY_SEC: '' })).toBe(60_000);
    expect(toolHostReadyTimeoutMs({ TAI_VOICE_TOOLHOST_READY_SEC: '90' })).toBe(90_000);
    expect(toolHostReadyTimeoutMs({ TAI_VOICE_TOOLHOST_READY_SEC: '10' })).toBe(10_000);
    expect(toolHostReadyTimeoutMs({ TAI_VOICE_TOOLHOST_READY_SEC: '300' })).toBe(300_000);
    for (const bad of ['9', '301', '0', '-5', 'abc', 'NaN', 'Infinity']) expect(toolHostReadyTimeoutMs({ TAI_VOICE_TOOLHOST_READY_SEC: bad })).toBe(60_000);
  });

  it('blanks what looks like a credential and cuts a line short, whatever a container printed', () => {
    expect(scrubOutput('  Authorization: Bearer abcdefghijklmnopqrstuvwxyzABCDEF0123456789  ')).toBe('Authorization: Bearer <redacted>');
    expect(scrubOutput('MCP server leanrag did not start: leanrag did not start within 20 s')).toBe('MCP server leanrag did not start: leanrag did not start within 20 s');
    expect(scrubOutput('x '.repeat(300)).length).toBeLessThanOrEqual(200);
    expect(scrubOutput('a\n  b\t c')).toBe('a b c');
  });
});
