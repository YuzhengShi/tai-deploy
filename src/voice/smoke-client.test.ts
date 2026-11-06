import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionCodec, loadSecret } from '../portal/auth.js';
import { formatReport, main, mintCookie, parseWav, runSmoke } from './smoke-client.js';
import { createHarness, Harness } from './testing/harness.js';

function wav(samples: number, opts: { rate?: number; channels?: number; bits?: number } = {}): Buffer {
  const rate = opts.rate ?? 16000;
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const data = Buffer.alloc(samples * channels * (bits / 8), 3);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE((rate * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const list = Buffer.from('LIST\u0004\u0000\u0000\u0000INFO', 'latin1'); // a chunk to skip
  const head = Buffer.alloc(8);
  head.write('data', 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + list.length + head.length + data.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, fmt, list, head, data]);
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('the smoke client', () => {
  it('reads 16 kHz mono PCM16 WAVs and explains what else to do with the rest', () => {
    expect(parseWav(wav(16000)).data.length).toBe(32000);
    expect(() => parseWav(wav(100, { rate: 44100 }))).toThrow(/ffmpeg -i in.wav -ac 1 -ar 16000/);
    expect(() => parseWav(wav(100, { channels: 2 }))).toThrow(/2 channel/);
    expect(() => parseWav(Buffer.from('not a wav at all'))).toThrow(/RIFF/);
  });

  it('signs the cookie the portal would, for an address on the allowlist only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-smoke-'));
    try {
      const users = path.join(dir, 'users.json');
      const secret = path.join(dir, 'secret');
      fs.writeFileSync(users, JSON.stringify({ users: [{ email: 'Ana@Example.edu', name: 'Ana' }] }));
      fs.writeFileSync(secret, crypto.randomBytes(32).toString('hex'));
      const cookie = mintCookie(users, secret, 'ana@example.edu');
      expect(new SessionCodec(loadSecret(secret), 600).verify(cookie)).toEqual({ email: 'ana@example.edu' });
      expect(() => mintCookie(users, secret, 'mallory@example.edu')).toThrow(/not on the allowlist/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('makes a whole call against the hub: start, audio, the answer, end, closed; and never prints the cookie', async () => {
    h = await createHarness();
    const user = h.user(1);
    const harness = h;
    // the fake Deepgram hears the student once enough audio has arrived, and answers
    const script = (async () => {
      const conn = await harness.dg.connection(1, 5000);
      await conn.waitFor('Settings');
      conn.agentSays("hey Yuzheng, what's up?", 4800);
      while (conn.audioBytes < 1280 * 10) await new Promise((r) => setTimeout(r, 10));
      conn.userSays('what is raft');
      conn.send({ type: 'AgentThinking', content: '' });
      conn.agentSays('Raft is a consensus algorithm, what do you know about leaders?', 9600);
    })();
    const report = await runSmoke({ url: `ws://127.0.0.1:${h.port}/api/voice`, origin: h.origin, cookie: user.folder, pcm: Buffer.alloc(32000, 1), mode: 'chat', timeoutMs: 8000, afterAnswerMs: 50 });
    await script;
    expect(report.ok).toBe(true);
    expect(report.answered).toBe(true);
    expect(report.ready?.mode).toBe('conversational');
    expect(report.agentAudioBytes).toBe(4800 + 9600);
    expect(report.transcripts.map((t) => t.role)).toEqual(['agent', 'user', 'agent']);
    expect(report.closed?.reason).toBe('user');
    const printed = formatReport(report);
    expect(printed).toContain('result: OK');
    expect(printed).not.toContain(user.folder);
  });

  it('fails a call where only the greeting came back (Deepgram speaks it without the model)', async () => {
    h = await createHarness();
    const user = h.user(1);
    const harness = h;
    void (async () => {
      const conn = await harness.dg.connection(1, 5000);
      await conn.waitFor('Settings');
      conn.agentSays("hey Yuzheng, what's up?", 4800);
      while (conn.audioBytes < 1280 * 10) await new Promise((r) => setTimeout(r, 10));
      conn.userSays('what is raft'); // ... and then nothing: the relay or the gateway is broken
    })();
    const report = await runSmoke({ url: `ws://127.0.0.1:${h.port}/api/voice`, origin: h.origin, cookie: user.folder, pcm: Buffer.alloc(3200, 1), mode: 'chat', timeoutMs: 1500, closeWaitMs: 2000 });
    expect(report.agentAudioBytes).toBe(4800);
    expect(report.transcripts.length).toBe(2);
    expect(report.answered).toBe(false);
    expect(report.ok).toBe(false);
    expect(formatReport(report)).toContain('TAi did not answer');
  });

  it('reports a failure when the portal refuses the socket, and a usage error as 2', async () => {
    h = await createHarness();
    const report = await runSmoke({ url: `ws://127.0.0.1:${h.port}/api/voice`, origin: h.origin, cookie: 'nobody', pcm: Buffer.alloc(320), mode: 'chat', timeoutMs: 3000 });
    expect(report.ok).toBe(false);
    expect(report.errors[0].code).toBe('http-404');
    expect(formatReport(report)).toContain('FAILED');
    expect(await main(['--origin', 'https://x'])).toBe(2);
  });
});
