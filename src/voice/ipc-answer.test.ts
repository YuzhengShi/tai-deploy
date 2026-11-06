import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newRequestId, readIpcAnswer, waitForIpcAnswer } from './ipc-answer.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-ipc-answer-'));
  fs.mkdirSync(path.join(dir, 'results'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const put = (id: string, body: unknown): string => {
  const file = path.join(dir, 'results', `${id}.json`);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
};
const ID = 'abcdefgh-123456';

describe('newRequestId', () => {
  it('is a name the host accepts, and a new one every time', () => {
    const a = newRequestId(1_793_000_000_000);
    const b = newRequestId(1_793_000_000_000);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(a).not.toBe(b);
  });
});

describe('readIpcAnswer', () => {
  it('reads the host\'s answer and removes the file', () => {
    const file = put(ID, { ok: false, message: 'Not scheduled: too often.', taskId: 'x' });
    expect(readIpcAnswer(dir, ID)).toEqual({ ok: false, message: 'Not scheduled: too often.' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('is null while there is no answer, and for a name that is not a request id', () => {
    expect(readIpcAnswer(dir, ID)).toBeNull();
    put('..-evil-name', { ok: true, message: 'x' });
    expect(readIpcAnswer(dir, '../results/x')).toBeNull();
    expect(readIpcAnswer(dir, 'short')).toBeNull();
  });

  it('takes only a small plain file that says {ok: boolean, message: string}', () => {
    put(ID, '{not json');
    expect(readIpcAnswer(dir, ID)).toBeNull();
    put(ID, { ok: 'yes', message: 'x' });
    expect(readIpcAnswer(dir, ID)).toBeNull();
    put(ID, { ok: true });
    expect(readIpcAnswer(dir, ID)).toBeNull();
    put(ID, { ok: true, message: 'x'.repeat(5000) });
    expect(readIpcAnswer(dir, ID)).toBeNull();
  });

  it('does not follow a link, and says only a line of plain text', () => {
    const target = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ ok: true, message: 'from a link' }));
    try {
      fs.symlinkSync(target, path.join(dir, 'results', `${ID}.json`));
      expect(readIpcAnswer(dir, ID)).toBeNull();
    } catch {
      /* this PC may not allow a link: the check is the lstat above */
    }
    fs.rmSync(path.join(dir, 'results', `${ID}.json`), { force: true });
    put(ID, { ok: true, message: 'line one\nline\u0007 two ' + 'y'.repeat(400) });
    const got = readIpcAnswer(dir, ID)!;
    expect(got.message.includes('\n')).toBe(false);
    expect(got.message.length).toBeLessThanOrEqual(300);
  });
});

describe('waitForIpcAnswer', () => {
  it('returns the answer as soon as it appears', async () => {
    let now = 0;
    let sleeps = 0;
    const got = await waitForIpcAnswer(dir, ID, 6000, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        if (++sleeps === 3) put(ID, { ok: true, message: 'done' });
      },
    });
    expect(got).toEqual({ ok: true, message: 'done' });
    expect(sleeps).toBe(3);
  });

  it('gives up with null when the time is used up', async () => {
    let now = 0;
    const got = await waitForIpcAnswer(dir, ID, 1000, { now: () => now, sleep: async (ms) => { now += ms; }, pollMs: 250 });
    expect(got).toBeNull();
    expect(now).toBeGreaterThanOrEqual(1000);
  });
});
