/**
 * What the voice functions and the text agent's tools hand to the gate for a chart, a trace and a prediction card (docs/CARDS.md): the arguments turned into the object's own fields, the sentence that says
 * what is wrong when the gate refuses, and what the gate left out. The invariant that matters: `whyNot...` is a sentence exactly when `cleanObject` gives nothing.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { chartDropped, chartFromArgs, whyNotChart } from './chart.js';
import { cleanObject } from './clean.js';
import { predictDropped, predictFromArgs, whyNotPredict } from './predict.js';
import { traceDropped, traceFromArgs, whyNotTrace } from './trace.js';
import { OBJECT_JSON_MAX } from './types.js';
import type { ChartObject, PredictObject, TraceObject } from './types.js';

const MAIN = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n';

describe('the chart from the arguments of show_chart', () => {
  const args = { title: 'p99 by threads', kind: 'line', x_label: 'threads', y_label: 'latency', x_unit: 'n', y_unit: 'ms', categories: ['a'], series: [{ name: 'gin', points: [1, 2] }], note: 'measured by run_code' };

  it('maps the snake_case names to the object\'s own and leaves the values for the gate', () => {
    expect(chartFromArgs(args)).toEqual({ t: 'chart', title: 'p99 by threads', kind: 'line', xLabel: 'threads', yLabel: 'latency', xUnit: 'n', yUnit: 'ms', categories: ['a'], series: [{ name: 'gin', points: [1, 2] }], note: 'measured by run_code' });
    expect(cleanObject(chartFromArgs(args))).toMatchObject({ t: 'chart', xLabel: 'threads', yUnit: 'ms' });
  });

  it('takes camelCase too, and anything at all without throwing', () => {
    expect(chartFromArgs({ title: 't', xLabel: 'x', yLabel: 'y', yUnit: 'ms' })).toMatchObject({ xLabel: 'x', yLabel: 'y', yUnit: 'ms' });
    for (const odd of [null, undefined, 5, 'x', [], [1]]) expect(chartFromArgs(odd)).toMatchObject({ t: 'chart' });
  });
});

describe('why a chart is refused', () => {
  const chart = { t: 'chart', title: 'T', kind: 'line', xLabel: 'x', yLabel: 'y', series: [{ name: 'a', points: [1, 2, 3] }] };

  it('says nothing for a chart the gate takes', () => {
    expect(whyNotChart(chart)).toBeNull();
    expect(whyNotChart({ ...chart, series: [{ name: 'a', points: ['x', 4] }] })).toBeNull();
  });

  it('names the first thing wrong, in words a model can act on', () => {
    expect(whyNotChart(null)).toMatch(/not a chart/);
    expect(whyNotChart({ ...chart, title: '  ' })).toMatch(/needs a title/);
    expect(whyNotChart({ ...chart, kind: 'pie' })).toMatch(/line, bar or scatter \(it was "pie"\)/);
    expect(whyNotChart({ ...chart, kind: undefined })).toMatch(/it was undefined/);
    expect(whyNotChart({ ...chart, series: 'x' })).toMatch(/list of \{ name, points \}/);
    expect(whyNotChart({ ...chart, series: [] })).toMatch(/at least one series/);
    expect(whyNotChart({ ...chart, series: [{ name: 'a', points: [1] }, { name: 'b', points: ['x', null] }] })).toBeNull();
    expect(whyNotChart({ ...chart, series: [{ name: 'a', points: ['x'] }, { name: 'b', points: [] }] })).toMatch(/series 1 has no point the chart can draw/);
    expect(whyNotChart({ ...chart, series: [{ name: 'a', points: [1e13] }] })).toMatch(/below 1e12/);
  });

  it('says when the chart is too big for the history, which the type\'s own cleaner does not check', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, points: Array.from({ length: 200 }, (_, k) => [k + 0.123456789, k * 1.987654321 + i]) }));
    const big = { ...chart, series: many };
    expect(cleanObject(big)).toBeNull();
    expect(whyNotChart(big)).toMatch(new RegExp(`too big \\(\\d+ characters, at most ${OBJECT_JSON_MAX}`));
  });

  it('is a sentence exactly when the gate gives nothing, over a lot of odd charts', () => {
    const odd: unknown[] = [
      chart, null, 3, 'chart', [], {}, { t: 'chart' }, { ...chart, series: [{}] }, { ...chart, series: [null] }, { ...chart, series: [{ points: 'x' }] },
      { ...chart, series: [{ name: 'a', points: [[1]] }] }, { ...chart, series: [{ name: 'a', points: [[1, 2, 3]] }] }, { ...chart, series: [{ name: 'a', points: [NaN, Infinity] }] },
      { ...chart, kind: 'bar', series: [{ name: 'a', points: [4, 5] }], categories: ['a'] }, { ...chart, kind: 'scatter', series: [{ name: 'a', points: [[1, 2]] }] },
      { ...chart, title: 5 }, { ...chart, title: 'x'.repeat(500) }, { ...chart, series: Array.from({ length: 9 }, () => ({ name: 's', points: [1] })) },
    ];
    for (const raw of odd) expect(whyNotChart(raw) === null, JSON.stringify(raw)?.slice(0, 80)).toBe(cleanObject(raw) !== null);
  });
});

describe('what a chart left out', () => {
  const given = (series: unknown) => ({ t: 'chart', title: 'T', kind: 'line', xLabel: '', yLabel: '', series });

  it('is nothing when every series and point was kept', () => {
    const raw = given([{ name: 'a', points: [1, 2] }]);
    expect(chartDropped(raw, cleanObject(raw) as ChartObject)).toBe('');
  });

  it('counts the series and the points that were not numbers or were over the limits', () => {
    const raw = given([{ name: 'a', points: [1, 'x', 3] }, { name: 'b', points: ['no'] }]);
    expect(chartDropped(raw, cleanObject(raw) as ChartObject)).toBe('Left out of the chart: 1 of 2 series and 2 of 4 points (not numbers, or over the limits of 6 series, 200 points a series and 24 bars).');
    const long = given([{ name: 'a', points: Array.from({ length: 250 }, (_, i) => i) }]);
    expect(chartDropped(long, cleanObject(long) as ChartObject)).toMatch(/0 of 1 series and 50 of 250 points/);
  });
});

describe('the trace from the arguments of show_trace, and why one is refused', () => {
  const trace = { t: 'trace', title: 'Raft election', actors: ['A', 'B'], events: [{ from: 'A', to: 'B', label: 'RequestVote' }] };

  it('maps the arguments to the object and takes anything without throwing', () => {
    expect(traceFromArgs({ title: 'T', actors: ['A', 'B'], events: [], note: 'n', extra: 1 })).toEqual({ t: 'trace', title: 'T', actors: ['A', 'B'], events: [], note: 'n' });
    for (const odd of [null, undefined, 5, 'x']) expect(traceFromArgs(odd)).toMatchObject({ t: 'trace' });
  });

  it('says nothing for a trace the gate takes', () => {
    expect(whyNotTrace(trace)).toBeNull();
  });

  it('names the first thing wrong, and the number of the first step that does not fit', () => {
    expect(whyNotTrace(null)).toMatch(/not a trace/);
    expect(whyNotTrace({ ...trace, title: '' })).toMatch(/needs a title/);
    expect(whyNotTrace({ ...trace, actors: ['A'] })).toMatch(/2 to 8 distinct names.*it had 1/);
    expect(whyNotTrace({ ...trace, actors: ['A', ' A ', 'A'] })).toMatch(/it had 1/);
    expect(whyNotTrace({ ...trace, actors: 'AB' })).toMatch(/it had 0/);
    expect(whyNotTrace({ ...trace, events: [] })).toMatch(/list of steps in order/);
    expect(whyNotTrace({ ...trace, events: [{ from: 'Z', label: 'x' }] })).toBe('step 1: from is "Z", which is not one of the actors (A, B)');
    expect(whyNotTrace({ ...trace, events: [{ from: 'A', label: '' }] })).toMatch(/step 1 has no label/);
    expect(whyNotTrace({ ...trace, events: [{ from: 'A', label: 'ok' }, 7] })).toBeNull();
    expect(whyNotTrace({ ...trace, events: [7, { from: 'A', to: 'Q', label: 'x' }] })).toMatch(/step 1 is not an object/);
    expect(whyNotTrace({ ...trace, events: [{ from: 'A', to: 'Q', label: 'x' }] })).toBe('step 1: to is "Q", which is not one of the actors (A, B)');
  });

  it('says when the trace is too big for the history', () => {
    const events = Array.from({ length: 120 }, (_, i) => ({ from: 'A', to: 'B', label: `step ${i} ${'x'.repeat(60)}`, note: 'n'.repeat(190), state: [{ actor: 'A', text: 's'.repeat(70) }, { actor: 'B', text: 't'.repeat(70) }] }));
    expect(cleanObject({ ...trace, events })).toBeNull();
    expect(whyNotTrace({ ...trace, events })).toMatch(/too big/);
  });

  it('is a sentence exactly when the gate gives nothing', () => {
    const odd: unknown[] = [
      trace, null, 'x', {}, { t: 'trace' }, { ...trace, events: [{ from: 'A' }] }, { ...trace, events: [{ from: 'B', to: 'B', label: 'self' }] }, { ...trace, events: [{ from: 'A', label: 'x', state: 'no' }] },
      { ...trace, actors: Array.from({ length: 12 }, (_, i) => `n${i}`) }, { ...trace, title: 4 }, { ...trace, events: Array.from({ length: 200 }, () => ({ from: 'A', label: 'x' })) },
    ];
    for (const raw of odd) expect(whyNotTrace(raw) === null, JSON.stringify(raw)?.slice(0, 80)).toBe(cleanObject(raw) !== null);
  });

  it('counts the steps that were left out', () => {
    const raw = { ...trace, events: [{ from: 'A', label: 'one' }, { from: 'Z', label: 'two' }, { from: 'B', label: '' }] };
    expect(traceDropped(raw, cleanObject(raw) as TraceObject)).toMatch(/^Left out of the trace: 2 of 3 steps/);
    expect(traceDropped(trace, cleanObject(trace) as TraceObject)).toBe('');
  });
});

describe('the prediction card from the arguments of ask_to_predict, and why one is refused', () => {
  const card = { t: 'predict', question: 'What does this print?', action: 'run', pkg: '.', files: [{ path: 'main.go', content: MAIN }], choices: ['hi', 'nothing'] };

  it('maps the arguments to the object', () => {
    expect(predictFromArgs({ question: 'q', action: 'test', pkg: './...', files: [], choices: ['a', 'b'], extra: 1 })).toEqual({ t: 'predict', question: 'q', action: 'test', pkg: './...', files: [], choices: ['a', 'b'] });
    for (const odd of [null, undefined, 5, 'x']) expect(predictFromArgs(odd)).toMatchObject({ t: 'predict' });
  });

  it('says nothing for a card the gate takes', () => {
    expect(whyNotPredict(card)).toBeNull();
    expect(whyNotPredict({ ...card, pkg: undefined })).toBeNull();
  });

  it('names the first thing wrong, with the sandbox\'s own sentence for a program it refuses', () => {
    expect(whyNotPredict(null)).toMatch(/not a prediction card/);
    expect(whyNotPredict({ ...card, question: '' })).toMatch(/needs a question/);
    expect(whyNotPredict({ ...card, action: 'vet' })).toMatch(/run \(go run\) or test/);
    expect(whyNotPredict({ ...card, files: [] })).toMatch(/1 to 6 files/);
    expect(whyNotPredict({ ...card, files: Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.go`, content: 'package main' })) })).toMatch(/7 files: at most 6/);
    expect(whyNotPredict({ ...card, files: [{ path: 'main.go', content: 5 }] })).toMatch(/file 1 needs a path and its content as text/);
    expect(whyNotPredict({ ...card, files: [{ path: 'main.go', content: 'x'.repeat(6001) }] })).toMatch(/file 1 is 6001 characters: at most 6000/);
    const gate = whyNotPredict({ ...card, files: [{ path: '../main.go', content: MAIN }] });
    expect(gate).toMatch(/^the sandbox's check refused the program: /);
    expect(gate).not.toMatch(/Not run/);
    expect(whyNotPredict({ ...card, pkg: '/etc' })).toMatch(/sandbox's check refused the program: .*pkg/);
    expect(whyNotPredict({ ...card, action: 'run', pkg: './...' })).toMatch(/go run. takes one package/);
  });

  it('says when the card is too big for the history (six files of six thousand characters are)', () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.go`, content: `package main\n// ${'x'.repeat(5900)}\n` }));
    expect(cleanObject({ ...card, action: 'test', pkg: './...', files })).toBeNull();
    expect(whyNotPredict({ ...card, action: 'test', pkg: './...', files })).toMatch(/too big|sandbox's check/);
  });

  it('is a sentence exactly when the gate gives nothing', () => {
    const odd: unknown[] = [
      card, null, 'x', {}, { t: 'predict' }, { ...card, files: [{ path: 'main.go' }] }, { ...card, files: [null] }, { ...card, question: 7 }, { ...card, action: 'build' }, { ...card, choices: ['only one'] },
      { ...card, choices: 'no' }, { ...card, files: [{ path: 'a_test.go', content: 'package a' }], action: 'test', pkg: './...' }, { ...card, pkg: 'x'.repeat(100) },
    ];
    for (const raw of odd) expect(whyNotPredict(raw) === null, JSON.stringify(raw)?.slice(0, 80)).toBe(cleanObject(raw) !== null);
  });

  it('says when the options were not used', () => {
    const ok = (raw: Record<string, unknown>) => cleanObject(raw) as PredictObject;
    expect(predictDropped(card, ok(card))).toBe('');
    expect(predictDropped({ ...card, choices: ['one'] }, ok({ ...card, choices: ['one'] }))).toMatch(/options were not used/);
    expect(predictDropped({ ...card, choices: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, ok({ ...card, choices: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }))).toMatch(/first 6 of the 7 options/);
    expect(predictDropped({ ...card, choices: undefined }, ok({ ...card, choices: undefined }))).toBe('');
  });
});

describe('the sample cards for looking at the card pages (portal/qa/fixtures/cards-c2.json)', () => {
  const samples = (JSON.parse(readFileSync(new URL('../../portal/qa/fixtures/cards-c2.json', import.meta.url), 'utf-8')) as { objects: unknown[] }).objects;

  it('are objects the gate accepts exactly as they are written, so that a history can be seeded with them', () => {
    expect(samples.length).toBeGreaterThanOrEqual(6);
    for (const raw of samples) expect(cleanObject(raw), JSON.stringify(raw).slice(0, 60)).toEqual(raw);
  });

  it('cover each kind of chart and a trace long enough to scroll, with state', () => {
    const kinds = new Set((samples as Array<{ t: string; kind?: string }>).map((o) => (o.t === 'chart' ? `chart:${o.kind}` : o.t)));
    expect([...kinds].sort()).toEqual(['chart:bar', 'chart:line', 'chart:scatter', 'trace']);
    const longest = Math.max(...(samples as Array<{ t: string; events?: unknown[] }>).filter((o) => o.t === 'trace').map((o) => o.events!.length));
    expect(longest).toBeGreaterThan(30);
  });
});
