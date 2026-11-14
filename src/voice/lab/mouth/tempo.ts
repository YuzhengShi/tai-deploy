/**
 * Time-scale modification of speech without a change of pitch (WSOLA: waveform-similarity overlap-add).
 *
 * WHY: LabGPU's voice speaks at 2.69 words a second and the adapter ignores a `speed` field, while today's call speaks at 3.45 (docs/VOICE_SELFBUILT.md, C7).
 * Playing the samples faster would raise the pitch ("chipmunk"); this keeps the pitch and shortens the time. The engine applies it to each sentence as it
 * arrives, so it has to be quick (a six-second sentence takes a few milliseconds) and must not click at the joins.
 *
 * How it works: the sentence is cut into frames of 25 ms that overlap by half and are cross-faded together (windows that add up to exactly 1). The frames
 * are taken from the input at a spacing of `factor` times the output spacing, so the audio moves through the input faster or slower. Each frame is not
 * taken exactly at its nominal place: within +-10 ms the place is chosen where the frame's start best continues the end of the previous frame (highest
 * normalised cross-correlation), so the waves line up in phase at the join and the cross-fade is inaudible. The search runs first on a 4x decimated copy
 * (a quarter of the length and a quarter of the places, about 16 times less work) and is then refined at the full rate around the winner.
 */

const FRAME_SECONDS = 0.025;
const SEARCH_SECONDS = 0.01;
const DECIMATION = 4;
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 2;
/** Below this many frames of input the search has nothing to work with; the sound is shorter than 50 ms, so a plain resample is not audible as a pitch change. */
const MIN_FRAMES = 2;

/** The factor that brings a voice speaking at `current` words a second to `target`, kept between 1 (never slower) and 1.5 (beyond that speech is distorted). */
export function stretchFactorFor(currentWordsPerSecond: number, targetWordsPerSecond: number): number {
  if (!Number.isFinite(currentWordsPerSecond) || !Number.isFinite(targetWordsPerSecond) || currentWordsPerSecond <= 0 || targetWordsPerSecond <= 0) return 1;
  return Math.min(1.5, Math.max(1, targetWordsPerSecond / currentWordsPerSecond));
}

/**
 * `pcm` (16-bit little-endian mono at `rate` Hz) played `factor` times faster (> 1) or slower (< 1) with the pitch unchanged. The result is a new Buffer
 * of `round(samples / factor)` samples; factor 1 gives a copy. A stray odd byte at the end of `pcm` is ignored. Throws RangeError for a factor outside 0.5 to 2.
 */
export function stretch(pcm: Buffer, rate: number, factor: number): Buffer {
  if (!Number.isFinite(rate) || rate < 4000 || rate > 192_000) throw new RangeError(`stretch: unusable sample rate ${rate}`);
  if (!(factor >= MIN_FACTOR && factor <= MAX_FACTOR)) throw new RangeError(`stretch: factor ${factor} is outside ${MIN_FACTOR} to ${MAX_FACTOR}`);
  const n = pcm.length >> 1;
  if (n === 0) return Buffer.alloc(0);
  if (factor === 1) return Buffer.from(pcm.subarray(0, n * 2)); // a copy: the caller may keep or change either one

  const frame = 2 * Math.max(8, Math.round((rate * FRAME_SECONDS) / 2)); // even, so the half-frame hop is a whole number of samples
  const hop = frame / 2;
  const reach = Math.max(2 * DECIMATION, Math.round(rate * SEARCH_SECONDS));
  const outLength = Math.max(1, Math.round(n / factor));

  // Zeros after the end: a frame or a search window that runs past the input reads silence instead of falling off the array.
  const pad = 4 * frame + 2 * reach;
  const x = new Float32Array(n + pad);
  for (let i = 0; i < n; i++) x[i] = ((pcm[2 * i] | (pcm[2 * i + 1] << 8)) << 16) >> 16; // by bytes: a pooled Buffer can have an odd byteOffset

  if (n < MIN_FRAMES * frame) return fromFloats(resample(x, n, outLength, factor), outLength);

  // A decimated copy (boxcar average of 4 samples: a crude low-pass, enough because voiced speech lives far below a quarter of the Nyquist rate).
  const xd = new Float32Array(Math.floor(x.length / DECIMATION));
  for (let j = 0; j < xd.length; j++) {
    const o = j * DECIMATION;
    xd[j] = (x[o] + x[o + 1] + x[o + 2] + x[o + 3]) * 0.25;
  }
  const hopD = Math.floor(hop / DECIMATION);

  // Windows that add up to 1 when shifted by half a frame (sin^2 = Hann shifted by half a sample, so the weight is never zero: the first and last
  // samples can be divided by the weight and come out exact, with no fade-in or fade-out).
  const window = new Float32Array(frame);
  for (let i = 0; i < frame; i++) window[i] = Math.sin((Math.PI * (i + 0.5)) / frame) ** 2;

  const frames = Math.max(1, Math.ceil((outLength - frame) / hop) + 1);
  const acc = new Float32Array((frames - 1) * hop + frame);
  const weight = new Float32Array(acc.length);
  const addFrame = (outAt: number, inAt: number): void => {
    for (let i = 0; i < frame; i++) {
      acc[outAt + i] += window[i] * x[inAt + i];
      weight[outAt + i] += window[i];
    }
  };

  /** The start in the input, near `nominal`, whose first half best continues `x[after .. after + hop)`: the second half of the frame placed before. */
  const place = (after: number, nominal: number): number => {
    const lo = Math.max(0, nominal - reach);
    const hi = Math.min(n, nominal + reach);
    if (lo >= hi) return Math.min(n, Math.max(0, nominal));

    // Coarse: on the decimated copy, every 4th place.
    const t0 = Math.floor(after / DECIMATION);
    const c0 = Math.ceil(lo / DECIMATION);
    const c1 = Math.floor(hi / DECIMATION);
    const mid = Math.round(nominal / DECIMATION);
    let energy = 0;
    for (let i = 0; i < hopD; i++) energy += xd[c0 + i] * xd[c0 + i];
    let bestC = c0;
    let bestScore = -Infinity;
    for (let c = c0; c <= c1; c++) {
      let dot = 0;
      for (let i = 0; i < hopD; i++) dot += xd[t0 + i] * xd[c + i];
      const score = energy > 1e-6 ? dot / Math.sqrt(energy) : 0;
      // On a tie (silence, mostly) the place nearest the nominal one wins, so quiet stretches keep their timing.
      if (score > bestScore || (score === bestScore && Math.abs(c - mid) < Math.abs(bestC - mid))) {
        bestScore = score;
        bestC = c;
      }
      const out = xd[c];
      const inn = xd[c + hopD];
      energy += inn * inn - out * out; // slide the window by one sample: no need to sum it again
      if (energy < 0) energy = 0;
    }

    // Fine: at the full rate, +-4 samples around the coarse winner.
    const centre = bestC * DECIMATION;
    const f0 = Math.max(0, centre - DECIMATION);
    const f1 = Math.min(n, centre + DECIMATION);
    let best = Math.min(Math.max(centre, f0), f1);
    bestScore = -Infinity;
    for (let p = f0; p <= f1; p++) {
      let dot = 0;
      let en = 0;
      for (let i = 0; i < hop; i++) {
        const b = x[p + i];
        dot += x[after + i] * b;
        en += b * b;
      }
      const score = en > 1e-6 ? dot / Math.sqrt(en) : 0;
      if (score > bestScore || (score === bestScore && Math.abs(p - centre) < Math.abs(best - centre))) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  };

  let previous = 0;
  addFrame(0, 0); // the first frame is the start of the input as it is
  for (let k = 1; k < frames; k++) {
    const chosen = place(previous + hop, Math.round(k * hop * factor));
    addFrame(k * hop, chosen);
    previous = chosen;
  }

  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) out[i] = weight[i] > 1e-6 ? acc[i] / weight[i] : 0;
  return fromFloats(out, outLength);
}

/** A sound shorter than two frames: linear interpolation at the new speed (the pitch moves for less than 50 ms, which cannot be heard). */
function resample(x: Float32Array, n: number, outLength: number, factor: number): Float32Array {
  const out = new Float32Array(outLength);
  for (let j = 0; j < outLength; j++) {
    const at = j * factor;
    const i = Math.min(n - 1, Math.floor(at));
    const next = Math.min(n - 1, i + 1);
    out[j] = x[i] + (x[next] - x[i]) * (at - i);
  }
  return out;
}

/** Rounds to 16-bit samples, clipped (a cross-fade of loud frames can overshoot a little), into a Buffer of its own (not a slice of the shared pool). */
function fromFloats(samples: Float32Array, length: number): Buffer {
  const out = Buffer.allocUnsafeSlow(length * 2);
  for (let i = 0; i < length; i++) {
    let v = Math.round(samples[i]);
    if (!(v < 32767)) v = v > 0 ? 32767 : 0; // also catches NaN: never write garbage into the audio
    else if (v < -32768) v = -32768;
    out.writeInt16LE(v, 2 * i);
  }
  return out;
}
