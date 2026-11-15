import { afterEach, describe, expect, it } from 'vitest';

import { recordingLog, sleep, until } from '../testing/fake-asr.js';
import { FakeFluxTts, type FakeFluxTtsOptions } from '../testing/fake-flux-tts.js';
import { drain } from '../testing/fake-tts.js';
import { MouthError, type SpeechTurn } from '../types.js';
import { FluxTtsMouth, fluxExpressivityParam, fluxSpeedParam, type FluxTtsMouthOptions } from './flux.js';

/** A sentence with words no message of the mouth may ever repeat. */
const TEXT = 'Zebrafish marmalade quietly orbits seventeen purple lanterns today';
const VOICE = 'flux-hannah-en';
const KEY = 'dg-test-key-9f8e7d6c5b4a';
/** The fake's pace: 20 ms of audio per character and 40 ms per frame. */
const FAST: FakeFluxTtsOptions = { msPerChar: 20, frameAudioMs: 40, frameWallMs: 5, startDelayMs: 5 };
const BYTES_PER_MS = 48;

const fakes: FakeFluxTts[] = [];
const mouths: FluxTtsMouth[] = [];

afterEach(async () => {
  for (const m of mouths.splice(0)) m.close();
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

async function setup(behavior: FakeFluxTtsOptions = FAST, options: Partial<FluxTtsMouthOptions> = {}): Promise<{ fake: FakeFluxTts; mouth: FluxTtsMouth }> {
  const fake = await FakeFluxTts.start({ ...FAST, ...behavior });
  fakes.push(fake);
  const mouth = new FluxTtsMouth({ apiKey: () => KEY, baseUrl: fake.url, ...options });
  mouths.push(mouth);
  return { fake, mouth };
}

const total = (pieces: Buffer[]): number => pieces.reduce((n, p) => n + p.length, 0);
/** The bytes the fake makes for a text of this many characters (its own rounding: whole frames). */
const bytesFor = (chars: number, o: FakeFluxTtsOptions = FAST): number => Math.max(1, Math.ceil((chars * (o.msPerChar ?? 60)) / (o.frameAudioMs ?? 40))) * (o.frameAudioMs ?? 40) * BYTES_PER_MS;

function expectMouthError(error: unknown, kind: MouthError['kind']): MouthError {
  expect(error).toBeInstanceOf(MouthError);
  expect((error as MouthError).kind).toBe(kind);
  return error as MouthError;
}

/** What a reader of the audio got, collected in the background. */
function collect(turn: SpeechTurn): { done: Promise<{ pieces: Buffer[]; error: unknown }>; pieces: Buffer[] } {
  const pieces: Buffer[] = [];
  const done = (async () => {
    try {
      for await (const p of turn.audio) pieces.push(p);
      return { pieces, error: undefined };
    } catch (error) {
      return { pieces, error };
    }
  })();
  return { done, pieces };
}

describe('fluxSpeedParam', () => {
  it('is Flux\'s scale: 0.5 to 1.5 in steps of 0.05, and nothing for its own pace', () => {
    expect(fluxSpeedParam(undefined)).toBeUndefined();
    expect(fluxSpeedParam(Number.NaN)).toBeUndefined();
    expect(fluxSpeedParam(1)).toBeUndefined();
    expect(fluxSpeedParam(1.02)).toBeUndefined();
    expect(fluxSpeedParam(1.2)).toBe('1.2');
    expect(fluxSpeedParam(1.17)).toBe('1.15');
    expect(fluxSpeedParam(0.3)).toBe('0.5');
    expect(fluxSpeedParam(1.77)).toBe('1.5');
  });
});

describe('fluxExpressivityParam', () => {
  it('is Flux\'s beta scale: the whole numbers -2 to 2, and nothing for its own (0) or for anything else', () => {
    expect(fluxExpressivityParam(undefined)).toBeUndefined();
    expect(fluxExpressivityParam(0)).toBeUndefined();
    expect(fluxExpressivityParam(Number.NaN)).toBeUndefined();
    expect(fluxExpressivityParam(1.5)).toBeUndefined();
    expect(fluxExpressivityParam(3)).toBeUndefined();
    expect(fluxExpressivityParam(-3)).toBeUndefined();
    expect([-2, -1, 1, 2].map((v) => fluxExpressivityParam(v))).toEqual(['-2', '-1', '1', '2']);
  });
});

describe('FluxTtsMouth: one sentence as a speech of its own', () => {
  it('opens /v2/speak with the voice, linear16 at 24 kHz and the key in the header only, sends Speak (with a space after it) and Flush, and yields whole samples', async () => {
    const { fake, mouth } = await setup();
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(error).toBeUndefined();
    const c = fake.last;
    expect(c.authorization).toBe(`Token ${KEY}`);
    expect(c.url.pathname).toBe('/v2/speak');
    expect(c.query.get('model')).toBe(VOICE);
    expect(c.query.get('encoding')).toBe('linear16');
    expect(c.query.get('sample_rate')).toBe('24000');
    expect(c.query.get('mip_opt_out')).toBe('true');
    expect(c.url.toString()).not.toContain(KEY);
    expect(c.clientTypes()).toEqual(['Speak', 'Flush']);
    expect(c.speaks()).toEqual([`${TEXT} `]);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length % 2).toBe(0);
    expect(total(pieces)).toBe(bytesFor(TEXT.length + 1));
    expect(fake.violations).toEqual([]);
  });

  it('says nothing for an empty text and opens no connection', async () => {
    const { fake, mouth } = await setup();
    expect((await drain(mouth.synthesize('   ', { voice: VOICE }))).pieces).toEqual([]);
    expect(fake.connections).toHaveLength(0);
  });

  it('does not take a voice that is not a Flux one (it goes into a URL)', async () => {
    const { fake, mouth } = await setup();
    for (const voice of ['aura-2-thalia-en', 'flux-hannah-en&x=1', 'flux-Hannah-en', '../flux-hannah-en', '']) {
      expect(() => mouth.openTurn({ voice }), voice).toThrow(/voice/);
    }
    const { error } = await drain(mouth.synthesize(TEXT, { voice: 'aura-2-thalia-en' }));
    expect(error).toBeInstanceOf(Error);
    expect(fake.connections).toHaveLength(0);
  });

  it('an abort ends it quietly, with an interrupt when audio had begun', async () => {
    const { fake, mouth } = await setup({ ...FAST, frameWallMs: 20 });
    const ctl = new AbortController();
    const run = drain(mouth.synthesize(`${TEXT} ${TEXT} ${TEXT}`, { voice: VOICE, signal: ctl.signal }));
    await until(() => (fake.connections[0]?.turns[0]?.frames ?? 0) >= 3, 3000, 'audio');
    ctl.abort();
    const { pieces, error } = await run;
    expect(error).toBeUndefined();
    expect(pieces.length).toBeGreaterThan(0);
    await until(() => fake.last.interruptCount === 1, 2000, 'the interrupt');
  });
});

describe('FluxTtsMouth: a whole answer as ONE speech', () => {
  it('takes the sentences as they come into one turn: a Speak for each, one Flush, one stream of audio, and the length the service says', async () => {
    const { fake, mouth } = await setup();
    const turn = mouth.openTurn({ voice: VOICE });
    expect(turn.speak('First sentence here.')).toBe('First sentence here.');
    expect(turn.speak('And the second one.')).toBe('And the second one.');
    turn.end();
    const { pieces, error } = await drain(turn.audio);
    expect(error).toBeUndefined();
    const c = fake.last;
    expect(c.clientTypes()).toEqual(['Speak', 'Speak', 'Flush']);
    expect(c.speaks()).toEqual(['First sentence here. ', 'And the second one. ']);
    expect(c.turns).toHaveLength(1);
    expect(c.turnTexts()[0]).toBe('First sentence here. And the second one. ');
    expect(total(pieces)).toBe(bytesFor('First sentence here. And the second one. '.length));
    expect(turn.durationMs).toBe(total(pieces) / BYTES_PER_MS);
    expect(fake.violations).toEqual([]);
  });

  it('the audio begins before the text is complete when the service starts early, and ends when the last sentence has been spoken', async () => {
    const { fake, mouth } = await setup({ ...FAST, startBeforeFlush: true, frameWallMs: 10 });
    const turn = mouth.openTurn({ voice: VOICE });
    turn.speak('The first sentence is spoken at once.');
    const r = collect(turn);
    await until(() => r.pieces.length > 0, 3000, 'audio before the end of the text');
    expect(fake.last.clientTypes()).toEqual(['Speak']);
    turn.speak('A second one follows later on.');
    await sleep(30);
    turn.end();
    const { error } = await r.done;
    expect(error).toBeUndefined();
    expect(total(r.pieces)).toBeGreaterThanOrEqual(bytesFor('The first sentence is spoken at once. A second one follows later on. '.length) - 2 * 40 * BYTES_PER_MS);
  });

  it('speaks to the service only what it was given: nothing is sent for text that is empty, and no more text after the end', async () => {
    const { fake, mouth } = await setup();
    const turn = mouth.openTurn({ voice: VOICE });
    expect(turn.speak('   ')).toBe('');
    expect(turn.speak('Real words.')).toBe('Real words.');
    turn.end();
    expect(turn.speak('Too late.')).toBe('');
    turn.end();
    await drain(turn.audio);
    expect(fake.last.clientTypes()).toEqual(['Speak', 'Flush']);
  });

  it('two speeches in a row on one socket: the second waits behind the first and each reader gets its own audio', async () => {
    const { fake, mouth } = await setup();
    const a = mouth.openTurn({ voice: VOICE });
    a.speak('One.');
    a.end();
    const b = mouth.openTurn({ voice: VOICE });
    b.speak('Two two.');
    b.end();
    const [ra, rb] = await Promise.all([drain(a.audio), drain(b.audio)]);
    expect(fake.connections).toHaveLength(1);
    expect(total(ra.pieces)).toBe(bytesFor('One. '.length));
    expect(total(rb.pieces)).toBe(bytesFor('Two two. '.length));
    expect(fake.last.turns.map((t) => t.index)).toEqual([0, 1]);
  });

  it('opens the socket ahead of the first speech when asked, and reuses it', async () => {
    const { fake, mouth } = await setup();
    mouth.prepare({ voice: VOICE });
    await until(() => fake.connections.length === 1, 2000, 'the connection');
    await drain(mouth.synthesize('Hello there.', { voice: VOICE }));
    expect(fake.connections).toHaveLength(1);
  });

  it('a change of pace goes to the service as Configure, and the first pace is in the address', async () => {
    const { fake, mouth } = await setup();
    await drain(mouth.synthesize('Faster now.', { voice: VOICE, speed: 1.2 }));
    expect(fake.last.query.get('speed')).toBe('1.2');
    await drain(mouth.synthesize('Slower now.', { voice: VOICE, speed: 0.8 }));
    expect(fake.connections).toHaveLength(1);
    expect(fake.last.clientTypes()).toContain('Configure');
    expect(fake.last.configuredSpeed).toBe(0.8);
    expect(fake.violations).toEqual([]);
  });

  it('the expressivity is in the address (the service has no Configure for it): nothing is added for 0 or for a value out of range, the same value keeps the socket and another value is another socket', async () => {
    const { fake, mouth } = await setup();
    await drain(mouth.synthesize('Plain.', { voice: VOICE, speed: 1.2, expressivity: 0 }));
    expect(fake.last.query.has('expressivity')).toBe(false);
    await drain(mouth.synthesize('Out of range.', { voice: VOICE, speed: 1.2, expressivity: 5 }));
    expect(fake.connections).toHaveLength(1);                                    // 5 is dropped, so it is the same as none: the same socket
    await drain(mouth.synthesize('Livelier.', { voice: VOICE, speed: 1.2, expressivity: 1 }));
    expect(fake.connections).toHaveLength(2);
    expect(fake.last.query.get('expressivity')).toBe('1');
    expect(fake.last.query.get('speed')).toBe('1.2');
    await until(() => fake.connections[0].closed, 2000, 'the first socket closed');
    await drain(mouth.synthesize('Livelier again.', { voice: VOICE, speed: 1.2, expressivity: 1 }));
    expect(fake.connections).toHaveLength(2);
    expect(fake.last.clientTypes()).not.toContain('Configure');
    await drain(mouth.synthesize('Calmer.', { voice: VOICE, speed: 1.2, expressivity: -2 }));
    expect(fake.connections).toHaveLength(3);
    expect(fake.last.query.get('expressivity')).toBe('-2');
    expect(fake.violations).toEqual([]);
  });

  it('another voice is another socket, and the first one is closed', async () => {
    const { fake, mouth } = await setup();
    await drain(mouth.synthesize('One voice.', { voice: VOICE }));
    await drain(mouth.synthesize('Another voice.', { voice: 'flux-miles-en' }));
    expect(fake.connections).toHaveLength(2);
    expect(fake.connections[1].query.get('model')).toBe('flux-miles-en');
    await until(() => fake.connections[0].closed, 2000, 'the first socket closed');
  });
});

describe('FluxTtsMouth: the student speaks', () => {
  const LONG = 'In Raft the leader sends heartbeats to the followers and when a follower stops hearing them it starts a new election after a random timeout.';

  it('cuts the speech with the offset of what had played and answers with the words that were heard, cut at a word; the socket is kept', async () => {
    const { fake, mouth } = await setup({ ...FAST, frameWallMs: 20 });
    const turn = mouth.openTurn({ voice: VOICE });
    turn.speak(LONG);
    turn.end();
    const r = collect(turn);
    await until(() => r.pieces.length >= 5, 3000, 'audio');
    const split = await turn.interrupt(400);
    const c = fake.last;
    expect(c.interruptCount).toBe(1);
    const sent = c.textsOfType('Interrupt')[0].json as { playback_offset: { type: string; value: number } };
    expect(sent.playback_offset).toEqual({ type: 'time_ms', value: 400 });
    expect(split).not.toBeNull();
    expect(split!.spoken.length).toBeGreaterThan(0);
    expect(split!.remaining.length).toBeGreaterThan(0);
    expect(LONG.startsWith(split!.spoken)).toBe(true);
    expect(`${split!.spoken} ${split!.remaining}`.replace(/\s+/g, ' ').trim()).toBe(LONG);
    expect(/\s/.test(LONG[split!.spoken.length] ?? ' ')).toBe(true);                  // a whole word
    const { error } = await r.done;
    expect(error).toBeUndefined();                                                   // ended quietly
    // the socket is usable for the next speech, which is made after the interrupted one
    const next = await drain(mouth.synthesize('Okay, go on.', { voice: VOICE }));
    expect(next.error).toBeUndefined();
    expect(next.pieces.length).toBeGreaterThan(0);
    expect(fake.connections).toHaveLength(1);
  });

  it('counts the offset on the audio the socket has made, so that a second interrupt asks for more than the first and nothing is refused', async () => {
    const { fake, mouth } = await setup({ ...FAST, frameWallMs: 15 });
    const offsets: number[] = [];
    for (let i = 0; i < 3; i++) {
      const turn = mouth.openTurn({ voice: VOICE });
      turn.speak(LONG);
      turn.end();
      const r = collect(turn);
      await until(() => r.pieces.length >= 6, 3000, `audio of speech ${i}`);
      expect(await turn.interrupt(150)).not.toBeNull();
      await r.done;
      offsets.push((fake.last.textsOfType('Interrupt')[i].json as { playback_offset: { value: number } }).playback_offset.value);
    }
    expect(offsets[1]).toBeGreaterThan(offsets[0]);
    expect(offsets[2]).toBeGreaterThan(offsets[1]);
    expect(offsets[1]).toBeGreaterThan(150 + 5 * 40);                                // more than what was played of the second: it began after the audio the first one had made
    expect(fake.connections).toHaveLength(1);
    expect(fake.violations).toEqual([]);
  });

  it('drops the speeches queued behind the one that is cut, and what the service made of the dropped ones never reaches a reader', async () => {
    const { fake, mouth } = await setup({ ...FAST, frameWallMs: 20 });
    const a = mouth.openTurn({ voice: VOICE });
    a.speak(LONG);
    a.end();
    const b = mouth.openTurn({ voice: VOICE });
    b.speak('Never spoken.');
    b.end();
    const ra = collect(a);
    const rb = collect(b);
    await until(() => ra.pieces.length >= 4, 3000, 'audio of the first');
    await a.interrupt(100);
    const [x, y] = await Promise.all([ra.done, rb.done]);
    expect(x.error).toBeUndefined();
    expect(y.error).toBeUndefined();
    expect(y.pieces).toEqual([]);
    expect(fake.connections).toHaveLength(1);
  });

  it('nothing made yet: the service would ignore an interrupt, so the connection is dropped and the next speech opens another', async () => {
    const { fake, mouth } = await setup({ ...FAST, startDelayMs: 600 });
    const turn = mouth.openTurn({ voice: VOICE });
    turn.speak(LONG);
    turn.end();
    const r = collect(turn);
    await until(() => fake.connections.length === 1, 2000, 'the connection');
    await sleep(60);
    expect(await turn.interrupt(0)).toBeNull();
    expect((await r.done).error).toBeUndefined();
    expect(fake.last.interruptCount).toBe(0);
    await until(() => fake.connections[0].closed, 2000, 'the connection dropped');
    const next = await drain(mouth.synthesize('Fresh start.', { voice: VOICE }));
    expect(next.pieces.length).toBeGreaterThan(0);
    expect(fake.connections).toHaveLength(2);
  });

  it('an interrupt that is never answered drops the connection after the wait', async () => {
    const { fake, mouth } = await setup({ ...FAST, frameWallMs: 20, ignoreInterrupt: true }, { interruptWaitMs: 150 });
    const turn = mouth.openTurn({ voice: VOICE });
    turn.speak(LONG);
    turn.end();
    const r = collect(turn);
    await until(() => r.pieces.length >= 3, 3000, 'audio');
    expect(await turn.interrupt(100)).toBeNull();
    await until(() => fake.connections[0].closed, 2000, 'the connection dropped');
    expect((await r.done).error).toBeUndefined();
  });

  it('a speech that has already been completed has nothing to cut', async () => {
    const { mouth } = await setup();
    const turn = mouth.openTurn({ voice: VOICE });
    turn.speak('Short one.');
    turn.end();
    await drain(turn.audio);
    expect(await turn.interrupt(100)).toBeNull();
  });
});

describe('FluxTtsMouth: when it fails', () => {
  it('a connection that goes away in the middle of a speech: the audio that came is delivered, then `down`', async () => {
    const { mouth } = await setup({ ...FAST, dropTurn: 0, dropAfterFrames: 3 });
    const { pieces, error } = await drain(mouth.synthesize(LONG_TEXT, { voice: VOICE }));
    expect(pieces.length).toBe(3);
    expectMouthError(error, 'down');
  });

  it('a service that begins a speech and then says nothing is given up after the stall, as `down`', async () => {
    const { mouth } = await setup({ ...FAST, silentTurn: 0 }, { stallMs: 300 });
    const { pieces, error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expect(pieces).toEqual([]);
    expectMouthError(error, 'down');
  }, 8000);

  it('a fatal error message is `down` with its code and nothing else of what the service said, and never the text', async () => {
    const { mouth } = await setup({ ...FAST, errorOnSpeak: true });
    const { error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    const e = expectMouthError(error, 'down');
    expect(e.message).toContain('MESSAGE-0000');
    expect(e.message).not.toContain('told to fail');
    for (const word of TEXT.split(' ')) expect(e.message).not.toContain(word);
  });

  it('a refused handshake is `down` with the HTTP status, and the key is nowhere in the message', async () => {
    const { mouth } = await setup({ ...FAST, refuseUpgrade: 403 });
    const { error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    const e = expectMouthError(error, 'down');
    expect(e.message).toContain('403');
    expect(e.message).not.toContain(KEY);
  });

  it('a service that does not answer the handshake is given up after the connect timeout', async () => {
    const { mouth } = await setup({ ...FAST, delayHandshakeMs: Infinity }, { connectTimeoutMs: 200 });
    const { error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    expectMouthError(error, 'down');
  });

  it('no key: `down` with fixed words, and no connection is made', async () => {
    const fake = await FakeFluxTts.start(FAST);
    fakes.push(fake);
    for (const apiKey of [() => '', () => 'has a space', () => { throw new Error(`secret ${KEY}`); }]) {
      const mouth = new FluxTtsMouth({ apiKey, baseUrl: fake.url });
      mouths.push(mouth);
      const { error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
      const e = expectMouthError(error, 'down');
      expect(e.message).toBe('the Deepgram key is not available');
    }
    expect(fake.connections).toHaveLength(0);
  });

  it('a key the service does not know: the connection is closed and the speech fails as `down`, without the key in the message', async () => {
    const { fake, mouth } = await setup({ ...FAST, expectedKey: 'another-key' });
    const { error } = await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    const e = expectMouthError(error, 'down');
    expect(e.message).not.toContain(KEY);
    expect(fake.refusedCount).toBe(1);
  });

  it('after a failure the next speech opens a new connection', async () => {
    const { fake, mouth } = await setup({ ...FAST, dropTurn: 0, dropAfterFrames: 2, misbehaveFirst: 1 });
    await drain(mouth.synthesize(LONG_TEXT, { voice: VOICE }));
    const next = await drain(mouth.synthesize('Second try.', { voice: VOICE }));
    expect(next.error).toBeUndefined();
    expect(next.pieces.length).toBeGreaterThan(0);
    expect(fake.connections).toHaveLength(2);
  });

  it('writes no key and no text into a log line, whatever happens', async () => {
    const rec = recordingLog();
    const { mouth } = await setup({ ...FAST, frameWallMs: 20 }, { log: rec.log, interruptWaitMs: 100 });
    const turn = mouth.openTurn({ voice: VOICE });
    turn.speak(TEXT);
    turn.end();
    const r = collect(turn);
    await until(() => r.pieces.length >= 2, 3000, 'audio');
    await turn.interrupt(50);
    await r.done;
    await drain(mouth.synthesize(TEXT, { voice: VOICE }));
    const dump = rec.dump();
    expect(dump).not.toContain(KEY);
    for (const word of TEXT.split(' ')) expect(dump).not.toContain(word);
  });
});

describe('FluxTtsMouth: the end of the call', () => {
  it('close() sends Close and ends the socket; what was owed ends quietly; a later speech would open another socket', async () => {
    const { fake, mouth } = await setup({ ...FAST, frameWallMs: 20 });
    const turn = mouth.openTurn({ voice: VOICE });
    turn.speak(LONG_TEXT);
    turn.end();
    const r = collect(turn);
    await until(() => r.pieces.length >= 2, 3000, 'audio');
    mouth.close();
    expect((await r.done).error).toBeUndefined();
    await until(() => fake.connections[0].closed, 3000, 'the socket closed');
    expect(fake.connections[0].clientTypes()).toContain('Close');
    const next = await drain(mouth.synthesize('Hello again.', { voice: VOICE }));
    expect(next.pieces.length).toBeGreaterThan(0);
    expect(fake.connections).toHaveLength(2);
  });
});

const LONG_TEXT = `${TEXT} ${TEXT} ${TEXT} ${TEXT}`;
