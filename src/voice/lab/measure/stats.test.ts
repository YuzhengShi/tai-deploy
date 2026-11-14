import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_REPS, bootstrapDiff, containsZero, mean, mulberry32, newcombe, pctl, rateDiffWithin, wilson } from './stats.js';

describe('pctl', () => {
  it('takes the value at index floor((n-1)p) of the sorted sample, as the document says', () => {
    const ten = [10, 3, 7, 1, 9, 2, 8, 4, 6, 5];
    expect(pctl(ten, 0.5)).toBe(5); // index floor(4.5) = 4 of 1..10: the lower middle value
    expect(pctl(ten, 0.9)).toBe(9); // index floor(8.1) = 8
    expect(pctl(ten, 0)).toBe(1);
    expect(pctl(ten, 1)).toBe(10);
    expect(pctl([42], 0.9)).toBe(42);
    expect(pctl([5, 1], 0.5)).toBe(1);
  });

  it('is null for an empty sample and leaves its input alone', () => {
    expect(pctl([], 0.5)).toBeNull();
    const input = [3, 1, 2];
    pctl(input, 0.5);
    expect(input).toEqual([3, 1, 2]);
  });

  it('does not lose an index to float noise (0.9 * 10 and friends)', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => i);
    expect(pctl(eleven, 0.9)).toBe(9); // (11-1) * 0.9 must land on index 9, not 8
    const twentyOne = Array.from({ length: 21 }, (_, i) => i);
    expect(pctl(twentyOne, 0.9)).toBe(18);
    expect(pctl(twentyOne, 0.1)).toBe(2);
  });

  it('lets Infinity (a turn with no answer) sort last and be the answer when enough turns have none', () => {
    const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(pctl([...nine, Infinity], 0.5)).toBe(5);
    expect(pctl([...nine, Infinity], 0.9)).toBe(9);
    expect(pctl([...nine, Infinity], 1)).toBe(Infinity);
    expect(pctl([...nine, Infinity, Infinity], 0.9)).toBe(Infinity); // 2 of 11 have no answer: p90 is index 9, the first Infinity
  });
});

describe('mean', () => {
  it('averages, and is null for nothing', () => {
    expect(mean([1, 2, 6])).toBe(3);
    expect(mean([])).toBeNull();
  });
});

describe('wilson', () => {
  const near = (actual: number, expected: number, digits = 4) => expect(actual).toBeCloseTo(expected, digits);

  it('gives the 95 % Wilson score interval', () => {
    const none = wilson(0, 10)!;
    expect(none.p).toBe(0);
    expect(none.lo).toBe(0);
    near(none.hi, 0.2775);
    const one = wilson(1, 10)!;
    near(one.lo, 0.0179);
    near(one.hi, 0.4042);
    const half = wilson(5, 10)!;
    near(half.lo, 0.2366);
    near(half.hi, 0.7634);
    const all = wilson(10, 10)!;
    near(all.lo, 0.7225);
    expect(all.hi).toBe(1);
    // 0 of 20 (the C0 sample): the interval says what "no call failed" can and cannot show
    near(wilson(0, 20)!.hi, 0.1611);
  });

  it('has no interval without trials, or with an impossible count', () => {
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(3, 2)).toBeNull();
    expect(wilson(-1, 2)).toBeNull();
  });
});

describe('newcombe', () => {
  it('reproduces the worked example of the method (56/70 against 48/80: 0.2000, 0.0524 to 0.3339)', () => {
    const d = newcombe(56, 70, 48, 80)!;
    expect(d.diff).toBeCloseTo(0.2, 10);
    expect(d.lo).toBeCloseTo(0.0524, 3);
    expect(d.hi).toBeCloseTo(0.3339, 3);
  });

  it('is B minus A, so the sign says which chain has the higher rate', () => {
    const d = newcombe(2, 30, 8, 30)!;
    expect(d.diff).toBeLessThan(0);
    const swapped = newcombe(8, 30, 2, 30)!;
    expect(swapped.diff).toBeCloseTo(-d.diff, 12);
    expect(swapped.lo).toBeCloseTo(-d.hi, 12);
    expect(swapped.hi).toBeCloseTo(-d.lo, 12);
  });

  it('is null when a side has no trials, and spans zero for equal rates', () => {
    expect(newcombe(1, 0, 1, 10)).toBeNull();
    const same = newcombe(3, 30, 3, 30)!;
    expect(same.diff).toBe(0);
    expect(containsZero(same)).toBe(true);
  });
});

describe('rateDiffWithin', () => {
  it('is exact on the edge where floats are not (0.4 - 0.3 > 0.1 in floating point)', () => {
    expect(0.4 - 0.3 > 0.1).toBe(true); // the trap
    expect(rateDiffWithin(4, 10, 3, 10, 10)).toBe(true); // exactly 10 points: within
    expect(rateDiffWithin(5, 10, 3, 10, 10)).toBe(false);
    expect(rateDiffWithin(3, 30, 0, 30, 10)).toBe(true); // 3/30 - 0/30 = 10 points exactly
    expect(rateDiffWithin(4, 30, 0, 30, 10)).toBe(false);
  });

  it('works with unequal sample sizes', () => {
    // 7/30 - 1/30 = 20 points
    expect(rateDiffWithin(7, 30, 1, 30, 20)).toBe(true);
    expect(rateDiffWithin(7, 30, 1, 30, 19)).toBe(false);
    // 1/3 against 1/6: 16.666 points
    expect(rateDiffWithin(1, 3, 1, 6, 17)).toBe(true);
    expect(rateDiffWithin(1, 3, 1, 6, 16)).toBe(false);
  });

  it('lets a lab that is better than live pass any tolerance', () => {
    expect(rateDiffWithin(0, 30, 9, 30, 0)).toBe(true);
  });
});

describe('mulberry32', () => {
  it('is deterministic, in [0, 1), and differs by seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(mulberry32(8)()).not.toBe(xs[0]);
  });
});

describe('bootstrapDiff', () => {
  const live = Array.from({ length: 30 }, (_, i) => 1400 + (i % 10) * 20); // 1400..1580
  it('is repeatable: the same samples give the same interval every time', () => {
    const lab = live.map((v) => v + 100);
    expect(bootstrapDiff(live, lab, 0.5)).toEqual(bootstrapDiff(live, lab, 0.5));
  });

  it('puts a clear shift outside zero and no shift around it', () => {
    const shifted = bootstrapDiff(
      live,
      live.map((v) => v + 500),
      0.5,
    )!;
    expect(shifted.diff).toBe(500);
    // the two samples are resampled independently, so the interval is as wide as the spread of the data (180 ms here) around the shift
    expect(shifted.lo).toBeGreaterThan(300);
    expect(shifted.lo).toBeLessThanOrEqual(500);
    expect(shifted.hi).toBeGreaterThanOrEqual(500);
    expect(shifted.hi).toBeLessThan(700);
    expect(containsZero(shifted)).toBe(false);
    const same = bootstrapDiff(live, [...live], 0.9)!;
    expect(same.diff).toBe(0);
    expect(containsZero(same)).toBe(true);
  });

  it('widens with noise: a mixed sample cannot tell a 50 ms shift from none at n = 12', () => {
    const noisy = [900, 1500, 1100, 2100, 1300, 1700, 1000, 1900, 1200, 1600, 1400, 2000];
    const r = bootstrapDiff(noisy, noisy.map((v) => v + 50), 0.5)!;
    expect(r.diff).toBe(50);
    expect(r.lo).toBeLessThan(0);
    expect(r.hi).toBeGreaterThan(50);
    expect(containsZero(r)).toBe(true);
  });

  it('has no interval for an empty sample or a percentile that is a turn with no answer', () => {
    expect(bootstrapDiff([], live, 0.5)).toBeNull();
    expect(bootstrapDiff(live, [], 0.5)).toBeNull();
    expect(bootstrapDiff([...live.slice(0, 5), Infinity, Infinity, Infinity], live, 0.9)).toBeNull();
  });

  it('uses the document\'s resample count and can be told another', () => {
    expect(BOOTSTRAP_REPS).toBe(2000);
    const a = bootstrapDiff(live, live.map((v) => v + 10), 0.5, 50)!;
    const b = bootstrapDiff(live, live.map((v) => v + 10), 0.5, 50)!;
    expect(a).toEqual(b);
  });
});

describe('containsZero', () => {
  it('is inclusive at both ends and false without an interval', () => {
    expect(containsZero({ lo: -1, hi: 1 })).toBe(true);
    expect(containsZero({ lo: 0, hi: 5 })).toBe(true);
    expect(containsZero({ lo: -5, hi: 0 })).toBe(true);
    expect(containsZero({ lo: 0.001, hi: 5 })).toBe(false);
    expect(containsZero(null)).toBe(false);
  });
});
