import { describe, expect, it } from 'vitest';

import { stretch, stretchFactorFor } from './tempo.js';

const RATE = 24_000;

/** A seeded generator, so a failure can be repeated. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toBuffer(samples: ArrayLike<number>): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]))), 2 * i);
  return b;
}

/** Read by `readInt16LE`: a Buffer made by the stretcher or sliced from a pool may sit at an odd byte offset. */
function toSamples(b: Buffer): Float64Array {
  const out = new Float64Array(b.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(2 * i);
  return out;
}

function sine(freq: number, seconds: number, amplitude = 12_000, rate = RATE): Buffer {
  const n = Math.round(seconds * rate);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  return toBuffer(s);
}

/** Voiced-speech-like: a 140 Hz tone with two harmonics under a slow envelope, a quiet gap, and a burst of smoothed noise (a fricative) in the middle. */
function speechLike(seconds: number, rate = RATE): Buffer {
  const rand = mulberry32(7);
  const n = Math.round(seconds * rate);
  const noise = new Float64Array(n);
  for (let i = 0; i < n; i++) noise[i] = rand() * 2 - 1;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const envelope = 0.5 - 0.5 * Math.cos(2 * Math.PI * 2.5 * t);
    const voiced = Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t) + 0.25 * Math.sin(2 * Math.PI * 420 * t);
    s[i] = 6000 * envelope * voiced;
    const inBurst = t > seconds * 0.45 && t < seconds * 0.45 + 0.12;
    if (inBurst) {
      let smooth = 0;
      for (let k = 0; k < 8; k++) smooth += noise[Math.max(0, i - k)];
      s[i] += 2500 * (smooth / 8) * 3;
    }
  }
  return toBuffer(s);
}

/** Positive-going zero crossings of a sine, over its whole length: the frequency in Hz. */
function frequencyOf(s: Float64Array, rate: number): number {
  const crossings: number[] = [];
  for (let i = 1; i < s.length; i++) if (s[i - 1] < 0 && s[i] >= 0) crossings.push(i);
  if (crossings.length < 3) return 0;
  return ((crossings.length - 1) * rate) / (crossings[crossings.length - 1] - crossings[0]);
}

function rms(s: Float64Array, from = 0, to = s.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** The lag (in samples) of the strongest autocorrelation between 60 and 400 Hz: the pitch period of a voiced signal. */
function pitchPeriod(s: Float64Array, rate: number, from: number, to: number): number {
  let best = 0;
  let bestLag = 0;
  for (let lag = Math.floor(rate / 400); lag <= Math.floor(rate / 60); lag++) {
    let dot = 0;
    for (let i = from; i + lag < to; i++) dot += s[i] * s[i + lag];
    if (dot > best) {
      best = dot;
      bestLag = lag;
    }
  }
  return bestLag;
}

/**
 * The click detector: the worst ratio between one sample-to-sample step and the RMS step of its neighbours (+-5 ms, the step itself left out). A smooth
 * waveform stays near the ratio of its own shape; a click or a badly joined splice is a step far larger than its surroundings.
 */
function worstStepRatio(s: Float64Array, rate: number): number {
  const w = Math.round(rate * 0.005);
  const d = new Float64Array(s.length - 1);
  for (let i = 0; i < d.length; i++) d[i] = s[i + 1] - s[i];
  const prefix = new Float64Array(d.length + 1);
  for (let i = 0; i < d.length; i++) prefix[i + 1] = prefix[i] + d[i] * d[i];
  let worst = 0;
  for (let i = w; i < d.length - w; i++) {
    const around = prefix[i + w + 1] - prefix[i - w] - d[i] * d[i];
    const ratio = Math.abs(d[i]) / (Math.sqrt(around / (2 * w)) + 20); // +20: digital silence must not make a step of 1 look huge
    if (ratio > worst) worst = ratio;
  }
  return worst;
}

describe('stretchFactorFor', () => {
  it('is the ratio of the target pace to the current one: LabGPU at 2.69 words a second to the live 3.45', () => {
    expect(stretchFactorFor(2.69, 3.45)).toBeCloseTo(1.2825, 3);
  });

  it('never slows a voice down, and never goes beyond 1.5', () => {
    expect(stretchFactorFor(3.5, 3)).toBe(1);
    expect(stretchFactorFor(3.45, 3.45)).toBe(1);
    expect(stretchFactorFor(1, 3)).toBe(1.5);
  });

  it('is 1 for a pace that makes no sense', () => {
    for (const [a, b] of [[0, 3], [3, 0], [-1, 3], [NaN, 3], [3, NaN], [Infinity, 3], [3, Infinity]]) expect(stretchFactorFor(a, b)).toBe(1);
  });
});

describe('stretch: the arguments', () => {
  const pcm = sine(200, 0.5);

  it('refuses a factor outside 0.5 to 2 and a sample rate that cannot be speech', () => {
    for (const f of [0.49, 2.01, 0, -1, NaN, Infinity]) expect(() => stretch(pcm, RATE, f), String(f)).toThrow(RangeError);
    for (const r of [0, 100, NaN, 1e9]) expect(() => stretch(pcm, r, 1.2), String(r)).toThrow(RangeError);
  });

  it('gives a copy for factor 1, never the same Buffer, and ignores a stray odd byte', () => {
    const out = stretch(pcm, RATE, 1);
    expect(out.equals(pcm)).toBe(true);
    expect(out).not.toBe(pcm);
    out[0] ^= 0xff;
    expect(out.equals(pcm)).toBe(false);
    const odd = Buffer.concat([pcm, Buffer.from([7])]);
    expect(stretch(odd, RATE, 1).length).toBe(pcm.length);
    expect(stretch(odd, RATE, 1.3).length % 2).toBe(0);
  });

  it('gives an empty Buffer for an empty one', () => {
    expect(stretch(Buffer.alloc(0), RATE, 1.3).length).toBe(0);
    expect(stretch(Buffer.from([1]), RATE, 1.3).length).toBe(0);
  });

  it('gives the same samples for a Buffer at an odd byte offset', () => {
    const base = Buffer.alloc(1 + pcm.length);
    pcm.copy(base, 1);
    const shifted = base.subarray(1);
    expect(shifted.byteOffset % 2).toBe(1); // `Buffer.alloc` is not pooled, so its slice from byte 1 starts at an odd offset
    expect(stretch(shifted, RATE, 1.28).equals(stretch(pcm, RATE, 1.28))).toBe(true);
  });
});

describe('stretch: time', () => {
  it('gives the length input / factor (within one sample), for slower and faster', () => {
    for (const seconds of [0.2, 1, 3, 6]) {
      const pcm = speechLike(seconds);
      const n = pcm.length / 2;
      for (const f of [0.5, 0.8, 1.05, 1.28, 1.5, 2]) {
        const out = stretch(pcm, RATE, f);
        expect(Math.abs(out.length / 2 - n / f), `${seconds} s at ${f}`).toBeLessThanOrEqual(1);
        expect(out.length % 2).toBe(0);
      }
    }
  });

  it('is within 1 % of input / factor for a one-second sentence at the factor the engine uses', () => {
    const pcm = speechLike(1);
    const out = stretch(pcm, RATE, 1.28);
    expect(Math.abs(out.length / 2 / (pcm.length / 2 / 1.28) - 1)).toBeLessThan(0.01);
  });

  it('is fast: a six-second sentence in well under 100 ms', () => {
    const pcm = speechLike(6);
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      stretch(pcm, RATE, 1.28);
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(100);
  });

  it('works at another sample rate (frames follow the rate)', () => {
    const rate = 16_000;
    const pcm = sine(200, 2, 12_000, rate);
    const out = stretch(pcm, rate, 1.28);
    expect(Math.abs(out.length / 2 - pcm.length / 2 / 1.28)).toBeLessThanOrEqual(1);
    expect(Math.abs(frequencyOf(toSamples(out), rate) / 200 - 1)).toBeLessThan(0.02);
  });
});

describe('stretch: the sound', () => {
  it('keeps the pitch of a sine, faster or slower (within 2 %), and its level (within 15 %)', () => {
    const pcm = sine(200, 3);
    const input = toSamples(pcm);
    for (const f of [0.7, 1.1, 1.28, 1.5, 1.8]) {
      const out = toSamples(stretch(pcm, RATE, f));
      expect(Math.abs(frequencyOf(out, RATE) / 200 - 1), `pitch at ${f}`).toBeLessThan(0.02);
      const skip = Math.round(RATE * 0.1);
      const level = rms(out, skip, out.length - skip) / rms(input, skip, input.length - skip);
      expect(Math.abs(level - 1), `level at ${f}`).toBeLessThan(0.15);
    }
  });

  it('keeps the pitch period of a voiced, speech-like signal', () => {
    const pcm = speechLike(3);
    const input = toSamples(pcm);
    const out = toSamples(stretch(pcm, RATE, 1.28));
    const before = pitchPeriod(input, RATE, Math.round(RATE * 0.5), Math.round(RATE * 1.2));
    const after = pitchPeriod(out, RATE, Math.round(RATE * 0.4), Math.round(RATE * 0.9));
    expect(before).toBeGreaterThan(0);
    expect(Math.abs(after / before - 1)).toBeLessThan(0.03);
  });

  it('keeps a silent buffer silent', () => {
    const out = stretch(Buffer.alloc(2 * RATE * 2), RATE, 1.28);
    expect(out.length / 2).toBe(Math.round((RATE * 2) / 1.28));
    expect(out.every((b) => b === 0)).toBe(true);
  });

  it('keeps the start and end of a signal that begins and ends in silence', () => {
    const pcm = Buffer.concat([Buffer.alloc(2 * 4000), sine(200, 1), Buffer.alloc(2 * 4000)]);
    const out = toSamples(stretch(pcm, RATE, 1.3));
    expect(rms(out, 0, 2000)).toBe(0); // the silence in front is still silence, not a fade of the tone
    expect(rms(out, out.length - 2000)).toBe(0);
  });

  it('does not fade the first or last samples of a loud sound', () => {
    const pcm = sine(200, 1);
    const input = toSamples(pcm);
    const out = toSamples(stretch(pcm, RATE, 1.3));
    expect(rms(out, 0, 300)).toBeGreaterThan(0.7 * rms(input, 0, 300));
  });

  it('stays inside 16 bits and never writes NaN, for the loudest input there is', () => {
    const rand = mulberry32(3);
    const square = new Float64Array(RATE);
    const noise = new Float64Array(RATE);
    for (let i = 0; i < RATE; i++) {
      square[i] = Math.floor(i / 60) % 2 ? 32767 : -32768;
      noise[i] = rand() < 0.5 ? 32767 : -32768;
    }
    for (const loud of [square, noise]) {
      for (const f of [0.5, 1.28, 2]) {
        const out = toSamples(stretch(toBuffer(loud), RATE, f));
        expect(out.length).toBe(Math.round(RATE / f));
        for (let i = 0; i < out.length; i++) {
          if (!(out[i] >= -32768 && out[i] <= 32767)) throw new Error(`sample ${i} is ${out[i]}`);
        }
      }
    }
  });

  it('handles a sound shorter than one frame, and one sample', () => {
    for (const n of [1, 2, 10, 100, 599, 600, 601, 1199, 1200, 1500]) {
      const pcm = sine(300, n / RATE, 9000);
      for (const f of [0.5, 1.28, 2]) {
        const out = stretch(pcm, RATE, f);
        expect(out.length / 2, `${n} samples at ${f}`).toBe(Math.max(1, Math.round(n / f)));
        const s = toSamples(out);
        for (let i = 0; i < s.length; i++) expect(Number.isFinite(s[i])).toBe(true);
      }
    }
  });

  it('keeps the whole of a short sound, speeded up (the end is not cut off)', () => {
    const pcm = sine(300, 800 / RATE, 9000); // 800 samples: shorter than two frames
    const out = toSamples(stretch(pcm, RATE, 1.25));
    expect(out.length).toBe(640);
    expect(rms(out, 560)).toBeGreaterThan(3000); // the tail still carries the tone
  });
});

describe('stretch: no clicks', () => {
  it('joins a speech-like signal without a step larger than its own', () => {
    const pcm = speechLike(4);
    const own = worstStepRatio(toSamples(pcm), RATE);
    for (const f of [0.8, 1.28, 1.5]) {
      const made = worstStepRatio(toSamples(stretch(pcm, RATE, f)), RATE);
      expect(made, `factor ${f}: own ${own.toFixed(2)}`).toBeLessThan(own * 1.5 + 1);
    }
  });

  it('is a detector that can fire: a planted step, and frames pasted without alignment, are far above that', () => {
    const pcm = speechLike(4);
    const own = worstStepRatio(toSamples(pcm), RATE);
    const made = worstStepRatio(toSamples(stretch(pcm, RATE, 1.28)), RATE);

    const stepped = toSamples(pcm);
    for (let i = 60_000; i < stepped.length; i++) stepped[i] += 5000;
    expect(worstStepRatio(stepped, RATE)).toBeGreaterThan(own * 1.5 + 1);

    // The naive speed-up: drop every 4th frame of about 23 ms and paste the rest together with no cross-fade (557 samples: not a whole number of periods
    // of the test tone, so the cut lands at a different phase each time, as it would in speech).
    const frame = 557;
    const input = toSamples(pcm);
    const kept: number[] = [];
    for (let f = 0; (f + 1) * frame <= input.length; f++) if (f % 4 !== 3) for (let i = 0; i < frame; i++) kept.push(input[f * frame + i]);
    const naive = worstStepRatio(Float64Array.from(kept), RATE);
    expect(naive).toBeGreaterThan(made * 1.5);
  });
});
