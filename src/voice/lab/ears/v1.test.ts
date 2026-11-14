/**
 * V1Ears against loopback fakes only: LabGPU's adapter (FakeAsr) and Deepgram's hosted /v1/listen (FakeListen). No test touches the real network.
 */
import net from 'net';
import type { AddressInfo } from 'net';
import { performance } from 'perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import { earsHarness, FakeAsr, sleep, until, type FakeAsrOptions } from '../testing/fake-asr.js';
import { FakeListen, type FakeListenOptions } from '../testing/fake-listen.js';
import type { EarsHandlers } from '../types.js';
import { UtteranceJoiner, V1Ears, type V1EarsOptions } from './v1.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  // newest first: an ears client is closed before the server it was talking to
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startAsr(opts?: FakeAsrOptions): Promise<FakeAsr> {
  const fake = await FakeAsr.start(opts);
  cleanups.push(() => fake.close());
  return fake;
}

async function startListen(opts?: FakeListenOptions): Promise<FakeListen> {
  const fake = await FakeListen.start(opts);
  cleanups.push(() => fake.close());
  return fake;
}

/** A port nothing listens on: bind one, then let it go. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const harness = earsHarness;

type Harness = ReturnType<typeof harness>;

function makeEars(opts: Partial<V1EarsOptions> & Pick<V1EarsOptions, 'url'>, h: Harness = harness()) {
  const ears = new V1Ears({ name: 'labgpu', frameBytes: 640, ...opts }, h.handlers, h.ctx);
  cleanups.push(() => ears.close());
  return { ears, h };
}

/** Connects a LabGPU-style ears client to a fresh FakeAsr and returns both with the server side of the connection. */
async function connectedToAsr(opts: Partial<V1EarsOptions> = {}) {
  const asr = await startAsr();
  const made = makeEars({ url: asr.url, ...opts });
  await made.ears.connect(2000);
  const conn = await asr.connection();
  return { asr, conn, ...made };
}

async function connectedToListen(opts: Partial<V1EarsOptions> = {}) {
  const listen = await startListen();
  const made = makeEars({ name: 'nova', url: listen.v1Url('?encoding=linear16&sample_rate=16000'), frameBytes: 2560, ...opts });
  await made.ears.connect(2000);
  const conn = await listen.connection();
  return { listen, conn, ...made };
}

/** A byte pattern that shows a lost, repeated or reordered byte. */
function pattern(length: number, start = 0): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = (start + i) % 251;
  return buf;
}

// ---------------------------------------------------------------- connect

describe('V1Ears connect', () => {
  it('connects, and the adapter sees the query it was given and no credentials', async () => {
    const asr = await startAsr();
    const { ears } = makeEars({ url: asr.url });
    expect(ears.name).toBe('labgpu');
    expect(ears.decidesTurn).toBe(false);
    expect(ears.connected).toBe(false);
    await ears.connect(2000);
    expect(ears.connected).toBe(true);
    const conn = await asr.connection();
    expect(conn.url.pathname).toBe('/v1/listen');
    expect(conn.url.searchParams.get('encoding')).toBe('linear16');
    expect(conn.url.searchParams.get('sample_rate')).toBe('16000');
    expect(conn.url.searchParams.get('language')).toBe('en');
    expect(conn.url.searchParams.get('label')).toBe('tai-lab');
    expect(conn.headers.authorization).toBeUndefined();
  });

  it('reads the URL when connect is called, not before', async () => {
    const asr = await startAsr();
    let reads = 0;
    const { ears } = makeEars({
      url: () => {
        reads++;
        return asr.url;
      },
    });
    expect(reads).toBe(0);
    await ears.connect(2000);
    expect(reads).toBe(1);
  });

  it('rejects with a plain Error when the port is closed, and never calls down', async () => {
    const port = await closedPort();
    const { ears, h } = makeEars({ url: `ws://127.0.0.1:${port}/v1/listen?label=tai-lab` });
    const err = await ears.connect(3000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).constructor).toBe(Error);
    expect((err as Error).message).toMatch(/refused/);
    expect(ears.connected).toBe(false);
    await sleep(50);
    expect(h.of('down')).toHaveLength(0);
  });

  it('rejects when the server never completes the handshake, after the time it was given', async () => {
    const asr = await startAsr({ delayHandshakeMs: Infinity });
    const { ears, h } = makeEars({ url: asr.url });
    const started = Date.now();
    const err = await ears.connect(250).catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect((err as Error).message).toMatch(/no handshake within 250 ms/);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(4000);
    expect(ears.connected).toBe(false);
    expect(h.of('down')).toHaveLength(0);
  });

  it('rejects when the handshake answers something other than 101', async () => {
    const asr = await startAsr({ refuseUpgrade: 403 });
    const { ears, h } = makeEars({ url: asr.url });
    await expect(ears.connect(2000)).rejects.toThrow(/refused the handshake \(HTTP 403\)/);
    asr.handshake.refuseUpgrade = 200;
    await expect(ears.connect(2000)).rejects.toThrow(/refused the handshake \(HTTP 200\)/);
    expect(h.of('down')).toHaveLength(0);
  });

  it('can try again after a failed connect', async () => {
    const asr = await startAsr({ refuseUpgrade: 503 });
    const { ears } = makeEars({ url: asr.url });
    await expect(ears.connect(2000)).rejects.toThrow(/HTTP 503/);
    asr.handshake.refuseUpgrade = undefined;
    await ears.connect(2000);
    expect(ears.connected).toBe(true);
  });

  it('refuses a second connect while connected, and any connect after close', async () => {
    const { ears } = await connectedToAsr();
    await expect(ears.connect(1000)).rejects.toThrow(/cannot connect/);
    ears.close();
    await expect(ears.connect(1000)).rejects.toThrow(/cannot connect/);
  });

  it('rejects a close() made while connect is pending, and calls down for nothing', async () => {
    const asr = await startAsr({ delayHandshakeMs: Infinity });
    const { ears, h } = makeEars({ url: asr.url });
    const pending = ears.connect(10_000);
    ears.close();
    await expect(pending).rejects.toThrow(/closed before it was connected/);
    expect(ears.connected).toBe(false);
    await sleep(50);
    expect(h.of('down')).toHaveLength(0);
  });

  it('does not show a URL it cannot use', async () => {
    const { ears } = makeEars({ url: 'ws://secret-host-name:99999999/v1/listen?token=hunter2-hunter2' });
    const err = await ears.connect(500).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/secret-host-name|hunter2/);
  });
});

// ---------------------------------------------------------------- partials and finals

describe('V1Ears results', () => {
  it('maps a partial to partial() and the speech_final to final(), stamped by the engine clock', async () => {
    const { asr, h } = await connectedToAsr();
    asr.sendPartial('what is');
    asr.sendPartial('what is paxos');
    asr.sendFinal('What is Paxos?');
    await until(() => h.events.length === 3);
    expect(h.texts()).toEqual(['partial:what is', 'partial:what is paxos', 'final:What is Paxos?']);
    expect(h.events[2].info).toEqual({});
    const ats = h.events.map((e) => e.at as number);
    for (const at of ats) expect(h.ticks).toContain(at);
    expect(ats[0]).toBeLessThan(ats[1]);
    expect(ats[1]).toBeLessThan(ats[2]);
  });

  it('ignores empty and blank texts and the adapter\'s late SpeechStarted', async () => {
    const { asr, h } = await connectedToAsr();
    asr.sendPartial('');
    asr.sendPartial('   ');
    asr.sendFinal('');
    asr.sendFinal('  \n ');
    asr.sendSpeechStarted();
    asr.sendPartial('now');
    await until(() => h.events.length >= 1);
    await sleep(30);
    expect(h.texts()).toEqual(['partial:now']);
  });

  it('ignores what is not a Results message: bad JSON, arrays, binary, Metadata, a Results with no text field', async () => {
    const { asr, conn, h } = await connectedToAsr();
    conn.sendRaw('this is not json');
    conn.sendRaw('[1,2,3]');
    conn.sendRaw(Buffer.from([1, 2, 3]), true);
    conn.sendJson({ type: 'Metadata', request_id: 'x' });
    conn.sendJson({ type: 'Results' });
    conn.sendJson({ type: 'Results', channel: { alternatives: [] } });
    conn.sendJson({ type: 'Results', channel: { alternatives: [{ transcript: 42 }] } });
    asr.sendPartial('after all that');
    await until(() => h.events.length >= 1);
    await sleep(30);
    expect(h.texts()).toEqual(['partial:after all that']);
    expect(h.rec.at('warn')).toHaveLength(0);
  });

  it('passes a non-Latin interjection and punctuation through untouched', async () => {
    const { asr, h } = await connectedToAsr();
    asr.sendFinal('嗯, so, what is Raft?');
    await until(() => h.of('final').length === 1);
    expect(h.of('final')[0].text).toBe('嗯, so, what is Raft?');
  });

  it('does not make a second final of the UtteranceEnd that follows a final', async () => {
    const { asr, h } = await connectedToAsr();
    asr.sendPartial('hello');
    asr.sendFinal('hello world');
    asr.sendUtteranceEnd();
    asr.sendPartial('next');
    await until(() => h.events.length >= 3);
    await sleep(30);
    expect(h.texts()).toEqual(['partial:hello', 'final:hello world', 'partial:next']);
  });

  it('takes the whole text of an adapter that repeats everything so far, even when it marks its partials final', async () => {
    const { asr, h } = await connectedToAsr();
    asr.sendPartial('hello', { isFinal: true });
    asr.sendPartial('hello world', { isFinal: true });
    asr.sendPartial('hello world how are', { isFinal: true });
    asr.sendFinal('Hello world, how are you?');
    await until(() => h.of('final').length === 1);
    await sleep(30);
    expect(h.texts()).toEqual(['partial:hello', 'partial:hello world', 'partial:hello world how are', 'final:Hello world, how are you?']);
  });

  it('a handler that throws does not stop the messages after it, and is logged', async () => {
    let calls = 0;
    const h = harness({
      partial: () => {
        calls++;
        if (calls === 1) throw new Error('handler blew up');
      },
    });
    const asr = await startAsr();
    const { ears } = makeEars({ url: asr.url }, h);
    await ears.connect(2000);
    asr.sendPartial('one');
    asr.sendPartial('two');
    asr.sendFinal('one two');
    await until(() => h.of('final').length === 1);
    expect(calls).toBe(2);
    expect(ears.connected).toBe(true);
    expect(h.rec.at('warn').some((l) => l.msg.includes('handler threw'))).toBe(true);
  });
});

// ---------------------------------------------------------------- Deepgram's own segments

describe('V1Ears against Deepgram\'s hosted /v1/listen', () => {
  it('joins the is_final segments of an utterance and releases them on speech_final, which carries only the last one', async () => {
    const { conn, h } = await connectedToListen();
    conn.sendInterim('hello');
    conn.sendSegment('Hello there,');
    conn.sendInterim('how are');
    conn.sendSegment('how are you');
    conn.sendSpeechFinal('today?');
    // the next utterance starts clean
    conn.sendInterim('fine');
    conn.sendSpeechFinal('fine thanks');
    await until(() => h.of('final').length === 2);
    expect(h.texts()).toEqual([
      'partial:hello',
      'partial:Hello there,',
      'partial:Hello there, how are',
      'partial:Hello there, how are you',
      'final:Hello there, how are you today?',
      'partial:fine',
      'final:fine thanks',
    ]);
  });

  it('a speech_final with no text still releases the segments waiting', async () => {
    const { conn, h } = await connectedToListen();
    conn.sendSegment('Okay so');
    conn.sendSpeechFinal('');
    await until(() => h.of('final').length === 1);
    expect(h.of('final')[0].text).toBe('Okay so');
  });

  it('UtteranceEnd releases pending segments once, and does nothing when none are waiting', async () => {
    const { conn, h } = await connectedToListen();
    conn.sendSegment('I was thinking');
    conn.sendUtteranceEnd();
    conn.sendUtteranceEnd();
    conn.sendInterim('and');
    await until(() => h.events.length >= 3);
    await sleep(30);
    expect(h.texts()).toEqual(['partial:I was thinking', 'final:I was thinking', 'partial:and']);
  });

  it('turns the answer to a Finalize (from_finalize) into the final, after sending the audio still waiting and then the Finalize', async () => {
    const { ears, conn, h } = await connectedToListen({ frameBytes: 640 });
    conn.sendSegment('so');
    await until(() => h.of('partial').length === 1);
    ears.sendAudio(pattern(300));
    ears.forceEndTurn();
    await until(() => conn.textsOfType('Finalize').length === 1);
    // the tail went first, padded with silence to a whole frame
    expect(conn.frameSizes).toEqual([640]);
    expect(conn.frames[0].subarray(0, 300).equals(pattern(300))).toBe(true);
    expect(conn.frames[0].subarray(300).every((b) => b === 0)).toBe(true);
    expect(conn.frameTimes[0]).toBeLessThanOrEqual(conn.textsOfType('Finalize')[0].at);
    conn.sendFromFinalize('and that is all');
    await until(() => h.of('final').length === 1);
    expect(h.of('final')[0].text).toBe('so and that is all');
  });

  it('sends KeepAlive and the Authorization header when asked to', async () => {
    const { conn } = await connectedToListen({ headers: () => ({ Authorization: 'Token dg-test-key-0123456789' }), keepAliveMs: 120 });
    expect(conn.authorization).toBe('Token dg-test-key-0123456789');
    await until(() => conn.keepAlives.length >= 1, 1500, 'a KeepAlive');
    expect(conn.textsOfType('KeepAlive')[0].raw).toBe('{"type":"KeepAlive"}');
  });
});

describe('UtteranceJoiner', () => {
  const feed = (j: UtteranceJoiner, text: string, isFinal = false, speechFinal = false, fromFinalize = false) => j.feed({ text, isFinal, speechFinal, fromFinalize });

  it('follows Deepgram\'s incremental segments', () => {
    const j = new UtteranceJoiner();
    expect(feed(j, 'a b')).toEqual([{ kind: 'partial', text: 'a b' }]);
    expect(feed(j, 'a b', true)).toEqual([{ kind: 'partial', text: 'a b' }]);
    expect(feed(j, 'c')).toEqual([{ kind: 'partial', text: 'a b c' }]);
    expect(feed(j, 'c d', true, true)).toEqual([{ kind: 'final', text: 'a b c d' }]);
    expect(j.pending).toBe(false);
    expect(j.flush()).toEqual([]);
  });

  it('compares whole words: a segment that merely begins with the letters of the last one is a new segment', () => {
    const j = new UtteranceJoiner();
    feed(j, 'go', true);
    expect(feed(j, 'gopher it', true, true)).toEqual([{ kind: 'final', text: 'go gopher it' }]);
  });

  it('ignores case and punctuation when it recognises a repeat of everything so far', () => {
    const j = new UtteranceJoiner();
    feed(j, 'Hello, world', true);
    expect(feed(j, 'hello world how are you?', true, true)).toEqual([{ kind: 'final', text: 'hello world how are you?' }]);
  });

  it('makes no event of an empty text', () => {
    const j = new UtteranceJoiner();
    expect(feed(j, '')).toEqual([]);
    expect(feed(j, '   ', true)).toEqual([]);
    expect(feed(j, '', true, true)).toEqual([]);
    expect(feed(j, '', false, false, true)).toEqual([]);
  });
});

// ---------------------------------------------------------------- audio frames

describe('V1Ears audio', () => {
  it('regroups pieces of any size into frames of frameBytes, in order, with no byte lost, across calls', async () => {
    const { ears, conn } = await connectedToAsr({ frameBytes: 640 });
    const sent = pattern(5000);
    let offset = 0;
    for (const size of [1280, 1, 637, 3, 1000, 1279, 800]) {
      ears.sendAudio(sent.subarray(offset, offset + size));
      offset += size;
    }
    expect(offset).toBe(5000);
    // 5000 = 7 x 640 + 520: seven frames are out, the rest waits for more audio
    await conn.waitForFrames(7);
    await sleep(80);
    expect(conn.frameSizes).toEqual(new Array(7).fill(640));
    expect(conn.received().equals(sent.subarray(0, 4480))).toBe(true);
    // 120 more bytes complete the eighth frame, and it continues the stream where the last one stopped
    ears.sendAudio(pattern(120, 5000));
    await conn.waitForFrames(8);
    expect(conn.frameSizes[7]).toBe(640);
    expect(conn.received().equals(Buffer.concat([sent, pattern(120, 5000)]))).toBe(true);
  });

  it('holds 1280-byte pieces until a 2560-byte frame is complete', async () => {
    const { ears, conn } = await connectedToListen({ frameBytes: 2560 });
    ears.sendAudio(pattern(1280));
    await sleep(60);
    expect(conn.frameSizes).toEqual([]);
    ears.sendAudio(pattern(1280, 1280));
    await conn.waitForFrames(1);
    expect(conn.frameSizes).toEqual([2560]);
    expect(conn.received().equals(pattern(2560))).toBe(true);
  });

  it('sends several frames out of one big piece', async () => {
    const { ears, conn } = await connectedToAsr({ frameBytes: 640 });
    ears.sendAudio(pattern(640 * 5 + 100));
    await conn.waitForFrames(5);
    await sleep(40);
    expect(conn.frameSizes).toEqual(new Array(5).fill(640));
    expect(conn.received().equals(pattern(3200))).toBe(true);
  });

  it('refuses a frame size that is not a positive whole number', () => {
    const h = harness();
    expect(() => new V1Ears({ name: 'labgpu', url: 'ws://127.0.0.1:1/', frameBytes: 0 }, h.handlers, h.ctx)).toThrow(RangeError);
    expect(() => new V1Ears({ name: 'labgpu', url: 'ws://127.0.0.1:1/', frameBytes: 640.5 }, h.handlers, h.ctx)).toThrow(RangeError);
  });

  it('drops audio sent while not connected: nothing is queued and replayed', async () => {
    const asr = await startAsr();
    const { ears } = makeEars({ url: asr.url });
    ears.sendAudio(Buffer.alloc(640, 0xaa));
    await ears.connect(2000);
    const conn = await asr.connection();
    ears.sendAudio(Buffer.alloc(640, 0xbb));
    await conn.waitForFrames(1);
    await sleep(40);
    expect(conn.frames).toHaveLength(1);
    expect(conn.frames[0].every((b) => b === 0xbb)).toBe(true);
  });

  it('drops frames, instead of growing, while the socket has more than maxBufferedBytes waiting', async () => {
    const { ears, conn, h } = await connectedToAsr({ frameBytes: 640, maxBufferedBytes: 10_000 });
    const socket = (ears as unknown as { socket: { bufferedAmount: number } }).socket;
    // a socket whose network is stalled: the bytes the kernel would not take stay in ws's queue
    Object.defineProperty(socket, 'bufferedAmount', { get: () => 50_000, configurable: true });
    ears.sendAudio(Buffer.alloc(640 * 4, 1));
    await sleep(60);
    expect(conn.frameSizes).toHaveLength(0);
    expect(h.rec.at('warn').filter((l) => l.msg.includes('backed up'))).toHaveLength(1);
    // once it drains, audio flows again and the recovery is logged
    Object.defineProperty(socket, 'bufferedAmount', { get: () => 0, configurable: true });
    ears.sendAudio(Buffer.alloc(640, 2));
    await conn.waitForFrames(1);
    expect(conn.frames[0].every((b) => b === 2)).toBe(true);
    expect(h.rec.at('info').some((l) => l.msg.includes('caught up'))).toBe(true);
  });
});

// ---------------------------------------------------------------- KeepAlive

describe('V1Ears KeepAlive', () => {
  it('sends none by default, however long the socket is idle', async () => {
    const { conn } = await connectedToAsr();
    await sleep(400);
    expect(conn.texts).toHaveLength(0);
  });

  it('sends one only after keepAliveMs without anything going out, never between frames', async () => {
    const keepAliveMs = 150;
    const { ears, conn } = await connectedToAsr({ frameBytes: 640, keepAliveMs });
    // what the client sends is timed where it is sent: the fake runs in this same process, so its arrival times would move with any stall of the event loop
    const socket = (ears as unknown as { socket: { send: (data: unknown, ...rest: unknown[]) => void } }).socket;
    const sends: Array<{ at: number; kind: 'frame' | 'KeepAlive' }> = [];
    const send = socket.send.bind(socket);
    socket.send = (data: unknown, ...rest: unknown[]) => {
      sends.push({ at: performance.now(), kind: typeof data === 'string' ? 'KeepAlive' : 'frame' });
      return send(data, ...rest);
    };
    // frames every 40 ms for 600 ms: far more often than the interval, so the timer is pushed back each time
    for (let i = 0; i < 15; i++) {
      ears.sendAudio(Buffer.alloc(640, 3));
      await sleep(40);
    }
    expect(sends.filter((s) => s.kind === 'KeepAlive')).toHaveLength(0);
    expect(sends.filter((s) => s.kind === 'frame')).toHaveLength(15);
    // idle: a KeepAlive, and then another one a whole interval later (not a burst)
    await until(() => conn.textsOfType('KeepAlive').length >= 2, 3000, 'two KeepAlives');
    expect(conn.textsOfType('KeepAlive')[0].raw).toBe('{"type":"KeepAlive"}');
    // every KeepAlive came at least keepAliveMs after the send before it (a Node timer may fire a millisecond early)
    sends.forEach((s, i) => {
      if (s.kind === 'KeepAlive') expect(s.at - sends[i - 1].at).toBeGreaterThanOrEqual(keepAliveMs - 5);
    });
    // audio again: the quiet restarts, and no KeepAlive is sent between these frames
    const before = sends.filter((s) => s.kind === 'KeepAlive').length;
    for (let i = 0; i < 6; i++) {
      ears.sendAudio(Buffer.alloc(640, 4));
      await sleep(40);
    }
    expect(sends.filter((s) => s.kind === 'KeepAlive')).toHaveLength(before);
  });
});

// ---------------------------------------------------------------- down and close

describe('V1Ears down and close', () => {
  it('calls down exactly once when the server closes, with the code and reason, and is not connected afterwards', async () => {
    const { asr, ears, h } = await connectedToAsr();
    asr.closeConnection(1011, 'adapter restarting');
    await until(() => h.of('down').length === 1);
    await sleep(100);
    expect(h.of('down')).toHaveLength(1);
    expect(h.of('down')[0].reason).toContain('1011');
    expect(h.of('down')[0].reason).toContain('adapter restarting');
    expect(ears.connected).toBe(false);
    expect(() => ears.sendAudio(Buffer.alloc(640))).not.toThrow();
  });

  it('calls down exactly once when the connection is cut without a close frame', async () => {
    const { conn, ears, h } = await connectedToAsr();
    conn.terminate();
    await until(() => h.of('down').length === 1);
    await sleep(100);
    expect(h.of('down')).toHaveLength(1);
    expect(h.of('down')[0].reason).toMatch(/1006|ECONNRESET/);
    ears.close();
    expect(h.of('down')).toHaveLength(1);
  });

  it('drops audio sent after the socket went down', async () => {
    const { asr, conn, ears, h } = await connectedToAsr();
    asr.closeConnection();
    await until(() => h.of('down').length === 1);
    ears.sendAudio(Buffer.alloc(1280));
    await sleep(40);
    expect(conn.frames).toHaveLength(0);
  });

  it('close() is idempotent, sends CloseStream and a normal close, and is silent from the first call', async () => {
    const { asr, conn, ears, h } = await connectedToAsr();
    ears.close();
    // a result already on the wire when we hung up must not reach the engine
    asr.sendPartial('too late');
    asr.sendFinal('too late for this one too');
    ears.close();
    ears.close();
    await until(() => conn.closed);
    expect(conn.closeCode).toBe(1000);
    expect(conn.textsOfType('CloseStream')).toHaveLength(1);
    await sleep(80);
    expect(h.events).toHaveLength(0);
    expect(ears.connected).toBe(false);
  });

  it('close() before connect, and again after, does nothing and calls nothing', async () => {
    const asr = await startAsr();
    const { ears, h } = makeEars({ url: asr.url });
    ears.close();
    ears.close();
    expect(ears.connected).toBe(false);
    expect(h.events).toHaveLength(0);
    expect(asr.connections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- credentials never show

describe('V1Ears and credentials', () => {
  const KEY = 'dg-secret-key-4f9a1c7e2b';

  it('sends the headers it was given and shows them nowhere: not in errors, down reasons or logs', async () => {
    const shown: string[] = [];
    const h = harness();
    const headers = () => ({ Authorization: `Token ${KEY}` });
    const listen = await startListen();

    // a good connection that the server ends with a reason that echoes the key
    const good = makeEars({ name: 'nova', url: listen.v1Url('?encoding=linear16'), frameBytes: 2560, headers }, h);
    await good.ears.connect(2000);
    const conn = await listen.connection();
    expect(conn.authorization).toBe(`Token ${KEY}`);
    listen.latest.close(1008, `bad token ${KEY} for this request`);
    await until(() => h.of('down').length === 1);
    shown.push(h.of('down')[0].reason ?? '');
    expect(h.of('down')[0].reason).toContain('1008');

    // refused with 401, a closed port, a handshake that never finishes
    listen.handshake.refuseUpgrade = 401;
    const refused = makeEars({ name: 'nova', url: listen.v1Url(), frameBytes: 2560, headers }, h);
    shown.push(((await refused.ears.connect(1000).catch((e: unknown) => e)) as Error).message);
    const port = await closedPort();
    const closed = makeEars({ name: 'nova', url: `ws://127.0.0.1:${port}/v1/listen`, frameBytes: 2560, headers }, h);
    shown.push(((await closed.ears.connect(1000).catch((e: unknown) => e)) as Error).message);
    listen.handshake.refuseUpgrade = undefined;
    listen.handshake.delayHandshakeMs = Infinity;
    const slow = makeEars({ name: 'nova', url: listen.v1Url(), frameBytes: 2560, headers }, h);
    shown.push(((await slow.ears.connect(150).catch((e: unknown) => e)) as Error).message);

    expect(shown.filter(Boolean)).toHaveLength(4);
    for (const text of shown) expect(text).not.toContain(KEY);
    expect(h.rec.dump()).not.toContain(KEY);
    expect(h.rec.dump()).not.toContain('4f9a1c7e2b');
  });

  it('logs an Error message from the recognizer at warn level with the credential taken out, and stays connected', async () => {
    const h = harness();
    const listen = await startListen();
    const { ears } = makeEars({ name: 'nova', url: listen.v1Url(), frameBytes: 2560, headers: () => ({ Authorization: `Token ${KEY}` }) }, h);
    await ears.connect(2000);
    const conn = await listen.connection();
    conn.sendJson({ type: 'Error', description: `invalid credentials ${KEY}`, variant: 'x' });
    conn.sendJson({ type: 'Results', channel: { alternatives: [{ transcript: 'sentinel' }] }, is_final: false, speech_final: false });
    await until(() => h.events.length === 1);
    const warn = h.rec.at('warn').find((l) => l.msg.includes('reported an error'));
    expect(warn?.obj.what).toBe('invalid credentials [redacted]');
    expect(h.rec.dump()).not.toContain(KEY);
    expect(ears.connected).toBe(true);
  });

  it('does not log the URL or its query', async () => {
    const asr = await startAsr();
    const h = harness();
    const { ears } = makeEars({ url: asr.url }, h);
    await ears.connect(2000);
    ears.close();
    expect(h.rec.dump()).not.toContain('label=tai-lab');
    expect(h.rec.dump()).not.toContain('language=en');
  });

  it('shows a header value that cannot be used without the value', async () => {
    const h = harness();
    const { ears } = makeEars({ url: 'ws://127.0.0.1:1/', headers: () => ({ 'X-Bad': `line\r\nbreak ${KEY}` }) }, h);
    const err = (await ears.connect(500).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(KEY);
    expect(h.rec.dump()).not.toContain(KEY);
  });
});
