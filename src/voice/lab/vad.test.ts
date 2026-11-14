import { describe, expect, it } from 'vitest';

import { Vad, rmsOf } from './vad.js';

/** 20 ms of a 16 kHz sine at the given peak amplitude (0 = digital silence). */
function frame(amp: number, ms = 20): Buffer {
  const n = (16000 * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2);
  return b;
}

/** Feeds `frames` 20 ms frames one at a time, advancing the fake clock by 20 ms each. */
function run(vad: Vad, clock: { t: number }, amp: number, frames: number): void {
  for (let i = 0; i < frames; i++) {
    clock.t += 20;
    vad.feed(frame(amp));
  }
}

describe('Vad', () => {
  it('rmsOf is the RMS of the samples', () => {
    expect(rmsOf(frame(0))).toBe(0);
    expect(Math.abs(rmsOf(frame(10_000)) - 10_000 / Math.SQRT2)).toBeLessThan(150);   // 4.4 periods in a frame: close to, not exactly, amp / sqrt 2
  });

  it('opens after three voiced frames, reports the onset at the start of the first, and ends at the last voiced frame', () => {
    const clock = { t: 1000 };
    const onsets: number[] = [];
    const vad = new Vad(() => clock.t, { onset: (at) => onsets.push(at) });
    run(vad, clock, 0, 10);
    expect(vad.voiced).toBe(false);
    expect(vad.lastVoicedEndAt).toBe(0);
    const speechStart = clock.t;
    run(vad, clock, 8000, 2);
    expect(vad.voiced).toBe(false);                            // two frames are not enough
    run(vad, clock, 8000, 1);
    expect(vad.voiced).toBe(true);
    expect(onsets).toEqual([speechStart]);
    expect(vad.onsets).toBe(1);
    run(vad, clock, 8000, 20);
    const lastLoudEnd = clock.t;
    run(vad, clock, 0, 3);
    expect(vad.voiced).toBe(true);                              // a short gap inside a word does not end it
    run(vad, clock, 0, 10);
    expect(vad.voiced).toBe(false);
    expect(vad.lastVoicedEndAt).toBe(lastLoudEnd);              // the end of speech is the last voiced frame, not when the VAD noticed
    expect(vad.onsets).toBe(1);
  });

  it('regroups input of any size into 20 ms frames, with the frame times counted back from now', () => {
    const clock = { t: 5000 };
    const vad = new Vad(() => clock.t);
    const loud = Buffer.concat(Array.from({ length: 10 }, () => frame(8000)));   // 200 ms arriving at once
    clock.t += 200;
    vad.feed(loud.subarray(0, 333));                           // an odd split
    vad.feed(loud.subarray(333));
    expect(vad.voiced).toBe(true);
    expect(vad.lastVoicedEndAt).toBe(5200);
    expect(vad.stats.frames).toBe(10);
  });

  it('a strict run needs a louder frame than a normal one', () => {
    const clock = { t: 0 };
    const vad = new Vad(() => clock.t);
    run(vad, clock, 0, 5);
    run(vad, clock, 700, 5);                                   // RMS about 495: over 350, under 1.5 x 350 = 525
    expect(vad.voicedRunMs).toBe(100);
    expect(vad.strictRunMs).toBe(0);
    run(vad, clock, 2000, 5);
    expect(vad.strictRunMs).toBe(100);
  });

  it('the noise floor lifts the threshold: a steady hum is not speech, and speech over it still is', () => {
    const clock = { t: 0 };
    const vad = new Vad(() => clock.t);
    run(vad, clock, 800, 100);                                  // 2 s of a hum at RMS about 566: over the floor of 350 at first, so it opens ...
    // ... but the quietest frame of the window is the hum itself, and the threshold becomes 3 x 566: the hum is no longer voiced
    run(vad, clock, 800, 100);
    expect(vad.voiced).toBe(false);
    run(vad, clock, 6000, 5);                                   // speech over it
    expect(vad.voiced).toBe(true);
  });

  it('a listener that throws does not stop the audio', () => {
    const clock = { t: 0 };
    const vad = new Vad(() => clock.t, { onset: () => { throw new Error('boom'); } });
    run(vad, clock, 8000, 5);
    expect(vad.voiced).toBe(true);
  });
});
