import { describe, expect, it } from 'vitest';

import { applyGain } from './level.js';

const pcm = (samples: number[]): Buffer => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const samples = (b: Buffer): number[] => Array.from({ length: b.length >> 1 }, (_, i) => b.readInt16LE(i * 2));
const db = (ratio: number): number => 20 * Math.log10(ratio);

describe('applyGain', () => {
  it('gives the buffer itself back for no gain, and for nothing that is a number or a sample', () => {
    const b = pcm([100, -200, 300]);
    expect(applyGain(b, 0)).toBe(b);
    expect(applyGain(b, Number.NaN)).toBe(b);
    expect(applyGain(b, Number.POSITIVE_INFINITY)).toBe(b);
    const one = Buffer.from([7]);
    expect(applyGain(one, 6)).toBe(one);
    expect(applyGain(Buffer.alloc(0), 6).length).toBe(0);
  });

  it('is a plain multiplication below the knee: +6.02 dB doubles, -6.02 dB halves, in both signs', () => {
    const out = samples(applyGain(pcm([1000, -1000, 4000, -4000, 0]), 6.0206));
    expect(out).toEqual([2000, -2000, 8000, -8000, 0]);
    expect(samples(applyGain(pcm([1000, -2000]), -6.0206))).toEqual([500, -1000]);
  });

  it('keeps the length and the odd last byte, and never touches the input', () => {
    const input = Buffer.from([0x10, 0x00, 0x20, 0x00, 0x7f]);
    const copy = Buffer.from(input);
    const out = applyGain(input, 6);
    expect(out.length).toBe(5);
    expect(out[4]).toBe(0x7f);
    expect(input.equals(copy)).toBe(true);
  });

  it('never clips: any input at any gain stays under the ceiling of -1 dBFS (29163), and is monotonic in the input', () => {
    for (const gain of [3, 9.9, 18]) {
      const ramp = Array.from({ length: 129 }, (_, i) => -32768 + i * 512);
      ramp[128] = 32767;
      const out = samples(applyGain(pcm(ramp), gain));
      for (const y of out) expect(Math.abs(y)).toBeLessThanOrEqual(29163);
      for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
    }
  });

  it('rounds the peaks of a boosted voice and leaves the rest alone: a quiet sample is exactly multiplied, one just over the knee is eased, a huge one is brought down to the ceiling', () => {
    const factor = 10 ** (9.9 / 20);
    const [quiet, mid, loud] = samples(applyGain(pcm([2000, 8500, 20000]), 9.9));
    expect(quiet).toBe(Math.round(2000 * factor));
    expect(mid).toBeGreaterThan(24576);                        // over the knee ...
    expect(mid).toBeLessThan(Math.round(8500 * factor));       // ... and eased below what the plain gain would give
    expect(loud).toBeLessThanOrEqual(29163);
    expect(loud).toBeGreaterThan(29000);                       // a sample far over is at the ceiling
  });

  it('raises the speech level of a voice by the gain when nothing is limited (a tone at 0.05 of full scale)', () => {
    const tone = Array.from({ length: 2400 }, (_, i) => Math.round(1600 * Math.sin((2 * Math.PI * 330 * i) / 24000)));
    const rms = (xs: number[]): number => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);
    const out = samples(applyGain(pcm(tone), 9));
    expect(db(rms(out) / rms(tone))).toBeCloseTo(9, 1);
  });
});
