// The card of a chart (a chat object of type 'chart': docs/CHAT_OBJECTS.md, docs/CARDS.md). TAi puts numbers in the chat (the student's own load-test results, a measurement it made with run_go) and the host
// turns them into this card: a line, bar or scatter chart drawn as SVG built from numbers and text, the way a run card is built from text. It registers on import (objects.js); app.js imports it.
//
// Everything on the card is DOM built with createElement and createElementNS from numbers and strings: nothing a model sent is ever markup, and nothing is set through an inline style attribute (the page's
// content policy forbids one). The colours of the series are classes (chartcard.css), and a series differs from the others by shape (a line's markers) or dash or hatching as well as by colour: colour is never
// the only signal. The numbers are drawn at a scale of one SVG unit to one CSS pixel: the card measures the width it has, makes its geometry for that width (`chartGeometry`, pure) and draws it again when the
// width changes, so that the text stays readable on a phone and the axes keep their ticks.
//
// What the student can do: read a point (hover it, or move to it with the arrow keys: its series and values are said in a line under the chart, which is a polite live region), pick one (a click, a tap, Enter or
// Space) and, in a table that is a real HTML table, read and copy all the numbers ("Show data"). A picked point is part of the view (docs/CHAT_OBJECTS.md, "The view"): `obj: { n, series, index }`, the series and
// the point as the host numbers them (the index into the series' own list, the x of a plain number being its position), so that TAi knows what "this point" is; it is taken back when focus leaves the card (except
// for the message box: see createFocusKeeper).
//
// The pure parts (the tick maths, the scales, the geometry, the nearest point, the keys, the words of the readout, the rows of the table) are exported and tested in chartcard.test.js; the DOM is checked in a browser.
import { registerObject } from './objects.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const CHART = {
  minWidth: 240,
  maxWidth: 760,
  defaultWidth: 560,
  heightRatio: 0.58,
  minHeight: 190,
  maxHeight: 340,
  /** The width of one character of the axis text (12 px sans-serif digits), for the room the labels need. */
  charWidth: 6.8,
  tick: 5,
  padRight: 14,
  /** Room inside the plot at each side of a line or scatter chart, so that a marker at the edge is whole. */
  padX: 8,
  markerRadius: 4.2,
  /** How far from a point (in SVG units, which are CSS pixels here) a pointer still means that point. */
  hit: 26,
  maxTicksY: 6,
  maxTicksX: 6,
};
/** A pick kept while the student types in the message box about it is let go after this long (the server keeps a view for three or ten minutes). */
export const KEEP_PICK_MS = 120_000;
export const KEYS_HELP = 'Left and right arrow keys move along a series, up and down change series, Home and End go to its first and last point, Enter or Space picks a point, Escape lets it go.';

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

// ---------------------------------------------------------------- text and numbers

/** One line of text: control, format and line-separator characters are spaces, white space is single, at most `max` characters. */
export function oneLine(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The smallest step of 1, 2 or 5 times a power of ten that gives at most `count` ticks over [lo, hi]: outward rounds the ends of the range outward to ticks, inward keeps the ticks inside. */
function stepFor(lo, hi, count, outward) {
  const range = hi - lo;
  const start = Math.floor(Math.log10(range / (count * 4)));
  for (let e = start; e < start + 12; e++) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** e;
      const first = outward ? Math.floor(lo / step + 1e-9) : Math.ceil(lo / step - 1e-9);
      const last = outward ? Math.ceil(hi / step - 1e-9) : Math.floor(hi / step + 1e-9);
      if (last - first + 1 <= count && last - first >= 1) return { step, first, last };
    }
  }
  const step = 10 ** (start + 12);
  return { step, first: Math.floor(lo / step), last: Math.ceil(hi / step) };
}

/** How many decimals a tick at this step needs: 0.5 needs one, 2 needs none. */
export const decimalsOf = (step) => clamp(-Math.floor(Math.log10(step) + 1e-9), 0, 12);

/**
 * Nice tick values over [min, max]: steps of 1, 2 or 5 times a power of ten, at most `maxTicks` of them (about six). With `outward` (the default) the scale reaches the ticks around the data, as a vertical
 * axis does; without it the ticks lie inside the data's range, and the scale is the range itself. A flat range (min equals max) is widened so that there is a scale. Answers { ticks, min, max, step }.
 */
export function niceTicks(min, max, maxTicks = CHART.maxTicksY, { outward = true } = {}) {
  let lo = Number(min);
  let hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
    lo -= pad;
    hi += pad;
  }
  const count = Math.max(2, Math.floor(maxTicks));
  const { step, first, last } = stepFor(lo, hi, count, outward);
  const decimals = decimalsOf(step);
  const ticks = [];
  for (let i = first; i <= last; i++) ticks.push(Number((i * step).toFixed(decimals)));
  return outward ? { ticks, min: ticks[0], max: ticks[ticks.length - 1], step } : { ticks, min: lo, max: hi, step };
}

function groupDigits(text) {
  return text.replace(/^(-?)(\d+)/, (_all, sign, whole) => sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
}

/** A tick label: the digits its step needs, grouped in thousands, and `2.5M` for a million and more. */
export function formatTick(value, step) {
  if (!finite(value)) return '';
  const v = value === 0 ? 0 : value;
  if (Math.abs(v) >= 1e6) {
    try {
      return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
    } catch {
      return String(v);
    }
  }
  return groupDigits(v.toFixed(Math.min(decimalsOf(step), 8)));
}

/** A number as the readout and the table say it: up to ten significant digits (the host keeps no more), grouped in thousands, never in exponent form. */
export function formatNumber(n) {
  if (!finite(n)) return '';
  if (n === 0) return '0';
  try {
    return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 10 }).format(n);
  } catch {
    return String(n);
  }
}

/** A unit after a number: ` ms`, and `%` or `°C` close to it. */
export const unitSuffix = (unit) => (unit ? (/^[%°]/.test(unit) ? unit : ` ${unit}`) : '');

/** The title of an axis with its unit: `latency (ms)`. */
export function axisTitle(label, unit) {
  const l = oneLine(label, 60);
  const u = oneLine(unit, 16);
  return l && u ? `${l} (${u})` : l || (u ? `(${u})` : '');
}

// ---------------------------------------------------------------- the chart as the card reads it

/** A point's x and y as the host reads them (src/chat-objects/view.ts): a pair is [x, y]; a plain number is a y whose x is its position in the list (for a bar, the category's). */
export const pointOf = (p, i) => (Array.isArray(p) ? { x: Number(p[0]), y: Number(p[1]) } : { x: i, y: Number(p) });

/** The names of the bars: the object's own, or 1, 2, 3 ... */
export function categoriesOf(obj) {
  const most = Math.max(1, ...obj.series.map((s) => s.points.length));
  const given = Array.isArray(obj.categories) ? obj.categories : [];
  return Array.from({ length: Math.min(24, most) }, (_, i) => oneLine(given[i], 40) || String(i + 1));
}

/**
 * The chart as the card draws it, from what the history holds. The host has cleaned it already (src/chat-objects/chart.ts), so this only guards what is cheap to guard: text is one line, a point that is not a
 * finite number is not drawn, a series with none left is not there. Null when there is nothing to draw.
 */
export function readChart(obj) {
  if (!obj || typeof obj !== 'object' || !['line', 'bar', 'scatter'].includes(obj.kind) || !Array.isArray(obj.series)) return null;
  const series = [];
  for (const s of obj.series.slice(0, 6)) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.points)) continue;
    const points = [];
    for (const p of s.points.slice(0, 200)) {
      if (finite(p)) points.push(p);
      else if (Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1])) points.push([p[0], p[1]]);
    }
    if (points.length) series.push({ name: oneLine(s.name, 40) || `Series ${series.length + 1}`, points });
  }
  if (series.length === 0) return null;
  const out = {
    kind: obj.kind,
    title: oneLine(obj.title, 120) || 'Chart',
    xLabel: oneLine(obj.xLabel, 60),
    yLabel: oneLine(obj.yLabel, 60),
    xUnit: oneLine(obj.xUnit, 16),
    yUnit: oneLine(obj.yUnit, 16),
    note: oneLine(obj.note, 200),
    series,
  };
  if (obj.kind === 'bar') {
    out.categories = categoriesOf({ series, categories: obj.categories });
    for (const s of series) s.points = s.points.slice(0, out.categories.length).map((p) => (Array.isArray(p) ? p[1] : p));
  }
  return out;
}

/** A sentence for a screen reader about the whole chart: its title, kind, series and number of points. */
export function describeChart(obj) {
  const kind = obj.kind === 'bar' ? 'bar chart' : obj.kind === 'scatter' ? 'scatter chart' : 'line chart';
  const counts = obj.series.map((s) => s.points.length);
  const total = counts.reduce((a, b) => a + b, 0);
  const points = obj.series.length === 1 ? `${total} ${total === 1 ? 'point' : 'points'}` : counts.every((c) => c === counts[0]) ? `${counts[0]} points each` : `${total} points in all`;
  const names = obj.series.map((s) => s.name).join(', ');
  return `${obj.title}: ${kind}, ${obj.series.length} series (${names}), ${points}.`;
}

// ---------------------------------------------------------------- series styles

/** How the series differ besides colour: the marker of a line or scatter chart, the dash of a line, the hatching of a bar. The legend shows the same. */
export const SERIES_STYLES = [
  { shape: 'circle', dash: '', pattern: 'solid' },
  { shape: 'square', dash: '7 4', pattern: 'diag' },
  { shape: 'triangle', dash: '2 4', pattern: 'dots' },
  { shape: 'diamond', dash: '10 4 2 4', pattern: 'back' },
  { shape: 'cross', dash: '14 5', pattern: 'horiz' },
  { shape: 'plus', dash: '1 5', pattern: 'grid' },
];
export const styleOf = (index) => SERIES_STYLES[((index % SERIES_STYLES.length) + SERIES_STYLES.length) % SERIES_STYLES.length];
/** A marker drawn as a line (a cross or a plus) has no fill. */
export const isStrokeShape = (shape) => shape === 'cross' || shape === 'plus';

const f2 = (v) => Math.round(v * 100) / 100;

/** The path of one marker centred at (cx, cy) with radius r. */
export function markerPath(shape, cx, cy, r) {
  const x = f2(cx);
  const y = f2(cy);
  switch (shape) {
    case 'square':
      return `M${f2(x - r)} ${f2(y - r)}h${f2(2 * r)}v${f2(2 * r)}h${f2(-2 * r)}z`;
    case 'triangle':
      return `M${x} ${f2(y - r * 1.2)}L${f2(x + r * 1.1)} ${f2(y + r * 0.85)}L${f2(x - r * 1.1)} ${f2(y + r * 0.85)}z`;
    case 'diamond':
      return `M${x} ${f2(y - r * 1.3)}L${f2(x + r * 1.3)} ${y}L${x} ${f2(y + r * 1.3)}L${f2(x - r * 1.3)} ${y}z`;
    case 'cross':
      return `M${f2(x - r)} ${f2(y - r)}L${f2(x + r)} ${f2(y + r)}M${f2(x - r)} ${f2(y + r)}L${f2(x + r)} ${f2(y - r)}`;
    case 'plus':
      return `M${f2(x - r * 1.15)} ${y}L${f2(x + r * 1.15)} ${y}M${x} ${f2(y - r * 1.15)}L${x} ${f2(y + r * 1.15)}`;
    default:
      return `M${f2(x - r)} ${y}a${r} ${r} 0 1 0 ${f2(2 * r)} 0a${r} ${r} 0 1 0 ${f2(-2 * r)} 0z`;
  }
}

// ---------------------------------------------------------------- the geometry

const cut = (text, n) => (text.length > n ? `${text.slice(0, Math.max(1, n - 1))}…` : text);

/**
 * The labels under the bars: every bar's, cut to the room its band has, when a band holds about six characters or more; with narrower bands (many bars) every second, third or later one, each with the
 * room of the bands it stands for, so that "service-13" is not cut to "service-…". The table has every name whole.
 */
function barTicks(categories, band, sx) {
  const want = Math.min(14, Math.max(...categories.map((c) => c.length)));
  const every = band >= 6 * CHART.charWidth + 8 ? 1 : Math.max(1, Math.ceil((want * CHART.charWidth + 8) / band));
  const room = Math.max(3, Math.floor((band * every - 4) / CHART.charWidth));
  const ticks = [];
  for (let i = 0; i < categories.length; i += every) ticks.push({ value: i, label: cut(categories[i], room), px: sx(i) });
  return ticks;
}

/**
 * Where everything goes, for a chart (as `readChart` makes it) drawn `width` units wide: the plot area, the ticks of both axes with their positions, and for each series its points with their positions (a bar
 * has its rectangle too) and the order the keyboard walks them in (by x for a scatter chart, as listed for the others). Pure: the card draws what this says, and the tests read it.
 */
export function chartGeometry(obj, width = CHART.defaultWidth) {
  const W = clamp(Math.round(Number(width) || CHART.defaultWidth), CHART.minWidth, CHART.maxWidth);
  const H = clamp(Math.round(W * CHART.heightRatio), CHART.minHeight, CHART.maxHeight);
  const bar = obj.kind === 'bar';
  const pts = obj.series.map((s) => s.points.map((p, i) => pointOf(p, i)));
  const flat = pts.flat();

  let lo = Math.min(...flat.map((p) => p.y));
  let hi = Math.max(...flat.map((p) => p.y));
  if (bar) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const yScale = niceTicks(lo, hi, CHART.maxTicksY);
  const yLabels = yScale.ticks.map((value) => formatTick(value, yScale.step));
  const yTitle = axisTitle(obj.yLabel, obj.yUnit);
  const xTitle = axisTitle(obj.xLabel, obj.xUnit);
  const plot = {
    x0: Math.round(CHART.tick + 8 + Math.max(...yLabels.map((l) => l.length)) * CHART.charWidth),
    x1: W - CHART.padRight,
    y0: yTitle ? 26 : 12,
    y1: H - (xTitle ? 44 : 24),
  };
  const sy = (y) => plot.y1 - ((y - yScale.min) / (yScale.max - yScale.min)) * (plot.y1 - plot.y0);

  let sx;
  let band = 0;
  let xTicks;
  if (bar) {
    const names = categoriesOf(obj);
    band = (plot.x1 - plot.x0) / names.length;
    sx = (i) => plot.x0 + (i + 0.5) * band;
    xTicks = barTicks(names, band, sx);
  } else {
    const xs = flat.map((p) => p.x);
    const wanted = clamp(Math.floor((plot.x1 - plot.x0) / 64), 2, CHART.maxTicksX);
    const xScale = niceTicks(Math.min(...xs), Math.max(...xs), wanted, { outward: false });
    sx = (x) => plot.x0 + CHART.padX + ((x - xScale.min) / (xScale.max - xScale.min)) * (plot.x1 - plot.x0 - 2 * CHART.padX);
    xTicks = xScale.ticks.map((value) => ({ value, label: formatTick(value, xScale.step), px: sx(value) }));
    // a few x values (thread counts 1, 2, 4, 8, 16) are labelled where they are, when the labels have the room, instead of at round numbers that are none of the data's
    const distinct = [...new Set(xs)].sort((a, b) => a - b);
    const names = distinct.map((x) => formatNumber(x));
    const room = Math.max(...names.map((name) => name.length)) * CHART.charWidth + 10;
    if (distinct.length <= CHART.maxTicksX && distinct.every((x, i) => i === 0 || sx(x) - sx(distinct[i - 1]) >= room)) xTicks = distinct.map((value, i) => ({ value, label: names[i], px: sx(value) }));
  }

  const zero = bar ? sy(0) : null;
  const group = band * 0.78;
  const each = group / obj.series.length;
  const series = obj.series.map((s, si) => {
    const points = pts[si].map((p, i) => {
      if (!bar) return { i, x: p.x, y: p.y, px: sx(p.x), py: sy(p.y) };
      const py = sy(p.y);
      const left = sx(i) - group / 2 + si * each;
      return { i, x: p.x, y: p.y, px: left + each / 2, py, bar: { x: left + 0.5, w: Math.max(1.5, each - 1), y: Math.min(py, zero), h: Math.max(1, Math.abs(zero - py)) } };
    });
    const order = points.map((_, i) => i);
    if (obj.kind === 'scatter') order.sort((a, b) => points[a].x - points[b].x || a - b);
    return { name: s.name, style: styleOf(si), points, order };
  });
  return { W, H, kind: obj.kind, plot, yTicks: yScale.ticks.map((value, i) => ({ value, label: yLabels[i], py: sy(value) })), xTicks, yTitle, xTitle, baseline: zero, series };
}

/** The point nearest to (px, py) in the geometry's units, or null when none is within `maxDist`. A bar is found by its x alone (its whole height is the target). */
export function nearestPoint(geom, px, py, maxDist = CHART.hit) {
  if (geom.kind === 'bar' && (py < geom.plot.y0 - 8 || py > geom.plot.y1 + 8)) return null;
  let best = null;
  let bestD = Infinity;
  geom.series.forEach((s, si) => {
    for (const p of s.points) {
      const d = geom.kind === 'bar' ? Math.abs(px - p.px) : Math.hypot(px - p.px, py - p.py);
      if (d < bestD) {
        bestD = d;
        best = { s: si, i: p.i };
      }
    }
  });
  return best && bestD <= maxDist ? best : null;
}

/**
 * Where an arrow key (or Home or End) takes the keyboard from the point `cur` ({ s, i }, or null): left and right along the series in its order, up and down to the previous and next series at the nearest x,
 * Home and End to the first and last point of the series. From nothing, any of them goes to the first point of the first series. Null for a key that is not one of these.
 */
export function stepPoint(geom, cur, key) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(key) || geom.series.length === 0) return null;
  if (!cur) return { s: 0, i: geom.series[0].order[0] };
  const s = clamp(cur.s, 0, geom.series.length - 1);
  const order = geom.series[s].order;
  const at = Math.max(0, order.indexOf(cur.i));
  switch (key) {
    case 'ArrowRight':
      return { s, i: order[Math.min(order.length - 1, at + 1)] };
    case 'ArrowLeft':
      return { s, i: order[Math.max(0, at - 1)] };
    case 'Home':
      return { s, i: order[0] };
    case 'End':
      return { s, i: order[order.length - 1] };
    default: {
      const t = clamp(s + (key === 'ArrowDown' ? 1 : -1), 0, geom.series.length - 1);
      if (t === s) return { s, i: cur.i };
      const here = geom.series[s].points[cur.i] ? geom.series[s].points[cur.i].x : 0;
      let best = geom.series[t].order[0];
      for (const i of geom.series[t].order) if (Math.abs(geom.series[t].points[i].x - here) < Math.abs(geom.series[t].points[best].x - here)) best = i;
      return { s: t, i: best };
    }
  }
}

// ---------------------------------------------------------------- words: the readout and the table

/** The x of a point as the readout says it: the bar's category, or the number with its unit. */
function xText(obj, p, i) {
  if (obj.kind === 'bar') return categoriesOf(obj)[i] || String(i + 1);
  return formatNumber(pointOf(p, i).x) + unitSuffix(obj.xUnit);
}

/** What the line under the chart says about a point: its series, its place in the series, and its values. `gin, point 3 of 5: threads 4, latency 31 ms`. */
export function readoutText(obj, s, i) {
  const series = obj.series[s];
  if (!series || series.points[i] === undefined) return '';
  const { y } = pointOf(series.points[i], i);
  const xs = xText(obj, series.points[i], i);
  const ys = formatNumber(y) + unitSuffix(obj.yUnit);
  const x = oneLine(obj.xLabel, 60);
  const yl = oneLine(obj.yLabel, 60);
  return `${series.name}, point ${i + 1} of ${series.points.length}: ${x ? `${x} ${xs}` : xs}, ${yl ? `${yl} ${ys}` : ys}`;
}

/**
 * The numbers as a table: { caption, head, rows }. A row is a point, in the order of the data, so that row N is "point N" of the readout: series that have the same x in every row (always so for bars, whose
 * rows are the categories) are columns beside one column of x. A line chart whose series have different x values shares rows by x (in order of x, with an empty cell where a series has no point); anything
 * else (a scatter chart whose series differ) is one row for each point under Series, x and y. Cells are text, grouped in thousands.
 */
export function tableOf(obj) {
  const bar = obj.kind === 'bar';
  const xHead = axisTitle(obj.xLabel, obj.xUnit) || (bar ? 'Category' : 'x');
  const yHead = axisTitle(obj.yLabel, obj.yUnit) || 'y';
  const pts = obj.series.map((s) => s.points.map((p, i) => pointOf(p, i)));
  const caption = `Data of ${obj.title}`;
  const names = obj.series.map((s) => (obj.series.length === 1 ? `${s.name}: ${yHead}` : s.name));
  const cell = (list, i) => (list[i] ? formatNumber(list[i].y) : '');
  if (bar) {
    const categories = categoriesOf(obj);
    return { caption, head: [xHead, ...names], rows: categories.map((name, i) => [name, ...pts.map((list) => cell(list, i))]) };
  }
  const same = pts.every((list) => list.length === pts[0].length && list.every((p, i) => p.x === pts[0][i].x));
  if (same) return { caption, head: [xHead, ...names], rows: pts[0].map((p, i) => [formatNumber(p.x), ...pts.map((list) => cell(list, i))]) };
  if (obj.kind === 'line' && pts.every((list) => new Set(list.map((p) => p.x)).size === list.length)) {
    const xs = [...new Set(pts.flat().map((p) => p.x))].sort((a, b) => a - b);
    const cells = pts.map((list) => new Map(list.map((p) => [p.x, p.y])));
    return { caption, head: [xHead, ...names], rows: xs.map((x) => [formatNumber(x), ...cells.map((m) => (m.has(x) ? formatNumber(m.get(x)) : ''))]) };
  }
  const rows = [];
  obj.series.forEach((s, si) => pts[si].forEach((p) => rows.push([s.name, formatNumber(p.x), formatNumber(p.y)])));
  return { caption, head: ['Series', xHead, yHead], rows };
}

// ---------------------------------------------------------------- what the card reports to the view

/** Whether a node is somewhere the student types: a text box, a text area, an editable region (not a button, a check box or a slider). */
export function isTextEntry(node) {
  if (!node || typeof node !== 'object') return false;
  const tag = String(node.tagName || node.tag || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'image', 'color', 'hidden'].includes(String(node.type || 'text').toLowerCase());
  return node.isContentEditable === true;
}

/**
 * What puts the card's part of the view on the page's shared view and takes it back. `report(part)` sets `obj`; `leave({ related, windowBlur })` is told that focus left the card: the part is taken back at once,
 * except (a) when only the window lost focus (the student went to another window and will come back to the same point) and (b) when focus went to a place the student types in, which is how they ask about
 * what they picked: there it is kept for `keepMs`, and taken back then. Only a part that is still this card's is taken back (`owns(obj)`): a run card's lines, a trace's step or another chart's point may
 * have replaced it. `onClear` is told when the part was taken back, so that the card forgets its mark.
 */
export function createFocusKeeper({ view, owns, onClear = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, keepMs = KEEP_PICK_MS }) {
  let timer = null;
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const current = () => (view && typeof view.get === 'function' ? view.get().obj : undefined);
  const clear = () => {
    cancel();
    const obj = current();
    if (obj && owns(obj) && typeof view.set === 'function') view.set({ obj: null });
    onClear();
  };
  return {
    report(part) {
      cancel();
      if (view && typeof view.set === 'function') view.set({ obj: part });
    },
    leave({ related = null, windowBlur = false } = {}) {
      if (windowBlur) return;
      if (isTextEntry(related)) {
        cancel();
        timer = setTimer(clear, keepMs);
        return;
      }
      clear();
    },
    enter: cancel,
    clear,
  };
}

// ---------------------------------------------------------------- the card

let cards = 0;

function svg(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The hatching of one series of bars, as the definitions of a pattern: 'solid' needs none. */
function patternDef(id, style, index) {
  const ink = { class: `ch-pat-ink ch-s${index}`, 'stroke-width': 1.6, fill: 'none' };
  const p = svg('pattern', { id, patternUnits: 'userSpaceOnUse', width: 6, height: 6 });
  p.append(svg('rect', { class: 'ch-pat-bg', width: 6, height: 6 }));
  switch (style.pattern) {
    case 'diag':
      p.append(svg('path', { ...ink, d: 'M-1 1L1 -1M0 6L6 0M5 7L7 5' }));
      break;
    case 'back':
      p.append(svg('path', { ...ink, d: 'M-1 5L1 7M0 0L6 6M5 -1L7 1' }));
      break;
    case 'dots':
      p.append(svg('circle', { class: `ch-pat-dot ch-s${index}`, cx: 3, cy: 3, r: 1.4 }));
      break;
    case 'horiz':
      p.append(svg('path', { ...ink, d: 'M0 1.5H6M0 4.5H6' }));
      break;
    default:
      p.append(svg('path', { ...ink, d: 'M0 3H6M3 0V6' }));
  }
  return p;
}

const drawsFill = (style) => style.pattern !== 'solid';

registerObject('chart', (entry, h) => {
  const obj = readChart(entry && entry.obj);
  if (!obj) throw new Error('nothing to draw');
  const n = Number(entry && entry.n);
  const uid = `chp-${Number.isFinite(n) ? n : 0}-${++cards}`;
  const view = h.view && typeof h.view.set === 'function' ? h.view : null;

  const node = h.el('div', 'chartcard');
  node.dataset.n = String(entry && entry.n);
  node.dataset.kind = obj.kind;
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', describeChart(obj));
  // the conversation is a polite live region: a card is not read out as it arrives (the readout below is its own live region, and says what the student moves to)
  node.setAttribute('aria-live', 'off');

  node.append(h.el('div', 'ch-title', obj.title));

  const plot = h.el('div', 'ch-plot');
  plot.tabIndex = 0;
  plot.setAttribute('role', 'application');
  plot.setAttribute('aria-roledescription', 'interactive chart');
  plot.setAttribute('aria-label', `${obj.title}. ${describeChart(obj)}`);
  const help = h.el('span', 'sr-only', KEYS_HELP);
  help.id = `${uid}-help`;
  plot.setAttribute('aria-describedby', help.id);
  node.append(plot, help);

  const readout = h.el('div', 'ch-readout');
  readout.setAttribute('aria-live', 'polite');
  readout.setAttribute('aria-atomic', 'true');
  node.append(readout);

  // the hatchings of the bars, once for the card (the plot and the legend both refer to them by id)
  const defs = svg('svg', { class: 'ch-defs', 'aria-hidden': 'true', focusable: 'false', width: 0, height: 0 });
  const defsRoot = svg('defs', {});
  obj.series.forEach((_, i) => {
    if (obj.kind === 'bar' && drawsFill(styleOf(i))) defsRoot.append(patternDef(`${uid}-p${i}`, styleOf(i), i % SERIES_STYLES.length));
  });
  defs.append(defsRoot);
  node.append(defs);

  // the legend: the same shape, dash or hatching that the series has in the plot, beside its name
  const legend = h.el('ul', 'ch-legend');
  obj.series.forEach((s, i) => {
    const style = styleOf(i);
    const item = h.el('li', `ch-key ch-s${i % SERIES_STYLES.length}`);
    const swatch = svg('svg', { class: 'ch-swatch', viewBox: '0 0 30 14', width: 30, height: 14, 'aria-hidden': 'true', focusable: 'false' });
    if (obj.kind === 'bar') {
      swatch.append(svg('rect', { class: drawsFill(style) ? 'ch-barp' : 'ch-bar', x: 4, y: 2, width: 22, height: 10, ...(drawsFill(style) ? { fill: `url(#${uid}-p${i})` } : {}) }));
    } else {
      if (obj.kind === 'line') swatch.append(svg('path', { class: 'ch-line', d: 'M1 7H29', ...(style.dash ? { 'stroke-dasharray': style.dash } : {}) }));
      swatch.append(svg('path', { class: isStrokeShape(style.shape) ? 'ch-mk-stroke' : 'ch-mk', d: markerPath(style.shape, 15, 7, CHART.markerRadius) }));
    }
    item.append(swatch, h.el('span', 'ch-key-name', s.name));
    legend.append(item);
  });
  node.append(legend);

  if (obj.note) node.append(h.el('p', 'ch-note', obj.note));

  // the data as a table: built the first time it is asked for
  const foot = h.el('div', 'ch-foot');
  const toggle = h.el('button', 'ch-btn', 'Show data');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  const dataId = `${uid}-data`;
  toggle.setAttribute('aria-controls', dataId);
  const data = h.el('div', 'ch-data');
  data.id = dataId;
  data.hidden = true;
  let built = false;
  toggle.addEventListener('click', () => {
    const open = data.hidden;
    if (open && !built) {
      built = true;
      const t = tableOf(obj);
      const table = h.el('table', 'ch-table');
      table.append(h.el('caption', 'sr-only', t.caption));
      const head = h.el('tr', '');
      for (const text of t.head) {
        const th = h.el('th', '', text);
        th.setAttribute('scope', 'col');
        head.append(th);
      }
      const thead = h.el('thead', '');
      thead.append(head);
      const body = h.el('tbody', '');
      for (const row of t.rows) {
        const tr = h.el('tr', '');
        row.forEach((cell, col) => {
          const td = h.el(col === 0 ? 'th' : 'td', '', cell);
          if (col === 0) td.setAttribute('scope', 'row');
          tr.append(td);
        });
        body.append(tr);
      }
      table.append(thead, body);
      data.tabIndex = 0;
      data.setAttribute('role', 'region');
      data.setAttribute('aria-label', t.caption);
      data.append(table);
    }
    data.hidden = !open;
    toggle.textContent = open ? 'Hide data' : 'Show data';
    toggle.setAttribute('aria-expanded', String(open));
  });
  foot.append(toggle);
  node.append(foot, data);

  // ------------------------------------------------ the plot, drawn for the width the card has
  const state = { width: CHART.defaultWidth, geom: chartGeometry(obj, CHART.defaultWidth), active: null, picked: null, hover: null, svgNode: null, cursor: null };

  function draw() {
    const g = (state.geom = chartGeometry(obj, state.width));
    const root = svg('svg', { class: 'ch-svg', viewBox: `0 0 ${g.W} ${g.H}`, 'aria-hidden': 'true', focusable: 'false' });
    const { plot: pl } = g;
    const grid = svg('g', { class: 'ch-grid' });
    for (const t of g.yTicks) grid.append(svg('line', { class: 'ch-gridline', x1: pl.x0, x2: pl.x1, y1: f2(t.py), y2: f2(t.py) }));
    root.append(grid);
    const axes = svg('g', { class: 'ch-axes' });
    axes.append(svg('line', { class: 'ch-axis', x1: pl.x0, x2: pl.x1, y1: pl.y1, y2: pl.y1 }), svg('line', { class: 'ch-axis', x1: pl.x0, x2: pl.x0, y1: pl.y0, y2: pl.y1 }));
    if (g.baseline !== null && Math.abs(g.baseline - pl.y1) > 1) axes.append(svg('line', { class: 'ch-axis ch-zero', x1: pl.x0, x2: pl.x1, y1: f2(g.baseline), y2: f2(g.baseline) }));
    for (const t of g.yTicks) axes.append(svg('text', { class: 'ch-tick', x: pl.x0 - CHART.tick - 3, y: f2(t.py + 4), 'text-anchor': 'end' }, t.label));
    for (const t of g.xTicks) {
      axes.append(svg('line', { class: 'ch-axis', x1: f2(t.px), x2: f2(t.px), y1: pl.y1, y2: pl.y1 + CHART.tick }));
      axes.append(svg('text', { class: 'ch-tick', x: f2(t.px), y: pl.y1 + CHART.tick + 13, 'text-anchor': 'middle' }, t.label));
    }
    if (g.yTitle) axes.append(svg('text', { class: 'ch-axis-title', x: 4, y: 14 }, g.yTitle));
    if (g.xTitle) axes.append(svg('text', { class: 'ch-axis-title', x: f2((pl.x0 + pl.x1) / 2), y: g.H - 6, 'text-anchor': 'middle' }, g.xTitle));
    root.append(axes);

    g.series.forEach((s, si) => {
      const cls = `ch-s${si % SERIES_STYLES.length}`;
      const layer = svg('g', { class: `ch-series ${cls}` });
      if (g.kind === 'bar') {
        for (const p of s.points) {
          const r = p.bar;
          layer.append(svg('rect', { class: drawsFill(s.style) ? 'ch-barp' : 'ch-bar', x: f2(r.x), y: f2(r.y), width: f2(r.w), height: f2(r.h), ...(drawsFill(s.style) ? { fill: `url(#${uid}-p${si})` } : {}) }));
        }
      } else {
        if (g.kind === 'line') {
          const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${f2(p.px)} ${f2(p.py)}`).join('');
          layer.append(svg('path', { class: 'ch-line', d, ...(s.style.dash ? { 'stroke-dasharray': s.style.dash } : {}) }));
        }
        if (g.kind === 'scatter' || s.points.length <= 40) {
          const d = s.points.map((p) => markerPath(s.style.shape, p.px, p.py, CHART.markerRadius)).join('');
          layer.append(svg('path', { class: isStrokeShape(s.style.shape) ? 'ch-mk-stroke' : 'ch-mk', d }));
        }
      }
      root.append(layer);
    });

    const cursor = svg('g', { class: 'ch-cursor' });
    cursor.append(svg('circle', { class: 'ch-halo', r: 9 }));
    root.append(cursor);
    plot.textContent = '';
    plot.append(root);
    state.svgNode = root;
    state.cursor = cursor;
    state.hover = null;
    show();
  }

  /** The point the readout and the ring are on now: the one under the pointer, else the keyboard's, else the picked one. */
  const shown = () => state.hover || state.active || state.picked;

  function show() {
    const p = shown();
    readout.textContent = p ? readoutText(obj, p.s, p.i) : '';
    const point = p && state.geom.series[p.s] ? state.geom.series[p.s].points[p.i] : null;
    if (state.cursor) {
      state.cursor.setAttribute('class', point ? 'ch-cursor ch-on' : 'ch-cursor');
      if (point) state.cursor.setAttribute('transform', `translate(${f2(point.px)} ${f2(point.py)})`);
    }
  }

  const keeper = createFocusKeeper({
    view,
    owns: (o) => o.n === n && o.series !== undefined,
    onClear: () => {
      state.picked = null;
      state.active = null;
      state.hover = null;
      show();
    },
  });

  function pick(p) {
    state.picked = p;
    state.active = p;
    show();
    keeper.report({ n, series: p.s, index: p.i });
  }

  /** The pointer's place in the geometry's units (one unit is one pixel when the card is drawn for its own width). */
  function local(event) {
    const box = state.svgNode && typeof state.svgNode.getBoundingClientRect === 'function' ? state.svgNode.getBoundingClientRect() : null;
    const scale = box && box.width > 0 ? state.geom.W / box.width : 1;
    return { x: (event.clientX - (box ? box.left : 0)) * scale, y: (event.clientY - (box ? box.top : 0)) * scale };
  }

  plot.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    const at = local(event);
    const hit = nearestPoint(state.geom, at.x, at.y, CHART.hit);
    if (JSON.stringify(hit) === JSON.stringify(state.hover)) return;
    state.hover = hit;
    show();
  });
  plot.addEventListener('pointerleave', () => {
    if (state.hover === null) return;
    state.hover = null;
    show();
  });
  plot.addEventListener('click', (event) => {
    const at = local(event);
    const hit = nearestPoint(state.geom, at.x, at.y, CHART.hit);
    if (typeof plot.focus === 'function') plot.focus({ preventScroll: true });
    if (hit) pick(hit);
    else {
      state.picked = null;
      keeper.clear();
    }
  });
  plot.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const p = state.active || state.picked || stepPoint(state.geom, null, 'Home');
      if (p) pick(p);
      return;
    }
    if (event.key === 'Escape') {
      if (state.picked || state.active) event.preventDefault();
      state.picked = null;
      keeper.clear();
      return;
    }
    const next = stepPoint(state.geom, state.active || state.picked, event.key);
    if (!next) return;
    event.preventDefault();
    state.active = next;
    show();
  });
  plot.addEventListener('focus', () => {
    keeper.enter();
    if (!state.active) state.active = state.picked || stepPoint(state.geom, null, 'Home');
    show();
  });
  node.addEventListener('focusin', () => keeper.enter());
  node.addEventListener('focusout', (event) => {
    const related = event.relatedTarget || null;
    if (related && typeof node.contains === 'function' && node.contains(related)) return;
    state.active = null;
    keeper.leave({ related, windowBlur: typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus() });
    show();
  });

  draw();

  // the width the card has: the geometry is made for it and made again when it changes (a phone turned round, a window pulled narrower)
  let watcher = null;
  if (typeof ResizeObserver === 'function') {
    watcher = new ResizeObserver((list) => {
      const width = list && list[0] && list[0].contentRect ? list[0].contentRect.width : 0;
      if (width >= 1 && Math.abs(width - state.width) >= 6) {
        state.width = clamp(width, CHART.minWidth, CHART.maxWidth);
        draw();
      }
    });
    watcher.observe(plot);
  }

  return {
    node,
    text: entry && entry.text,
    destroy() {
      if (watcher) watcher.disconnect();
      keeper.clear();
    },
  };
});
