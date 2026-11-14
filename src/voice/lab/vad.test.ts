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

  describe('strictWindow (A11: the barge-in rule reads loud frames in a window, not an unbroken run)', () => {
    const quietThenLoud = (pattern: string): { vad: Vad; clock: { t: number } } => {
      const clock = { t: 0 };
      const vad = new Vad(() => clock.t);
      run(vad, clock, 0, 30);                                   // the room: the noise floor is learned
      for (const ch of pattern) run(vad, clock, ch === 'x' ? 8000 : 0, 1);
      return { vad, clock };
    };

    it('an unbroken stretch of loud frames counts as the run does', () => {
      const { vad } = quietThenLoud('x'.repeat(12));
      expect(vad.strictRunMs).toBe(240);
      expect(vad.strictWindow(300).voicedMs).toBe(240);
    });

    it('a dip of up to three frames inside the window is gone past: 12 loud frames in 15 are 240 ms of speech', () => {
      const { vad } = quietThenLoud('xxxxx___xxxxxxx');           // a stop consonant's closure: 3 quiet frames
      expect(vad.strictRunMs).toBe(140);                          // the run restarted at the dip: the round-1 rule would still wait
      expect(vad.strictWindow(300).voicedMs).toBe(240);
    });

    it('it reads the window again at every frame: during the dip it is zero, the frame after it counts again', () => {
      const { vad, clock } = quietThenLoud('xxxxxxxxxx__');
      expect(vad.strictWindow(300).voicedMs).toBe(0);              // the latest frame is not loud
      run(vad, clock, 8000, 1);
      expect(vad.strictWindow(300).voicedMs).toBe(220);
    });

    it('a longer gap leaves too little speech in the window: 12 loud frames in 15 are not there', () => {
      const { vad } = quietThenLoud('xxxxx_____xxxxxxx');         // 5 quiet frames: 12 loud in 17
      expect(vad.strictWindow(300).voicedMs).toBeLessThan(240);
    });

    it('clicks and taps do not add up to speech: a loud frame in four is far from 12 in 15', () => {
      const { vad } = quietThenLoud('x___'.repeat(10) + 'x');
      expect(vad.strictWindow(300).voicedMs).toBe(80);
    });

    it('says where the first loud frame of the window began, for the trace', () => {
      const clock = { t: 1000 };
      const vad = new Vad(() => clock.t);
      run(vad, clock, 0, 30);
      const begin = clock.t;
      run(vad, clock, 8000, 4);
      run(vad, clock, 0, 2);
      run(vad, clock, 8000, 8);
      expect(vad.strictWindow(300)).toEqual({ voicedMs: 240, startedAt: begin });
    });

    it('is cleared with the rest of the speech state when the audio had a gap (reset)', () => {
      const { vad } = quietThenLoud('x'.repeat(12));
      vad.reset();
      expect(vad.strictWindow(300).voicedMs).toBe(0);
    });
  });

  it('a listener that throws does not stop the audio', () => {
    const clock = { t: 0 };
    const vad = new Vad(() => clock.t, { onset: () => { throw new Error('boom'); } });
    run(vad, clock, 8000, 5);
    expect(vad.voiced).toBe(true);
  });
});
