import { getEventListeners } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BODY_MARKER, FakeTts, chunkedFetch, drain, loopbackOnlyFetch, tonePcm, wavBytes, type FakeTtsBehavior } from '../testing/fake-tts.js';
import { MouthError } from '../types.js';
import { LabGPUMouth, checkLabGPUVoice, labgpuSpeedField, type LabGPUMouthOptions } from './labgpu.js';

/** A sentence with words no message of the mouth may ever repeat. */
const TEXT = 'Zebrafish marmalade quietly orbits seventeen purple lanterns today';
const VOICE = 'af_bella';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const fakes: FakeTts[] = [];
const guards: Array<{ blocked: string[] }> = [];

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
  expect(guards.splice(0).flatMap((g) => g.blocked), 'a request tried to leave 127.0.0.1').toEqual([]);
});

async function setup(
  behavior: Partial<FakeTtsBehavior> = {},
  options: LabGPUMouthOptions = {},
): Promise<{ fake: FakeTts; mouth: LabGPUMouth; fetchImpl: typeof fetch }> {
  const fake = await FakeTts.start(behavior);
  fakes.push(fake);
  const guard = loopbackOnlyFetch(); // every mouth in this file goes through it: a forgotten baseUrl fails the test instead of reaching a real machine
  guards.push(guard);
  return { fake, mouth: new LabGPUMouth({ baseUrl: fake.url, fetchImpl: guard.fetchImpl, ...options }), fetchImpl: guard.fetchImpl };
}

/** A mouth whose `fetch` never touches a network: the answer is exactly these chunks. */
function offline(chunks: Uint8Array[], init?: ResponseInit): LabGPUMouth {
  return new LabGPUMouth({ baseUrl: 'http://127.0.0.1:1', fetchImpl: chunkedFetch(chunks, init) });
}

function expectMouthError(error: unknown, kind: MouthError['kind']): MouthError {
  expect(error).toBeInstanceOf(MouthError);
  const e = error as MouthError;
  expect(e.kind).toBe(kind);
  expect(e.name).toBe('MouthError');
  // never the text spoken, a header value, the body of an error answer, or an address
  for (const secret of ['Zebrafish', 'marmalade', 'lanterns', BODY_MARKER, 'elevenlabs', 'ElevenLabs', 'x-tts-fallback', '127.0.0.1']) expect(e.message.toLowerCase()).not.toContain(secret.toLowerCase());
  return e;
}

const expected = (fake: FakeTts): Buffer => fake.pcmFor(TEXT);

describe('LabGPUMouth: what it is', () => {
  it('is the LabGPU mouth, takes no speed, and aims at LabGPU\'s box unless told otherwise', () => {
    const mouth = new LabGPUMouth();
    expect(mouth.name).toBe('labgpu');
    expect(mouth.takesSpeed).toBe(false);
    expect(mouth.baseUrl).toBe('http://192.0.2.29:8805'); // nothing is sent: the constructor makes no request
  });

  it('refuses options that make no sense', () => {
    expect(() => new LabGPUMouth({ baseUrl: 'ftp://x' })).toThrow(TypeError);
    expect(() => new LabGPUMouth({ baseUrl: 'not a url' })).toThrow(TypeError);
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => new LabGPUMouth({ connectTimeoutMs: bad })).toThrow(RangeError);
      expect(() => new LabGPUMouth({ firstByteTimeoutMs: bad })).toThrow(RangeError);
      expect(() => new LabGPUMouth({ totalTimeoutMs: bad })).toThrow(RangeError);
    }
  });
});

describe('LabGPUMouth: the sentence', () => {
  it('yields the audio of the answer in pieces of whole samples, and sends the text and the voice only', async () => {
    const { fake, mouth } = await setup();
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(error).toBeUndefined();
    expect(Buffer.concat(pieces).equals(expected(fake))).toBe(true);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.length).toBeGreaterThan(0);
      expect(p.length % 2).toBe(0);
    }
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/tts');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.body).toEqual({ text: TEXT, voice: VOICE });
    await request.closed;
    expect(request.finished).toBe(true);
  });

  it('never sends a speed, whatever the engine asks for', async () => {
    const { fake, mouth } = await setup();
    await drain(mouth.synthesize(TEXT, { voice: VOICE, speed: 1.3 }));
    await drain(mouth.synthesize(TEXT, { voice: VOICE, speed: 0.8 }));
    expect(fake.requests).toHaveLength(2);
    for (const r of fake.requests) {
      expect(r.hasSpeed).toBe(false);
      expect(Object.keys(r.body).sort()).toEqual(['text', 'voice']);
    }
  });

  it('sends the speed, clamped to what the service takes, when it is told that the service takes one (the local voice service), and then takes a speed', async () => {
    const { fake, mouth } = await setup({}, { speedParam: true });
    expect(mouth.takesSpeed).toBe(true);
    for (const speed of [1.2, 3, 0.2, undefined, Number.NaN, 1.0833]) await drain(mouth.synthesize(TEXT, { voice: VOICE, speed }));
    expect(fake.requests.map((r) => r.body.speed)).toEqual([1.2, 2, 0.5, undefined, undefined, 1.08]);
    expect(fake.requests.map((r) => r.hasSpeed)).toEqual([true, true, true, false, false, true]);
    expect(Object.keys(fake.requests[0].body).sort()).toEqual(['speed', 'text', 'voice']);
    expect(fake.requests.every((r) => r.body.text === TEXT && r.body.voice === VOICE)).toBe(true);
  });

  it('lets the engine render its fixed lines ahead of time unless it is told not to (the local CPU service is told not to), whatever it does with the speed', () => {
    expect(new LabGPUMouth().prewarm).toBe(true);
    expect(new LabGPUMouth({ speedParam: true }).prewarm).toBe(true);
    expect(new LabGPUMouth({ prewarm: false }).prewarm).toBe(false);
    expect(new LabGPUMouth({ prewarm: true, speedParam: true }).prewarm).toBe(true);
  });

  it('labgpuSpeedField: nothing for no pace, a clamped pace in hundredths otherwise', () => {
    expect(labgpuSpeedField(undefined)).toBeUndefined();
    expect(labgpuSpeedField(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(labgpuSpeedField(1)).toBe(1);
    expect(labgpuSpeedField(1.296)).toBe(1.3);
    expect(labgpuSpeedField(0)).toBe(0.5);
    expect(labgpuSpeedField(5)).toBe(2);
  });

  it('accepts a base URL with a trailing slash, and every voice of the adapter except DrBerg', async () => {
    const { fake, mouth, fetchImpl } = await setup();
    const slashed = new LabGPUMouth({ baseUrl: `${fake.url}//`, fetchImpl });
    expect((await drain(slashed.synthesize('Hello there', { voice: VOICE }))).error).toBeUndefined();
    for (const voice of ['af_bella', 'af_heart', 'default', 'ef_dora', 'ff_siwis', 'jf_gongitsune', 'pf_dora', 'zf_xiaobei']) {
      expect((await drain(mouth.synthesize('Hello', { voice }))).error, voice).toBeUndefined();
    }
  });

  it('yields nothing and sends nothing for a sentence with no text in it', async () => {
    const { fake, mouth } = await setup();
    for (const text of ['', '   ', '\n']) expect(await drain(mouth.synthesize(text, { voice: VOICE }))).toEqual({ pieces: [], error: undefined });
    expect(fake.requests).toHaveLength(0);
  });

  it('can speak two sentences at the same time, each its own', async () => {
    const { fake, mouth } = await setup({ holdAfterChunks: 1 });
    const a = 'The first sentence is quite a bit longer than the other one';
    const b = 'Short one';
    const speaking = Promise.all([drain(mouth.synthesize(a, { voice: VOICE })), drain(mouth.synthesize(b, { voice: VOICE }))]);
    await vi.waitFor(() => expect(fake.requests.filter((r) => r.chunksWritten >= 1)).toHaveLength(2)); // both in flight, each held after its first chunk
    fake.release();
    const [ra, rb] = await speaking;
    expect(Buffer.concat(ra.pieces).equals(fake.pcmFor(a))).toBe(true);
    expect(Buffer.concat(rb.pieces).equals(fake.pcmFor(b))).toBe(true);
  });

  it('does not leave a listener on the caller\'s signal, however many sentences it speaks', async () => {
    const { mouth } = await setup();
    const ctl = new AbortController();
    for (let i = 0; i < 5; i++) await drain(mouth.synthesize('Hello there', { voice: VOICE, signal: ctl.signal }));
    expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
  });
});

describe('LabGPUMouth: pieces and streaming', () => {
  it('yields the first piece while the adapter is still sending the rest', async () => {
    const { fake, mouth } = await setup({ holdAfterChunks: 2 });
    const it = mouth.synthesize(TEXT, { voice: VOICE })[Symbol.asyncIterator]();
    const first = await it.next(); // the adapter holds everything after its second chunk until `release`
    expect(first.done).toBe(false);
    expect((first.value as Buffer).length).toBeGreaterThan(0);
    expect(fake.requests[0].finished).toBe(false);
    expect(fake.requests[0].chunksWritten).toBeLessThanOrEqual(2);
    fake.release();
    const pieces = [first.value as Buffer];
    for (let r = await it.next(); !r.done; r = await it.next()) pieces.push(r.value);
    expect(Buffer.concat(pieces).equals(expected(fake))).toBe(true);
  });

  it('cuts the audio into whole samples however the body is split: odd chunks of every size', async () => {
    for (const chunkBytes of [1, 3, 7, 1001, 4097]) {
      const tiny = chunkBytes < 10; // a one-byte chunk is a lot of chunks: keep that sentence short, and make the voice fast so it is also few samples
      const { fake, mouth } = await setup({ chunkBytes, ...(tiny ? { wordsPerSecond: 20 } : {}) });
      const text = tiny ? 'Hi' : TEXT;
      const { pieces, error } = await drain(mouth.synthesize(text, { voice: VOICE }));
      expect(error, `chunk ${chunkBytes}`).toBeUndefined();
      expect(Buffer.concat(pieces).equals(fake.pcmFor(text)), `chunk ${chunkBytes}`).toBe(true);
      for (const p of pieces) {
        expect(p.length % 2, `chunk ${chunkBytes}`).toBe(0);
        expect(p.length).toBeGreaterThan(0);
      }
    }
  });

  it('makes whole samples out of one-byte chunks with no network at all', async () => {
    const audio = tonePcm(200);
    const mouth = offline(Array.from(audio, (b) => Uint8Array.of(b)));
    const { pieces, error } = await drain(mouth.synthesize('Hello there', { voice: VOICE }));
    expect(error).toBeUndefined();
    expect(Buffer.concat(pieces).equals(audio)).toBe(true);
    expect(pieces.every((p) => p.length > 0 && p.length % 2 === 0)).toBe(true);
  });

  it('ignores an empty chunk in the middle of the body', async () => {
    const audio = tonePcm(100);
    const mouth = offline([audio.subarray(0, 51), new Uint8Array(0), audio.subarray(51)]);
    const { pieces, error } = await drain(mouth.synthesize('Hello there', { voice: VOICE }));
    expect(error).toBeUndefined();
    expect(Buffer.concat(pieces).equals(audio)).toBe(true);
  });

  it('speaks a body of one sample, and fails one of one byte, three bytes or none', async () => {
    expect(Buffer.concat((await drain(offline([Uint8Array.of(1, 2)]).synthesize('Hi', { voice: VOICE }))).pieces)).toEqual(Buffer.from([1, 2]));
    expectMouthError((await drain(offline([Uint8Array.of(1)]).synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');
    const three = await drain(offline([Uint8Array.of(1, 2, 3)]).synthesize('Hi', { voice: VOICE }));
    expect(Buffer.concat(three.pieces)).toEqual(Buffer.from([1, 2])); // the whole sample comes out, then the error
    expectMouthError(three.error, 'bad-audio');
    expectMouthError((await drain(offline([]).synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');
  });
});

describe('LabGPUMouth: abort', () => {
  it('ends quietly when the signal is aborted between two pieces, and drops the request', async () => {
    const { fake, mouth } = await setup({ holdAfterChunks: 2 });
    const ctl = new AbortController();
    const it = mouth.synthesize(TEXT, { voice: VOICE, signal: ctl.signal })[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    ctl.abort();
    expect(await it.next()).toEqual({ value: undefined, done: true }); // no error, no more audio
    await fake.requests[0].closed;
    expect(fake.requests[0].aborted).toBe(true);
    expect(fake.requests[0].finished).toBe(false);
  });

  it('drops the request at once, also while nobody is asking for the next piece', async () => {
    const { fake, mouth } = await setup({ holdAfterChunks: 2 });
    const ctl = new AbortController();
    const it = mouth.synthesize(TEXT, { voice: VOICE, signal: ctl.signal })[Symbol.asyncIterator]();
    await it.next();
    ctl.abort(); // and no further `next()`: the engine has stopped listening
    await fake.requests[0].closed;
    expect(fake.requests[0].aborted).toBe(true);
  });

  it('sends no request when the signal is aborted already', async () => {
    const { fake, mouth } = await setup();
    const ctl = new AbortController();
    ctl.abort();
    expect(await drain(mouth.synthesize(TEXT, { voice: VOICE, signal: ctl.signal }))).toEqual({ pieces: [], error: undefined });
    expect(fake.requests).toHaveLength(0);
  });

  it('ends quietly when the signal is aborted while the adapter has not answered yet', async () => {
    const { fake, mouth } = await setup({ stallBeforeHead: true });
    const ctl = new AbortController();
    const speaking = drain(mouth.synthesize(TEXT, { voice: VOICE, signal: ctl.signal }));
    await sleep(60);
    ctl.abort();
    expect(await speaking).toEqual({ pieces: [], error: undefined });
    await fake.requests[0].closed;
    expect(fake.requests[0].aborted).toBe(true);
  });

  it('drops the request when the consumer stops reading (an early break)', async () => {
    const { fake, mouth } = await setup({ holdAfterChunks: 2 });
    for await (const piece of mouth.synthesize(TEXT, { voice: VOICE })) {
      expect(piece.length).toBeGreaterThan(0);
      break;
    }
    await fake.requests[0].closed;
    expect(fake.requests[0].aborted).toBe(true);
  });
});

describe('LabGPUMouth: the service is not there', () => {
  it('fails with `down` from the first next() when the connection is refused', async () => {
    const { fake, mouth } = await setup();
    await fake.close(); // the port is now closed
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(pieces).toEqual([]);
    expect(expectMouthError(error, 'down').message).toMatch(/not reachable/);
  });

  it('fails with `down` for an HTTP status other than 200, and never repeats the body of the answer', async () => {
    for (const status of [500, 503, 404, 422]) {
      const { fake, mouth } = await setup({ status });
      const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(pieces).toEqual([]);
      expect(expectMouthError(error, 'down').message).toContain(String(status));
      expect(fake.requests).toHaveLength(1);
    }
  });

  it('fails with `down` when the adapter never answers (the head), after the time it was given', async () => {
    const { mouth } = await setup({ stallBeforeHead: true }, { connectTimeoutMs: 120 });
    const started = Date.now();
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(pieces).toEqual([]);
    expect(expectMouthError(error, 'down').message).toContain('120 ms');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('fails with `down` when the head comes and the first byte does not', async () => {
    for (const behavior of [{ firstByteDelayMs: 800 }, { stallAfterHead: true }] as const) {
      const { mouth } = await setup(behavior, { firstByteTimeoutMs: 150 });
      const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(pieces).toEqual([]);
      expect(expectMouthError(error, 'down').message).toMatch(/no audio within 150 ms/);
    }
  });

  it('counts the first byte from the start of the request, not from the head', async () => {
    // The head takes 100 ms, the first byte comes at 100 + 100 ms: over a limit of 150 ms measured from the start, though each wait alone is under it.
    const { mouth } = await setup({ headDelayMs: 100, firstByteDelayMs: 100 }, { firstByteTimeoutMs: 150 });
    const { error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(expectMouthError(error, 'down').message).toMatch(/no audio within 150 ms/);
  });

  it('fails with `down` after some audio when the adapter goes silent between two chunks', async () => {
    const { mouth } = await setup({ chunkDelayMs: 400 }, { firstByteTimeoutMs: 120 });
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(pieces.length).toBeGreaterThanOrEqual(1);
    expect(expectMouthError(error, 'down').message).toMatch(/went silent for 120 ms/);
  });

  it('fails with `down` when the whole answer takes longer than the total time', async () => {
    const { mouth } = await setup({ chunkDelayMs: 60 }, { totalTimeoutMs: 200, firstByteTimeoutMs: 1000 });
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(pieces.length).toBeGreaterThanOrEqual(1);
    expect(expectMouthError(error, 'down').message).toMatch(/longer than 200 ms/);
  });

  it('does not count the time the consumer takes against the total time', async () => {
    const { fake, mouth } = await setup({}, { totalTimeoutMs: 400 });
    const pieces: Buffer[] = [];
    for await (const piece of mouth.synthesize(TEXT, { voice: VOICE })) {
      pieces.push(piece);
      await sleep(60); // a consumer that plays at its own pace: the ten pieces take longer than the total time
    }
    expect(Buffer.concat(pieces).equals(expected(fake))).toBe(true);
  });
});

describe('LabGPUMouth: the adapter served another voice', () => {
  it('throws the audio away unread and fails with `fallback`, however the header is valued', async () => {
    for (const fallback of [true, 'elevenlabs', '0', ''] as const) {
      const { fake, mouth } = await setup({ fallback });
      const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(pieces, `header ${JSON.stringify(fallback)}`).toEqual([]); // not one byte
      expectMouthError(error, 'fallback');
      expect(fake.requests).toHaveLength(1); // the adapter did see the request, and sent audio, which was dropped
      expect(fake.requests[0].bytesWritten).toBeGreaterThan(0);
    }
  });

  it('reports the fallback before it looks at the status', async () => {
    const { mouth } = await setup({ fallback: true, status: 500 });
    expectMouthError((await drain(mouth.synthesize(TEXT, { voice: VOICE }))).error, 'fallback');
  });

  it('drops the request of a fallback answer', async () => {
    const { fake, mouth } = await setup({ fallback: true, chunkDelayMs: 50 });
    await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    await fake.requests[0].closed;
    expect(fake.requests[0].aborted).toBe(true);
  });

  it('speaks normally the next time', async () => {
    const { fake, mouth } = await setup();
    fake.once({ fallback: true });
    expectMouthError((await drain(mouth.synthesize(TEXT, { voice: VOICE }))).error, 'fallback');
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(error).toBeUndefined();
    expect(Buffer.concat(pieces).equals(expected(fake))).toBe(true);
  });
});

describe('LabGPUMouth: audio that is not PCM', () => {
  it('fails with `bad-audio` for a body of odd length, after the whole samples', async () => {
    const { fake, mouth } = await setup({ oddByte: true });
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(Buffer.concat(pieces).equals(expected(fake))).toBe(true);
    expectMouthError(error, 'bad-audio');
  });

  it('fails with `bad-audio` for an empty body', async () => {
    const { mouth } = await setup({ empty: true });
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(pieces).toEqual([]);
    expectMouthError(error, 'bad-audio');
  });

  it('fails with `bad-audio` for an answer that says it is JSON or text, whatever the status', async () => {
    for (const contentType of ['application/json', 'text/html; charset=utf-8', 'text/plain']) {
      const { mouth } = await setup({ contentType });
      const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(pieces, contentType).toEqual([]);
      expectMouthError(error, 'bad-audio');
    }
  });

  it('accepts audio/* and application/octet-stream, and an answer that names no type', async () => {
    for (const contentType of ['audio/L16; rate=24000', 'audio/pcm', 'application/octet-stream']) {
      const { fake, mouth } = await setup({ contentType });
      const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(error, contentType).toBeUndefined();
      expect(Buffer.concat(pieces).equals(expected(fake))).toBe(true);
    }
    const audio = tonePcm(50);
    expect(Buffer.concat((await drain(offline([audio]).synthesize('Hi', { voice: VOICE }))).pieces).equals(audio)).toBe(true);
  });

  it('fails with `bad-audio` for a 200 answer with no body at all', async () => {
    const mouth = new LabGPUMouth({ baseUrl: 'http://127.0.0.1:1', fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch });
    expectMouthError((await drain(mouth.synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');
  });
});

describe('LabGPUMouth: a WAV body', () => {
  it('yields only the samples of the data chunk', async () => {
    const { fake, mouth } = await setup({ wav: {} });
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(error).toBeUndefined();
    expect(Buffer.concat(pieces).equals(expected(fake))).toBe(true);
  });

  it('copes with a LIST chunk before the data, an unknown data size and a chunk after the data', async () => {
    for (const wav of [{ extraChunk: true }, { unknownSize: true }, { trailingChunk: true }, { extraChunk: true, unknownSize: true }]) {
      const { fake, mouth } = await setup({ wav });
      const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(error, JSON.stringify(wav)).toBeUndefined();
      expect(Buffer.concat(pieces).equals(expected(fake)), JSON.stringify(wav)).toBe(true);
    }
  });

  it('copes with the header cut at every byte, and with odd chunks after it', async () => {
    const audio = tonePcm(300);
    for (const options of [{}, { extraChunk: true }, { unknownSize: true, extraChunk: true }]) {
      const wav = wavBytes(audio, options);
      const headerLength = wav.length - audio.length;
      for (let cut = 1; cut < headerLength + 3; cut++) {
        const mouth = offline([wav.subarray(0, cut), wav.subarray(cut, cut + 5), wav.subarray(cut + 5)]);
        const { pieces, error } = await drain(mouth.synthesize('Hi', { voice: VOICE }));
        expect(error, `${JSON.stringify(options)} cut at ${cut}`).toBeUndefined();
        expect(Buffer.concat(pieces).equals(audio), `${JSON.stringify(options)} cut at ${cut}`).toBe(true);
      }
    }
  });

  it('copes with a header that arrives one byte at a time', async () => {
    const audio = tonePcm(40);
    const wav = wavBytes(audio, { extraChunk: true });
    const mouth = offline(Array.from(wav, (b) => Uint8Array.of(b)));
    const { pieces, error } = await drain(mouth.synthesize('Hi', { voice: VOICE }));
    expect(error).toBeUndefined();
    expect(Buffer.concat(pieces).equals(audio)).toBe(true);
  });

  it('reads to the end when the data size announced is larger than what arrives', async () => {
    const audio = tonePcm(50);
    const wav = Buffer.from(wavBytes(audio));
    wav.writeUInt32LE(audio.length + 1000, wav.length - audio.length - 4); // the size field sits right before the audio
    const { pieces, error } = await drain(offline([wav]).synthesize('Hi', { voice: VOICE }));
    expect(error).toBeUndefined();
    expect(Buffer.concat(pieces).equals(audio)).toBe(true);
  });

  it('refuses a rate other than 24000, more than one channel, or a depth other than 16 bits, with `bad-audio` and no audio', async () => {
    for (const wav of [{ rate: 22_050 }, { rate: 16_000 }, { rate: 48_000 }, { channels: 2 }, { bits: 8 }, { bits: 24 }]) {
      const { mouth } = await setup({ wav });
      const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(pieces, JSON.stringify(wav)).toEqual([]);
      const e = expectMouthError(error, 'bad-audio');
      if ('rate' in wav) expect(e.message).toContain(String(wav.rate));
    }
  });

  it('refuses a RIFF that is not a WAVE, audio before the format, and a header that never ends', async () => {
    const audio = tonePcm(40);
    const good = wavBytes(audio);
    const notWave = Buffer.from(good);
    notWave.write('AVI ', 8, 'latin1');
    expectMouthError((await drain(offline([notWave]).synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');

    const noFormat = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.from('data'), Buffer.from([4, 0, 0, 0]), Buffer.from([1, 2, 3, 4])]);
    expectMouthError((await drain(offline([noFormat]).synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');

    const endless = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.from('junk'), Buffer.from([0xff, 0xff, 0xff, 0x7f])]);
    expectMouthError((await drain(offline([endless]).synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');

    const cut = good.subarray(0, 30); // the body ends inside the header
    expectMouthError((await drain(offline([cut]).synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');
  });

  it('fails with `bad-audio` for a WAV with a header and no audio, and for odd audio', async () => {
    expectMouthError((await drain(offline([wavBytes(Buffer.alloc(0))]).synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');
    const odd = await drain(offline([wavBytes(tonePcm(10)), Buffer.from([1])].map((b) => new Uint8Array(b))).synthesize('Hi', { voice: VOICE }));
    expect(Buffer.concat(odd.pieces).equals(tonePcm(10))).toBe(true); // the byte after a data chunk of known size is not audio: ignored
    expect(odd.error).toBeUndefined();
    const oddData = Buffer.concat([wavBytes(tonePcm(10), { unknownSize: true }), Buffer.from([1])]);
    expectMouthError((await drain(offline([oddData]).synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');
  });
});

describe('LabGPUMouth: DrBerg', () => {
  const FORBIDDEN = ['DrBerg', 'drberg', 'DRBERG', 'Dr_Berg', 'dr-berg', ' DrBerg ', 'Dr.Berg', 'DrBerg2', 'my_drberg_clone'];

  it('is refused by the check, whatever the spelling', () => {
    for (const voice of FORBIDDEN) {
      expect(() => checkLabGPUVoice(voice), JSON.stringify(voice)).toThrow(/DrBerg/);
    }
  });

  it('is refused in the options of the constructor, as a plain Error', () => {
    for (const voice of FORBIDDEN) {
      let thrown: unknown;
      try {
        new LabGPUMouth({ voices: ['af_bella', voice] });
      } catch (e) {
        thrown = e;
      }
      expect(thrown, JSON.stringify(voice)).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(MouthError);
    }
    expect(() => new LabGPUMouth({ voices: ['af_bella', 'af_heart', 'default'] })).not.toThrow();
  });

  it('is refused when asked for, from the first next(), as a plain Error, before any request', async () => {
    const { fake, mouth } = await setup();
    for (const voice of FORBIDDEN) {
      const { pieces, error } = await drain(mouth.synthesize('Hello there', { voice }));
      expect(pieces).toEqual([]);
      expect(error, JSON.stringify(voice)).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(MouthError); // a mistake in the settings, not a service that is down: the engine must not fall back to Aura on it
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('is not refused by the iterator when the call to synthesize() itself is made', async () => {
    const { mouth } = await setup();
    expect(() => mouth.synthesize('Hello', { voice: 'DrBerg' })).not.toThrow(); // it surfaces from the first next(), like every other failure
  });

  it('refuses a voice that is not a name at all', async () => {
    const { fake, mouth } = await setup();
    for (const voice of ['', 'af bella', '../etc', 'af_bella"', 'a'.repeat(65), undefined as unknown as string]) {
      const { error } = await drain(mouth.synthesize('Hello', { voice }));
      expect(error, JSON.stringify(voice)).toBeInstanceOf(Error);
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe('LabGPUMouth: errors say nothing they should not', () => {
  it('has no spoken text, header, body or address in any message of any failure', async () => {
    const scenarios: Array<[Partial<FakeTtsBehavior>, LabGPUMouthOptions]> = [
      [{ status: 500 }, {}],
      [{ status: 429 }, {}],
      [{ fallback: true }, {}],
      [{ fallback: 'elevenlabs', status: 503 }, {}],
      [{ oddByte: true }, {}],
      [{ empty: true }, {}],
      [{ wav: { rate: 8000 } }, {}],
      [{ contentType: 'application/json' }, {}],
      [{ stallBeforeHead: true }, { connectTimeoutMs: 80 }],
      [{ stallAfterHead: true }, { firstByteTimeoutMs: 80 }],
      [{ chunkDelayMs: 300 }, { firstByteTimeoutMs: 80 }],
      [{ chunkDelayMs: 60 }, { totalTimeoutMs: 100, firstByteTimeoutMs: 1000 }],
    ];
    for (const [behavior, options] of scenarios) {
      const { mouth } = await setup(behavior, options);
      const { error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(error, JSON.stringify(behavior)).toBeInstanceOf(MouthError);
      expectMouthError(error, (error as MouthError).kind);
    }
  });
});

describe('FakeTts: the stand-in itself', () => {
  it('answers /health and /voices the way the real adapter does', async () => {
    const fake = await FakeTts.start();
    fakes.push(fake);
    const health = await fetch(`${fake.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', engine: 'supertonic', backend: true, fallback: 'armed' });
    const voices = (await (await fetch(`${fake.url}/voices`)).json()) as { voices: string[] };
    expect(voices.voices).toEqual(expect.arrayContaining(['af_bella', 'af_heart', 'default', 'ef_dora', 'ff_siwis', 'jf_gongitsune', 'pf_dora', 'zf_xiaobei', 'DrBerg']));
    expect((await fetch(`${fake.url}/nothing`)).status).toBe(404);
    expect((await fetch(`${fake.url}/tts`, { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('speaks at the pace it is given: a sentence lasts words / wordsPerSecond', async () => {
    const text = 'one two three four five six seven eight nine ten';
    for (const wordsPerSecond of [2.69, 3.45, 5]) {
      const { fake, mouth } = await setup({ wordsPerSecond });
      const { pieces } = await drain(mouth.synthesize(text, { voice: VOICE }));
      const seconds = Buffer.concat(pieces).length / 2 / 24_000;
      expect(Math.abs(seconds - 10 / wordsPerSecond)).toBeLessThan(0.001);
      expect(fake.samplesFor(text)).toBe(Buffer.concat(pieces).length / 2);
    }
  });

  it('sends the same tone however it is cut into chunks, and records what it received', async () => {
    const { fake, mouth } = await setup();
    await drain(mouth.synthesize('Hello there', { voice: 'af_heart' }));
    expect(fake.requests[0]).toMatchObject({ method: 'POST', url: '/tts', text: 'Hello there', voice: 'af_heart', hasSpeed: false });
    expect(fake.pcmFor('Hello there').equals(tonePcm(fake.samplesFor('Hello there')))).toBe(true);
  });
});
