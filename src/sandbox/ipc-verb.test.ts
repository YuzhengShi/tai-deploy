import { afterEach, describe, expect, it, vi } from 'vitest';

import { SANDBOX_ALREADY_GOING, SANDBOX_ANSWER_CHARS, SANDBOX_FAILED, SANDBOX_NOT_REGISTERED, SANDBOX_NO_ANSWER, SANDBOX_WATCHDOG_MS, _resetSandboxRuns, sandboxRunsInFlight, startSandboxRun, withoutFileNames } from './ipc-verb.js';
import type { SandboxVerbEnv, SandboxVerbInput } from './ipc-verb.js';
import { cleanObject } from '../chat-objects/clean.js';
import { SANDBOX_LIMITS, SANDBOX_OFF, frameSandboxResult, parseSandboxRequest } from './types.js';
import type { SandboxRequest, SandboxResult } from './types.js';

// The host's side of `run_go` without a database: the order of the checks, the binding, one run in flight for a folder, exactly one answer for a request, and what is logged.
// (src/ipc-sandbox.test.ts has the same verb through processTaskIpc, the real answer files and the other groups.)

const ran = (over: Partial<SandboxResult> = {}): SandboxResult => ({ ok: true, exitCode: 0, timedOut: false, outputTruncated: false, output: 'hello\n', durationMs: 120.4, ...over });
/** A runner that answers at once and remembers what it was asked (typed so that `mock.calls[0][0]` is the student). */
const fakeRun = () => vi.fn(async (_who: { folder: string; githubUsername?: string }, _request: SandboxRequest) => ran());
const body = { action: 'run', files: [{ path: 'main.go', content: 'package main\nfunc main() {}\n' }] };

function harness(over: Partial<SandboxVerbEnv> = {}) {
  const said: Array<{ id: string; ok: boolean; message: string }> = [];
  const audits: Array<{ operation: string; fields: Record<string, unknown> }> = [];
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const env: SandboxVerbEnv = {
    runSandbox: async () => ran(),
    say: (id, ok, message) => void said.push({ id, ok, message }),
    audit: (operation, fields) => void audits.push({ operation, fields }),
    log,
    ...over,
  };
  return { env, said, audits, log };
}
const input = (over: Partial<SandboxVerbInput> = {}): SandboxVerbInput => ({ folder: 'ada', isMain: false, requestId: 'req-00000001', request: body, group: { githubUsername: 'ada-gh' }, ...over });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: (r: SandboxResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<SandboxResult>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  _resetSandboxRuns();
  vi.useRealTimers();
});

describe('what is run, for whom', () => {
  it('runs the validated request for the folder of the IPC directory and answers with the framed result', async () => {
    const run = fakeRun();
    const h = harness({ runSandbox: run });
    startSandboxRun(input(), h.env);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual([{ folder: 'ada', githubUsername: 'ada-gh' }, parseSandboxRequest(body).ok ? (parseSandboxRequest(body) as { value: SandboxRequest }).value : null]);
    expect(h.said).toHaveLength(1);
    expect(h.said[0]).toMatchObject({ id: 'req-00000001', ok: true });
    expect(JSON.parse(h.said[0].message)).toMatchObject({ status: 'ran, exit code 0', command: 'go run .', exit_code: 0 });
  });

  it('takes the account from the registered group and never from the request: whatever the file adds, the runner is given the folder and that account', async () => {
    const run = fakeRun();
    const h = harness({ runSandbox: run });
    startSandboxRun(input({ request: { ...body, githubUsername: 'someone-else', folder: 'bob', who: { folder: 'bob' }, owner: 'bob-gh', github: 'bob-gh', env: { A: 'b' } } }), h.env);
    await flush();
    const [who, request] = run.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(who).toEqual({ folder: 'ada', githubUsername: 'ada-gh' });
    expect(Object.keys(request).sort()).toEqual(['action', 'args', 'pkg', 'race', 'source']);
    // a group the host has no account for: the runner is told nothing about one
    const none = fakeRun();
    startSandboxRun(input({ folder: 'cy', requestId: 'req-00000002', group: {} }), harness({ runSandbox: none }).env);
    await flush();
    expect(none.mock.calls[0][0]).toStrictEqual({ folder: 'cy' });
  });

  it('says how it ended: a run that did not happen is a refusal (ok false) with the sentence, a run that failed is a result', async () => {
    const busy = harness({ runSandbox: async () => ran({ ok: false, exitCode: null, output: '', phase: 'busy', message: 'The sandbox is busy.' }) });
    startSandboxRun(input(), busy.env);
    await flush();
    expect(busy.said[0].ok).toBe(false);
    expect(JSON.parse(busy.said[0].message)).toEqual({ status: 'not run', command: 'go run .', message: 'The sandbox is busy.' });
    const failed = harness({ runSandbox: async () => ran({ exitCode: 2, output: 'panic: boom\n' }) });
    startSandboxRun(input({ folder: 'bob', requestId: 'req-00000003' }), failed.env);
    await flush();
    expect(failed.said[0].ok).toBe(true);
    expect(JSON.parse(failed.said[0].message).status).toBe('ran, exit code 2');
  });
});

describe('every refusal is one sentence and no run', () => {
  it('drops a request with no usable id without a run and without an answer (nobody could be told, and a run is one of the student\'s)', async () => {
    const run = fakeRun();
    const h = harness({ runSandbox: run });
    startSandboxRun(input({ requestId: null }), h.env);
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(h.said).toEqual([]);
    expect(h.log.warn).toHaveBeenCalled();
    expect(sandboxRunsInFlight()).toBe(0);
  });

  it('says the sandbox is off when there is no runner, and a chat that is not registered has no student to run for (the admin chat needs no registration)', async () => {
    const off = harness({ runSandbox: undefined });
    startSandboxRun(input(), off.env);
    expect(off.said).toEqual([{ id: 'req-00000001', ok: false, message: SANDBOX_OFF }]);
    const run = fakeRun();
    const unregistered = harness({ runSandbox: run });
    startSandboxRun(input({ group: undefined }), unregistered.env);
    expect(unregistered.said).toEqual([{ id: 'req-00000001', ok: false, message: SANDBOX_NOT_REGISTERED }]);
    expect(run).not.toHaveBeenCalled();
    startSandboxRun(input({ folder: 'main', isMain: true, group: undefined, requestId: 'req-00000009' }), unregistered.env);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toStrictEqual({ folder: 'main' });
  });

  it('refuses what parseSandboxRequest refuses, with its sentence, runs nothing, audits the reason, and does not hold the folder', async () => {
    const run = fakeRun();
    const h = harness({ runSandbox: run });
    const bad: unknown[] = [null, 'run', { action: 'fmt', files: body.files }, { action: 'run' }, { action: 'run', files: body.files, repo: 'r' }, { action: 'run', files: [{ path: '../x.go', content: 'x' }] }, { action: 'run', files: body.files, race: true }];
    bad.forEach((request, i) => startSandboxRun(input({ request, requestId: `req-0000010${i}` }), h.env));
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(h.said).toHaveLength(bad.length);
    for (const s of h.said) {
      expect(s.ok).toBe(false);
      expect(s.message).toMatch(/^Not run: /);
    }
    expect(h.audits.map((a) => a.operation)).toEqual(bad.map(() => 'sandbox_run_refused'));
    expect(sandboxRunsInFlight()).toBe(0);
    startSandboxRun(input({ requestId: 'req-00000200' }), h.env);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('checks in the order of what they cost: off before a registration, a run going before the request is read', async () => {
    const hold = deferred();
    const h = harness({ runSandbox: () => hold.promise });
    startSandboxRun(input(), h.env);
    startSandboxRun(input({ requestId: 'req-00000002', request: { action: 'nonsense' } }), h.env);
    expect(h.said).toEqual([{ id: 'req-00000002', ok: false, message: SANDBOX_ALREADY_GOING }]);
    hold.resolve(ran());
    await flush();
    const off = harness({ runSandbox: undefined });
    startSandboxRun(input({ group: undefined, request: null }), off.env);
    expect(off.said[0].message).toBe(SANDBOX_OFF);
  });
});

describe('one run in flight for a folder', () => {
  it('answers a second request for the same folder at once with a sentence of its own, runs it never, and lets another folder run meanwhile', async () => {
    const first = deferred();
    const run = vi.fn((who: { folder: string }) => (who.folder === 'ada' ? first.promise : Promise.resolve(ran())));
    const h = harness({ runSandbox: run });
    startSandboxRun(input(), h.env);
    await flush();
    startSandboxRun(input({ requestId: 'req-00000002' }), h.env);
    startSandboxRun(input({ requestId: 'req-00000003' }), h.env);
    expect(h.said).toEqual([
      { id: 'req-00000002', ok: false, message: SANDBOX_ALREADY_GOING },
      { id: 'req-00000003', ok: false, message: SANDBOX_ALREADY_GOING },
    ]);
    expect(SANDBOX_ALREADY_GOING).not.toBe(SANDBOX_OFF);
    expect(SANDBOX_ALREADY_GOING).toMatch(/still going/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sandboxRunsInFlight()).toBe(1);
    // the refusals did not free the folder: it is still held, and another student is not
    startSandboxRun(input({ folder: 'bob', requestId: 'req-00000004', group: { githubUsername: 'bob-gh' } }), h.env);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(h.said.at(-1)).toMatchObject({ id: 'req-00000004', ok: true });
    expect(sandboxRunsInFlight()).toBe(1);
    // the first one ends: its answer, and the folder is free again
    first.resolve(ran());
    await flush();
    expect(h.said.at(-1)).toMatchObject({ id: 'req-00000001', ok: true });
    expect(sandboxRunsInFlight()).toBe(0);
    startSandboxRun(input({ requestId: 'req-00000005' }), h.env);
    await flush();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('frees the folder before it writes the answer: a container that asks again the moment it is answered is not told a run is going', async () => {
    const run = fakeRun();
    const nested: Array<{ id: string; message: string }> = [];
    const h = harness({ runSandbox: run });
    const say = h.env.say;
    h.env.say = (id, ok, message) => {
      say(id, ok, message);
      if (id === 'req-00000001') startSandboxRun(input({ requestId: 'req-00000002' }), { ...h.env, say: (nid, _ok, m) => void nested.push({ id: nid, message: m }) });
    };
    startSandboxRun(input(), h.env);
    await flush();
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(nested.map((n) => n.message)).not.toContain(SANDBOX_ALREADY_GOING);
  });

  it('frees the folder when the runner throws, rejects or answers nonsense, so that one bad run does not lock a student out', async () => {
    const throwers: Array<(() => Promise<SandboxResult>) | (() => never)> = [
      () => {
        throw new Error('docker is gone');
      },
      () => Promise.reject(new Error('docker is gone')),
      () => Promise.resolve(undefined as unknown as SandboxResult),
    ];
    for (const [i, runner] of throwers.entries()) {
      const h = harness({ runSandbox: runner as never });
      startSandboxRun(input({ requestId: `req-0000030${i}` }), h.env);
      await flush();
      expect(h.said, String(i)).toEqual([{ id: `req-0000030${i}`, ok: false, message: SANDBOX_FAILED }]);
      expect(sandboxRunsInFlight()).toBe(0);
    }
  });
});

describe('exactly one answer for a request', () => {
  it('answers for a runner that never does, after the watchdog; its late result is ignored, and the folder was free from the watchdog on', async () => {
    vi.useFakeTimers();
    const hold = deferred();
    const run = vi.fn(() => hold.promise);
    const h = harness({ runSandbox: run });
    startSandboxRun(input(), h.env);
    await vi.advanceTimersByTimeAsync(SANDBOX_WATCHDOG_MS - 1);
    expect(h.said).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.said).toEqual([{ id: 'req-00000001', ok: false, message: SANDBOX_NO_ANSWER }]);
    expect(sandboxRunsInFlight()).toBe(0);
    hold.resolve(ran());
    await vi.advanceTimersByTimeAsync(10);
    expect(h.said).toHaveLength(1);
    startSandboxRun(input({ requestId: 'req-00000002' }), h.env);
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);
    expect(SANDBOX_WATCHDOG_MS).toBeGreaterThan(SANDBOX_LIMITS.requestWaitMs);
  });

  it('does not answer a second time when the watchdog comes after the result', async () => {
    vi.useFakeTimers();
    const h = harness();
    startSandboxRun(input(), h.env);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.said).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SANDBOX_WATCHDOG_MS * 2);
    expect(h.said).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is not undone by an answer that cannot be written or a log that fails: nothing rejects, the folder is free', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = harness({
        say: () => {
          throw new Error('disk full');
        },
        audit: () => {
          throw new Error('audit disk full');
        },
      });
      startSandboxRun(input(), h.env);
      await flush();
      await flush();
      expect(sandboxRunsInFlight()).toBe(0);
      expect(h.log.warn).toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('the answer\'s size and what is logged', () => {
  it('keeps the framed answer of the worst output inside the cap the host writes and the container reads, and parseable', async () => {
    const request = (parseSandboxRequest(body) as { value: SandboxRequest }).value;
    for (const output of ['"'.repeat(200_000), '\n'.repeat(200_000), '\\'.repeat(200_000), 'é\t"\\\n'.repeat(40_000)]) {
      const framed = frameSandboxResult(ran({ output, exitCode: 1, timedOut: true, outputTruncated: true }), request);
      expect(framed.length).toBeLessThan(SANDBOX_ANSWER_CHARS / 2);
      expect(() => JSON.parse(framed)).not.toThrow();
    }
    const h = harness({ runSandbox: async () => ran({ output: '"x"\n'.repeat(30_000) }) });
    startSandboxRun(input(), h.env);
    await flush();
    expect(h.said[0].message.length).toBeGreaterThan(600);
    expect(h.said[0].message.length).toBeLessThanOrEqual(SANDBOX_ANSWER_CHARS);
    const framed = JSON.parse(h.said[0].message) as { output: string };
    expect(framed.output.split('PROGRAM OUTPUT ').length - 1).toBe(2);   // the opening and the closing marker
  });

  it('logs the kind of run and how it ended, never the code, a name, the output or the request', async () => {
    const h = harness({ runSandbox: async () => ran({ output: 'SECRET-OUTPUT-MARKER\n' }) });
    startSandboxRun(input({ request: { action: 'test', repo: { name: 'secret-repo-name', path: 'secret/folder' } }, requestId: 'req-00000001' }), h.env);
    startSandboxRun(input({ folder: 'bob', requestId: 'req-00000002', group: { githubUsername: 'bob-gh' }, request: { action: 'run', files: [{ path: 'secret_file.go', content: 'SECRET-CODE-MARKER' }] } }), h.env);
    startSandboxRun(input({ folder: 'cy', requestId: 'req-00000003', group: {}, request: { action: 'run', files: [{ path: 'bad name.go', content: 'SECRET-CODE-MARKER' }] } }), h.env);
    await flush();
    const everything = JSON.stringify([h.audits, h.log.info.mock.calls, h.log.warn.mock.calls, h.log.debug.mock.calls]);
    for (const secret of ['SECRET-CODE-MARKER', 'SECRET-OUTPUT-MARKER', 'secret-repo-name', 'secret/folder', 'secret_file']) expect(everything).not.toContain(secret);
    expect(h.audits.find((a) => a.fields.sourceGroup === 'ada')).toEqual({
      operation: 'sandbox_run',
      fields: { sourceGroup: 'ada', isMain: false, action: 'test', source: 'repo', ok: true, card: false, exitCode: 0, timedOut: false, durationMs: 120 },
    });
    expect(h.audits.find((a) => a.fields.sourceGroup === 'bob')?.fields).toMatchObject({ action: 'run', source: 'files', files: 1 });
  });

  it('does not log the name of a file either, when the gate\'s sentence for a refusal names it: the container is told the whole sentence, the audit log and the process log are not', async () => {
    const NUL = String.fromCharCode(0);
    const refusals: Array<[string, unknown]> = [
      ['given twice, in two cases', { action: 'run', files: [{ path: 'secret_file.go', content: 'x' }, { path: 'SECRET_FILE.go', content: 'y' }] }],
      ['a control character', { action: 'run', files: [{ path: 'secret_file.go', content: `a${NUL}b` }] }],
      ['no text', { action: 'run', files: [{ path: 'secret_file.go' }] }],
      ['too big', { action: 'run', files: [{ path: 'secret_file.go', content: 'x'.repeat(SANDBOX_LIMITS.maxFileBytes + 1) }] }],
    ];
    const h = harness();
    refusals.forEach(([, request], i) => startSandboxRun(input({ request, requestId: `req-0000040${i}` }), h.env));
    await flush();
    expect(h.audits).toHaveLength(refusals.length);
    for (const a of h.audits) expect(a.operation).toBe('sandbox_run_refused');
    for (const said of h.said) expect(said.message.toLowerCase(), said.message).toContain('secret_file');   // the student's own sentence names it
    const logged = JSON.stringify([h.audits, h.log.info.mock.calls, h.log.warn.mock.calls, h.log.debug.mock.calls]).toLowerCase();
    expect(logged).not.toContain('secret_file');
    expect(h.audits.map((a) => a.fields.reason)).toEqual(['Not run: a file is given twice.', 'Not run: a file has control characters in it.', 'Not run: a file has no text content.', 'Not run: a file is over 128 KB.']);
    expect(withoutFileNames('Not run: the files together are over 256 KB; use `repo` for a bigger project.')).toBe('Not run: the files together are over 256 KB; use `repo` for a bigger project.');
  });
});

describe('the run card (docs/RUN_CARDS.md)', () => {
  it('leaves a card in the chat of the folder, before the answer: the student reads the output before they read what TAi says of it', async () => {
    const events: string[] = [];
    const posted: Array<{ folder: string; obj: unknown }> = [];
    const h = harness({
      runSandbox: async () => ran({ output: 'ok  hw2 0.01s\n', exitCode: 0 }),
      postObject: (folder, obj) => {
        events.push('card');
        posted.push({ folder, obj });
      },
      say: (_id, ok, message) => void events.push(`say:${ok}:${(JSON.parse(message) as { status: string }).status}`),
    });
    startSandboxRun(input({ request: { action: 'test', repo: { name: 'hw2' }, race: true } }), h.env);
    await flush();
    expect(events).toEqual(['card', 'say:true:ran, exit code 0']);
    expect(posted).toHaveLength(1);
    expect(posted[0].folder).toBe('ada');
    expect(posted[0].obj).toMatchObject({ t: 'run', command: 'go test -race ./...', ok: true, exitCode: 0, timedOut: false, output: 'ok  hw2 0.01s', truncated: false });
    expect(cleanObject(posted[0].obj)).toEqual(posted[0].obj);
  });

  it('tells the model the student sees the output only when a card was really left', async () => {
    const left = harness({ postObject: () => undefined });
    startSandboxRun(input(), left.env);
    await flush();
    expect(JSON.parse(left.said[0].message).note).toMatch(/already sees this output in the chat, as a card/);
    // no way to post (the host has not wired it), or a posting that throws: the words that were there before cards
    const none = harness();
    const broke = harness({
      postObject: () => {
        throw new Error('the history is closed');
      },
    });
    startSandboxRun(input(), none.env);
    startSandboxRun(input({ folder: 'bob', requestId: 'req-00000002', group: {} }), broke.env);
    await flush();
    for (const h of [none, broke]) {
      expect(h.said).toHaveLength(1);
      expect(h.said[0].ok).toBe(true);
      expect(JSON.parse(h.said[0].message).note).not.toMatch(/card/);
    }
    expect(broke.log.warn.mock.calls.some((c) => c[1] === 'sandbox_run: the run card could not be left')).toBe(true);
    expect(JSON.stringify(broke.log.warn.mock.calls)).toContain('the history is closed');
  });

  it('never changes what the container is answered with, and never keeps the folder: the answer is the framed result whether or not the card could be left', async () => {
    const plain = harness({ runSandbox: async () => ran({ exitCode: 1, output: 'FAIL' }) });
    const thrower = harness({
      runSandbox: async () => ran({ exitCode: 1, output: 'FAIL' }),
      postObject: () => {
        throw new Error('boom');
      },
    });
    startSandboxRun(input(), plain.env);
    startSandboxRun(input({ folder: 'bob', requestId: 'req-00000002', group: {} }), thrower.env);
    await flush();
    const a = JSON.parse(plain.said[0].message);
    const b = JSON.parse(thrower.said[0].message);
    expect(thrower.said[0].ok).toBe(plain.said[0].ok);
    expect({ ...b, output: undefined }).toEqual({ ...a, output: undefined });
    expect(sandboxRunsInFlight()).toBe(0);
    // and a second run for the same folder is not told one is going
    startSandboxRun(input({ requestId: 'req-00000003' }), plain.env);
    await flush();
    expect(plain.said[1].message).not.toBe(SANDBOX_ALREADY_GOING);
  });

  it('leaves nothing for a run that did not happen: a busy sandbox, a refusal, a runner that throws, a chat that is not registered', async () => {
    const posted = vi.fn();
    const busy = harness({ postObject: posted, runSandbox: async () => ran({ ok: false, exitCode: null, output: '', phase: 'busy', message: 'The sandbox is busy.' }) });
    const thrown = harness({
      postObject: posted,
      runSandbox: async () => {
        throw new Error('docker is gone');
      },
    });
    startSandboxRun(input(), busy.env);
    startSandboxRun(input({ folder: 'bob', requestId: 'req-00000002', group: {} }), thrown.env);
    startSandboxRun(input({ folder: 'cy', requestId: 'req-00000003', request: { action: 'run', files: [{ path: 'bad name.go', content: 'x' }] } }), harness({ postObject: posted }).env);
    startSandboxRun(input({ folder: 'dee', requestId: 'req-00000004', group: undefined }), harness({ postObject: posted }).env);
    await flush();
    expect(posted).not.toHaveBeenCalled();
    expect(JSON.parse(busy.said[0].message).note).toBeUndefined();
  });

  it('leaves no card for a result that arrives after the watchdog has answered: the model was told the run may or may not have happened', async () => {
    vi.useFakeTimers();
    const slow = deferred();
    const posted = vi.fn();
    const h = harness({ runSandbox: () => slow.promise, postObject: posted, watchdogMs: 1000 });
    startSandboxRun(input(), h.env);
    await vi.advanceTimersByTimeAsync(1001);
    expect(h.said).toHaveLength(1);
    expect(h.said[0].message).toBe(SANDBOX_NO_ANSWER);
    slow.resolve(ran());
    await vi.advanceTimersByTimeAsync(10);
    expect(posted).not.toHaveBeenCalled();
    expect(h.said).toHaveLength(1);
  });

  it("shows the student what the program printed, up to the card's own cap, where the model is given a shorter cut", async () => {
    const output = Array.from({ length: 700 }, (_, i) => `line ${i} of what the program printed`).join('\n');
    expect(output.length).toBeGreaterThan(20_000);
    const posted: Array<Record<string, unknown>> = [];
    const h = harness({ runSandbox: async () => ran({ output, outputTruncated: false }), postObject: (_f, obj) => void posted.push(obj as Record<string, unknown>) });
    startSandboxRun(input(), h.env);
    await flush();
    const card = posted[0] as { output: string; truncated: boolean };
    const framed = JSON.parse(h.said[0].message) as { output: string };
    expect(card.output.length).toBeGreaterThan(10_000);
    expect(card.output.length).toBeLessThanOrEqual(16_000);
    expect(card.truncated).toBe(true);
    expect(card.output).toContain('line 0 of what the program printed');
    expect(framed.output.length).toBeLessThan(card.output.length);
  });

  it('says in the audit line that a card was left, and still never logs the output', async () => {
    const h = harness({ runSandbox: async () => ran({ output: 'SECRET-OUTPUT-MARKER\n' }), postObject: () => undefined });
    startSandboxRun(input(), h.env);
    await flush();
    expect(h.audits[0].fields).toMatchObject({ ok: true, card: true });
    expect(JSON.stringify([h.audits, h.log.info.mock.calls, h.log.warn.mock.calls])).not.toContain('SECRET-OUTPUT-MARKER');
  });
});
