/**
 * The pace a student chose in Settings (their preferences file, `voiceSpeed`) is the pace of their call: in the Settings message, and in the
 * UpdateSpeak of every mode switch. Without a usable value it is the deployment's TAI_VOICE_SPEED, as before.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { prefsFile } from './speed.js';
import { BrowserClient, Harness, createHarness } from './testing/harness.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import type { Caller } from './types.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function chooses(harness: Harness, user: Caller, prefs: string): void {
  fs.mkdirSync(path.join(harness.storeDir, 'portal'), { recursive: true });
  fs.writeFileSync(prefsFile(harness.storeDir, user.folder), prefs);
}

async function startCall(harness: Harness, user: Caller): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection }> {
  const browser = await harness.browser(user);
  browser.send({ type: 'start', mode: 'chat' });
  const conn = await harness.dg.connection(harness.dg.connections.length + 1);
  await browser.next('ready');
  return { browser, conn };
}

const speakOf = (conn: FakeDeepgramConnection): any => (conn.ofType('Settings')[0] as any).agent.speak.provider;

describe('the pace of a call', () => {
  it('is the pace the student chose, in the Settings and in the voice the interviewer switches to', async () => {
    h = await createHarness({
      toolHandlers: {
        canvas_query: () => ({ ok: true, text: JSON.stringify([{ id: 3527597, name: 'HW3 Concurrency', due_at: '2026-11-04T17:00:00Z' }]) }),
        start_mock_interview: () => ({ ok: true, text: 'Mock interview ready for Ana — HW3 Concurrency' }),
      },
    });
    const u = h.user(1);
    chooses(h, u, JSON.stringify({ voiceSpeed: 1.35, theme: 'dark' }));
    const { conn } = await startCall(h, u);
    expect(speakOf(conn)).toEqual({ type: 'deepgram', version: 'v2', model: 'flux-hannah-en', speed: 1.35 });
    conn.userSays('homework three, the concurrency one');
    conn.callFunction('fc-iv', 'start_interview', { topic: 'HW3 concurrency' });
    const update: any = await conn.waitFor('UpdateSpeak');
    // the interviewer's voice (Aura, no `version`) takes the student's 1.35 times its pace factor 0.9 (settings.ts PACE_OF), in steps of 0.05
    expect(update.speak.provider).toEqual({ type: 'deepgram', model: 'aura-2-mars-en', speed: 1.2 });
  });

  it('is the deployment\'s (1.2) for a student who has chosen nothing, and for a file that is broken or says something unusable', async () => {
    h = await createHarness({ env: { TAI_VOICE_MAX_CONCURRENT: '10' } }); // five calls at once, one for each file
    const none = h.user(1);
    expect(speakOf((await startCall(h, none)).conn).speed).toBe(1.2);

    for (const [n, prefs] of [[2, '{"voiceSpeed": '], [3, '{"voiceSpeed": 3}'], [4, '{"voiceSpeed": "fast"}'], [5, '[]']] as const) {
      const u = h.user(n);
      chooses(h, u, prefs);
      expect(speakOf((await startCall(h, u)).conn).speed, prefs).toBe(1.2);
    }
  });

  it('is the voice\'s own pace (nothing sent) for a student who chose 1.0, though the deployment speaks faster', async () => {
    h = await createHarness();
    const u = h.user(1);
    chooses(h, u, '{"voiceSpeed": 1.0}');
    const speak = speakOf((await startCall(h, u)).conn);
    expect(speak).toEqual({ type: 'deepgram', version: 'v2', model: 'flux-hannah-en' });
  });

  it('is one student\'s: another student\'s file does not change the pace of a call of someone else', async () => {
    h = await createHarness();
    const slow = h.user(1);
    const other = h.user(2);
    chooses(h, slow, '{"voiceSpeed": 0.8}');
    expect(speakOf((await startCall(h, other)).conn).speed).toBe(1.2);
    expect(speakOf((await startCall(h, slow)).conn).speed).toBe(0.8);
  });

  it('takes the file when the call starts: a change in Settings counts from the next call', async () => {
    h = await createHarness();
    const u = h.user(1);
    chooses(h, u, '{"voiceSpeed": 1.1}');
    const first = await startCall(h, u);
    expect(speakOf(first.conn).speed).toBe(1.1);
    first.browser.send({ type: 'end' });
    await first.browser.next('closed');
    await until(() => h!.logs.some((l) => l.msg === 'voice call ended'));
    chooses(h, u, '{"voiceSpeed": 1.4}');
    expect(speakOf((await startCall(h, u)).conn).speed).toBe(1.4);
  });
});

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};
