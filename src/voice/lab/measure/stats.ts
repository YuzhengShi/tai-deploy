/**
 * Plain statistics for the voice lab's report (docs/VOICE_SELFBUILT.md 9.2): percentiles the way the document takes them, Wilson intervals for
 * rates, and the two ways a difference gets an interval (Newcombe's hybrid score for two rates, a seeded bootstrap for two percentiles).
 * Pure functions, no I/O: every number in the report comes through here, so the tests can pin them exactly.
 */

/**
 * The value at index floor((n-1) * p) of the sorted sample (so p50 of an even sample is the lower of the two middle values), or null for an
 * empty sample. Infinity is a legal value (a turn that never got an answer): it sorts last and can be the answer.
 */
export function pctl(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  // the epsilon keeps a product like 0.9 * 10 that float arithmetic leaves a hair under 9 from landing on index 8
  const index = Math.floor((sorted.length - 1) * p + 1e-9);
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** The two-sided 95 % point of the normal distribution. */
export const Z95 = 1.959963984540054;

export interface Proportion {
  k: number;
  n: number;
  /** k / n */
  p: number;
  /** the 95 % Wilson score interval */
  lo: number;
  hi: number;
}

/** A rate with its 95 % Wilson score interval; null when there are no trials. */
export function wilson(k: number, n: number): Proportion | null {
  if (!(n > 0) || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = Z95 * Z95;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  // at the edges the bound is exact (float noise would leave 1e-17 instead of 0)
  return { k, n, p, lo: k === 0 ? 0 : Math.max(0, centre - half), hi: k === n ? 1 : Math.min(1, centre + half) };
}

export interface DiffInterval {
  /** B minus A */
  diff: number;
  lo: number;
  hi: number;
}

/**
 * The 95 % interval of (B's rate minus A's rate) by Newcombe's hybrid score method (method 10 of Newcombe 1998), built from the two Wilson
 * intervals. Deterministic and exact enough for 30-trial samples; null when either side has no trials.
 */
export function newcombe(kB: number, nB: number, kA: number, nA: number): DiffInterval | null {
  const b = wilson(kB, nB);
  const a = wilson(kA, nA);
  if (!a || !b) return null;
  const diff = b.p - a.p;
  const lo = diff - Math.sqrt((b.p - b.lo) ** 2 + (a.hi - a.p) ** 2);
  const hi = diff + Math.sqrt((b.hi - b.p) ** 2 + (a.p - a.lo) ** 2);
  return { diff, lo, hi };
}

/** A small seeded generator (mulberry32): the bootstrap must give the same interval for the same logs every time the report is made. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BOOTSTRAP_REPS = 2000;
export const BOOTSTRAP_SEED = 20261113;

/**
 * The 95 % percentile bootstrap interval of (B's p-th percentile minus A's): both samples are resampled with replacement (their own sizes),
 * the percentile is taken the document's way, and the 2.5th and 97.5th percentiles of the differences are the interval. Seeded, so repeatable.
 * Returns null when either sample is empty or the difference itself is not finite (a percentile that lands on a turn with no answer).
 * A resample in which both sides land on "no answer" counts as a difference of zero.
 */
export function bootstrapDiff(a: readonly number[], b: readonly number[], p: number, reps = BOOTSTRAP_REPS, seed = BOOTSTRAP_SEED): DiffInterval | null {
  if (a.length === 0 || b.length === 0) return null;
  const pa = pctl(a, p);
  const pb = pctl(b, p);
  if (pa === null || pb === null || !Number.isFinite(pa) || !Number.isFinite(pb)) return null;
  const rng = mulberry32(seed);
  const draw = (sample: readonly number[]): number[] => {
    const out = new Array<number>(sample.length);
    for (let i = 0; i < sample.length; i++) out[i] = sample[Math.floor(rng() * sample.length)];
    return out;
  };
  const diffs: number[] = [];
  for (let r = 0; r < reps; r++) {
    const qa = pctl(draw(a), p) as number;
    const qb = pctl(draw(b), p) as number;
    diffs.push(qa === Infinity && qb === Infinity ? 0 : qb - qa);
  }
  return { diff: pb - pa, lo: pctl(diffs, 0.025) as number, hi: pctl(diffs, 0.975) as number };
}

/** True when the interval of a difference contains zero: the data cannot tell the two chains apart at this sample size. */
export function containsZero(interval: { lo: number; hi: number } | null): boolean {
  return interval !== null && interval.lo <= 0 && interval.hi >= 0;
}

/**
 * Is k_B/n_B - k_A/n_A <= tolerancePoints percentage points, in exact integer arithmetic (floating point says 0.4 - 0.3 > 0.1, and a verdict on the
 * edge must not depend on that). `tolerancePoints` is a whole number of points.
 */
export function rateDiffWithin(kB: number, nB: number, kA: number, nA: number, tolerancePoints: number): boolean {
  return 100 * (kB * nA - kA * nB) <= tolerancePoints * nA * nB;
}
