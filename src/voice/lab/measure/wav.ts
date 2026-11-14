/**
 * Audio helpers of the measuring client: where the speech is in a clip, trimming a clip to its speech, digital silence, frame arithmetic, and
 * the playout clock of the agent's audio (what the student would still be hearing). The speech rule is the one tools/cs6650/speech_check.sh
 * and the probe use: a sample is speech when its absolute value exceeds max(200, 2 % of the clip's peak). Pure functions on 16 kHz mono PCM16.
 */

/** What the browser sends: 16 kHz mono PCM16. */
export const SAMPLE_RATE = 16_000;
export const SAMPLES_PER_MS = SAMPLE_RATE / 1000;
/** The margin kept on each side of the speech when a clip is trimmed (40 ms = one frame). */
export const MARGIN_MS = 40;
export const MARGIN_SAMPLES = MARGIN_MS * SAMPLES_PER_MS;
/** A sample counts as speech above max(MIN_THRESHOLD, PEAK_FRACTION * peak). */
export const MIN_THRESHOLD = 200;
export const PEAK_FRACTION = 0.02;
/** What the agent sends back: 24 kHz mono PCM16, 48 bytes a millisecond. */
export const AGENT_BYTES_PER_MS = 48;

export interface SpeechBounds {
  /** index of the first speech sample */
  first: number;
  /** index of the last speech sample (inclusive) */
  last: number;
}

export function sampleCount(pcm: Buffer): number {
  return Math.floor(pcm.length / 2);
}

/** The largest absolute sample of the clip (0 for an empty one). */
export function peakOf(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

/** The first and last sample above the speech threshold, or null when the clip never exceeds it. */
export function speechBounds(pcm: Buffer): SpeechBounds | null {
  const threshold = Math.max(MIN_THRESHOLD, peakOf(pcm) * PEAK_FRACTION);
  let first = -1;
  let last = -1;
  for (let i = 0, n = sampleCount(pcm); i < n; i++) {
    if (Math.abs(pcm.readInt16LE(i * 2)) > threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : { first, last };
}

export interface TrimmedClip {
  /** the clip from `margin` samples before the speech to `margin` samples after it (less where the clip itself ends sooner) */
  pcm: Buffer;
  /** index of the first speech sample INSIDE the trimmed clip */
  first: number;
  /** index of the last speech sample (inclusive) INSIDE the trimmed clip */
  last: number;
}

/**
 * The clip cut to its speech plus a margin of silence on each side, with the position of the speech inside the cut. Where the source has less
 * than `margin` samples of silence before (or after) the speech the margin is what there is, and `first` says so: the positions are always
 * exact, never "margin". Null for a clip with no speech.
 */
export function trimToSpeech(pcm: Buffer, margin = MARGIN_SAMPLES): TrimmedClip | null {
  const bounds = speechBounds(pcm);
  if (!bounds) return null;
  const from = Math.max(0, bounds.first - margin);
  const to = Math.min(sampleCount(pcm), bounds.last + 1 + margin);
  return { pcm: pcm.subarray(from * 2, to * 2), first: bounds.first - from, last: bounds.last - from };
}

/** Digital silence of `ms` milliseconds at 16 kHz (rounded to a whole sample). */
export function silence(ms: number): Buffer {
  return Buffer.alloc(Math.max(0, Math.round(ms * SAMPLES_PER_MS)) * 2);
}

/** The frame of a stream that carries sample `sample`, for frames of `frameSamples` samples. */
export function frameOfSample(sample: number, frameSamples: number): number {
  return Math.floor(sample / frameSamples);
}

/** The clip as whole frames of `frameBytes` bytes (the last one padded with silence); every frame is a view or a fresh buffer, none is shared with a later write. */
export function toFrames(pcm: Buffer, frameBytes: number): Buffer[] {
  const frames: Buffer[] = [];
  for (let off = 0; off < pcm.length; off += frameBytes) {
    const piece = pcm.subarray(off, Math.min(pcm.length, off + frameBytes));
    if (piece.length === frameBytes) frames.push(piece);
    else {
      const padded = Buffer.alloc(frameBytes);
      piece.copy(padded);
      frames.push(padded);
    }
  }
  return frames;
}

export interface AudioMark {
  /** arrival time, ms of the call's clock */
  t: number;
  /** bytes of PCM16 at 24 kHz */
  bytes: number;
}

/**
 * When the audio that has arrived by `at` would finish playing if the page plays it back to back from its arrival (a browser queues what it
 * receives and plays it in order; audio that arrives faster than real time waits its turn). Marks after `at` are not counted. -Infinity when nothing arrived.
 */
export function playoutEnd(marks: readonly AudioMark[], at: number): number {
  let end = -Infinity;
  for (const m of marks) {
    if (m.t > at) break;
    end = Math.max(end, m.t) + m.bytes / AGENT_BYTES_PER_MS;
  }
  return end;
}

/**
 * Slack for "is the agent audible": audio that finished playing this long ago still counts as speech in progress. Frames that arrive just in time
 * (each as the last one ends) make the exact answer flip on a millisecond, and a page keeps a little audio queued ahead of its speaker anyway.
 */
export const AUDIBLE_SLACK_MS = 150;

/** Is the agent still audible at time `at` (the audio that arrived by then has not finished playing, give or take `slackMs`)? */
export function audibleAt(marks: readonly AudioMark[], at: number, slackMs = 0): boolean {
  return playoutEnd(marks, at) > at - slackMs;
}
