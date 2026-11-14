import { describe, expect, it } from 'vitest';

import { cleanObject, objectSummary } from './clean.js';

describe('cleanObject: chart', () => {
  const chart = { t: 'chart', title: 'p99 latency by threads', kind: 'line', xLabel: 'threads', yLabel: 'latency', yUnit: 'ms', series: [{ name: 'gin', points: [[1, 12], [2, 15.5], [4, 31]] }] };

  it('keeps a well formed chart', () => {
    expect(cleanObject(chart)).toEqual(chart);
  });

  it('is nothing without a title, a known kind or a series with a number in it', () => {
    expect(cleanObject({ ...chart, title: '  ' })).toBeNull();
    expect(cleanObject({ ...chart, kind: 'pie' })).toBeNull();
    expect(cleanObject({ ...chart, series: [] })).toBeNull();
    expect(cleanObject({ ...chart, series: 'x' })).toBeNull();
    expect(cleanObject({ ...chart, series: [{ name: 'a', points: ['x', null, NaN, Infinity] }] })).toBeNull();
  });

  it('drops points that are not finite numbers and series with none left, and names an unnamed series', () => {
    const got = cleanObject({ ...chart, series: [{ points: [1, 'no', 3, Infinity, 5] }, { name: 'empty', points: ['x'] }] });
    expect(got).toMatchObject({ series: [{ name: 'Series 1', points: [1, 3, 5] }] });
  });

  it('turns mixed point shapes into pairs, with the index as the x of a plain number', () => {
    const got = cleanObject({ ...chart, series: [{ name: 'a', points: [4, [10, 20], 6] }] });
    expect(got).toMatchObject({ series: [{ points: [[0, 4], [10, 20], [2, 6]] }] });
  });

  it('keeps at most 6 series of 200 points and numbers under 1e12', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, points: Array.from({ length: 300 }, (_, k) => k) }));
    const got = cleanObject({ ...chart, series: many });
    expect(got && got.t === 'chart' && got.series).toHaveLength(6);
    expect(got && got.t === 'chart' && got.series[0].points).toHaveLength(200);
    expect(cleanObject({ ...chart, series: [{ name: 'a', points: [1e13] }] })).toBeNull();
  });

  it('gives a bar chart categories (its own, cut and cleaned, or 1, 2, 3 ...) and plain numbers', () => {
    const bars = { t: 'chart', title: 'requests per second', kind: 'bar', xLabel: '', yLabel: 'rps', series: [{ name: 'a', points: [[0, 100], [1, 140], [2, 90]] }] };
    expect(cleanObject(bars)).toMatchObject({ categories: ['1', '2', '3'], series: [{ points: [100, 140, 90] }] });
    expect(cleanObject({ ...bars, categories: ['go', '  rust ', 7] })).toMatchObject({ categories: ['go', 'rust', '7'] });
  });

  it('cleans the labels and the note to one line', () => {
    const got = cleanObject({ ...chart, xLabel: 'a\nb', note: '  steady   after four  ' });
    expect(got).toMatchObject({ xLabel: 'a b', note: 'steady after four' });
  });

  it('has a summary', () => {
    const got = cleanObject(chart);
    expect(got && objectSummary(got)).toBe('Chart: p99 latency by threads (1 series)');
  });
});

describe('cleanObject: trace', () => {
  const trace = {
    t: 'trace',
    title: 'Raft election',
    actors: ['A', 'B', 'C'],
    events: [{ from: 'A', label: 'election timeout' }, { from: 'A', to: 'B', label: 'RequestVote', note: 'term 2', state: [{ actor: 'A', text: 'candidate, term 2' }] }],
  };

  it('keeps a well formed trace', () => {
    expect(cleanObject(trace)).toEqual(trace);
  });

  it('needs a title, two different actors and a step', () => {
    expect(cleanObject({ ...trace, title: '' })).toBeNull();
    expect(cleanObject({ ...trace, actors: ['A'] })).toBeNull();
    expect(cleanObject({ ...trace, actors: ['A', 'A', ' A '] })).toBeNull();
    expect(cleanObject({ ...trace, events: [] })).toBeNull();
    expect(cleanObject({ ...trace, events: [{ from: 'Z', label: 'x' }] })).toBeNull();
  });

  it('drops a step that names an actor the trace does not have, or has no label', () => {
    const got = cleanObject({ ...trace, events: [{ from: 'A', to: 'Z', label: 'lost' }, { from: 'B', label: '' }, { from: 'C', to: 'A', label: 'vote granted' }] });
    expect(got).toMatchObject({ events: [{ from: 'C', to: 'A', label: 'vote granted' }] });
  });

  it('treats a message to oneself as an event of that actor', () => {
    const got = cleanObject({ ...trace, events: [{ from: 'A', to: 'A', label: 'reset timer' }] });
    expect(got).toMatchObject({ events: [{ from: 'A', label: 'reset timer' }] });
    expect(got && got.t === 'trace' && 'to' in got.events[0]).toBe(false);
  });

  it('keeps at most 8 actors and 120 steps, and drops state of unknown actors', () => {
    const actors = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const events = Array.from({ length: 200 }, (_, i) => ({ from: 'n0', to: 'n1', label: `m${i}` }));
    const got = cleanObject({ t: 'trace', title: 'big', actors, events });
    expect(got && got.t === 'trace' && got.actors).toHaveLength(8);
    expect(got && got.t === 'trace' && got.events).toHaveLength(120);
    const state = cleanObject({ ...trace, events: [{ from: 'A', label: 'x', state: [{ actor: 'Q', text: 'no' }, { actor: 'B', text: 'yes' }] }] });
    expect(state).toMatchObject({ events: [{ state: [{ actor: 'B', text: 'yes' }] }] });
  });

  it('has a summary', () => {
    const got = cleanObject(trace);
    expect(got && objectSummary(got)).toBe('Sequence: Raft election (2 steps)');
  });
});

describe('cleanObject: predict', () => {
  const card = {
    t: 'predict',
    question: 'What does this print?',
    action: 'run',
    pkg: '.',
    files: [{ path: 'main.go', content: 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println(2 + 3) }\n' }],
    choices: ['5', '23', 'an error'],
  };

  it('keeps a card whose program the sandbox gate accepts', () => {
    expect(cleanObject(card)).toEqual(card);
  });

  it('is nothing for a program the sandbox gate refuses (a bad file name, a bad package) or too much code', () => {
    expect(cleanObject({ ...card, files: [{ path: '../main.go', content: 'package main' }] })).toBeNull();
    expect(cleanObject({ ...card, pkg: '-exec=sh' })).toBeNull();
    expect(cleanObject({ ...card, action: 'vet' })).toBeNull();
    expect(cleanObject({ ...card, files: [] })).toBeNull();
    expect(cleanObject({ ...card, files: Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.go`, content: 'package main' })) })).toBeNull();
    expect(cleanObject({ ...card, files: [{ path: 'main.go', content: 'x'.repeat(6001) }] })).toBeNull();
    expect(cleanObject({ ...card, question: '   ' })).toBeNull();
  });

  it('keeps two to six one-line options, and none when there are fewer than two', () => {
    expect(cleanObject({ ...card, choices: ['only one'] })).toEqual({ ...card, choices: undefined });
    expect(cleanObject({ ...card, choices: ['a', ' b\nb ', '', 'c', 'd', 'e', 'f', 'g'] })).toMatchObject({ choices: ['a', 'b b', 'c', 'd', 'e'] });
  });

  it('has a summary', () => {
    const got = cleanObject(card);
    expect(got && objectSummary(got)).toBe('Prediction: What does this print?');
  });
});
