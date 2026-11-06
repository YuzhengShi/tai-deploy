// The call's audio arithmetic, at the rates real devices run at (the browser suite only sees the rate of the machine it runs on): the
// capture worklet must hand over 16 kHz frames of 640 samples, 25 a second, at the pitch that went in; the playback resampler must join
// TAi's chunks without a seam, whatever their sizes.
import { beforeAll, describe, expect, it } from 'vitest';

import { createWarmer, followLevel, resample, rmsOf, startMessage, warmRequest } from './voice.js';

const sine = (n, rate, freq, amp = 1) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

function crossings(samples) {
  let count = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 !== samples[i] < 0) count++;
  return count;
}

describe('the capture worklet', () => {
  let Processor;

  beforeAll(async () => {
    // what an AudioWorkletGlobalScope gives a processor
    globalThis.AudioWorkletProcessor = class {
      constructor() {
        this.port = { posted: [], postMessage(message) { this.posted.push(message); } };
      }
    };
    globalThis.registerProcessor = (name, cls) => {
      if (name === 'tai-capture') Processor = cls;
    };
    await import('./voice-worklet.js');
  });

  for (const rate of [48000, 44100, 16000]) {
    it(`turns ${rate} Hz into 16 kHz PCM16 frames of 1280 bytes, 25 a second, at the pitch that went in`, () => {
      globalThis.sampleRate = rate;
      const capture = new Processor({ processorOptions: { rate: 16000, frame: 640 } });
      const input = sine(rate * 2, rate, 440, 0.5);
      for (let at = 0; at + 128 <= input.length; at += 128) expect(capture.process([[input.subarray(at, at + 128)]])).toBe(true);
      const frames = capture.port.posted;
      expect(frames.length).toBeGreaterThanOrEqual(49);
      expect(frames.length).toBeLessThanOrEqual(50);
      for (const frame of frames) expect(frame.pcm.byteLength).toBe(1280);
      const samples = Float32Array.from(frames.flatMap((f) => [...new Int16Array(f.pcm)]).map((v) => v / 32768));
      const seconds = samples.length / 16000;
      expect(crossings(samples) / 2 / seconds).toBeGreaterThan(436);
      expect(crossings(samples) / 2 / seconds).toBeLessThan(444);
      // the loudness that comes with each frame: a sine of 0.5 has an RMS of 0.354 (the filter settles within the first frame)
      expect(frames[10].level).toBeGreaterThan(0.33);
      expect(frames[10].level).toBeLessThan(0.37);
    });
  }

  it('keeps running without a microphone, and says nothing', () => {
    globalThis.sampleRate = 48000;
    const capture = new Processor({ processorOptions: {} });
    expect(capture.process([[]])).toBe(true);
    expect(capture.process([])).toBe(true);
    expect(capture.port.posted).toEqual([]);
  });
});

describe('the playback resampler (TAi speaks at 24 kHz)', () => {
  for (const rate of [48000, 44100]) {
    it(`joins chunks of any size without a seam at ${rate} Hz`, () => {
      const input = sine(24000, 24000, 330);
      const whole = resample({ pos: 0, prev: 0 }, input, 24000 / rate);
      const state = { pos: 0, prev: 0 };
      const joined = [];
      const sizes = [480, 1201, 2399, 960, 7];
      for (let at = 0, k = 0; at < input.length; k++) {
        joined.push(...resample(state, input.subarray(at, at + sizes[k % sizes.length]), 24000 / rate));
        at += sizes[k % sizes.length];
      }
      expect(joined.length).toBe(whole.length);
      let worst = 0;
      for (let i = 0; i < whole.length; i++) worst = Math.max(worst, Math.abs(joined[i] - whole[i]));
      expect(worst).toBeLessThan(1e-6);
      expect(Math.abs(whole.length - rate)).toBeLessThanOrEqual(2);              // a second in, a second out
      expect(crossings(whole) / 2).toBeGreaterThan(326);                          // and the pitch it had
      expect(crossings(whole) / 2).toBeLessThan(334);
    });
  }

  it('hands a stream at its own rate over as it is', () => {
    const input = sine(100, 24000, 330);
    expect(resample({ pos: 0, prev: 0 }, input, 1)).toBe(input);
  });
});

describe('the first message of a call', () => {
  it('is a plain call, an interview with its link\'s token, or "Talk it through" with the topic it was started for', () => {
    expect(startMessage({ mode: 'chat' })).toEqual({ type: 'start', mode: 'chat' });
    expect(startMessage({ mode: 'interview', token: 'abc.def' })).toEqual({ type: 'start', mode: 'interview', token: 'abc.def' });
    expect(startMessage({ mode: 'talk' })).toEqual({ type: 'start', mode: 'talk' });
    expect(startMessage({ mode: 'talk', topic: '  how Raft elects a leader ' })).toEqual({ type: 'start', mode: 'talk', topic: 'how Raft elects a leader' });
  });

  it('carries a token only for an interview and a topic only for "Talk it through"', () => {
    expect(startMessage({ mode: 'chat', token: 'abc', topic: 'Raft' })).toEqual({ type: 'start', mode: 'chat' });
    expect(startMessage({ mode: 'talk', token: 'abc', topic: '' })).toEqual({ type: 'start', mode: 'talk' });
    expect(startMessage({ mode: 'interview', topic: 'Raft' })).toEqual({ type: 'start', mode: 'interview' });
  });

  it('keeps a topic to 200 characters', () => {
    expect(startMessage({ mode: 'talk', topic: 'x'.repeat(500) }).topic).toHaveLength(200);
  });

  it('says only that a dropped call is being taken up again: it has its kind already', () => {
    expect(startMessage({ mode: 'talk', topic: 'Raft' }, true)).toEqual({ type: 'start', mode: 'talk', resume: true });
    expect(startMessage({ mode: 'interview', token: 'abc' }, true)).toEqual({ type: 'start', mode: 'interview', resume: true });
    expect(startMessage({ mode: 'chat' }, true)).toEqual({ type: 'start', mode: 'chat', resume: true });
  });
});

describe('telling the server a call is coming (the warm-up of the call\'s tool host)', () => {
  it('is a POST of an empty JSON body to api/voice/warm under the page\'s base, with the page\'s header, from its own origin', () => {
    const { url, init } = warmRequest('https://tai.example/tai/');
    expect(url).toBe('https://tai.example/tai/api/voice/warm');
    expect(init).toMatchObject({ method: 'POST', body: '{}', credentials: 'same-origin' });
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-tai': '1' });
    expect(warmRequest('http://127.0.0.1:8840/').url).toBe('http://127.0.0.1:8840/api/voice/warm');
    expect(warmRequest('https://tai.example/tai/index.html').url).toBe('https://tai.example/tai/api/voice/warm'); // a page opened with a file name
  });

  it('is sent once for a burst of presses, and again after a while: the server allows one a minute, and the page need not ask more often than half of that', () => {
    const sent = [];
    let clock = 1_000_000;
    const warm = createWarmer({ fetchImpl: (url, init) => { sent.push([url, init.method]); return Promise.resolve({ ok: true }); }, base: () => 'https://tai.example/tai/', now: () => clock });
    warm();
    warm();
    clock += 10_000;
    warm();
    expect(sent).toEqual([['https://tai.example/tai/api/voice/warm', 'POST']]);
    clock += 25_000; // thirty-five seconds since the first
    warm();
    expect(sent).toHaveLength(2);
  });

  it('never gets in the way of a call: a request that fails, a fetch that throws, no fetch and no base are all silent', async () => {
    const failing = createWarmer({ fetchImpl: () => Promise.reject(new Error('offline')), base: () => 'https://tai.example/' });
    expect(() => failing()).not.toThrow();
    const throwing = createWarmer({ fetchImpl: () => { throw new Error('blocked'); }, base: () => 'https://tai.example/' });
    expect(() => throwing()).not.toThrow();
    expect(() => createWarmer({ fetchImpl: undefined, base: () => 'https://tai.example/' })()).not.toThrow();
    expect(() => createWarmer({ fetchImpl: () => Promise.resolve(), base: () => { throw new Error('no document'); } })()).not.toThrow();
    // and an unhandled rejection would fail the run: give the rejected promise its turn
    await new Promise((r) => setTimeout(r, 5));
  });

  it('does not wait for the answer: it returns before the server has said anything', () => {
    let answered = false;
    const warm = createWarmer({ fetchImpl: () => new Promise((resolve) => setTimeout(() => { answered = true; resolve({}); }, 50)), base: () => 'https://tai.example/' });
    warm();
    expect(answered).toBe(false);
  });
});

describe('the level the orb shows', () => {
  it('is the loudness of the samples: a full sine is about 0.71, silence is 0', () => {
    expect(rmsOf(sine(4800, 48000, 440))).toBeCloseTo(Math.SQRT1_2, 2);
    expect(rmsOf(sine(4800, 48000, 440, 0.2))).toBeCloseTo(0.2 * Math.SQRT1_2, 2);
    expect(rmsOf(new Float32Array(1024))).toBe(0);
    expect(rmsOf(new Float32Array(0))).toBe(0);
    expect(rmsOf(undefined)).toBe(0);
  });

  it('rises at once and falls at a pace, and stays between 0 and 1', () => {
    expect(followLevel(0, 0.6)).toBe(0.6);
    const down = followLevel(0.6, 0);
    expect(down).toBeGreaterThan(0.4);
    expect(down).toBeLessThan(0.6);
    let level = 1;
    for (let i = 0; i < 60; i++) level = followLevel(level, 0);
    expect(level).toBeLessThan(0.001);
    expect(followLevel(0.2, 7)).toBe(1);
    expect(followLevel(0.2, -3)).toBeLessThan(0.2);
    expect(followLevel(0, NaN)).toBe(0);
  });
});
