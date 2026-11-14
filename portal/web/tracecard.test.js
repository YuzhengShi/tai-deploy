// The card of a sequence: the pure parts (the layout, the phases of the steps, the words of a step, the keys, Play's timing, the scroll that keeps a step in view), and the card itself built into a small
// stand-in for the DOM (what it holds, how it steps, what it reports to the view, that nothing a model sent becomes markup or an inline style). The look of it and the real scrolling are checked in a browser
// (docs/CARDS.md).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { objectRow, setObjectHelpers } from './objects.js';
import {
  PLAY_MS,
  TRACE,
  describeStep,
  describeTrace,
  fitLabel,
  lineOf,
  phaseOf,
  playNext,
  readTrace,
  rowAt,
  scrollForRow,
  scrollInto,
  stateAt,
  stepFromKey,
  traceLayout,
} from './tracecard.js';

const trace = {
  title: 'Raft election',
  actors: ['A', 'B', 'C'],
  events: [
    { from: 'A', label: 'election timeout', note: 'no heartbeat for 150 ms', state: [{ actor: 'A', text: 'candidate, term 2' }] },
    { from: 'A', to: 'B', label: 'RequestVote', note: 'term 2' },
    { from: 'A', to: 'C', label: 'RequestVote' },
    { from: 'B', to: 'A', label: 'vote granted', state: [{ actor: 'B', text: 'voted for A' }] },
    { from: 'C', to: 'A', label: 'vote granted', state: [{ actor: 'C', text: 'voted for A' }] },
    { from: 'A', label: 'majority: becomes leader', state: [{ actor: 'A', text: 'leader, term 2' }] },
  ],
};

describe('the trace as the card reads it', () => {
  it('keeps what the host cleaned', () => {
    expect(readTrace(trace)).toEqual({ ...trace, note: '' });
    expect(readTrace({ ...trace, note: ' one\nline ' }).note).toBe('one line');
  });

  it('guards the cheap things: text is one line, two to eight distinct actors, a step that names an actor the trace does not have or has no label is not there', () => {
    const got = readTrace({
      title: ' a\nb ',
      actors: ['A', ' A ', 'B', 7, ...Array.from({ length: 12 }, (_, i) => `n${i}`)],
      events: [{ from: 'A', to: 'B', label: 'x' }, { from: 'Z', label: 'lost' }, { from: 'A', label: '' }, { from: 'A', to: 'Q', label: 'lost' }, null, { from: 'A', to: 'A', label: 'self' }, { from: 'B', label: 'with state', state: [{ actor: 'B', text: 'ok' }, { actor: 'Z', text: 'no' }, { actor: 'B', text: '' }, null] }],
    });
    expect(got.title).toBe('a b');
    expect(got.actors).toHaveLength(8);
    expect(got.events.map((e) => e.label)).toEqual(['x', 'self', 'with state']);
    expect(got.events[1]).toEqual({ from: 'A', label: 'self' });
    expect(got.events[2].state).toEqual([{ actor: 'B', text: 'ok' }]);
    for (const bad of [null, 5, {}, { actors: ['A'], events: [{ from: 'A', label: 'x' }] }, { actors: ['A', 'B'], events: [] }, { actors: ['A', 'B'], events: [{ from: 'Z', label: 'x' }] }, { actors: 'AB', events: 'x' }]) expect(readTrace(bad)).toBeNull();
  });

  it('says in a sentence what the whole diagram is', () => {
    expect(describeTrace(readTrace(trace))).toBe('Raft election: sequence diagram, 3 actors (A, B, C), 6 steps.');
    expect(describeTrace(readTrace({ ...trace, events: [trace.events[0]] }))).toBe('Raft election: sequence diagram, 3 actors (A, B, C), 1 step.');
  });
});

describe('the layout', () => {
  const t = readTrace(trace);

  it('gives each actor a lane, evenly, with its name in a pill, and each step a row with its arrow running from the sender to the receiver', () => {
    const l = traceLayout(t, 560);
    expect(l.W).toBe(560);
    expect(l.scrolls).toBe(false);
    expect(l.lanes.map((x) => x.actor)).toEqual(['A', 'B', 'C']);
    expect(l.lanes[1].x - l.lanes[0].x).toBeCloseTo(l.lanes[2].x - l.lanes[1].x, 5);
    expect(l.lanes[0].x).toBeGreaterThan(TRACE.gutter);
    expect(l.lanes[2].x).toBeLessThan(l.W);
    expect(l.rows).toHaveLength(6);
    const [timeout, ab, ac, ba] = l.rows;
    expect(timeout.kind).toBe('mark');
    expect(timeout.x1).toBe(l.lanes[0].x);
    expect(ab).toMatchObject({ kind: 'message', x1: l.lanes[0].x, x2: l.lanes[1].x, dir: 1 });
    expect(ac.x2).toBe(l.lanes[2].x);
    expect(ba).toMatchObject({ x1: l.lanes[1].x, x2: l.lanes[0].x, dir: -1 });
    expect(l.rows[1].top - l.rows[0].top).toBe(TRACE.rowHeight);
    expect(l.bodyH).toBeGreaterThan(l.rows[5].top + TRACE.rowHeight);
  });

  it('keeps every label inside the diagram, cut to the room it has: the whole label is in the words under the diagram', () => {
    const long = readTrace({ ...trace, events: [{ from: 'A', to: 'B', label: 'x'.repeat(80) }, { from: 'C', label: 'y'.repeat(80) }, { from: 'A', to: 'C', label: 'AppendEntries with a long list of entries to replicate to the follower' }] });
    for (const width of [240, 360, 560, 760]) {
      const l = traceLayout(long, width);
      for (const r of l.rows) {
        const px = r.label.length * TRACE.charWidth;
        const left = r.anchor === 'middle' ? r.labelX - px / 2 : r.anchor === 'start' ? r.labelX : r.labelX - px;
        expect(left, `${width} ${r.label}`).toBeGreaterThanOrEqual(TRACE.gutter - 1);
        expect(left + px, `${width} ${r.label}`).toBeLessThanOrEqual(l.W + 1);
      }
      expect(l.rows[0].label.endsWith('…')).toBe(true);
    }
  });

  it('puts a mark\'s label on the side that has room', () => {
    const l = traceLayout(t, 560);
    expect(l.rows[0].anchor).toBe('start');
    const edge = traceLayout(readTrace({ ...trace, events: [{ from: 'C', label: 'something happens at the last actor' }] }), 300);
    expect(edge.rows[0].anchor).toBe('end');
    expect(edge.rows[0].labelX).toBeLessThan(edge.rows[0].x1);
  });

  it('makes a card too narrow for its lanes wider than it is, to scroll sideways inside itself', () => {
    const eight = readTrace({ ...trace, actors: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], events: [{ from: 'A', to: 'H', label: 'across' }] });
    const l = traceLayout(eight, 360);
    expect(l.scrolls).toBe(true);
    expect(l.W).toBeGreaterThan(360);
    expect(l.gap).toBeGreaterThanOrEqual(TRACE.minLane);
    expect(traceLayout(t, 360).scrolls).toBe(false);
    expect(traceLayout(t, 100).W).toBeGreaterThanOrEqual(TRACE.minWidth);
    expect(traceLayout(t, NaN).W).toBe(560);
  });

  it('fits a pill to its lane, cutting a long name', () => {
    const l = traceLayout(readTrace({ ...trace, actors: ['A very long name of an actor', 'B'], events: [{ from: 'B', label: 'x' }] }), 300);
    expect(l.lanes[0].text.endsWith('…')).toBe(true);
    expect(l.lanes[0].pillW).toBeLessThanOrEqual(l.gap - 8);
    expect(fitLabel('abcdefghij', 40)).toBe('abcd…');
    expect(fitLabel('abc', 10)).toBe('abc');
    expect(fitLabel('abcdefghij', 1)).toBe('ab…');
  });

  it('finds the step a click at a height means', () => {
    const l = traceLayout(t, 560);
    expect(rowAt(l, l.rows[0].top + 3)).toBe(0);
    expect(rowAt(l, l.rows[3].top + TRACE.rowHeight - 1)).toBe(3);
    expect(rowAt(l, 0)).toBeNull();
    expect(rowAt(l, l.rows[5].top + TRACE.rowHeight + 1)).toBeNull();
    expect(rowAt(l, NaN)).toBeNull();
  });
});

describe('keeping a step in view', () => {
  it('moves the scroll the least that shows the range, and leaves it when the range is in view', () => {
    expect(scrollInto(100, 140, 0, 300)).toBe(0);
    expect(scrollInto(400, 440, 0, 300)).toBe(148);
    expect(scrollInto(10, 40, 200, 300)).toBe(2);
    expect(scrollInto(0, 40, 200, 300)).toBe(0);
    expect(scrollInto(100, 900, 0, 300)).toBe(92);
    expect(scrollInto(NaN, 40, 5, 300)).toBe(5);
    expect(scrollInto(10, 40, 5, 0)).toBe(5);
  });

  it('scrolls a long trace down to a row below the header, and back up, and not at all for a row that is in view', () => {
    const many = readTrace({ ...trace, events: Array.from({ length: 60 }, (_, i) => ({ from: 'A', to: 'B', label: `step ${i}` })) });
    const l = traceLayout(many, 560);
    expect(scrollForRow(l, 0, 0, 300)).toBe(0);
    expect(scrollForRow(l, 2, 0, 300)).toBe(0);
    const down = scrollForRow(l, 30, 0, 300);
    expect(down).toBeGreaterThan(0);
    const row = l.rows[30];
    expect(l.headH + row.top).toBeGreaterThanOrEqual(down + l.headH);
    expect(l.headH + row.top + l.rowH).toBeLessThanOrEqual(down + 300);
    expect(scrollForRow(l, 30, down, 300)).toBe(down);
    const up = scrollForRow(l, 3, down, 300);
    expect(up).toBeLessThan(down);
    expect(l.headH + l.rows[3].top).toBeGreaterThanOrEqual(up + l.headH);
    expect(scrollForRow(l, 99, 10, 300)).toBe(10);
    expect(scrollForRow(l, 3, 10, 0)).toBe(10);
  });
});

describe('the steps', () => {
  const t = readTrace(trace);

  it('are solid up to the current one, which is marked, and later ones are faint, unless all are shown', () => {
    expect([0, 1, 2, 3].map((i) => phaseOf(i, 1, false))).toEqual(['done', 'now', 'later', 'later']);
    expect([0, 1, 2, 3].map((i) => phaseOf(i, 1, true))).toEqual(['done', 'now', 'done', 'done']);
    expect(phaseOf(0, 0, false)).toBe('now');
  });

  it('give the actors the states they hold after each step: the last one given, and whether this step gave it', () => {
    expect(stateAt(t, 0)).toEqual([{ actor: 'A', text: 'candidate, term 2', changed: true }]);
    expect(stateAt(t, 2)).toEqual([{ actor: 'A', text: 'candidate, term 2', changed: false }]);
    expect(stateAt(t, 3)).toEqual([{ actor: 'A', text: 'candidate, term 2', changed: false }, { actor: 'B', text: 'voted for A', changed: true }]);
    expect(stateAt(t, 5)).toEqual([{ actor: 'A', text: 'leader, term 2', changed: true }, { actor: 'B', text: 'voted for A', changed: false }, { actor: 'C', text: 'voted for A', changed: false }]);
    expect(stateAt(t, 99).map((s) => s.actor)).toEqual(['A', 'B', 'C']);
  });

  it('say what a step is: the line, the note and the states it gave, as words on the page and as one sentence for a screen reader', () => {
    expect(lineOf(t.events[1])).toBe('A to B: RequestVote');
    expect(lineOf(t.events[0])).toBe('At A: election timeout');
    expect(describeStep(t, 0)).toEqual({
      step: 0,
      heading: 'Step 1 of 6',
      line: 'At A: election timeout',
      note: 'no heartbeat for 150 ms',
      changed: [{ actor: 'A', text: 'candidate, term 2' }],
      spoken: 'Step 1 of 6. At A: election timeout. no heartbeat for 150 ms. A now: candidate, term 2.',
    });
    expect(describeStep(t, 2).spoken).toBe('Step 3 of 6. A to C: RequestVote.');
    expect(describeStep(t, 3).changed).toEqual([{ actor: 'B', text: 'voted for A' }]);
    expect(describeStep(t, 99).step).toBe(5);
    expect(describeStep(t, -4).step).toBe(0);
    expect(describeStep(t, NaN).step).toBe(0);
  });

  it('are stepped by Play one at a time until the end, where it stops', () => {
    expect(PLAY_MS).toBe(1200);
    expect(playNext(0, 6)).toBe(1);
    expect(playNext(4, 6)).toBe(5);
    expect(playNext(5, 6)).toBeNull();
    expect(playNext(0, 1)).toBeNull();
  });

  it('are stepped by the keys: left and right, the ends hold, Home and End, and no other key', () => {
    expect(stepFromKey(2, 6, 'ArrowRight')).toBe(3);
    expect(stepFromKey(5, 6, 'ArrowRight')).toBe(5);
    expect(stepFromKey(2, 6, 'ArrowLeft')).toBe(1);
    expect(stepFromKey(0, 6, 'ArrowLeft')).toBe(0);
    expect(stepFromKey(3, 6, 'Home')).toBe(0);
    expect(stepFromKey(3, 6, 'End')).toBe(5);
    for (const key of ['ArrowUp', 'ArrowDown', 'PageDown', 'Enter', ' ', 'a', 'Tab']) expect(stepFromKey(2, 6, key)).toBeNull();
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
    this.value = '';
    this.min = '';
    this.max = '';
    this.step = '';
    this.tabIndex = -1;
    this.hidden = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.clientHeight = 0;
    this.clientWidth = 0;
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
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 560, height: 0 };
  }
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
function draw(obj = trace, extra = {}) {
  view = fakeView();
  vi.stubGlobal('document', { createElementNS: (ns, tag) => new Node_(tag, '', undefined, ns), hasFocus: () => true });
  setObjectHelpers({ el, view });
  const row = objectRow({ n: 52, ts: '2026-11-07T10:15:00.000Z', role: 'assistant', text: 'Sequence: Raft election (6 steps)', kind: 'object', obj: { t: 'trace', ...obj }, ...extra });
  expect(row).not.toBeNull();
  const card = row.children[0];
  return {
    row,
    card,
    scroller: card.find('tr-diagram'),
    prev: card.find('tr-prev'),
    play: card.find('tr-play'),
    next: card.find('tr-next'),
    slider: card.find('tr-slider'),
    all: card.find('tr-all'),
    head: card.find('tr-said-head'),
    line: card.find('tr-said-line'),
    note: card.find('tr-said-note'),
    states: card.find('tr-states'),
  };
}
const rowsOf = (c) => c.scroller.find('tr-body').findAll('tr-ev').map((g) => g.className.split(' ')[1]);
const click = (node) => node.fire('click');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setObjectHelpers(null);
});

describe('the card of a sequence', () => {
  it('is a row of the conversation of the card\'s type, with the line\'s summary as the text a search and a copy have, and a named group that is not read out as it arrives', () => {
    const c = draw();
    expect(c.row.className).toBe('row object');
    expect(c.row.dataset).toEqual({ n: 52, type: 'trace' });
    expect(c.row._text).toBe('Sequence: Raft election (6 steps)');
    expect(c.card.className).toBe('tracecard');
    expect(c.card.attrs.role).toBe('group');
    expect(c.card.attrs['aria-label']).toBe('Raft election: sequence diagram, 3 actors (A, B, C), 6 steps.');
    expect(c.card.attrs['aria-live']).toBe('off');
    expect(c.card.find('tr-title').textContent).toBe('Raft election');
  });

  it('has a diagram region that is one tab stop with a name and the keys to use, and controls with names that say what they do', () => {
    const c = draw();
    expect(c.scroller.tabIndex).toBe(0);
    expect(c.scroller.attrs['aria-label']).toBe('Sequence diagram of Raft election');
    const help = c.card.all().find((n) => n.id === c.scroller.attrs['aria-describedby']);
    expect(help.textContent).toMatch(/Left and right arrow keys step.*Home and End/);
    expect(c.card.find('tr-controls').attrs.role).toBe('group');
    expect(c.prev.attrs['aria-label']).toBe('Previous step');
    expect(c.next.attrs['aria-label']).toBe('Next step');
    expect(c.play.attrs['aria-label']).toBe('Play the steps');
    expect(c.play.attrs['aria-pressed']).toBe('false');
    expect([c.slider.type, c.slider.min, c.slider.max, c.slider.value, c.slider.attrs['aria-label']]).toEqual(['range', '1', '6', '1', 'Step']);
    expect(c.all.attrs['aria-pressed']).toBe('false');
    for (const b of [c.prev, c.play, c.next, c.all]) expect(b.type).toBe('button');
  });

  it('draws the actors\' names in a header of their own, a lane for each, and a row for each step, the first the current one and the others later', () => {
    const c = draw();
    const head = c.scroller.find('tr-head');
    const body = c.scroller.find('tr-body');
    expect(head.ns).toBe('http://www.w3.org/2000/svg');
    expect(head.attrs['aria-hidden']).toBe('true');
    expect(head.attrs.viewBox).toBe('0 0 560 40');
    expect(head.findAll('tr-actor-name').map((n) => n.textContent)).toEqual(['A', 'B', 'C']);
    expect(head.findAll('tr-actor').map((g) => g.all().find((n) => n.tag === 'title').textContent)).toEqual(['A', 'B', 'C']);
    expect(body.findAll('tr-lane')).toHaveLength(3);
    expect(rowsOf(c)).toEqual(['tr-now', 'tr-later', 'tr-later', 'tr-later', 'tr-later', 'tr-later']);
    const rows = body.findAll('tr-ev');
    expect(rows[1].find('tr-label').textContent).toBe('RequestVote');
    expect(rows[1].find('tr-num').textContent).toBe('2');
    expect(rows[1].find('tr-arrow').tag).toBe('line');
    expect(rows[1].find('tr-point').tag).toBe('path');
    expect(rows[0].find('tr-mark').tag).toBe('circle');
    expect(rows[0].find('tr-arrow')).toBeUndefined();
  });

  it('says the first step in words under the diagram, in a polite live region, with the state the actors hold', () => {
    const c = draw();
    const said = c.card.find('tr-said');
    expect(said.attrs['aria-live']).toBe('polite');
    expect(said.attrs['aria-atomic']).toBe('true');
    expect(c.head.textContent).toBe('Step 1 of 6');
    expect(c.line.textContent).toBe('At A: election timeout');
    expect(c.note.textContent).toBe('no heartbeat for 150 ms');
    expect(said.find('sr-only').textContent).toBe('A now: candidate, term 2');
    expect(c.states.findAll('tr-state').map((s) => [s.find('tr-state-actor').textContent, s.find('tr-state-text').textContent, s.dataset.changed])).toEqual([['A', 'candidate, term 2', 'true']]);
    expect(c.states.find('tr-tag').textContent).toBe('updated');
    expect(c.prev.attrs['aria-disabled']).toBe('true');
    expect(c.next.attrs['aria-disabled']).toBe('false');
    expect(view.sets).toEqual([]);                                                  // nothing is reported until the student moves
  });
});

describe('stepping', () => {
  it('goes to the next and the previous step, draws what is done solid and what is to come faint, says the step, and reports the step to the view', () => {
    const c = draw();
    click(c.next);
    expect(rowsOf(c)).toEqual(['tr-done', 'tr-now', 'tr-later', 'tr-later', 'tr-later', 'tr-later']);
    expect(c.head.textContent).toBe('Step 2 of 6');
    expect(c.line.textContent).toBe('A to B: RequestVote');
    expect(c.note.textContent).toBe('term 2');
    expect(c.note.hidden).toBe(false);
    expect(c.slider.value).toBe('2');
    expect(c.slider.attrs['aria-valuetext']).toBe('Step 2 of 6: A to B: RequestVote');
    expect(c.prev.attrs['aria-disabled']).toBe('false');
    expect(view.sets).toEqual([{ obj: { n: 52, step: 1 } }]);
    click(c.next);
    click(c.next);
    expect(c.states.findAll('tr-state').map((s) => s.dataset.changed)).toEqual(['false', 'true']);
    expect(c.card.find('tr-said').find('sr-only').textContent).toBe('B now: voted for A');
    click(c.prev);
    expect(c.head.textContent).toBe('Step 3 of 6');
    expect(c.note.hidden).toBe(true);
    expect(view.get().obj).toEqual({ n: 52, step: 2 });
  });

  it('holds at the ends and reports nothing for a press that moves nowhere', () => {
    const c = draw();
    click(c.prev);
    expect(view.sets).toEqual([]);
    for (let i = 0; i < 9; i++) click(c.next);
    expect(c.head.textContent).toBe('Step 6 of 6');
    expect(c.next.attrs['aria-disabled']).toBe('true');
    const reported = view.sets.length;
    click(c.next);
    expect(view.sets).toHaveLength(reported);
    expect(view.get().obj).toEqual({ n: 52, step: 5 });
  });

  it('follows the slider', () => {
    const c = draw();
    c.slider.value = '4';
    c.slider.fire('input');
    expect(c.head.textContent).toBe('Step 4 of 6');
    expect(view.sets.at(-1)).toEqual({ obj: { n: 52, step: 3 } });
  });

  it('follows the arrow keys on the diagram, Home and End, and leaves every other key to the browser (the arrows up and down scroll the diagram)', () => {
    const c = draw();
    expect(c.scroller.fire('keydown', { key: 'ArrowRight' }).defaultPrevented).toBe(true);
    expect(c.head.textContent).toBe('Step 2 of 6');
    c.scroller.fire('keydown', { key: 'End' });
    expect(c.head.textContent).toBe('Step 6 of 6');
    c.scroller.fire('keydown', { key: 'ArrowLeft' });
    c.scroller.fire('keydown', { key: 'Home' });
    expect(c.head.textContent).toBe('Step 1 of 6');
    for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'a']) expect(c.scroller.fire('keydown', { key }).defaultPrevented).toBe(false);
    expect(c.scroller.fire('keydown', { key: 'ArrowRight', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(c.head.textContent).toBe('Step 1 of 6');
  });

  it('goes to the step that is clicked in the diagram', () => {
    const c = draw();
    const l = traceLayout(readTrace(trace), 560);
    c.scroller.fire('click', { clientY: l.rows[3].top + 10 });
    expect(c.head.textContent).toBe('Step 4 of 6');
    expect(view.sets.at(-1)).toEqual({ obj: { n: 52, step: 3 } });
    c.scroller.fire('click', { clientY: 1 });
    expect(c.head.textContent).toBe('Step 4 of 6');
  });

  it('draws every step solid with "Show all", and says which way the button is', () => {
    const c = draw();
    click(c.all);
    expect(rowsOf(c)).toEqual(['tr-now', 'tr-done', 'tr-done', 'tr-done', 'tr-done', 'tr-done']);
    expect(c.all.textContent).toBe('Hide upcoming');
    expect(c.all.attrs['aria-pressed']).toBe('true');
    click(c.all);
    expect(rowsOf(c)[1]).toBe('tr-later');
    expect(c.all.textContent).toBe('Show all');
    expect(view.sets).toEqual([]);
  });

  it('keeps the current step in view in a diagram that scrolls: its own scroll, never the page\'s', () => {
    const many = { ...trace, events: Array.from({ length: 60 }, (_, i) => ({ from: 'A', to: 'B', label: `step ${i}` })) };
    const c = draw(many);
    c.scroller.clientHeight = 300;
    c.scroller.clientWidth = 560;
    for (let i = 0; i < 30; i++) click(c.next);
    expect(c.scroller.scrollTop).toBeGreaterThan(0);
    const l = traceLayout(readTrace(many), 560);
    expect(l.headH + l.rows[30].top + l.rowH).toBeLessThanOrEqual(c.scroller.scrollTop + 300);
    c.scroller.fire('keydown', { key: 'Home' });
    expect(c.scroller.scrollTop).toBe(0);
  });
});

describe('Play', () => {
  it('steps once each 1.2 seconds, reports each step, says Pause while it goes and stops at the end', () => {
    vi.useFakeTimers();
    const c = draw();
    click(c.play);
    expect(c.play.textContent).toBe('Pause');
    expect(c.play.attrs['aria-label']).toBe('Pause');
    expect(c.play.attrs['aria-pressed']).toBe('true');
    expect(c.head.textContent).toBe('Step 1 of 6');
    vi.advanceTimersByTime(PLAY_MS - 1);
    expect(c.head.textContent).toBe('Step 1 of 6');
    vi.advanceTimersByTime(1);
    expect(c.head.textContent).toBe('Step 2 of 6');
    vi.advanceTimersByTime(PLAY_MS);
    expect(c.head.textContent).toBe('Step 3 of 6');
    expect(view.sets.map((s) => s.obj.step)).toEqual([1, 2]);
    vi.advanceTimersByTime(PLAY_MS * 10);
    expect(c.head.textContent).toBe('Step 6 of 6');
    expect(c.play.textContent).toBe('Play');
    expect(c.play.attrs['aria-pressed']).toBe('false');
    expect(vi.getTimerCount()).toBe(0);
    expect(view.sets.map((s) => s.obj.step)).toEqual([1, 2, 3, 4, 5]);
  });

  it('stops when Pause is pressed and at any other control: Previous, Next, the slider, Show all and the arrow keys', () => {
    vi.useFakeTimers();
    const controls = [
      (c) => click(c.play),
      (c) => click(c.prev),
      (c) => click(c.next),
      (c) => {
        c.slider.value = '3';
        c.slider.fire('input');
      },
      (c) => click(c.all),
      (c) => c.scroller.fire('keydown', { key: 'ArrowRight' }),
    ];
    for (const control of controls) {
      const c = draw();
      click(c.play);
      vi.advanceTimersByTime(PLAY_MS);
      const at = c.head.textContent;
      control(c);
      expect(c.play.textContent, String(control)).toBe('Play');
      expect(vi.getTimerCount()).toBe(0);
      const after = c.head.textContent;
      vi.advanceTimersByTime(PLAY_MS * 3);
      expect(c.head.textContent).toBe(after);
      expect(at).toBe('Step 2 of 6');
    }
  });

  it('starts again from the first step when it is pressed at the end', () => {
    vi.useFakeTimers();
    const c = draw();
    c.scroller.fire('keydown', { key: 'End' });
    click(c.play);
    expect(c.head.textContent).toBe('Step 1 of 6');
    vi.advanceTimersByTime(PLAY_MS);
    expect(c.head.textContent).toBe('Step 2 of 6');
  });

  it('stops when the card is no longer on the page, and when focus leaves it', () => {
    vi.useFakeTimers();
    const gone = draw();
    click(gone.play);
    gone.card.isConnected = false;
    vi.advanceTimersByTime(PLAY_MS);
    expect(gone.head.textContent).toBe('Step 1 of 6');
    expect(gone.play.textContent).toBe('Play');
    const left = draw();
    click(left.play);
    vi.advanceTimersByTime(PLAY_MS);
    left.card.fire('focusout', { relatedTarget: { tagName: 'BUTTON' } });
    expect(left.play.textContent).toBe('Play');
    vi.advanceTimersByTime(PLAY_MS * 3);
    expect(left.head.textContent).toBe('Step 2 of 6');
  });
});

describe('when focus leaves the card', () => {
  it('takes the step back from the view, unless focus only moves inside the card', () => {
    const c = draw();
    click(c.next);
    c.card.fire('focusout', { relatedTarget: c.slider });
    expect(view.get().obj).toEqual({ n: 52, step: 1 });
    c.card.fire('focusout', { relatedTarget: { tagName: 'BUTTON' } });
    expect(view.get().obj).toBeUndefined();
    expect(c.head.textContent).toBe('Step 2 of 6');                                   // the card stays where it was
  });

  it('keeps it while the student writes their question in the message box, and takes it back after a while', () => {
    vi.useFakeTimers();
    const c = draw();
    click(c.next);
    c.card.fire('focusout', { relatedTarget: { tagName: 'TEXTAREA' } });
    expect(view.get().obj).toEqual({ n: 52, step: 1 });
    vi.advanceTimersByTime(120_000 + 10);
    expect(view.get().obj).toBeUndefined();
  });

  it('does not take away what another card reported since', () => {
    const c = draw();
    click(c.next);
    view.set({ obj: { n: 40, lines: [2, 4] } });
    c.card.fire('focusout', { relatedTarget: null });
    expect(view.get().obj).toEqual({ n: 40, lines: [2, 4] });
  });
});

describe('what a model wrote is text, never markup or style', () => {
  it('stays the text of a node, in the title, the actors, the labels, the notes, the states and the note under the diagram', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const c = draw({ title: evil, actors: [evil, 'B'], events: [{ from: evil, to: 'B', label: evil, note: evil, state: [{ actor: evil, text: evil }] }], note: evil });
    expect(c.card.find('tr-title').textContent).toBe(evil);
    expect(c.card.find('tr-note').textContent).toBe(evil);
    expect(c.line.textContent).toMatch(/^<img src=x onerror=aler… to B: <img src=x onerror=alert\(1\)>$/);          // the name is cut to one line of 24, as the host cuts it, and is still text
    expect(c.note.textContent).toBe(evil);
    expect(c.states.find('tr-state-text').textContent).toBe(evil);
    expect(c.scroller.find('tr-head').find('tr-actor-name').textContent.startsWith('<img')).toBe(true);
    for (const n of c.card.all()) {
      expect(n.tag).toMatch(/^[a-z]+$/);
      for (const name of Object.keys(n.attrs)) expect(name, `${n.tag} ${name}`).not.toMatch(/^on|^style$|^href$|^xlink/i);
    }
  });

  it('is nothing for a trace that has nothing to draw, so the conversation skips it', () => {
    view = fakeView();
    setObjectHelpers({ el, view });
    for (const obj of [{ t: 'trace', title: 'x', actors: ['A'], events: [{ from: 'A', label: 'x' }] }, { t: 'trace', title: 'x', actors: ['A', 'B'], events: [] }, { t: 'trace' }]) expect(objectRow({ n: 1, kind: 'object', obj })).toBeNull();
  });
});

describe('the width it has', () => {
  function observers() {
    const list = [];
    class FakeObserver {
      constructor(fn) {
        this.fn = fn;
        this.disconnected = false;
        list.push(this);
      }
      observe(node) {
        this.node = node;
      }
      disconnect() {
        this.disconnected = true;
      }
    }
    vi.stubGlobal('ResizeObserver', FakeObserver);
    return list;
  }

  it('draws again for the width it is measured at, and makes a card too narrow for its lanes wider than itself', () => {
    const list = observers();
    const c = draw();
    expect(list).toHaveLength(1);
    expect(list[0].node).toBe(c.scroller);
    expect(c.scroller.find('tr-body').attrs.viewBox).toBe(`0 0 560 ${c.scroller.find('tr-body').attrs.height}`);
    list[0].fn([{ contentRect: { width: 300 } }]);
    const body = c.scroller.find('tr-body');
    expect(Number(body.attrs.width)).toBeGreaterThan(300);                              // three lanes need more than that: it scrolls sideways inside itself
    expect(body.attrs.viewBox.startsWith(`0 0 ${body.attrs.width} `)).toBe(true);
    expect(c.scroller.find('tr-head').attrs.width).toBe(body.attrs.width);
    const before = c.scroller.find('tr-body');
    list[0].fn([{ contentRect: { width: 302 } }]);
    expect(c.scroller.find('tr-body')).toBe(before);
    list[0].fn([{ contentRect: { width: 0 } }]);
    expect(c.scroller.find('tr-body')).toBe(before);
    click(c.next);
    list[0].fn([{ contentRect: { width: 700 } }]);
    expect(c.scroller.find('tr-body').attrs.viewBox.startsWith('0 0 700 ')).toBe(true);
    expect(c.head.textContent).toBe('Step 2 of 6');                                      // the step and the words survive a redraw
    expect(rowsOf(c)[1]).toBe('tr-now');
  });

  it('starts as wide as its lanes need when there are many actors', () => {
    const eight = { ...trace, actors: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], events: [{ from: 'A', to: 'H', label: 'across' }, { from: 'H', label: 'done' }] };
    const c = draw(eight);
    expect(Number(c.scroller.find('tr-body').attrs.width)).toBeGreaterThanOrEqual(TRACE.gutter + 2 * TRACE.pad + 8 * TRACE.minLane);
    expect(c.head.textContent).toBe('Step 1 of 2');
  });

  it('lets go of the observer, of Play and of the step when the card is taken away', () => {
    vi.useFakeTimers();
    const list = observers();
    const c = draw();
    click(c.next);
    click(c.play);
    c.row._object.destroy();
    expect(list[0].disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(view.get().obj).toBeUndefined();
  });
});
