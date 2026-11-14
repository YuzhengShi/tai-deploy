// The card of a chart: the pure parts (the tick maths, the number words, the geometry, the nearest point, the keys, the readout, the table, what reports a pick to the view), and the card itself built into a
// small stand-in for the DOM (what it holds, the keyboard, what it reports, that nothing a model sent becomes markup or an inline style). The look of it, the pointer and the real width are checked in a browser
// (docs/CARDS.md).
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHART,
  KEEP_PICK_MS,
  SERIES_STYLES,
  axisTitle,
  categoriesOf,
  chartGeometry,
  createFocusKeeper,
  describeChart,
  formatNumber,
  formatTick,
  isStrokeShape,
  isTextEntry,
  markerPath,
  nearestPoint,
  niceTicks,
  pointOf,
  readChart,
  readoutText,
  stepPoint,
  styleOf,
  tableOf,
  unitSuffix,
} from './chartcard.js';
import { objectRow, setObjectHelpers } from './objects.js';

const line = { kind: 'line', title: 'p99 latency by threads', xLabel: 'threads', yLabel: 'latency', xUnit: '', yUnit: 'ms', series: [{ name: 'gin', points: [[1, 12], [2, 15.5], [4, 31]] }, { name: 'echo', points: [[1, 10], [2, 11], [4, 20]] }] };
const bar = { kind: 'bar', title: 'Throughput', xLabel: '', yLabel: 'requests per second', xUnit: '', yUnit: 'rps', categories: ['go', 'rust', 'java'], series: [{ name: 'a', points: [100, 140, 90] }, { name: 'b', points: [80, 120, 60] }] };
const scatter = { kind: 'scatter', title: 'Size and time', xLabel: 'size', yLabel: 'time', xUnit: 'KB', yUnit: 's', series: [{ name: 'runs', points: [[30, 2], [10, 1], [20, 5]] }] };

describe('nice ticks', () => {
  it('are steps of 1, 2 or 5 times a power of ten that reach round the data, at most six', () => {
    expect(niceTicks(12, 31)).toEqual({ ticks: [10, 15, 20, 25, 30, 35], min: 10, max: 35, step: 5 });
    expect(niceTicks(0, 1)).toEqual({ ticks: [0, 0.2, 0.4, 0.6, 0.8, 1], min: 0, max: 1, step: 0.2 });
    expect(niceTicks(-37, 12)).toEqual({ ticks: [-40, -20, 0, 20], min: -40, max: 20, step: 20 });
    expect(niceTicks(0, 2_500_000).step).toBe(500_000);
    expect(niceTicks(0, 0.0003).ticks).toEqual([0, 0.0001, 0.0002, 0.0003]);
  });

  it('can stay inside the data\'s range, which is then the scale (the horizontal axis of a line)', () => {
    expect(niceTicks(0, 11, 6, { outward: false })).toEqual({ ticks: [0, 2, 4, 6, 8, 10], min: 0, max: 11, step: 2 });
    expect(niceTicks(0.3, 0.7, 6, { outward: false }).ticks).toEqual([0.3, 0.4, 0.5, 0.6, 0.7]);
  });

  it('gives a flat range a scale, and takes what is not a number for 0 to 1', () => {
    expect(niceTicks(5, 5)).toEqual({ ticks: [4.5, 5, 5.5], min: 4.5, max: 5.5, step: 0.5 });
    expect(niceTicks(0, 0).ticks).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(niceTicks(NaN, 3).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(9, 3).min).toBeLessThanOrEqual(3);
  });

  it('hold for ranges of every size: two to six ticks, ascending, the data inside the scale, and each tick a whole multiple of a step of 1, 2 or 5', () => {
    let seed = 7;
    const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 300; k++) {
      const a = (next() - 0.4) * 10 ** Math.floor(next() * 12 - 4);
      const b = a + next() * 10 ** Math.floor(next() * 12 - 4);
      for (const outward of [true, false]) {
        const t = niceTicks(a, b, 6, { outward });
        const label = `${a}..${b} ${outward}`;
        expect(t.ticks.length, label).toBeGreaterThanOrEqual(2);
        expect(t.ticks.length, label).toBeLessThanOrEqual(6);
        expect(t.ticks, label).toEqual([...t.ticks].sort((x, y) => x - y));
        const mantissa = t.step / 10 ** Math.floor(Math.log10(t.step) + 1e-9);
        expect([1, 2, 5].some((m) => Math.abs(mantissa - m) < 1e-6), label).toBe(true);
        if (outward) {
          expect(t.min, label).toBeLessThanOrEqual(Math.min(a, b) + 1e-6 * t.step);
          expect(t.max, label).toBeGreaterThanOrEqual(Math.max(a, b) - 1e-6 * t.step);
        } else {
          for (const v of t.ticks) expect(v >= t.min - 1e-6 * t.step && v <= t.max + 1e-6 * t.step, label).toBe(true);
        }
      }
    }
  });
});

describe('the words for numbers', () => {
  it('labels a tick with the digits its step needs, in thousands, and a million as 2.5M', () => {
    expect(formatTick(1234, 1)).toBe('1,234');
    expect(formatTick(0.5, 0.5)).toBe('0.5');
    expect(formatTick(-1234.5, 0.5)).toBe('-1,234.5');
    expect(formatTick(2_500_000, 500_000)).toBe('2.5M');
    expect(formatTick(-0, 1)).toBe('0');
    expect(formatTick(0.30000000000000004, 0.1)).toBe('0.3');
    expect(formatTick(NaN, 1)).toBe('');
  });

  it('says a number with up to ten digits, never in exponent form, and nothing for what is not a number', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(0.0000001234)).toBe('0.0000001234');
    expect(formatNumber(15.5)).toBe('15.5');
    expect(formatNumber(1e11)).toBe('100,000,000,000');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(Infinity)).toBe('');
    expect(formatNumber('4')).toBe('');
  });

  it('puts a unit after a number (a space, but not before % or a degree sign) and in the title of an axis', () => {
    expect(unitSuffix('ms')).toBe(' ms');
    expect(unitSuffix('%')).toBe('%');
    expect(unitSuffix('°C')).toBe('°C');
    expect(unitSuffix('')).toBe('');
    expect(axisTitle('latency', 'ms')).toBe('latency (ms)');
    expect(axisTitle('latency', '')).toBe('latency');
    expect(axisTitle('', 'ms')).toBe('(ms)');
    expect(axisTitle('', '')).toBe('');
    expect(axisTitle('a\nb', undefined)).toBe('a b');
  });
});

describe('the chart as the card reads it', () => {
  it('keeps what the host cleaned, and a point is a pair or a number whose x is its position', () => {
    expect(readChart({ t: 'chart', ...line })).toMatchObject({ kind: 'line', title: 'p99 latency by threads', series: [{ name: 'gin', points: [[1, 12], [2, 15.5], [4, 31]] }, { name: 'echo' }] });
    expect(pointOf([3, 9], 0)).toEqual({ x: 3, y: 9 });
    expect(pointOf(9, 4)).toEqual({ x: 4, y: 9 });
  });

  it('guards the cheap things: text is one line, a point that is no finite number is not drawn, a series with none is not there, a chart with none is nothing', () => {
    const got = readChart({ kind: 'line', title: ' a\nb ', xLabel: 5, series: [{ name: '', points: [1, 'x', NaN, Infinity, 5] }, { name: 'none', points: ['x'] }, null, { points: 'no' }] });
    expect(got.title).toBe('a b');
    expect(got.xLabel).toBe('');
    expect(got.series).toEqual([{ name: 'Series 1', points: [1, 5] }]);
    for (const bad of [null, 5, {}, { kind: 'pie', series: [{ points: [1] }] }, { kind: 'line', series: [] }, { kind: 'line', series: [{ points: ['x'] }] }, { kind: 'line' }]) expect(readChart(bad)).toBeNull();
  });

  it('gives a bar chart its categories (cut to what the series have, named 1, 2, 3 when they are missing) and plain numbers', () => {
    const got = readChart({ kind: 'bar', title: 'b', series: [{ name: 'a', points: [[0, 5], [1, 7]] }], categories: ['go'] });
    expect(got.categories).toEqual(['go', '2']);
    expect(got.series[0].points).toEqual([5, 7]);
    expect(categoriesOf({ series: [{ points: Array.from({ length: 40 }, (_, i) => i) }] })).toHaveLength(24);
  });

  it('says in a sentence what the whole chart is', () => {
    expect(describeChart(line)).toBe('p99 latency by threads: line chart, 2 series (gin, echo), 3 points each.');
    expect(describeChart(scatter)).toBe('Size and time: scatter chart, 1 series (runs), 3 points.');
    expect(describeChart({ ...bar, series: [{ name: 'a', points: [1, 2] }, { name: 'b', points: [1] }] })).toBe('Throughput: bar chart, 2 series (a, b), 3 points in all.');
  });
});

describe('how the series differ besides colour', () => {
  it('has six styles, each with a marker, a dash and a hatching of its own, and wraps round', () => {
    expect(SERIES_STYLES).toHaveLength(6);
    for (const key of ['shape', 'dash', 'pattern']) expect(new Set(SERIES_STYLES.map((s) => s[key])).size).toBe(6);
    expect(styleOf(6)).toBe(SERIES_STYLES[0]);
    expect(styleOf(-1)).toBe(SERIES_STYLES[5]);
  });

  it('draws every marker as a path of finite numbers; a cross and a plus are lines', () => {
    for (const { shape } of SERIES_STYLES) {
      const d = markerPath(shape, 10.123, 20.456, CHART.markerRadius);
      expect(d.startsWith('M'), shape).toBe(true);
      expect(d, shape).not.toMatch(/NaN|undefined|Infinity/);
      expect(d.length).toBeGreaterThan(10);
    }
    expect(SERIES_STYLES.filter((s) => isStrokeShape(s.shape)).map((s) => s.shape)).toEqual(['cross', 'plus']);
    expect(markerPath('circle', 10, 10, 4)).toBe('M6 10a4 4 0 1 0 8 0a4 4 0 1 0 -8 0z');
  });
});

describe('the geometry', () => {
  it('makes the plot, ticks at the data\'s round numbers, and the points where their numbers say, for the width it is given', () => {
    const g = chartGeometry(line, 560);
    expect(g.W).toBe(560);
    expect(g.H).toBe(325);
    expect(g.yTicks.map((t) => t.label)).toEqual(['10', '15', '20', '25', '30', '35']);
    expect(g.yTicks[0].py).toBe(g.plot.y1);
    expect(g.yTicks[5].py).toBe(g.plot.y0);
    expect(g.xTicks.map((t) => t.label)).toEqual(['1', '2', '4']);              // the x values the data has, where they are (there is room for each)
    expect(g.yTitle).toBe('latency (ms)');
    expect(g.xTitle).toBe('threads');
    const [a, b, c] = g.series[0].points;
    expect(a.px).toBeLessThan(b.px);
    expect(b.px).toBeLessThan(c.px);
    expect(a.py).toBeGreaterThan(c.py);                     // a bigger y is higher up
    for (const s of g.series) for (const p of s.points) expect(p.px >= g.plot.x0 && p.px <= g.plot.x1 && p.py >= g.plot.y0 && p.py <= g.plot.y1).toBe(true);
    expect(g.series[0].order).toEqual([0, 1, 2]);
  });

  it('labels the x values the data has when there are few and each has room (thread counts), and round numbers when there are many or they would touch', () => {
    const threads = { ...line, series: [{ name: 'a', points: [[1, 1], [2, 2], [4, 3], [8, 4], [16, 5]] }] };
    expect(chartGeometry(threads, 560).xTicks.map((t) => t.label)).toEqual(['1', '2', '4', '8', '16']);
    expect(chartGeometry(threads, 560).xTicks.map((t) => t.value)).toEqual([1, 2, 4, 8, 16]);
    const wide = { ...line, series: [{ name: 'a', points: Array.from({ length: 7 }, (_, i) => [i * 10, i]) }] };      // seven: past the six a chart labels
    expect(chartGeometry(wide, 560).xTicks.length).toBeLessThanOrEqual(6);
    expect(chartGeometry(wide, 560).xTicks.map((t) => t.label)).toEqual(['0', '20', '40', '60']);
    const close = { ...line, series: [{ name: 'a', points: [[1000000, 1], [1000001, 2], [2000000, 3]] }] };            // the first two would touch
    expect(chartGeometry(close, 400).xTicks.map((t) => t.label)).not.toContain('1,000,001');
    const plain = { ...line, series: [{ name: 'a', points: [3, 5, 4, 6] }] };                                            // positions 0 to 3
    expect(chartGeometry(plain, 560).xTicks.map((t) => t.label)).toEqual(['0', '1', '2', '3']);
    for (const t of chartGeometry(threads, 240).xTicks) expect(Number.isFinite(t.px)).toBe(true);
  });

  it('keeps the width between what a phone shows and what a page can use, and the height with it', () => {
    expect(chartGeometry(line, 100).W).toBe(CHART.minWidth);
    expect(chartGeometry(line, 5000).W).toBe(CHART.maxWidth);
    expect(chartGeometry(line, NaN).W).toBe(CHART.defaultWidth);
    expect(chartGeometry(line, 360).H).toBe(209);
    expect(chartGeometry(line, 760).H).toBe(CHART.maxHeight);
    expect(chartGeometry(line, 240).H).toBe(CHART.minHeight);
  });

  it('puts the labels of a narrow chart inside it: the plot is never less than its labels leave', () => {
    const wide = { ...line, series: [{ name: 'a', points: [[1, 1234567890], [2, 2234567890]] }] };
    const g = chartGeometry(wide, 240);
    expect(g.plot.x1 - g.plot.x0).toBeGreaterThan(100);
    expect(g.plot.y1).toBeGreaterThan(g.plot.y0);
  });

  it('puts a bar for each category, side by side for the series, on a baseline at zero, and thins the labels that do not fit', () => {
    const g = chartGeometry(bar, 360);
    expect(g.baseline).toBe(g.plot.y1);
    expect(g.xTicks.map((t) => t.label)).toEqual(['go', 'rust', 'java']);
    const [first, second] = [g.series[0].points[0], g.series[1].points[0]];
    expect(first.px).toBeLessThan(second.px);               // series side by side inside a category
    expect(first.bar.y + first.bar.h).toBeCloseTo(g.baseline, 5);
    expect(first.bar.h).toBeGreaterThan(second.bar.h);
    expect(g.series[0].points[1].px).toBeGreaterThan(second.px);
    const many = { ...bar, categories: Array.from({ length: 24 }, (_, i) => `category ${i + 1}`), series: [{ name: 'a', points: Array.from({ length: 24 }, (_, i) => i + 1) }] };
    const narrow = chartGeometry(many, 240);
    expect(narrow.xTicks.length).toBeLessThan(24);
    expect(narrow.xTicks.length).toBeGreaterThan(2);
    for (const t of narrow.xTicks) expect(t.label.length).toBeLessThanOrEqual(12);
  });

  it('labels many bars every nth, with the room of the bands each stands for, so that a number at the end of a name is not cut off; a few bars are all labelled, cut to their band', () => {
    const services = { ...bar, categories: Array.from({ length: 24 }, (_, i) => `service-${i + 1}`), series: [{ name: 'p50', points: Array.from({ length: 24 }, (_, i) => i + 1) }] };
    const g = chartGeometry(services, 325);
    expect(g.xTicks.length).toBeLessThan(24);
    expect(g.xTicks[0].label).toBe('service-1');
    for (const t of g.xTicks) expect(t.label.endsWith('…'), t.label).toBe(false);
    expect(g.xTicks.map((t) => t.value)).toEqual(g.xTicks.map((_, i) => i * (g.xTicks[1].value - g.xTicks[0].value)));
    const four = { ...bar, categories: ['go-gin', 'go-echo', 'node-express', 'python-flask'], series: [{ name: 'a', points: [1, 2, 3, 4] }] };
    const f = chartGeometry(four, 325);
    expect(f.xTicks.map((t) => t.value)).toEqual([0, 1, 2, 3]);
    expect(f.xTicks[0].label).toBe('go-gin');
    expect(f.xTicks[3].label.endsWith('…')).toBe(true);
  });

  it('has bars below zero hang from the baseline, which is then inside the plot', () => {
    const g = chartGeometry({ ...bar, series: [{ name: 'a', points: [10, -5] }], categories: ['up', 'down'] }, 400);
    expect(g.baseline).toBeLessThan(g.plot.y1);
    expect(g.series[0].points[1].bar.y).toBeCloseTo(g.baseline, 5);
    expect(g.series[0].points[0].bar.y + g.series[0].points[0].bar.h).toBeCloseTo(g.baseline, 5);
  });

  it('walks a scatter chart\'s points by x, and the other kinds as listed', () => {
    expect(chartGeometry(scatter, 400).series[0].order).toEqual([1, 2, 0]);
    expect(chartGeometry({ ...line, series: [{ name: 'a', points: [[3, 1], [1, 2]] }] }, 400).series[0].order).toEqual([0, 1]);
  });

  it('draws one point, and a flat series, without a division by zero', () => {
    for (const chart of [{ ...line, series: [{ name: 'a', points: [7] }] }, { ...line, series: [{ name: 'a', points: [[2, 5], [2, 5]] }] }, { ...bar, series: [{ name: 'a', points: [0, 0] }] }]) {
      const g = chartGeometry(chart, 400);
      for (const p of g.series[0].points) expect([p.px, p.py].every(Number.isFinite)).toBe(true);
      expect([...g.xTicks, ...g.yTicks].every((t) => Number.isFinite(t.px ?? t.py))).toBe(true);
    }
  });
});

describe('the point under a pointer', () => {
  const g = chartGeometry(line, 560);
  const p = (s, i) => g.series[s].points[i];

  it('is the nearest within reach, in both directions, and none beyond it', () => {
    expect(nearestPoint(g, p(0, 1).px + 3, p(0, 1).py - 4)).toEqual({ s: 0, i: 1 });
    expect(nearestPoint(g, p(1, 2).px, p(1, 2).py + 2)).toEqual({ s: 1, i: 2 });
    expect(nearestPoint(g, p(0, 1).px + 80, p(0, 1).py)).toBeNull();
    expect(nearestPoint(g, g.plot.x0 + 40, g.plot.y0 + 2)).toBeNull();
  });

  it('is found by x alone for a bar, anywhere in the plot\'s height and nowhere outside it', () => {
    const b = chartGeometry(bar, 360);
    const target = b.series[1].points[2];
    expect(nearestPoint(b, target.px, b.plot.y0 + 3)).toEqual({ s: 1, i: 2 });
    expect(nearestPoint(b, target.px, b.plot.y1 - 3)).toEqual({ s: 1, i: 2 });
    expect(nearestPoint(b, target.px, b.plot.y1 + 60)).toBeNull();
    expect(nearestPoint(b, target.px, b.plot.y0 - 60)).toBeNull();
  });
});

describe('the keys', () => {
  const g = chartGeometry(line, 560);
  const sc = chartGeometry(scatter, 560);

  it('go along a series with left and right, to its ends with Home and End, and stop at them', () => {
    expect(stepPoint(g, { s: 0, i: 0 }, 'ArrowRight')).toEqual({ s: 0, i: 1 });
    expect(stepPoint(g, { s: 0, i: 2 }, 'ArrowRight')).toEqual({ s: 0, i: 2 });
    expect(stepPoint(g, { s: 0, i: 2 }, 'ArrowLeft')).toEqual({ s: 0, i: 1 });
    expect(stepPoint(g, { s: 0, i: 0 }, 'ArrowLeft')).toEqual({ s: 0, i: 0 });
    expect(stepPoint(g, { s: 1, i: 1 }, 'Home')).toEqual({ s: 1, i: 0 });
    expect(stepPoint(g, { s: 1, i: 1 }, 'End')).toEqual({ s: 1, i: 2 });
  });

  it('change series with up and down, to the point nearest in x, and stop at the first and last series', () => {
    expect(stepPoint(g, { s: 0, i: 2 }, 'ArrowDown')).toEqual({ s: 1, i: 2 });
    expect(stepPoint(g, { s: 1, i: 1 }, 'ArrowUp')).toEqual({ s: 0, i: 1 });
    expect(stepPoint(g, { s: 1, i: 1 }, 'ArrowDown')).toEqual({ s: 1, i: 1 });
    expect(stepPoint(g, { s: 0, i: 1 }, 'ArrowUp')).toEqual({ s: 0, i: 1 });
    const uneven = chartGeometry({ ...line, series: [{ name: 'a', points: [[1, 1], [10, 2]] }, { name: 'b', points: [[2, 1], [9, 5], [30, 7]] }] }, 560);
    expect(stepPoint(uneven, { s: 0, i: 1 }, 'ArrowDown')).toEqual({ s: 1, i: 1 });         // x 10 is nearest to 9
    expect(stepPoint(uneven, { s: 1, i: 2 }, 'ArrowUp')).toEqual({ s: 0, i: 1 });
  });

  it('walk a scatter chart by x, and start at the first point from nothing', () => {
    expect(stepPoint(sc, { s: 0, i: 1 }, 'ArrowRight')).toEqual({ s: 0, i: 2 });            // x 10 then 20
    expect(stepPoint(sc, { s: 0, i: 2 }, 'ArrowRight')).toEqual({ s: 0, i: 0 });            // x 20 then 30
    expect(stepPoint(sc, null, 'ArrowRight')).toEqual({ s: 0, i: 1 });
    expect(stepPoint(g, null, 'Home')).toEqual({ s: 0, i: 0 });
  });

  it('are none for any other key', () => {
    for (const key of ['a', 'Enter', 'Tab', 'PageDown', ' ', 'Escape']) expect(stepPoint(g, { s: 0, i: 0 }, key)).toBeNull();
  });
});

describe('the readout', () => {
  it('says the series, the place in it and both values with their labels and units', () => {
    expect(readoutText(line, 0, 2)).toBe('gin, point 3 of 3: threads 4, latency 31 ms');
    expect(readoutText(line, 1, 1)).toBe('echo, point 2 of 3: threads 2, latency 11 ms');
    expect(readoutText(scatter, 0, 0)).toBe('runs, point 1 of 3: size 30 KB, time 2 s');
  });

  it('says a plain number\'s x as its position, the way the host does, and a bar by its category, with no label of the x when there is none', () => {
    expect(readoutText({ ...line, series: [{ name: 'a', points: [4, 5, 6] }] }, 0, 2)).toBe('a, point 3 of 3: threads 2, latency 6 ms');
    expect(readoutText(bar, 1, 1)).toBe('b, point 2 of 3: rust, requests per second 120 rps');
    expect(readoutText({ ...line, xLabel: '', yLabel: '', yUnit: '%' }, 0, 0)).toBe('gin, point 1 of 3: 1, 12%');
  });

  it('is nothing for a point that is not there', () => {
    expect(readoutText(line, 5, 0)).toBe('');
    expect(readoutText(line, 0, 9)).toBe('');
  });
});

describe('the table of the data', () => {
  it('is one column of x and a column for each series when they can share rows, in order of x, with a hole where a series has no point', () => {
    expect(tableOf(line)).toEqual({ caption: 'Data of p99 latency by threads', head: ['threads', 'gin', 'echo'], rows: [['1', '12', '10'], ['2', '15.5', '11'], ['4', '31', '20']] });
    const uneven = tableOf({ ...line, series: [{ name: 'a', points: [[3, 1], [1, 2]] }, { name: 'b', points: [[2, 9]] }] });
    expect(uneven.rows).toEqual([['1', '2', ''], ['2', '', '9'], ['3', '1', '']]);
  });

  it('names the one series\' column for what it measures, and the bars by their categories', () => {
    expect(tableOf({ ...line, series: [line.series[0]] }).head).toEqual(['threads', 'gin: latency (ms)']);
    expect(tableOf(bar)).toEqual({ caption: 'Data of Throughput', head: ['Category', 'a', 'b'], rows: [['go', '100', '80'], ['rust', '140', '120'], ['java', '90', '60']] });
  });

  it('keeps the order of the data, so that row N is point N of the readout, even when x does not rise or comes twice', () => {
    expect(tableOf(scatter)).toEqual({ caption: 'Data of Size and time', head: ['size (KB)', 'runs: time (s)'], rows: [['30', '2'], ['10', '1'], ['20', '5']] });
    expect(tableOf({ ...line, series: [{ name: 'a', points: [[1, 2], [1, 3]] }] }).rows).toEqual([['1', '2'], ['1', '3']]);
  });

  it('is a row for each point under Series, x and y when the series of a scatter chart do not share their x', () => {
    const two = { ...scatter, series: [{ name: 'a', points: [[1, 2], [3, 4]] }, { name: 'b', points: [[2, 5]] }] };
    expect(tableOf(two)).toEqual({ caption: 'Data of Size and time', head: ['Series', 'size (KB)', 'time (s)'], rows: [['a', '1', '2'], ['a', '3', '4'], ['b', '2', '5']] });
  });

  it('has the numbers grouped in thousands, as text', () => {
    expect(tableOf({ ...line, series: [{ name: 'a', points: [[1000, 1234567]] }] }).rows).toEqual([['1,000', '1,234,567']]);
  });
});

describe('where the student types', () => {
  it('is a text box, a text area or an editable region, and not a button, a check box or a slider', () => {
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    for (const type of ['button', 'checkbox', 'radio', 'range', 'submit', 'file']) expect(isTextEntry({ tagName: 'INPUT', type })).toBe(false);
    for (const other of [{ tagName: 'BUTTON' }, { tagName: 'DIV' }, null, undefined, 5, 'x']) expect(isTextEntry(other)).toBe(false);
  });
});

describe('what puts a pick on the view and takes it back', () => {
  /** The page's shared view, as view-state.js keeps it. */
  function fakeView() {
    const state = {};
    return {
      sets: [],
      set(part) {
        this.sets.push(part);
        for (const key of Object.keys(part)) if (part[key] === null) delete state[key]; else state[key] = part[key];
      },
      get: () => ({ v: 1, ...state }),
    };
  }
  /** Timers the test turns by hand. */
  function timers() {
    const pending = [];
    return { set: (fn, ms) => (pending.push({ fn, ms }), pending.length), clear: (id) => void (pending[id - 1] = null), pending, fire: () => pending.splice(0).forEach((t) => t && t.fn()) };
  }
  const owns = (o) => o.n === 5 && o.series !== undefined;

  it('reports a part, and takes it back when focus goes anywhere else, but only if it is still this card\'s', () => {
    const view = fakeView();
    const cleared = [];
    const keeper = createFocusKeeper({ view, owns, onClear: () => cleared.push(1) });
    keeper.report({ n: 5, series: 0, index: 2 });
    expect(view.get().obj).toEqual({ n: 5, series: 0, index: 2 });
    keeper.leave({ related: { tagName: 'BUTTON' } });
    expect(view.get().obj).toBeUndefined();
    expect(cleared).toHaveLength(1);
    // another card's part, or a run card's lines, are not taken away
    keeper.report({ n: 5, series: 0, index: 2 });
    view.set({ obj: { n: 9, lines: [1, 2] } });
    keeper.leave({ related: null });
    expect(view.get().obj).toEqual({ n: 9, lines: [1, 2] });
    view.set({ obj: { n: 7, series: 1, index: 0 } });
    keeper.clear();
    expect(view.get().obj).toEqual({ n: 7, series: 1, index: 0 });
  });

  it('keeps it when the window alone lost focus (the student will come back to it)', () => {
    const view = fakeView();
    const keeper = createFocusKeeper({ view, owns });
    keeper.report({ n: 5, series: 0, index: 0 });
    keeper.leave({ related: null, windowBlur: true });
    expect(view.get().obj).toEqual({ n: 5, series: 0, index: 0 });
  });

  it('keeps it for a while when focus goes to the message box, which is how the student asks about it, and takes it back then', () => {
    const view = fakeView();
    const t = timers();
    const keeper = createFocusKeeper({ view, owns, setTimer: t.set, clearTimer: t.clear });
    keeper.report({ n: 5, series: 1, index: 1 });
    keeper.leave({ related: { tagName: 'TEXTAREA' } });
    expect(view.get().obj).toEqual({ n: 5, series: 1, index: 1 });
    expect(t.pending).toHaveLength(1);
    expect(t.pending[0].ms).toBe(KEEP_PICK_MS);
    t.fire();
    expect(view.get().obj).toBeUndefined();
  });

  it('forgets the wait when focus comes back, or the point is picked again, or the part is let go', () => {
    const view = fakeView();
    const t = timers();
    const keeper = createFocusKeeper({ view, owns, setTimer: t.set, clearTimer: t.clear });
    keeper.report({ n: 5, series: 0, index: 0 });
    keeper.leave({ related: { tagName: 'TEXTAREA' } });
    keeper.enter();
    t.fire();
    expect(view.get().obj).toEqual({ n: 5, series: 0, index: 0 });
    keeper.leave({ related: { tagName: 'TEXTAREA' } });
    keeper.report({ n: 5, series: 0, index: 1 });
    t.fire();
    expect(view.get().obj).toEqual({ n: 5, series: 0, index: 1 });
    keeper.leave({ related: { tagName: 'TEXTAREA' } });
    keeper.clear();
    expect(view.get().obj).toBeUndefined();
    t.fire();
    expect(view.sets.filter((s) => s.obj === null)).toHaveLength(1);
  });

  it('does nothing, and does not throw, with no view to report to', () => {
    const keeper = createFocusKeeper({ view: null, owns });
    expect(() => {
      keeper.report({ n: 5, series: 0, index: 0 });
      keeper.leave({ related: null });
      keeper.clear();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------- the card, in a stand-in for the DOM

class Node_ {
  constructor(tag, className, text, ns) {
    this.tag = tag;
    this.ns = ns || null;
    this.className = className || '';
    this.text = text === undefined ? '' : text;
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.title = '';
    this.type = '';
    this.id = '';
    this.tabIndex = -1;
    this.hidden = false;
    this.focused = 0;
    this.W = 560;
  }
  append(...items) {
    this.children.push(...items);
  }
  setAttribute(name, value) {
    if (name === 'style') throw new Error('an inline style attribute: the page\'s content policy forbids it');
    this.attrs[name] = String(value);
    if (name === 'class') this.className = String(value);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  get textContent() {
    return this.text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(value) {
    this.text = value;
    this.children = [];
  }
  set innerHTML(_value) {
    throw new Error('innerHTML');
  }
  get style() {
    throw new Error('an inline style');
  }
  all() {
    return this.children.flatMap((c) => (typeof c === 'string' ? [] : [c, ...c.all()]));
  }
  contains(other) {
    return other === this || this.all().includes(other);
  }
  find(className) {
    return this.all().find((n) => n.className.split(' ').includes(className));
  }
  findAll(className) {
    return this.all().filter((n) => n.className.split(' ').includes(className));
  }
  focus() {
    this.focused++;
    this.fire('focus', {});
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.W, height: 0 };
  }
  /** Runs the listeners of an event; `event.defaultPrevented` is set when one of them prevents it. */
  fire(type, event = {}) {
    const e = { preventDefault: () => (e.defaultPrevented = true), defaultPrevented: false, ...event };
    for (const fn of this.listeners[type] || []) fn(e);
    return e;
  }
}
const el = (tag, className, text) => new Node_(tag, className, text);

function fakeView() {
  const state = {};
  return {
    sets: [],
    set(part) {
      this.sets.push(part);
      for (const key of Object.keys(part)) if (part[key] === null) delete state[key]; else state[key] = part[key];
    },
    get: () => ({ v: 1, ...state }),
  };
}

let view;
function draw(obj, extra = {}) {
  view = fakeView();
  vi.stubGlobal('document', { createElementNS: (ns, tag) => new Node_(tag, '', undefined, ns), hasFocus: () => true });
  setObjectHelpers({ el, view });
  const row = objectRow({ n: 41, ts: '2026-11-07T10:15:00.000Z', role: 'assistant', text: 'Chart: x (2 series)', kind: 'object', obj: { t: 'chart', ...obj }, ...extra });
  expect(row).not.toBeNull();
  const card = row.children[0];
  return { row, card, plot: card.find('ch-plot'), readout: card.find('ch-readout') };
}
const key = (plot, k, extra = {}) => plot.fire('keydown', { key: k, ...extra });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setObjectHelpers(null);
});

describe('the card of a chart', () => {
  it('is a row of the conversation of the card\'s type, with the line\'s summary as the text a search and a copy have, and a named group that is not read out as it arrives', () => {
    const { row, card } = draw(line);
    expect(row.className).toBe('row object');
    expect(row.dataset).toEqual({ n: 41, type: 'chart' });
    expect(row._text).toBe('Chart: x (2 series)');
    expect(card.className).toBe('chartcard');
    expect(card.dataset).toEqual({ n: '41', kind: 'line' });
    expect(card.attrs.role).toBe('group');
    expect(card.attrs['aria-label']).toBe('p99 latency by threads: line chart, 2 series (gin, echo), 3 points each.');
    expect(card.attrs['aria-live']).toBe('off');
    expect(card.find('ch-title').textContent).toBe('p99 latency by threads');
  });

  it('has a plot that is one tab stop with a name and the keys to use, and a readout that is a polite live region', () => {
    const { card, plot, readout } = draw(line);
    expect(plot.tabIndex).toBe(0);
    expect(plot.attrs.role).toBe('application');
    expect(plot.attrs['aria-roledescription']).toBe('interactive chart');
    expect(plot.attrs['aria-label']).toMatch(/^p99 latency by threads\. p99 latency by threads: line chart/);
    const help = card.all().find((n) => n.id === plot.attrs['aria-describedby']);
    expect(help.textContent).toMatch(/Left and right arrow keys move along a series.*Enter or Space picks a point.*Escape lets it go/);
    expect(readout.attrs['aria-live']).toBe('polite');
    expect(readout.attrs['aria-atomic']).toBe('true');
    expect(readout.textContent).toBe('');
    expect(card.all().filter((n) => n.tabIndex === 0)).toEqual([plot]);                 // one tab stop in the plot, the buttons are the browser's
  });

  it('draws the plot as SVG for the series: a line with its own dash and markers for each, ticks and titles as text', () => {
    const { plot } = draw(line);
    const svg = plot.find('ch-svg');
    expect(svg.ns).toBe('http://www.w3.org/2000/svg');
    expect(svg.attrs.viewBox).toBe('0 0 560 325');
    expect(svg.attrs['aria-hidden']).toBe('true');
    const lines = svg.findAll('ch-line');
    expect(lines).toHaveLength(2);
    expect(lines[0].attrs['stroke-dasharray']).toBeUndefined();
    expect(lines[1].attrs['stroke-dasharray']).toBe(SERIES_STYLES[1].dash);
    expect(lines[0].attrs.d).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
    expect(svg.findAll('ch-mk')).toHaveLength(2);
    expect(svg.findAll('ch-series').map((n) => n.className)).toEqual(['ch-series ch-s0', 'ch-series ch-s1']);
    expect(svg.findAll('ch-tick').map((n) => n.textContent)).toEqual(['10', '15', '20', '25', '30', '35', '1', '2', '4']);
    expect(svg.findAll('ch-axis-title').map((n) => n.textContent)).toEqual(['latency (ms)', 'threads']);
    expect(svg.find('ch-cursor').className).toBe('ch-cursor');
  });

  it('draws bars with hatching for every series but the first, which the legend shows too, and no line', () => {
    const { card, plot } = draw(bar);
    const svg = plot.find('ch-svg');
    expect(svg.findAll('ch-line')).toHaveLength(0);
    expect(svg.findAll('ch-bar')).toHaveLength(3);
    const hatched = svg.findAll('ch-barp');
    expect(hatched).toHaveLength(3);
    const id = /^url\(#(.+)\)$/.exec(hatched[0].attrs.fill)[1];
    const patterns = card.find('ch-defs').all().filter((n) => n.tag === 'pattern');
    expect(patterns.map((p) => p.attrs.id)).toEqual([id]);
    expect(card.find('ch-defs').attrs['aria-hidden']).toBe('true');
    const swatches = card.find('ch-legend').findAll('ch-swatch');
    expect(swatches[0].find('ch-bar')).toBeDefined();
    expect(swatches[1].find('ch-barp').attrs.fill).toBe(`url(#${id})`);
  });

  it('has a legend of the names with the marker and dash each series has in the plot, and a note when there is one', () => {
    const { card } = draw(line, { obj: { t: 'chart', ...line, note: 'measured with run_go' } });
    const keys = card.find('ch-legend').findAll('ch-key');
    expect(keys.map((k) => k.find('ch-key-name').textContent)).toEqual(['gin', 'echo']);
    expect(keys.map((k) => k.className)).toEqual(['ch-key ch-s0', 'ch-key ch-s1']);
    expect(keys[1].find('ch-line').attrs['stroke-dasharray']).toBe(SERIES_STYLES[1].dash);
    expect(keys[1].find('ch-mk').attrs.d).toBe(markerPath('square', 15, 7, CHART.markerRadius));
    expect(card.find('ch-note').textContent).toBe('measured with run_go');
    expect(draw(line).card.find('ch-note')).toBeUndefined();
  });

  it('is nothing for a chart that has nothing to draw, so the conversation skips it', () => {
    view = fakeView();
    setObjectHelpers({ el, view });
    for (const obj of [{ t: 'chart', kind: 'line', title: 'x', series: [] }, { t: 'chart', kind: 'pie', title: 'x', series: [{ name: 'a', points: [1] }] }, { t: 'chart' }]) {
      expect(objectRow({ n: 1, kind: 'object', obj })).toBeNull();
    }
  });
});

describe('what a model wrote is text, never markup or style', () => {
  it('stays the text of a node, in the title, the labels, the names, the categories, the note and the table (the stand-in refuses innerHTML and every inline style)', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { card, plot } = draw({ ...bar, title: evil, yLabel: evil, yUnit: '<b>x</b>', categories: [evil, '</text><script>x()</script>', 'ok'], note: evil, series: [{ name: evil, points: [1, 2, 3] }] });
    expect(card.find('ch-title').textContent).toBe(evil);
    expect(card.find('ch-note').textContent).toBe(evil);
    expect(card.find('ch-key-name').textContent).toBe(evil);
    expect(plot.find('ch-svg').findAll('ch-axis-title')[0].textContent).toBe(`${evil} (<b>x</b>)`);
    expect(plot.find('ch-svg').findAll('ch-tick').some((n) => n.textContent.startsWith('</text><script>'))).toBe(true);        // cut to the room under its bar, still text
    card.find('ch-btn').fire('click');
    expect(card.find('ch-table').all().some((n) => n.tag === 'th' && n.textContent === evil)).toBe(true);
    for (const n of card.all()) {
      expect(n.tag).toMatch(/^[a-z]+$/);
      for (const name of Object.keys(n.attrs)) expect(name, `${n.tag} ${name}`).not.toMatch(/^on|^style$|^href$|^xlink/i);
    }
  });
});

describe('reading a point with the keyboard', () => {
  it('says the first point when the plot is focused, then moves along the series and between them, and says each in the live region', () => {
    const { plot, readout } = draw(line);
    plot.fire('focus', {});
    expect(readout.textContent).toBe('gin, point 1 of 3: threads 1, latency 12 ms');
    const right = key(plot, 'ArrowRight');
    expect(right.defaultPrevented).toBe(true);
    expect(readout.textContent).toBe('gin, point 2 of 3: threads 2, latency 15.5 ms');
    key(plot, 'End');
    expect(readout.textContent).toBe('gin, point 3 of 3: threads 4, latency 31 ms');
    key(plot, 'ArrowDown');
    expect(readout.textContent).toBe('echo, point 3 of 3: threads 4, latency 20 ms');
    key(plot, 'ArrowLeft');
    key(plot, 'ArrowUp');
    expect(readout.textContent).toBe('gin, point 2 of 3: threads 2, latency 15.5 ms');
    expect(plot.find('ch-cursor').className).toBe('ch-cursor ch-on');
    expect(plot.find('ch-cursor').attrs.transform).toMatch(/^translate\([\d.]+ [\d.]+\)$/);
  });

  it('does not report where it is until a point is picked, and leaves the keys it does not use to the browser', () => {
    const { plot } = draw(line);
    plot.fire('focus', {});
    key(plot, 'ArrowRight');
    expect(view.sets).toEqual([]);
    expect(key(plot, 'Tab').defaultPrevented).toBe(false);
    expect(key(plot, 'a').defaultPrevented).toBe(false);
    expect(key(plot, 'ArrowRight', { ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it('picks the point on Enter or Space and reports its series and index (the host\'s numbering) to the view; Escape lets it go', () => {
    const { plot } = draw(line);
    plot.fire('focus', {});
    key(plot, 'ArrowRight');
    key(plot, 'ArrowDown');
    expect(key(plot, 'Enter').defaultPrevented).toBe(true);
    expect(view.sets).toEqual([{ obj: { n: 41, series: 1, index: 1 } }]);
    key(plot, 'ArrowLeft');
    key(plot, ' ');
    expect(view.sets.at(-1)).toEqual({ obj: { n: 41, series: 1, index: 0 } });
    key(plot, 'Escape');
    expect(view.get().obj).toBeUndefined();
  });

  it('reports a bar\'s category as its index and a scatter point by its place in the list, not in the order of x', () => {
    const b = draw(bar);
    b.plot.fire('focus', {});
    key(b.plot, 'ArrowRight');
    key(b.plot, 'Enter');
    expect(view.sets).toEqual([{ obj: { n: 41, series: 0, index: 1 } }]);
    const s = draw(scatter);
    s.plot.fire('focus', {});
    key(s.plot, 'Enter');                                                              // the first by x is the second in the list
    expect(view.sets).toEqual([{ obj: { n: 41, series: 0, index: 1 } }]);
  });
});

describe('reading a point with a pointer', () => {
  const at = (plot, p) => ({ clientX: p.px, clientY: p.py });

  it('shows the point under a mouse and goes back to what was there when it leaves, without reporting anything', () => {
    const { plot, readout } = draw(line);
    const g = chartGeometry(readChart({ ...line }), 560);
    plot.find('ch-svg');
    const svg = plot.find('ch-svg');
    plot.fire('pointermove', { ...at(plot, g.series[0].points[1]), pointerType: 'mouse' });
    expect(readout.textContent).toBe('gin, point 2 of 3: threads 2, latency 15.5 ms');
    expect(svg.find('ch-cursor').className).toBe('ch-cursor ch-on');
    plot.fire('pointerleave', {});
    expect(readout.textContent).toBe('');
    expect(view.sets).toEqual([]);
    plot.fire('pointermove', { clientX: g.plot.x0 + 100, clientY: g.plot.y0 + 5, pointerType: 'mouse' });
    expect(readout.textContent).toBe('');
  });

  it('ignores a finger moving over the plot (it scrolls the page), and picks on a tap or click', () => {
    const { plot, readout } = draw(line);
    const g = chartGeometry(readChart({ ...line }), 560);
    plot.fire('pointermove', { ...at(plot, g.series[1].points[2]), pointerType: 'touch' });
    expect(readout.textContent).toBe('');
    plot.fire('click', at(plot, g.series[1].points[2]));
    expect(readout.textContent).toBe('echo, point 3 of 3: threads 4, latency 20 ms');
    expect(view.sets).toEqual([{ obj: { n: 41, series: 1, index: 2 } }]);
    expect(plot.focused).toBe(1);
  });

  it('lets a pick go when the empty plot is clicked, and reports nothing for it', () => {
    const { plot, readout } = draw(line);
    const g = chartGeometry(readChart({ ...line }), 560);
    plot.fire('click', at(plot, g.series[0].points[0]));
    expect(view.get().obj).toEqual({ n: 41, series: 0, index: 0 });
    plot.fire('click', { clientX: g.plot.x0 + 200, clientY: g.plot.y0 + 2 });
    expect(view.get().obj).toBeUndefined();
    expect(readout.textContent).toBe('');
  });
});

describe('when focus leaves the card', () => {
  it('takes the pick back, and the card forgets it', () => {
    const { card, plot, readout } = draw(line);
    plot.fire('focus', {});
    key(plot, 'Enter');
    expect(view.get().obj).toEqual({ n: 41, series: 0, index: 0 });
    card.fire('focusout', { relatedTarget: { tagName: 'BUTTON' } });
    expect(view.get().obj).toBeUndefined();
    expect(readout.textContent).toBe('');
    expect(plot.find('ch-cursor').className).toBe('ch-cursor');
  });

  it('does not take it back when focus only moves inside the card, or the window alone loses focus', () => {
    const { card, plot } = draw(line);
    plot.fire('focus', {});
    key(plot, 'Enter');
    card.fire('focusout', { relatedTarget: card.find('ch-btn') });
    expect(view.get().obj).toEqual({ n: 41, series: 0, index: 0 });
    vi.stubGlobal('document', { createElementNS: () => new Node_('x'), hasFocus: () => false });
    card.fire('focusout', { relatedTarget: null });
    expect(view.get().obj).toEqual({ n: 41, series: 0, index: 0 });
  });

  it('keeps it while the student writes their question in the message box, and takes it back after a while', () => {
    vi.useFakeTimers();
    const { card, plot, readout } = draw(line);
    plot.fire('focus', {});
    key(plot, 'ArrowRight');
    key(plot, 'Enter');
    card.fire('focusout', { relatedTarget: { tagName: 'TEXTAREA' } });
    expect(view.get().obj).toEqual({ n: 41, series: 0, index: 1 });
    expect(readout.textContent).toBe('gin, point 2 of 3: threads 2, latency 15.5 ms');
    vi.advanceTimersByTime(KEEP_PICK_MS + 10);
    expect(view.get().obj).toBeUndefined();
    expect(readout.textContent).toBe('');
  });
});

describe('the data table', () => {
  it('is built the first time, a real table with a caption and header cells, and shown and hidden by one button that says which', () => {
    const { card } = draw(line);
    const button = card.find('ch-btn');
    const data = card.find('ch-data');
    expect(button.textContent).toBe('Show data');
    expect(button.attrs['aria-expanded']).toBe('false');
    expect(button.attrs['aria-controls']).toBe(data.id);
    expect(data.hidden).toBe(true);
    expect(data.all()).toEqual([]);
    button.fire('click');
    expect(data.hidden).toBe(false);
    expect(button.textContent).toBe('Hide data');
    expect(button.attrs['aria-expanded']).toBe('true');
    const table = data.find('ch-table');
    expect(table.tag).toBe('table');
    expect(table.find('sr-only').tag).toBe('caption');
    expect(table.find('sr-only').textContent).toBe('Data of p99 latency by threads');
    expect(table.all().filter((n) => n.tag === 'th' && n.attrs.scope === 'col').map((n) => n.textContent)).toEqual(['threads', 'gin', 'echo']);
    const rows = table.all().filter((n) => n.tag === 'tr').slice(1);
    expect(rows.map((r) => r.children.map((c) => c.textContent))).toEqual([['1', '12', '10'], ['2', '15.5', '11'], ['4', '31', '20']]);
    expect(rows[0].children[0].attrs.scope).toBe('row');
    expect(data.attrs.role).toBe('region');
    expect(data.tabIndex).toBe(0);
    button.fire('click');
    expect(data.hidden).toBe(true);
    expect(button.textContent).toBe('Show data');
    button.fire('click');
    expect(data.findAll('ch-table')).toHaveLength(1);
  });
});

describe('the width it has', () => {
  it('makes the geometry again for the width it is measured at, and not for a change of a pixel or two', () => {
    const watchers = [];
    class FakeObserver {
      constructor(fn) {
        this.fn = fn;
        this.disconnected = false;
        watchers.push(this);
      }
      observe(node) {
        this.node = node;
      }
      disconnect() {
        this.disconnected = true;
      }
    }
    vi.stubGlobal('ResizeObserver', FakeObserver);
    const { card, plot } = draw(line);
    expect(watchers).toHaveLength(1);
    expect(watchers[0].node).toBe(plot);
    expect(plot.find('ch-svg').attrs.viewBox).toBe('0 0 560 325');
    watchers[0].fn([{ contentRect: { width: 344 } }]);
    expect(plot.find('ch-svg').attrs.viewBox).toBe('0 0 344 200');
    const before = plot.find('ch-svg');
    watchers[0].fn([{ contentRect: { width: 346 } }]);
    expect(plot.find('ch-svg')).toBe(before);
    watchers[0].fn([{ contentRect: { width: 0 } }]);
    expect(plot.find('ch-svg')).toBe(before);
    watchers[0].fn([{ contentRect: { width: 2000 } }]);
    expect(plot.find('ch-svg').attrs.viewBox).toBe(`0 0 ${CHART.maxWidth} ${CHART.maxHeight}`);
    // a pick survives a redraw, with its ring on the point
    plot.fire('focus', {});
    key(plot, 'ArrowRight');
    watchers[0].fn([{ contentRect: { width: 300 } }]);
    expect(plot.find('ch-cursor').className).toBe('ch-cursor ch-on');
    expect(card.find('ch-readout').textContent).toBe('gin, point 2 of 3: threads 2, latency 15.5 ms');
  });

  it('lets go of the observer, and of a pick, when the card is taken away', () => {
    const watchers = [];
    class FakeObserver {
      constructor() {
        this.disconnected = false;
        watchers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    }
    vi.stubGlobal('ResizeObserver', FakeObserver);
    const { row, plot } = draw(line);
    plot.fire('focus', {});
    key(plot, 'Enter');
    row._object.destroy();
    expect(watchers[0].disconnected).toBe(true);
    expect(view.get().obj).toBeUndefined();
  });
});
