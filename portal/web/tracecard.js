// The card of a sequence (a chat object of type 'trace': docs/CHAT_OBJECTS.md, docs/CARDS.md). TAi draws how something works as messages in order (a leader election, a replication round, a request through a
// service) and the student steps through it: a lane for each actor with its name at the top, an arrow for each message (a mark on the lane for something that happens at one actor), the label on the arrow.
// It registers on import (objects.js); app.js imports it.
//
// Everything on the card is DOM built with createElement and createElementNS from text and numbers: nothing a model sent is ever markup, and nothing is set through an inline style attribute (the page's
// content policy forbids one). Steps up to the current one are drawn solid with their labels, the current one is marked, the later ones are dashed and faint without their labels; "Show all" draws them all.
// Under the diagram the current step is said as text in a polite live region (its label, its note and the state the actors hold after it), so that a screen reader hears each step; the keys are the left and right
// arrows (Home and End for the ends), Previous and Next, Play (one step each 1.2 seconds, stopped by any other control, at the end and when focus leaves the card) and a slider. Nothing animates and the diagram
// follows the current step by setting its scroll position, never the page's.
//
// The step the student moves to is part of the view (docs/CHAT_OBJECTS.md, "The view"): `obj: { n, step }`, the step as the host numbers it (0-based, in the events as kept), so that TAi knows where they are;
// it is taken back when focus leaves the card (except for the message box: see createFocusKeeper in chartcard.js, which this uses).
//
// The pure parts (the layout, the phases, the words of a step, the keys, Play's timing, the scroll that keeps a step in view) are exported and tested in tracecard.test.js; the DOM is checked in a browser.
import { createFocusKeeper, oneLine } from './chartcard.js';
import { registerObject } from './objects.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const TRACE = {
  minWidth: 240,
  /** The column at the left that holds the step numbers. */
  gutter: 26,
  pad: 10,
  /** The least room an actor's lane has: a narrower card scrolls sideways inside itself. */
  minLane: 96,
  rowHeight: 38,
  headHeight: 40,
  bodyPad: 6,
  charWidth: 6.8,
  markRadius: 5,
  arrowLength: 8,
  maxActors: 8,
  maxEvents: 120,
};
/** Play moves one step each this long. */
export const PLAY_MS = 1200;
export const KEYS_HELP = 'Left and right arrow keys step through the sequence, Home and End go to its first and last step.';

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

// ---------------------------------------------------------------- the trace as the card reads it

/**
 * The trace as the card draws it, from what the history holds. The host has cleaned it already (src/chat-objects/trace.ts), so this only guards what is cheap to guard: text is one line, two to eight actors,
 * a step that names an actor the trace does not have, or has no label, is not there. Null when there is nothing to draw.
 */
export function readTrace(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.actors) || !Array.isArray(obj.events)) return null;
  const actors = [];
  for (const a of obj.actors) {
    const name = oneLine(a, 24);
    if (name && !actors.includes(name) && actors.length < TRACE.maxActors) actors.push(name);
  }
  if (actors.length < 2) return null;
  const events = [];
  for (const e of obj.events.slice(0, TRACE.maxEvents)) {
    if (!e || typeof e !== 'object') continue;
    const from = oneLine(e.from, 24);
    const label = oneLine(e.label, 80);
    const to = typeof e.to === 'string' ? oneLine(e.to, 24) : '';
    if (!actors.includes(from) || !label || (to && !actors.includes(to))) continue;
    const step = { from, label };
    if (to && to !== from) step.to = to;
    const note = oneLine(e.note, 200);
    if (note) step.note = note;
    if (Array.isArray(e.state)) {
      const state = [];
      for (const s of e.state.slice(0, 8)) {
        const actor = s && typeof s === 'object' ? oneLine(s.actor, 24) : '';
        const text = s && typeof s === 'object' ? oneLine(s.text, 80) : '';
        if (actors.includes(actor) && text) state.push({ actor, text });
      }
      if (state.length) step.state = state;
    }
    events.push(step);
  }
  if (events.length === 0) return null;
  return { title: oneLine(obj.title, 120) || 'Sequence', actors, events, note: oneLine(obj.note, 200) };
}

/** A sentence for a screen reader about the whole diagram. */
export function describeTrace(trace) {
  return `${trace.title}: sequence diagram, ${trace.actors.length} actors (${trace.actors.join(', ')}), ${trace.events.length} ${trace.events.length === 1 ? 'step' : 'steps'}.`;
}

// ---------------------------------------------------------------- the layout

const cut = (text, n) => (text.length > n ? `${text.slice(0, Math.max(1, n - 1))}…` : text);

/** A label cut to the room it has (an estimate of the text's width), with an ellipsis; the whole of it is in the description under the diagram. */
export function fitLabel(label, maxPx) {
  return cut(String(label), Math.max(3, Math.floor(maxPx / TRACE.charWidth)));
}

/**
 * Where everything goes for a trace drawn at least `width` units wide: a lane for each actor (its name in a pill at the top, in a header of its own so that it stays in view when a long trace scrolls),
 * and for each step a row with its arrow or mark, its label and where the label sits. A card too narrow to give each lane `minLane` is made wider than `width` (`scrolls`), and scrolls sideways inside itself.
 */
export function traceLayout(trace, width = 560) {
  const n = trace.actors.length;
  const need = TRACE.gutter + 2 * TRACE.pad + n * TRACE.minLane;
  const given = clamp(Math.round(Number(width) || 560), TRACE.minWidth, 4000);
  const W = Math.max(given, need);
  const gap = (W - TRACE.gutter - 2 * TRACE.pad) / n;
  const lanes = trace.actors.map((actor, k) => ({ actor, x: TRACE.gutter + TRACE.pad + (k + 0.5) * gap, text: fitLabel(actor, gap - 24), pillW: Math.min(gap - 8, fitLabel(actor, gap - 24).length * TRACE.charWidth + 18) }));
  const xOf = new Map(lanes.map((l) => [l.actor, l.x]));
  const rows = trace.events.map((e, i) => {
    const top = TRACE.bodyPad + i * TRACE.rowHeight;
    const x1 = xOf.get(e.from);
    if (e.to === undefined) {
      const room = Math.min(W - TRACE.gutter - 8, gap * 2);
      const text = fitLabel(e.label, room - 14);
      const right = x1 + 12 + text.length * TRACE.charWidth <= W - 4;
      return { i, top, kind: 'mark', x1, x2: x1, y: top + 22, dir: 1, label: text, labelX: right ? x1 + 12 : x1 - 12, anchor: right ? 'start' : 'end', labelY: top + 26 };
    }
    const x2 = xOf.get(e.to);
    const dir = x2 >= x1 ? 1 : -1;
    const span = Math.abs(x2 - x1);
    const room = Math.min(W - TRACE.gutter - 8, Math.max(span - 12, gap * 1.6));
    const text = fitLabel(e.label, room);
    const half = (text.length * TRACE.charWidth) / 2;
    const mid = (x1 + x2) / 2;
    return { i, top, kind: 'message', x1, x2, y: top + 26, dir, label: text, labelX: clamp(mid, TRACE.gutter + half + 2, W - half - 4), anchor: 'middle', labelY: top + 17 };
  });
  return { W, headH: TRACE.headHeight, bodyH: TRACE.bodyPad + trace.events.length * TRACE.rowHeight + 8, rowH: TRACE.rowHeight, gap, scrolls: need > given, lanes, rows };
}

/** The step a click at height `y` of the body means, or null above the first row and below the last. */
export function rowAt(layout, y) {
  const i = Math.floor((y - TRACE.bodyPad) / layout.rowH);
  return Number.isFinite(i) && i >= 0 && i < layout.rows.length ? i : null;
}

/**
 * Where a diagram's scroll must be for a step to be in view: an offset along one axis, for the range [start, end] of what is to be seen, the offset the view has now and its size. It stays where it
 * is when the range is in view already, moves the least otherwise, and aligns the start when the range is bigger than the view.
 */
export function scrollInto(start, end, scroll, size, margin = 8) {
  if (![start, end, scroll, size].every(Number.isFinite) || size <= 0) return scroll;
  if (end - start > size - 2 * margin || start - margin < scroll) return Math.max(0, start - margin);
  if (end + margin > scroll + size) return Math.max(0, end + margin - size);
  return scroll;
}

/** The vertical scroll that brings step i's row into view below the header, which covers the top of the view. */
export function scrollForRow(layout, i, scrollTop, clientHeight, margin = 6) {
  const row = layout.rows[i];
  if (!row || !Number.isFinite(scrollTop) || !Number.isFinite(clientHeight) || clientHeight <= layout.headH) return scrollTop;
  const top = layout.headH + row.top;
  const bottom = top + layout.rowH;
  if (top - margin < scrollTop + layout.headH) return Math.max(0, top - margin - layout.headH);
  if (bottom + margin > scrollTop + clientHeight) return Math.max(0, bottom + margin - clientHeight);
  return scrollTop;
}

// ---------------------------------------------------------------- steps

/** Whether a step is drawn as done, as the current one, or as later: with "Show all" none is later. */
export function phaseOf(i, step, showAll) {
  if (i < step) return 'done';
  if (i === step) return 'now';
  return showAll ? 'done' : 'later';
}

/** What every actor holds after step `step`: the last state any step up to it gave, and whether this very step gave it. Only actors that have been given one are in it, in the order of the actors. */
export function stateAt(trace, step) {
  const held = new Map();
  for (let i = 0; i <= step && i < trace.events.length; i++) for (const s of trace.events[i].state || []) held.set(s.actor, { text: s.text, at: i });
  return trace.actors.filter((a) => held.has(a)).map((actor) => ({ actor, text: held.get(actor).text, changed: held.get(actor).at === step }));
}

/** The line that says what a step is: `A to B: RequestVote`, or `At A: election timeout` for something that happens at one actor. */
export const lineOf = (e) => (e.to === undefined ? `At ${e.from}: ${e.label}` : `${e.from} to ${e.to}: ${e.label}`);

/**
 * What the card says about a step under the diagram: `heading` ("Step 3 of 12"), `line`, the step's `note`, the states this step gave (`changed`), and `spoken`, the same as one sentence for a screen reader.
 */
export function describeStep(trace, step) {
  const total = trace.events.length;
  const i = clamp(Number.isFinite(step) ? Math.trunc(step) : 0, 0, total - 1);
  const e = trace.events[i];
  const changed = stateAt(trace, i).filter((s) => s.changed).map(({ actor, text }) => ({ actor, text }));
  const heading = `Step ${i + 1} of ${total}`;
  const parts = [heading, lineOf(e)];
  if (e.note) parts.push(e.note);
  for (const c of changed) parts.push(`${c.actor} now: ${c.text}`);
  return { step: i, heading, line: lineOf(e), note: e.note || '', changed, spoken: parts.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(' ') };
}

/** The step after Play's tick, or null when it is at the end (Play stops there). */
export const playNext = (step, total) => (step + 1 < total ? step + 1 : null);

/** Where a key takes the student: the next or previous step (the ends hold), Home and End to the ends; null for any other key. */
export function stepFromKey(step, total, key) {
  switch (key) {
    case 'ArrowRight':
      return Math.min(total - 1, step + 1);
    case 'ArrowLeft':
      return Math.max(0, step - 1);
    case 'Home':
      return 0;
    case 'End':
      return Math.max(0, total - 1);
    default:
      return null;
  }
}

// ---------------------------------------------------------------- the card

function svg(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
  if (text !== undefined) node.textContent = text;
  return node;
}
const f2 = (v) => Math.round(v * 100) / 100;

registerObject('trace', (entry, h) => {
  const trace = readTrace(entry && entry.obj);
  if (!trace) throw new Error('nothing to draw');
  const n = Number(entry && entry.n);
  const total = trace.events.length;
  const view = h.view && typeof h.view.set === 'function' ? h.view : null;
  const uid = `trc-${Number.isFinite(n) ? n : 0}`;

  const node = h.el('div', 'tracecard');
  node.dataset.n = String(entry && entry.n);
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', describeTrace(trace));
  // the conversation is a polite live region: a card is not read out as it arrives (the step below is its own live region, and says each step the student moves to)
  node.setAttribute('aria-live', 'off');
  node.append(h.el('div', 'tr-title', trace.title));

  const scroller = h.el('div', 'tr-diagram');
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'group');
  scroller.setAttribute('aria-label', `Sequence diagram of ${trace.title}`);
  const help = h.el('span', 'sr-only', KEYS_HELP);
  help.id = `${uid}-help`;
  scroller.setAttribute('aria-describedby', help.id);
  node.append(scroller, help);

  // ------------------------------------------------ the controls
  const controls = h.el('div', 'tr-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Step controls');
  const button = (className, text, label) => {
    const b = h.el('button', `tr-btn ${className}`, text);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    return b;
  };
  const prev = button('tr-prev', 'Previous', 'Previous step');
  const play = button('tr-play', 'Play', 'Play the steps');
  play.setAttribute('aria-pressed', 'false');
  const next = button('tr-next', 'Next', 'Next step');
  const slider = h.el('input', 'tr-slider');
  slider.type = 'range';
  slider.min = '1';
  slider.max = String(total);
  slider.step = '1';
  slider.value = '1';
  slider.setAttribute('aria-label', 'Step');
  const all = button('tr-all', 'Show all');
  all.setAttribute('aria-pressed', 'false');
  controls.append(prev, play, next, slider, all);
  node.append(controls);

  // ------------------------------------------------ what the current step says, as text
  const now = h.el('div', 'tr-said');
  now.setAttribute('aria-live', 'polite');
  now.setAttribute('aria-atomic', 'true');
  const nowHead = h.el('p', 'tr-said-head');
  const nowLine = h.el('p', 'tr-said-line');
  const nowNote = h.el('p', 'tr-said-note');
  const nowSaid = h.el('span', 'sr-only');
  now.append(nowHead, nowLine, nowNote, nowSaid);
  node.append(now);
  const states = h.el('ul', 'tr-states');
  node.append(states);
  if (trace.note) node.append(h.el('p', 'tr-note', trace.note));

  // ------------------------------------------------ the diagram, drawn for the width the card has
  const state = { width: 560, layout: traceLayout(trace, 560), step: 0, showAll: false, rowNodes: [], headNode: null, bodyNode: null };

  function draw() {
    const l = (state.layout = traceLayout(trace, state.width));
    const head = svg('svg', { class: 'tr-head', viewBox: `0 0 ${l.W} ${l.headH}`, width: l.W, height: l.headH, 'aria-hidden': 'true', focusable: 'false' });
    for (const lane of l.lanes) {
      head.append(svg('line', { class: 'tr-lane', x1: f2(lane.x), x2: f2(lane.x), y1: 32, y2: l.headH }));
      const pill = svg('g', { class: 'tr-actor' });
      pill.append(svg('rect', { class: 'tr-pill', x: f2(lane.x - lane.pillW / 2), y: 5, width: f2(lane.pillW), height: 26, rx: 8 }));
      pill.append(svg('text', { class: 'tr-actor-name', x: f2(lane.x), y: 22, 'text-anchor': 'middle' }, lane.text));
      pill.append(svg('title', {}, lane.actor));
      head.append(pill);
    }

    const body = svg('svg', { class: 'tr-body', viewBox: `0 0 ${l.W} ${l.bodyH}`, width: l.W, height: l.bodyH, 'aria-hidden': 'true', focusable: 'false' });
    for (const lane of l.lanes) body.append(svg('line', { class: 'tr-lane', x1: f2(lane.x), x2: f2(lane.x), y1: 0, y2: l.bodyH }));
    state.rowNodes = l.rows.map((r) => {
      const g = svg('g', { class: 'tr-ev tr-later', 'data-i': r.i });
      g.append(svg('rect', { class: 'tr-band', x: 0, y: r.top, width: l.W, height: l.rowH }));
      g.append(svg('text', { class: 'tr-num', x: TRACE.gutter - 6, y: r.y + 4, 'text-anchor': 'end' }, String(r.i + 1)));
      if (r.kind === 'message') {
        g.append(svg('line', { class: 'tr-arrow', x1: f2(r.x1), x2: f2(r.x2 - r.dir * (TRACE.arrowLength - 1)), y1: r.y, y2: r.y }));
        g.append(svg('path', { class: 'tr-point', d: `M${f2(r.x2)} ${r.y}L${f2(r.x2 - r.dir * TRACE.arrowLength)} ${r.y - 4}L${f2(r.x2 - r.dir * TRACE.arrowLength)} ${r.y + 4}z` }));
      } else {
        g.append(svg('circle', { class: 'tr-mark', cx: f2(r.x1), cy: r.y, r: TRACE.markRadius }));
      }
      g.append(svg('text', { class: 'tr-label', x: f2(r.labelX), y: r.labelY, 'text-anchor': r.anchor }, r.label));
      body.append(g);
      return g;
    });
    scroller.textContent = '';
    scroller.append(head, body);
    state.headNode = head;
    state.bodyNode = body;
    paint();
  }

  /** The classes of the rows, the controls and the words under the diagram, for the current step. */
  function paint() {
    state.rowNodes.forEach((g, i) => g.setAttribute('class', `tr-ev tr-${phaseOf(i, state.step, state.showAll)}`));
    const d = describeStep(trace, state.step);
    nowHead.textContent = d.heading;
    nowLine.textContent = d.line;
    nowNote.textContent = d.note;
    nowNote.hidden = !d.note;
    nowSaid.textContent = d.changed.map((c) => `${c.actor} now: ${c.text}`).join('. ');
    states.textContent = '';
    for (const s of stateAt(trace, state.step)) {
      const li = h.el('li', 'tr-state');
      li.dataset.changed = String(s.changed);
      li.append(h.el('span', 'tr-state-actor', s.actor), h.el('span', 'tr-state-text', s.text));
      if (s.changed) li.append(h.el('span', 'tr-tag', 'updated'));
      states.append(li);
    }
    slider.value = String(state.step + 1);
    slider.setAttribute('aria-valuetext', `${d.heading}: ${d.line}`);
    prev.setAttribute('aria-disabled', String(state.step <= 0));
    next.setAttribute('aria-disabled', String(state.step >= total - 1));
  }

  /** Keeps the current step in view inside the diagram (the diagram's own scroll, never the page's). */
  function follow() {
    const row = state.layout.rows[state.step];
    if (!row || !Number.isFinite(scroller.clientHeight) || scroller.clientHeight <= 0) return;
    scroller.scrollTop = scrollForRow(state.layout, state.step, scroller.scrollTop, scroller.clientHeight);
    scroller.scrollLeft = scrollInto(Math.min(row.x1, row.x2) - 24, Math.max(row.x1, row.x2) + 24, scroller.scrollLeft, scroller.clientWidth);
  }

  const keeper = createFocusKeeper({ view, owns: (o) => o.n === n && o.step !== undefined });

  // ------------------------------------------------ Play
  let timer = null;
  function stop() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    play.textContent = 'Play';
    play.setAttribute('aria-label', 'Play the steps');
    play.setAttribute('aria-pressed', 'false');
  }
  function go(i, { report = true } = {}) {
    state.step = clamp(i, 0, total - 1);
    paint();
    follow();
    if (report) keeper.report({ n, step: state.step });
  }
  function tick() {
    timer = null;
    if (node.isConnected === false) return stop();
    const to = playNext(state.step, total);
    if (to === null) return stop();
    go(to);
    if (playNext(state.step, total) === null) stop();
    else timer = setTimeout(tick, PLAY_MS);
  }
  play.addEventListener('click', () => {
    if (timer !== null) return stop();
    if (state.step >= total - 1) go(0);
    play.textContent = 'Pause';
    play.setAttribute('aria-label', 'Pause');
    play.setAttribute('aria-pressed', 'true');
    timer = setTimeout(tick, PLAY_MS);
  });

  // ------------------------------------------------ the other controls: each stops Play
  prev.addEventListener('click', () => {
    stop();
    if (state.step > 0) go(state.step - 1);
  });
  next.addEventListener('click', () => {
    stop();
    if (state.step < total - 1) go(state.step + 1);
  });
  slider.addEventListener('input', () => {
    stop();
    go(Number(slider.value) - 1);
  });
  all.addEventListener('click', () => {
    stop();
    state.showAll = !state.showAll;
    all.textContent = state.showAll ? 'Hide upcoming' : 'Show all';
    all.setAttribute('aria-pressed', String(state.showAll));
    paint();
  });
  scroller.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const to = stepFromKey(state.step, total, event.key);
    if (to === null) return;
    event.preventDefault();
    stop();
    if (to !== state.step) go(to);
  });
  scroller.addEventListener('click', (event) => {
    const box = state.bodyNode && typeof state.bodyNode.getBoundingClientRect === 'function' ? state.bodyNode.getBoundingClientRect() : null;
    if (!box || !Number.isFinite(event.clientY)) return;
    const i = rowAt(state.layout, event.clientY - box.top);
    if (i === null) return;
    stop();
    go(i);
  });
  node.addEventListener('focusin', () => keeper.enter());
  node.addEventListener('focusout', (event) => {
    const related = event.relatedTarget || null;
    if (related && typeof node.contains === 'function' && node.contains(related)) return;
    stop();
    keeper.leave({ related, windowBlur: typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus() });
  });

  draw();

  // the width the card has: the layout is made for it and made again when it changes
  let watcher = null;
  if (typeof ResizeObserver === 'function') {
    watcher = new ResizeObserver((list) => {
      const width = list && list[0] && list[0].contentRect ? list[0].contentRect.width : 0;
      if (width >= 1 && Math.abs(width - state.width) >= 6) {
        state.width = clamp(width, TRACE.minWidth, 4000);
        draw();
        follow();
      }
    });
    watcher.observe(scroller);
  }

  return {
    node,
    text: entry && entry.text,
    destroy() {
      stop();
      if (watcher) watcher.disconnect();
      keeper.clear();
    },
  };
});
