import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RESULT_WAIT_MS, awaitIpcResult, newRequestId } from '../src/ipc-result.js';

// The task tools write a request and then wait for what the host decided (src/ipc.ts answer() writes results/<id>.json). The wait is tested with a clock and a way of
// waiting of its own, so that no test sleeps.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-result-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const answerFile = (id: string, body: unknown, where = dir) => fs.writeFileSync(path.join(where, `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body));

/** A clock that moves only when the wait sleeps; `onSleep(n)` runs at the nth sleep (the host answering while the tool waits). */
function clock(onSleep: (n: number) => void = () => undefined) {
  let at = 1_000_000;
  let sleeps = 0;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      sleeps++;
      at += ms;
      onSleep(sleeps);
    },
    sleeps: () => sleeps,
  };
}

describe('newRequestId', () => {
  it('is a plain id that the host accepts as the name of a file, and a different one each time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe('awaitIpcResult', () => {
  it('returns the host\'s answer when it is already there, and takes the file away', async () => {
    answerFile('req-00000001', { ok: true, message: 'Scheduled (task-1): once 2026-11-06T09:00:00', taskId: 'task-1' });
    const c = clock();
    expect(await awaitIpcResult(dir, 'req-00000001', { now: c.now, sleep: c.sleep })).toEqual({ ok: true, message: 'Scheduled (task-1): once 2026-11-06T09:00:00', taskId: 'task-1' });
    expect(fs.existsSync(path.join(dir, 'req-00000001.json'))).toBe(false);
    expect(c.sleeps()).toBe(0);
  });

  it('returns a refusal as a refusal, with the host\'s own sentence', async () => {
    answerFile('req-00000002', { ok: false, message: 'Not scheduled: a repeating reminder may not run more often than once an hour.' });
    const answer = await awaitIpcResult(dir, 'req-00000002', { now: clock().now, sleep: clock().sleep });
    expect(answer).toEqual({ ok: false, message: 'Not scheduled: a repeating reminder may not run more often than once an hour.' });
  });

  it('waits for an answer that comes while it waits, and stops waiting once it has it', async () => {
    const c = clock((n) => {
      if (n === 3) answerFile('req-00000003', { ok: true, message: 'Task task-9 paused.' });
    });
    expect(await awaitIpcResult(dir, 'req-00000003', { now: c.now, sleep: c.sleep, pollMs: 150 })).toEqual({ ok: true, message: 'Task task-9 paused.' });
    expect(c.sleeps()).toBe(3);
  });

  it('says nothing came (null) when the time is up: ten seconds by default, and what the caller then tells is that it is not confirmed', async () => {
    expect(RESULT_WAIT_MS).toBe(10_000);
    const c = clock();
    expect(await awaitIpcResult(dir, 'req-00000004', { now: c.now, sleep: c.sleep, timeoutMs: 1000, pollMs: 250 })).toBeNull();
    expect(c.sleeps()).toBe(4);
    const d = clock();
    expect(await awaitIpcResult(dir, 'req-00000005', { now: d.now, sleep: d.sleep })).toBeNull();
    expect(d.sleeps() * 150).toBeGreaterThanOrEqual(RESULT_WAIT_MS);
  });

  it('does not wait at all where there is no results directory: a host from before the answers existed never makes one', async () => {
    const c = clock();
    expect(await awaitIpcResult(path.join(dir, 'no-such-dir'), 'req-00000006', { now: c.now, sleep: c.sleep })).toBeNull();
    expect(c.sleeps()).toBe(0);
  });

  it('takes the name of a file for no name but a plain id: a path is never read', async () => {
    const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}`);
    fs.mkdirSync(outside);
    try {
      answerFile('secret', { ok: true, message: 'from outside' }, outside);
      const c = clock();
      for (const id of [`../outside-${path.basename(dir)}/secret`, '..', '', 'short', 'a/b-0000000', 'x'.repeat(65), 'req 0000001', 'req-0000000\u0000']) {
        expect(await awaitIpcResult(dir, id, { now: c.now, sleep: c.sleep }), JSON.stringify(id)).toBeNull();
      }
      expect(c.sleeps()).toBe(0);
      expect(fs.existsSync(path.join(outside, 'secret.json'))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads an answer that cannot be read as a refusal that says so, never as a success', async () => {
    const bad: Array<[string, unknown]> = [
      ['req-00000010', '{not json'],
      ['req-00000011', { ok: 'yes', message: 'Scheduled' }],
      ['req-00000012', { ok: true }],
      ['req-00000013', []],
      ['req-00000014', 'null'],
    ];
    for (const [id, body] of bad) {
      answerFile(id, body);
      const answer = await awaitIpcResult(dir, id, { now: clock().now, sleep: clock().sleep });
      expect(answer, id).toMatchObject({ ok: false, message: expect.stringMatching(/could not read its answer/) });
      expect(fs.existsSync(path.join(dir, `${id}.json`)), id).toBe(false);
    }
  });

  it('cuts a long message to 600 characters and keeps the task id only when it is text', async () => {
    answerFile('req-00000020', { ok: true, message: 'x'.repeat(5000), taskId: 7 });
    const answer = await awaitIpcResult(dir, 'req-00000020', { now: clock().now, sleep: clock().sleep });
    expect(answer?.message).toHaveLength(600);
    expect(answer).not.toHaveProperty('taskId');
  });

  it('leaves other requests\' answers alone, and drops the ones nobody collected for an hour', async () => {
    answerFile('req-00000030', { ok: true, message: 'another request, just now' });
    answerFile('req-00000031', { ok: true, message: 'a request nobody collected' });
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(dir, 'req-00000031.json'), old, old);
    answerFile('req-00000032', { ok: true, message: 'mine' });
    expect(await awaitIpcResult(dir, 'req-00000032', { now: Date.now, sleep: async () => undefined })).toMatchObject({ ok: true, message: 'mine' });
    expect(fs.existsSync(path.join(dir, 'req-00000030.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'req-00000031.json'))).toBe(false);
  });

  it('does not fail on something that is there under the name but is not a file: it is no answer', async () => {
    fs.mkdirSync(path.join(dir, 'req-00000040.json'));
    const c = clock();
    expect(await awaitIpcResult(dir, 'req-00000040', { now: c.now, sleep: c.sleep, timeoutMs: 500 })).toBeNull();
  });
});
