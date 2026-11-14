/**
 * The lab's REAL ears and mouth classes (V1Ears, LabGPUMouth, the tempo stretch), through the whole hub, against loopback fakes of LabGPU's adapters: what the owner's call would do, minus the
 * network. And the one thing no double can show: where a lab call connects (S2), and that the Deepgram key reaches none of it (S3).
 */
import net from 'net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { streamed } from '../testing/fake-gateway.js';
import { BrowserClient, TEST_KEY } from '../testing/harness.js';
import { DEFAULT_AURA_URL, DEFAULT_LABGPU_ASR, DEFAULT_LABGPU_TTS, DEFAULT_FLUX_URL, DEFAULT_NOVA_URL } from './config.js';
import { FakeAsr } from './testing/fake-asr.js';
import { FakeTts } from './testing/fake-tts.js';
import { createLabHarness, type LabHarness } from './testing/lab-harness.js';

let lab: LabHarness | null = null;
let asr: FakeAsr | null = null;
let tts: FakeTts | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await lab?.close();
  await asr?.close();
  await tts?.close();
  lab = null;
  asr = null;
  tts = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
};

async function speak(b: BrowserClient, ms: number, amp: number): Promise<void> {
  const frames = Math.round(ms / 40);
  const start = performance.now();
  for (let f = 0; f < frames; f++) {
    const buf = Buffer.alloc(1280);
    for (let i = 0; i < 640; i++) buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * (f * 640 + i)) / 16000)), i * 2);
    b.sendAudio(buf);
    const wait = start + (f + 1) * 40 - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

describe('the real parts through the hub (against loopback fakes)', () => {
  it('a lab call: the page\'s 40 ms frames reach the recognizer as 20 ms ones, the answer is spoken in LabGPU\'s voice stretched to the live pace, and every address it connects to is loopback', async () => {
    asr = await FakeAsr.start();
    tts = await FakeTts.start();
    const targets: string[] = [];
    const original = net.Socket.prototype.connect;
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: unknown[]) {
      const first = args[0] as { host?: string; port?: number; path?: string } | number | string;
      if (typeof first === 'object' && first) targets.push(first.path ? `unix:${first.path}` : String(first.host ?? 'localhost'));
      else targets.push(typeof args[1] === 'string' ? (args[1] as string) : 'localhost');
      return (original as (...a: unknown[]) => net.Socket).apply(this, args);
    } as never);
    lab = await createLabHarness({ real: true, env: { TAI_VOICE_LAB_EARS_URL: asr.url, TAI_VOICE_LAB_TTS_URL: tts.url, TAI_VOICE_LAB_EARS_FALLBACK: 'none', TAI_VOICE_LAB_MOUTH_FALLBACK: 'none', TAI_VOICE_LAB_TEMPO: '1' } });
    lab.gw.respond = () => streamed('A mutex is a lock.');
    const b = await lab.browser(lab.owner());
    b.send({ type: 'start', mode: 'chat' });
    await b.next('ready');
    const conn = await asr.connection(1);
    // the greeting is LabGPU's voice too
    await b.next('transcript', (e) => e.role === 'agent');
    await b.next('status', (e) => e.state === 'listening');
    await sleep(2500);                                                                // the greeting is a few seconds of audio at the stretched pace
    await speak(b, 560, 0);
    await speak(b, 400, 6000);
    await speak(b, 160, 0);
    expect(conn.frameSizes.length).toBeGreaterThan(20);
    expect(new Set(conn.frameSizes)).toEqual(new Set([640]));                         // regrouped from the page's 1280 bytes: every frame the adapter sees is 20 ms
    asr.sendPartial('What is a mutex?');
    await b.next('transcript', (e) => e.role === 'agent' && e.text === 'A mutex is a lock.', 6000);
    await until(() => tts!.requests.some((r) => r.text === 'A mutex is a lock.'));
    const req = tts.requests.find((r) => r.text === 'A mutex is a lock.')!;
    expect(req.voice).toBe('af_bella');
    expect(req.hasSpeed).toBe(false);                                                 // the adapter ignores a speed: never sent
    expect(req.headers.authorization).toBeUndefined();
    // the pace: 5 words at the adapter's 2.69 words/s are 1.86 s; stretched by 3.45 / 2.69 they are 1.45 s
    const rawBytes = tts.pcmFor('A mutex is a lock.').length;
    expect(rawBytes / 48000).toBeGreaterThan(1.7);
    b.send({ type: 'end' });
    await b.next('closed');
    // S2: the stand-in, the relay door, the fakes, the portal: all loopback. Nothing went to LabGPU's address or Deepgram's.
    expect(targets.length).toBeGreaterThan(3);
    for (const t of targets) expect(['127.0.0.1', 'localhost', '::1'], t).toContain(t);
    // S3: the Deepgram key is nowhere in what the fakes saw, and nothing the adapters were sent carries credentials
    expect(JSON.stringify(conn.req.headers)).not.toContain(TEST_KEY);
    expect(conn.req.headers.authorization).toBeUndefined();
    expect(JSON.stringify(tts.requests.map((r) => r.headers))).not.toContain(TEST_KEY);
  }, 30_000);

  it('the stretched audio of a sentence is as long as the live pace says (3.45 words/s at the Settings\' speed 1.2)', async () => {
    asr = await FakeAsr.start();
    tts = await FakeTts.start();
    lab = await createLabHarness({ real: true, env: { TAI_VOICE_LAB_EARS_URL: asr.url, TAI_VOICE_LAB_TTS_URL: tts.url, TAI_VOICE_LAB_EARS_FALLBACK: 'none', TAI_VOICE_LAB_MOUTH_FALLBACK: 'none', TAI_VOICE_LAB_TEMPO: '1' } });
    const b = await lab.browser(lab.owner());
    b.send({ type: 'start', mode: 'chat' });
    await b.next('ready');
    const text = (await b.next('transcript', (e) => e.role === 'agent')).text as string;
    await b.next('status', (e) => e.state === 'speaking');
    await until(() => b.ofType('status').slice(-1)[0]?.state === 'listening', 15_000);      // the greeting has been played out
    await sleep(100);
    const words = text.trim().split(/\s+/).length;
    const rawSeconds = tts.pcmFor(text).length / 48000;
    // the audio that reached the page for the greeting (the only speech so far): its length against the unstretched length
    const seconds = b.audioBytes / 48000;
    expect(seconds).toBeGreaterThan(0.5);
    expect(text.length).toBeGreaterThan(5);
    const factor = rawSeconds / seconds;
    expect(factor).toBeGreaterThan(1.2);                                              // about 1.28 at speed 1.2 (the page's greeting at the student's own pace)
    expect(factor).toBeLessThan(1.36);
    expect(words / seconds).toBeGreaterThan(3.2);
    expect(words / seconds).toBeLessThan(3.7);
    b.close();
  }, 20_000);

  it('the defaults name only LabGPU\'s box and Deepgram', () => {
    const hosts = [DEFAULT_LABGPU_ASR, DEFAULT_LABGPU_TTS, DEFAULT_FLUX_URL, DEFAULT_NOVA_URL, DEFAULT_AURA_URL].map((u) => new URL(u).hostname);
    expect([...new Set(hosts)].sort()).toEqual(['192.0.2.29', 'api.deepgram.com']);
  });
});
