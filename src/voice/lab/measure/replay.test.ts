import { describe, expect, it } from 'vitest';

import { replayBarge } from './replay.js';

/** 20 ms frames of a 16 kHz sine at `amp` (0 = silence), for each character of the pattern: 'x' loud, '_' quiet. */
function clip(pattern: string, amp = 8000): Buffer {
  const parts: Buffer[] = [];
  for (const ch of pattern) {
    const b = Buffer.alloc(640);
    if (ch === 'x') for (let i = 0; i < 320; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

describe('replayBarge', () => {
  const opts = { minVoicedMs: 240, windowMs: 300 };

  it('both rules confirm after 240 ms of unbroken loud speech, counted from the first frame', () => {
    const r = replayBarge(clip('x'.repeat(30)), opts);
    expect(r.firstLoudMs).toBe(20);
    expect(r.runMs).toBe(240);
    expect(r.windowMs).toBe(240);
  });

  it('a gap of three frames makes the unbroken rule wait for a second run, and the windowed rule not', () => {
    const r = replayBarge(clip('xxxxx___' + 'x'.repeat(20)), opts);
    expect(r.windowMs).toBe(300);                                  // 12 loud in 15 frames at the 15th frame
    expect(r.runMs).toBe(8 * 20 + 240);                            // 12 in a row only after the gap
  });

  it('speech that never gets loud enough, or that is only a click, confirms nothing', () => {
    expect(replayBarge(clip('x'.repeat(30), 300), opts)).toEqual({ firstLoudMs: null, runMs: null, windowMs: null });
    expect(replayBarge(clip('x___'.repeat(20)), opts).windowMs).toBeNull();
  });
});
