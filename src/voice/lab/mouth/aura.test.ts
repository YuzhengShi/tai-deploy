import { getEventListeners } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeAura, type FakeAuraBehavior } from '../testing/fake-aura.js';
import { BODY_MARKER, chunkedFetch, drain, loopbackOnlyFetch, tonePcm, wavBytes } from '../testing/fake-tts.js';
import { MouthError } from '../types.js';
import { AuraMouth, auraSpeedParam, type AuraMouthOptions } from './aura.js';

/** A sentence with words no message of the mouth may ever repeat. */
const TEXT = 'Zebrafish marmalade quietly orbits seventeen purple lanterns today';
const VOICE = 'aura-2-mars-en';
const KEY = 'dg-test-key-9f8e7d6c5b4a';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const fakes: FakeAura[] = [];
const guards: Array<{ blocked: string[] }> = [];

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
  expect(guards.splice(0).flatMap((g) => g.blocked), 'a request tried to leave 127.0.0.1').toEqual([]);
});

async function setup(
  behavior: Partial<FakeAuraBehavior> = {},
  options: Partial<AuraMouthOptions> = {},
  expectedKey?: string,
): Promise<{ fake: FakeAura; mouth: AuraMouth; fetchImpl: typeof fetch }> {
  const fake = await FakeAura.start(behavior, expectedKey);
  fakes.push(fake);
  const guard = loopbackOnlyFetch(); // a forgotten baseUrl fails the test instead of reaching api.deepgram.com
  guards.push(guard);
  return { fake, mouth: new AuraMouth({ apiKey: () => KEY, baseUrl: fake.url, fetchImpl: guard.fetchImpl, ...options }), fetchImpl: guard.fetchImpl };
}

function offline(chunks: Uint8Array[], init?: ResponseInit): AuraMouth {
  return new AuraMouth({ apiKey: () => KEY, baseUrl: 'http://127.0.0.1:1', fetchImpl: chunkedFetch(chunks, init) });
}

function expectMouthError(error: unknown, kind: MouthError['kind']): MouthError {
  expect(error).toBeInstanceOf(MouthError);
  const e = error as MouthError;
  expect(e.kind).toBe(kind);
  // never the key, the text spoken, the body of an error answer, or an address
  for (const secret of [KEY, 'dg-test-key', 'Zebrafish', 'marmalade', 'lanterns', BODY_MARKER, 'Token', 'Authorization', '127.0.0.1']) expect(e.message).not.toContain(secret);
  return e;
}

const expected = (fake: FakeAura, speed?: number): Buffer => fake.pcmFor(TEXT, speed);

describe('AuraMouth: what it is', () => {
  it('is the Aura mouth and takes a speed', () => {
    const mouth = new AuraMouth({ apiKey: () => KEY });
    expect(mouth.name).toBe('aura');
    expect(mouth.takesSpeed).toBe(true);
  });

  it('refuses options that make no sense', () => {
    expect(() => new AuraMouth({ apiKey: 'a string' as unknown as () => string })).toThrow(TypeError);
    expect(() => new AuraMouth({ apiKey: () => KEY, baseUrl: 'ftp://x' })).toThrow(TypeError);
    expect(() => new AuraMouth({ apiKey: () => KEY, baseUrl: 'not a url' })).toThrow(TypeError);
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => new AuraMouth({ apiKey: () => KEY, firstByteTimeoutMs: bad })).toThrow(RangeError);
      expect(() => new AuraMouth({ apiKey: () => KEY, totalTimeoutMs: bad })).toThrow(RangeError);
    }
  });
});

describe('AuraMouth: the request', () => {
  it('asks the way Deepgram wants it and yields the audio in pieces of whole samples', async () => {
    const { fake, mouth } = await setup({}, {}, KEY);
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(error).toBeUndefined();
    expect(Buffer.concat(pieces).equals(expected(fake))).toBe(true);
    for (const p of pieces) {
      expect(p.length).toBeGreaterThan(0);
      expect(p.length % 2).toBe(0);
    }
    expect(fake.violations).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/speak');
    expect(request.query).toEqual({ model: VOICE, encoding: 'linear16', sample_rate: '24000', container: 'none', mip_opt_out: 'true' });
    expect(request.authorization).toBe(`Token ${KEY}`);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.body).toEqual({ text: TEXT });
    await request.closed;
    expect(request.finished).toBe(true);
  });

  it('speaks with any voice that looks like an Aura one, and accepts a base URL with a trailing slash', async () => {
    const { fake, mouth, fetchImpl } = await setup();
    const slashed = new AuraMouth({ apiKey: () => KEY, baseUrl: `${fake.url}/`, fetchImpl });
    for (const voice of ['aura-2-thalia-en', 'aura-2-mars-en', 'aura-2-estrella-es']) {
      expect((await drain(mouth.synthesize('Hello there', { voice }))).error, voice).toBeUndefined();
      expect((await drain(slashed.synthesize('Hello there', { voice }))).error, voice).toBeUndefined();
    }
    expect(fake.violations).toEqual([]);
    expect(fake.requests.map((r) => r.model)).toEqual(['aura-2-thalia-en', 'aura-2-thalia-en', 'aura-2-mars-en', 'aura-2-mars-en', 'aura-2-estrella-es', 'aura-2-estrella-es']);
  });

  it('rejects a voice that does not look like an Aura one, before any request, with a plain Error', async () => {
    const { fake, mouth } = await setup();
    const bad = ['aura-2-thalia', 'thalia', 'aura-2-Thalia-en', 'aura-2-thalia-en&speed=2', 'aura-2-thalia-en#x', 'aura-2-thalia-en ', '../x', '', 'aura-2-thalia-eng', 'aura-2-thalia-e', 'aura-2--en', undefined as unknown as string];
    for (const voice of bad) {
      const { pieces, error } = await drain(mouth.synthesize('Hello there', { voice }));
      expect(pieces).toEqual([]);
      expect(error, JSON.stringify(voice)).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(MouthError); // a mistake in the settings, not a service that is down
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('yields nothing and sends nothing for a sentence with no text in it, and does not even read the key', async () => {
    let reads = 0;
    const { fake, mouth } = await setup({}, { apiKey: () => (reads++, KEY) });
    for (const text of ['', '   ', '\n']) expect(await drain(mouth.synthesize(text, { voice: VOICE }))).toEqual({ pieces: [], error: undefined });
    expect(fake.requests).toHaveLength(0);
    expect(reads).toBe(0);
  });

  it('can speak two sentences at the same time, each its own', async () => {
    const { fake, mouth } = await setup({ holdAfterChunks: 1 });
    const a = 'The first sentence is quite a bit longer than the other one';
    const b = 'Short one';
    const speaking = Promise.all([drain(mouth.synthesize(a, { voice: VOICE })), drain(mouth.synthesize(b, { voice: 'aura-2-thalia-en' }))]);
    await vi.waitFor(() => expect(fake.requests.filter((r) => r.chunksWritten >= 1)).toHaveLength(2)); // both in flight, each held after its first chunk
    fake.release();
    const [ra, rb] = await speaking;
    expect(Buffer.concat(ra.pieces).equals(fake.pcmFor(a, undefined))).toBe(true);
    expect(Buffer.concat(rb.pieces).equals(fake.pcmFor(b, undefined))).toBe(true);
  });

  it('does not leave a listener on the caller\'s signal, however many sentences it speaks', async () => {
    const { mouth } = await setup();
    const ctl = new AbortController();
    for (let i = 0; i < 5; i++) await drain(mouth.synthesize('Hello there', { voice: VOICE, signal: ctl.signal }));
    expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
  });
});

describe('AuraMouth: speed', () => {
  it('turns a pace into the speed parameter: clamped to 0.7 to 1.5, in steps of 0.05, and none when it comes to 1', () => {
    const table: Array<[number | undefined, string | undefined]> = [
      [undefined, undefined],
      [1, undefined],
      [NaN, undefined],
      [Infinity, undefined],
      [-Infinity, undefined],
      [1.02, undefined], // rounds to 1
      [0.98, undefined],
      [1.2, '1.2'],
      [1.15, '1.15'], // and not 1.1500000000000001
      [1.1, '1.1'],
      [1.05, '1.05'],
      [1.03, '1.05'],
      [1.07, '1.05'],
      [1.08, '1.1'],
      [0.9, '0.9'],
      [0.95, '0.95'],
      [2, '1.5'],
      [1.52, '1.5'],
      [0.5, '0.7'],
      [0.69, '0.7'],
      [0, '0.7'],
      [-3, '0.7'],
    ];
    for (const [speed, param] of table) expect(auraSpeedParam(speed), String(speed)).toBe(param);
  });

  it('sends the speed parameter when it is not 1, and none otherwise', async () => {
    const { fake, mouth } = await setup({ wordsPerSecond: 40 }, {}, KEY);
    for (const speed of [undefined, 1, NaN, 1.02, 1.2, 1.15, 2, 0.5]) await drain(mouth.synthesize('Hello there', { voice: VOICE, speed }));
    expect(fake.violations).toEqual([]);
    expect(fake.requests.map((r) => r.query.speed)).toEqual([undefined, undefined, undefined, undefined, '1.2', '1.15', '1.5', '0.7']);
    expect(fake.requests.map((r) => r.speed)).toEqual([undefined, undefined, undefined, undefined, 1.2, 1.15, 1.5, 0.7]);
  });
});

describe('AuraMouth: the key', () => {
  it('reads the key at every request, not once', async () => {
    let key = 'dg-key-one';
    let reads = 0;
    const { fake, mouth } = await setup({}, { apiKey: () => (reads++, key) });
    expect(reads).toBe(0); // not at construction
    await drain(mouth.synthesize('Hello there', { voice: VOICE }));
    key = 'dg-key-two';
    await drain(mouth.synthesize('Hello there', { voice: VOICE }));
    key = 'dg-key-three';
    await drain(mouth.synthesize('Hello there', { voice: VOICE }));
    expect(reads).toBe(3);
    expect(fake.requests.map((r) => r.authorization)).toEqual(['Token dg-key-one', 'Token dg-key-two', 'Token dg-key-three']);
  });

  it('follows a key that is changed while the process runs: refused with the old one, accepted with the new one', async () => {
    let key = 'dg-old-key';
    const { fake, mouth } = await setup({}, { apiKey: () => key }, 'dg-new-key');
    const refused = await drain(mouth.synthesize('Hello there', { voice: VOICE }));
    expect(refused.pieces).toEqual([]);
    expect((expectMouthError(refused.error, 'down')).message).toContain('401');
    key = 'dg-new-key';
    const accepted = await drain(mouth.synthesize('Hello there', { voice: VOICE }));
    expect(accepted.error).toBeUndefined();
    expect(accepted.pieces.length).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(2);
  });

  it('fails with `down` and fixed words when the key is not there, whatever the reason, and sends no request', async () => {
    const scenarios: Array<[string, () => string]> = [
      ['empty', () => ''],
      ['throws', () => {
        throw new Error(`secret-in-the-error ${KEY}`);
      }],
      ['a space in it', () => `${KEY} extra`],
      ['a newline in it', () => `${KEY}\nX-Evil: 1`],
      ['not a string', () => undefined as unknown as string],
    ];
    for (const [name, apiKey] of scenarios) {
      const { fake, mouth } = await setup({}, { apiKey });
      const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(pieces, name).toEqual([]);
      const e = expectMouthError(error, 'down');
      expect(e.message, name).not.toContain('secret-in-the-error');
      expect(e.message, name).not.toContain('X-Evil');
      expect(fake.requests, name).toHaveLength(0);
    }
  });
});

describe('AuraMouth: Deepgram is not there', () => {
  it('fails with `down` and the status code, and nothing of the answer, for 401, 429, 500 and 503', async () => {
    for (const status of [401, 429, 500, 503, 400]) {
      const { fake, mouth } = await setup({ status });
      const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(pieces).toEqual([]);
      expect(expectMouthError(error, 'down').message).toBe(`Aura answered HTTP ${status}`);
      expect(fake.requests).toHaveLength(1);
    }
  });

  it('fails with `down` from the first next() when the connection is refused', async () => {
    const { fake, mouth } = await setup();
    await fake.close();
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(pieces).toEqual([]);
    expect(expectMouthError(error, 'down').message).toMatch(/not reachable/);
  });

  it('fails with `down` when nothing answers (the head), after the time it was given', async () => {
    const { mouth } = await setup({ stallBeforeHead: true }, { firstByteTimeoutMs: 120 });
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

  it('fails with `down` after some audio when the stream goes silent between two chunks', async () => {
    const { mouth } = await setup({ chunkDelayMs: 400, chunkBytes: 20_000 }, { firstByteTimeoutMs: 120 });
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(pieces.length).toBeGreaterThanOrEqual(1);
    expect(expectMouthError(error, 'down').message).toMatch(/went silent for 120 ms/);
  });

  it('fails with `down` when the whole answer takes longer than the total time, but not because the consumer is slow', async () => {
    const slowStream = await setup({ chunkDelayMs: 40, chunkBytes: 20_000 }, { totalTimeoutMs: 100, firstByteTimeoutMs: 1000 });
    const late = await drain(slowStream.mouth.synthesize(TEXT, { voice: VOICE }));
    expect(late.pieces.length).toBeGreaterThanOrEqual(1);
    expect(expectMouthError(late.error, 'down').message).toMatch(/longer than 100 ms/);

    const { fake, mouth } = await setup({ chunkBytes: 16_000 }, { totalTimeoutMs: 400 });
    const pieces: Buffer[] = [];
    for await (const piece of mouth.synthesize(TEXT, { voice: VOICE })) {
      pieces.push(piece);
      await sleep(60); // a consumer at its own pace: the pieces take more than a second to be taken
    }
    expect(Buffer.concat(pieces).equals(expected(fake))).toBe(true);
  });
});

describe('AuraMouth: pieces and streaming', () => {
  it('yields the first piece while Deepgram is still sending the rest', async () => {
    const { fake, mouth } = await setup({ holdAfterChunks: 3 });
    const it = mouth.synthesize(TEXT, { voice: VOICE })[Symbol.asyncIterator]();
    const first = await it.next(); // everything after the third chunk is held until `release`
    expect(first.done).toBe(false);
    expect(fake.requests[0].finished).toBe(false);
    expect(fake.requests[0].chunksWritten).toBeLessThanOrEqual(3);
    fake.release();
    const pieces = [first.value as Buffer];
    for (let r = await it.next(); !r.done; r = await it.next()) pieces.push(r.value);
    expect(Buffer.concat(pieces).equals(expected(fake))).toBe(true);
  });

  it('cuts the audio into whole samples however the stream is split: odd chunks of every size', async () => {
    for (const chunkBytes of [1, 3, 7, 1001, 4097]) {
      const tiny = chunkBytes < 10;
      const { fake, mouth } = await setup({ chunkBytes, ...(tiny ? { wordsPerSecond: 20 } : {}) });
      const text = tiny ? 'Hi' : TEXT;
      const { pieces, error } = await drain(mouth.synthesize(text, { voice: VOICE }));
      expect(error, `chunk ${chunkBytes}`).toBeUndefined();
      expect(Buffer.concat(pieces).equals(fake.pcmFor(text, undefined)), `chunk ${chunkBytes}`).toBe(true);
      for (const p of pieces) {
        expect(p.length % 2, `chunk ${chunkBytes}`).toBe(0);
        expect(p.length).toBeGreaterThan(0);
      }
    }
  });

  it('makes whole samples out of one-byte chunks with no network at all, and handles the end like LabGPU\'s mouth does', async () => {
    const audio = tonePcm(200);
    const { pieces, error } = await drain(offline(Array.from(audio, (b) => Uint8Array.of(b))).synthesize('Hello there', { voice: VOICE }));
    expect(error).toBeUndefined();
    expect(Buffer.concat(pieces).equals(audio)).toBe(true);
    expectMouthError((await drain(offline([Uint8Array.of(1)]).synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');
    expectMouthError((await drain(offline([]).synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');
  });
});

describe('AuraMouth: abort', () => {
  it('ends quietly when the signal is aborted between two pieces, and drops the request', async () => {
    const { fake, mouth } = await setup({ holdAfterChunks: 3 });
    const ctl = new AbortController();
    const it = mouth.synthesize(TEXT, { voice: VOICE, signal: ctl.signal })[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    ctl.abort();
    expect(await it.next()).toEqual({ value: undefined, done: true });
    await fake.requests[0].closed;
    expect(fake.requests[0].aborted).toBe(true);
    expect(fake.requests[0].finished).toBe(false);
  });

  it('drops the request at once, also while nobody is asking for the next piece', async () => {
    const { fake, mouth } = await setup({ holdAfterChunks: 3 });
    const ctl = new AbortController();
    const it = mouth.synthesize(TEXT, { voice: VOICE, signal: ctl.signal })[Symbol.asyncIterator]();
    await it.next();
    ctl.abort();
    await fake.requests[0].closed;
    expect(fake.requests[0].aborted).toBe(true);
  });

  it('sends no request, and does not read the key, when the signal is aborted already', async () => {
    let reads = 0;
    const { fake, mouth } = await setup({}, { apiKey: () => (reads++, KEY) });
    const ctl = new AbortController();
    ctl.abort();
    expect(await drain(mouth.synthesize(TEXT, { voice: VOICE, signal: ctl.signal }))).toEqual({ pieces: [], error: undefined });
    expect(fake.requests).toHaveLength(0);
    expect(reads).toBe(0);
  });

  it('ends quietly when the signal is aborted while Deepgram has not answered yet', async () => {
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
    const { fake, mouth } = await setup({ holdAfterChunks: 3 });
    for await (const piece of mouth.synthesize(TEXT, { voice: VOICE })) {
      expect(piece.length).toBeGreaterThan(0);
      break;
    }
    await fake.requests[0].closed;
    expect(fake.requests[0].aborted).toBe(true);
  });
});

describe('AuraMouth: audio that is not PCM', () => {
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

  it('fails with `bad-audio` for an answer that says it is JSON or text', async () => {
    for (const contentType of ['application/json', 'text/plain']) {
      const { mouth } = await setup({ contentType });
      const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(pieces, contentType).toEqual([]);
      expectMouthError(error, 'bad-audio');
    }
  });

  it('unwraps a WAV if Deepgram ever sends one, and refuses it in another format', async () => {
    const audio = tonePcm(100);
    const ok = await drain(offline([wavBytes(audio)]).synthesize('Hi', { voice: VOICE }));
    expect(Buffer.concat(ok.pieces).equals(audio)).toBe(true);
    expectMouthError((await drain(offline([wavBytes(audio, { rate: 16_000 })]).synthesize('Hi', { voice: VOICE }))).error, 'bad-audio');
  });
});

describe('AuraMouth: errors say nothing they should not', () => {
  it('has no key, spoken text, header, body or address in any message of any failure', async () => {
    const scenarios: Array<[Partial<FakeAuraBehavior>, Partial<AuraMouthOptions>]> = [
      [{ status: 401 }, {}],
      [{ status: 429 }, {}],
      [{ status: 500 }, {}],
      [{ oddByte: true }, {}],
      [{ empty: true }, {}],
      [{ contentType: 'application/json' }, {}],
      [{ stallBeforeHead: true }, { firstByteTimeoutMs: 80 }],
      [{ stallAfterHead: true }, { firstByteTimeoutMs: 80 }],
      [{ chunkDelayMs: 300, chunkBytes: 20_000 }, { firstByteTimeoutMs: 80 }],
      [{ chunkDelayMs: 40, chunkBytes: 20_000 }, { totalTimeoutMs: 80, firstByteTimeoutMs: 1000 }],
    ];
    for (const [behavior, options] of scenarios) {
      const { mouth } = await setup(behavior, options);
      const { error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      expect(error, JSON.stringify(behavior)).toBeInstanceOf(MouthError);
      expectMouthError(error, (error as MouthError).kind);
    }
  });

  it('has no key in the message when the key itself is refused as the wrong one', async () => {
    const { mouth } = await setup({}, {}, 'some-other-key');
    const { error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expectMouthError(error, 'down');
  });
});

describe('FakeAura: the stand-in itself', () => {
  const GOOD = 'model=aura-2-mars-en&encoding=linear16&sample_rate=24000&container=none&mip_opt_out=true';
  const call = (fake: FakeAura, query: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${fake.url}/v1/speak?${query}`, {
      method: 'POST',
      headers: { Authorization: `Token ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello there' }),
      ...init,
    });

  it('accepts a request that follows every rule, and streams audio in many chunks', async () => {
    const fake = await FakeAura.start();
    fakes.push(fake);
    const res = await call(fake, `${GOOD}&speed=1.2`);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(fake.pcmFor('Hello there', 1.2))).toBe(true);
    expect(fake.violations).toEqual([]);
  });

  it('refuses, and records why, a request that breaks a rule of the real service', async () => {
    const fake = await FakeAura.start({}, KEY);
    fakes.push(fake);
    const bad: Array<[string, string, RequestInit | undefined, number, string]> = [
      ['a model that is not aura-2', GOOD.replace('aura-2-mars-en', 'nova-3'), undefined, 400, 'model'],
      ['another encoding', GOOD.replace('linear16', 'mp3'), undefined, 400, 'encoding'],
      ['another sample rate', GOOD.replace('24000', '16000'), undefined, 400, 'sample_rate'],
      ['a container', GOOD.replace('container=none', 'container=wav'), undefined, 400, 'container'],
      ['no mip_opt_out', GOOD.replace('&mip_opt_out=true', ''), undefined, 400, 'mip_opt_out'],
      ['an unknown parameter', `${GOOD}&tag=x`, undefined, 400, 'unknown parameter tag'],
      ['a speed out of range', `${GOOD}&speed=2`, undefined, 400, 'out of range'],
      ['a speed of 1', `${GOOD}&speed=1`, undefined, 400, 'speed=1'],
      ['another key', GOOD, { headers: { Authorization: 'Token not-the-key', 'content-type': 'application/json' } }, 401, 'Authorization'],
      ['no key', GOOD, { headers: { 'content-type': 'application/json' } }, 401, 'Authorization'],
      ['no JSON header', GOOD, { headers: { Authorization: `Token ${KEY}` } }, 400, 'content-type'],
      ['no text', GOOD, { body: JSON.stringify({}) }, 400, 'no text'],
      ['a body that is not JSON', GOOD, { body: 'plain' }, 400, 'not JSON'],
    ];
    for (const [name, query, init, status, fragment] of bad) {
      const before = fake.violations.length;
      const res = await call(fake, query, init);
      await res.arrayBuffer();
      expect(res.status, name).toBe(status);
      expect(fake.violations.slice(before).join(' | '), name).toContain(fragment);
    }
    const wrongRoute = await fetch(`${fake.url}/v1/listen?${GOOD}`, { method: 'POST', headers: { Authorization: `Token ${KEY}`, 'content-type': 'application/json' }, body: '{"text":"x"}' });
    await wrongRoute.arrayBuffer();
    expect(fake.violations.join(' | ')).toContain('wrong route');
  });
});
