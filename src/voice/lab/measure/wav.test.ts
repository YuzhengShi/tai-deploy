import { describe, expect, it } from 'vitest';

import { AUDIBLE_SLACK_MS, audibleAt, frameOfSample, MARGIN_SAMPLES, peakOf, playoutEnd, sampleCount, silence, speechBounds, toFrames, trimToSpeech } from './wav.js';

/** PCM16 from runs of [samples, amplitude]: a run is a constant value (its sign alternates every 8 samples, so it is not a DC offset). */
function pcm(...runs: Array<[number, number]>): Buffer {
  const total = runs.reduce((s, [n]) => s + n, 0);
  const buf = Buffer.alloc(total * 2);
  let at = 0;
  for (const [n, amp] of runs) {
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.floor(i / 8) % 2 === 0 ? amp : -amp, (at + i) * 2);
    at += n;
  }
  return buf;
}

describe('speechBounds', () => {
  it('finds the first and last sample above the threshold', () => {
    const clip = pcm([1600, 0], [3200, 3000], [1600, 0]);
    expect(speechBounds(clip)).toEqual({ first: 1600, last: 1600 + 3200 - 1 });
  });

  it('counts a sample as speech only when it EXCEEDS max(200, 2 % of the peak)', () => {
    expect(speechBounds(pcm([100, 0], [50, 200], [100, 0]))).toBeNull(); // 200 is the threshold, not above it
    expect(speechBounds(pcm([100, 0], [50, 201], [100, 0]))).toEqual({ first: 100, last: 149 });
  });

  it('raises the threshold to 2 % of the peak for a loud clip: a quiet tail above 200 is not speech', () => {
    // peak 30000 -> threshold 600: the 500-amplitude tail (above 200, below 600) is a noise floor
    const clip = pcm([800, 0], [1600, 30000], [800, 500], [800, 0]);
    expect(peakOf(clip)).toBe(30000);
    expect(speechBounds(clip)).toEqual({ first: 800, last: 800 + 1600 - 1 });
  });

  it('uses absolute values (negative speech samples count) and survives -32768', () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(-32768, 2);
    buf.writeInt16LE(-5000, 4);
    buf.writeInt16LE(0, 6);
    expect(speechBounds(buf)).toEqual({ first: 1, last: 2 });
  });

  it('is null for silence and for nothing', () => {
    expect(speechBounds(silence(500))).toBeNull();
    expect(speechBounds(Buffer.alloc(0))).toBeNull();
    expect(peakOf(Buffer.alloc(0))).toBe(0);
  });
});

describe('trimToSpeech', () => {
  it('keeps 40 ms (640 samples) of margin on each side and reports where the speech is inside the cut', () => {
    const clip = pcm([16000, 0], [4800, 3000], [16000, 0]); // 1 s, 300 ms, 1 s
    const t = trimToSpeech(clip)!;
    expect(MARGIN_SAMPLES).toBe(640);
    expect(sampleCount(t.pcm)).toBe(640 + 4800 + 640);
    expect(t.first).toBe(640);
    expect(t.last).toBe(640 + 4800 - 1);
  });

  it('keeps what there is where the clip has less than the margin, and says so exactly', () => {
    const clip = pcm([100, 0], [4800, 3000], [50, 0]);
    const t = trimToSpeech(clip)!;
    expect(sampleCount(t.pcm)).toBe(100 + 4800 + 50);
    expect(t.first).toBe(100);
    expect(t.last).toBe(100 + 4800 - 1);
    const tight = trimToSpeech(pcm([4800, 3000]))!;
    expect(tight.first).toBe(0);
    expect(tight.last).toBe(4799);
    expect(sampleCount(tight.pcm)).toBe(4800);
  });

  it('is a view of the same samples (the speech inside the cut is the speech of the source)', () => {
    const clip = pcm([5000, 0], [800, 7000], [5000, 0]);
    const t = trimToSpeech(clip)!;
    expect(t.pcm.readInt16LE(t.first * 2)).toBe(clip.readInt16LE(5000 * 2));
    expect(t.pcm.readInt16LE(t.last * 2)).toBe(clip.readInt16LE((5000 + 799) * 2));
  });

  it('is null for a clip with no speech', () => {
    expect(trimToSpeech(silence(300))).toBeNull();
  });
});

describe('silence, frames', () => {
  it('makes digital silence of the right length (600 ms is 9600 samples)', () => {
    expect(silence(600).length).toBe(19200);
    expect(sampleCount(silence(1500))).toBe(24000);
    expect(silence(0).length).toBe(0);
    expect(silence(0.03).length).toBe(0); // under half a sample
    expect(silence(0.04).length).toBe(2); // rounded to a whole sample
    expect(silence(10).every((b) => b === 0)).toBe(true);
  });

  it('names the frame that carries a sample (640 samples per 40 ms frame): the last sample of a frame is still in it', () => {
    expect(frameOfSample(0, 640)).toBe(0);
    expect(frameOfSample(639, 640)).toBe(0);
    expect(frameOfSample(640, 640)).toBe(1);
    expect(frameOfSample(1279, 640)).toBe(1);
    expect(frameOfSample(1280, 640)).toBe(2);
  });

  it('cuts a clip into whole frames and pads the last one with silence', () => {
    const clip = Buffer.alloc(1280 * 2 + 300, 7);
    const frames = toFrames(clip, 1280);
    expect(frames.length).toBe(3);
    expect(frames.every((f) => f.length === 1280)).toBe(true);
    expect(frames[2].subarray(0, 300).every((b) => b === 7)).toBe(true);
    expect(frames[2].subarray(300).every((b) => b === 0)).toBe(true);
    expect(toFrames(Buffer.alloc(2560, 1), 1280).length).toBe(2); // an exact multiple adds nothing
    expect(toFrames(Buffer.alloc(0), 1280)).toEqual([]);
  });
});

describe('the playout clock of the agent\'s audio', () => {
  const sec = 48_000; // bytes of 24 kHz PCM16 in one second

  it('plays what arrives back to back: a second of audio is audible for a second from its arrival', () => {
    const marks = [{ t: 1000, bytes: sec }];
    expect(playoutEnd(marks, 1000)).toBe(2000);
    expect(audibleAt(marks, 1500)).toBe(true);
    expect(audibleAt(marks, 1999.9)).toBe(true);
    expect(audibleAt(marks, 2000)).toBe(false); // finished exactly now
    expect(audibleAt(marks, 500)).toBe(false); // nothing had arrived yet
  });

  it('queues audio that arrives faster than real time behind what is playing', () => {
    const marks = [
      { t: 0, bytes: sec },
      { t: 500, bytes: sec },
    ];
    expect(playoutEnd(marks, 600)).toBe(2000);
    expect(audibleAt(marks, 1500)).toBe(true);
    expect(audibleAt(marks, 2000)).toBe(false);
  });

  it('has a gap where the next audio arrives after the last has finished (a filler, a look-up, then the answer)', () => {
    const marks = [
      { t: 0, bytes: 24_000 }, // 500 ms
      { t: 3000, bytes: sec },
    ];
    expect(audibleAt(marks, 400)).toBe(true);
    expect(audibleAt(marks, 1500)).toBe(false);
    expect(audibleAt(marks, 3500)).toBe(true);
  });

  it('can allow a little slack, so that frames that arrive just in time do not make the answer flip on a millisecond', () => {
    const marks = [{ t: 0, bytes: sec }]; // audible until 1000
    expect(audibleAt(marks, 1100)).toBe(false);
    expect(audibleAt(marks, 1100, AUDIBLE_SLACK_MS)).toBe(true); // finished 100 ms ago
    expect(audibleAt(marks, 1149.9, AUDIBLE_SLACK_MS)).toBe(true);
    expect(audibleAt(marks, 1150, AUDIBLE_SLACK_MS)).toBe(false); // 150 ms ago is over
    expect(audibleAt([], 100, AUDIBLE_SLACK_MS)).toBe(false); // nothing ever arrived
    expect(AUDIBLE_SLACK_MS).toBe(150);
  });

  it('ignores marks after the moment asked about and is -Infinity before any', () => {
    expect(playoutEnd([{ t: 100, bytes: sec }], 50)).toBe(-Infinity);
    expect(playoutEnd([], 50)).toBe(-Infinity);
    expect(audibleAt([], 50)).toBe(false);
  });
});
