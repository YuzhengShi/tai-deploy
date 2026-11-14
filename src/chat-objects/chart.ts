import { isRecord, oneLine } from './text.js';
import { OBJECT_JSON_MAX } from './types.js';
import type { ChartObject } from './types.js';

const KINDS: ReadonlyArray<ChartObject['kind']> = ['line', 'bar', 'scatter'];
const MAX_SERIES = 6;
const MAX_POINTS = 200;
const MAX_CATEGORIES = 24;
const BIG = 1e12;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= BIG;
/** A number as the card keeps it: ten significant digits are more than a chart can show, and a float's tail is not worth a line of history. */
const tidy = (n: number): number => Number(n.toPrecision(10));

/**
 * A chart as the history keeps it (batch C of docs/CHAT_OBJECTS.md): a title, a kind (line, bar, scatter), labels and units, at most 6 series of at most 200 points; a point is a number (its
 * x is its index, or the bar's category) or an [x, y] pair, every number finite and under 1e12. A bar chart without categories gets 1, 2, 3 ... Points that are not numbers are dropped, a series
 * with none left is dropped; a chart with no series left is nothing. Mixed point shapes in one series become pairs (a bar's series are plain numbers, its categories are the x).
 */
export function cleanChart(raw: unknown): ChartObject | null {
  if (!isRecord(raw) || raw.t !== 'chart') return null;
  const title = oneLine(raw.title, 120);
  const kind = KINDS.find((k) => k === raw.kind);
  if (!title || !kind || !Array.isArray(raw.series)) return null;

  const series: ChartObject['series'] = [];
  raw.series.forEach((entry, i) => {
    if (series.length >= MAX_SERIES || !isRecord(entry) || !Array.isArray(entry.points)) return;
    const points: Array<number | [number, number]> = [];
    for (const point of entry.points.slice(0, MAX_POINTS)) {
      if (finite(point)) points.push(tidy(point));
      else if (Array.isArray(point) && point.length === 2 && finite(point[0]) && finite(point[1])) points.push([tidy(point[0]), tidy(point[1])]);
    }
    if (points.length === 0) return;
    const anyPair = points.some((p) => Array.isArray(p));
    const normal = anyPair ? points.map((p, at) => (Array.isArray(p) ? p : ([at, p] as [number, number]))) : points;
    series.push({ name: oneLine(entry.name, 40) || `Series ${i + 1}`, points: kind === 'bar' ? normal.map((p) => (Array.isArray(p) ? p[1] : p)) : normal });
  });
  if (series.length === 0) return null;

  const out: ChartObject = { t: 'chart', title, kind, xLabel: oneLine(raw.xLabel, 60), yLabel: oneLine(raw.yLabel, 60), series };
  const xUnit = oneLine(raw.xUnit, 16);
  const yUnit = oneLine(raw.yUnit, 16);
  if (xUnit) out.xUnit = xUnit;
  if (yUnit) out.yUnit = yUnit;
  if (kind === 'bar') {
    const bars = Math.min(MAX_CATEGORIES, Math.max(...series.map((s) => s.points.length)));
    // a category is a word, or a number a model wrote as one (thread counts: 1, 2, 4, 8)
    const given = Array.isArray(raw.categories) ? raw.categories.slice(0, MAX_CATEGORIES).map((c) => (finite(c) ? String(tidy(c)) : oneLine(c, 40))) : [];
    out.categories = Array.from({ length: Math.max(bars, 1) }, (_, i) => given[i] || String(i + 1));
    for (const s of out.series) s.points = s.points.slice(0, out.categories.length);
  }
  const note = oneLine(raw.note, 200);
  if (note) out.note = note;
  return out;
}

export const chartSummary = (chart: ChartObject): string => `Chart: ${chart.title} (${chart.series.length} series)`;

/**
 * The raw chart that the arguments of `show_chart` (the voice function and the text agent's tool: `title, kind, x_label, y_label, x_unit?, y_unit?, categories?, series, note?`) stand for, with the
 * field names of the object (camelCase is taken too). Nothing is checked here: the values go to `cleanObject` untouched, and `whyNotChart` says what is wrong when it refuses.
 */
export function chartFromArgs(args: unknown): Record<string, unknown> {
  const a = isRecord(args) ? args : {};
  return {
    t: 'chart',
    title: a.title,
    kind: a.kind,
    xLabel: a.x_label ?? a.xLabel,
    yLabel: a.y_label ?? a.yLabel,
    xUnit: a.x_unit ?? a.xUnit,
    yUnit: a.y_unit ?? a.yUnit,
    categories: a.categories,
    series: a.series,
    note: a.note,
  };
}

const quoted = (value: unknown): string => (typeof value === 'string' ? JSON.stringify(oneLine(value, 30)) : typeof value);

/**
 * Why `cleanObject` would refuse this chart, in a plain sentence a model can act on, or null when it would not: the first thing wrong (no title, a kind that is not one of three, no series, a series with
 * no usable point, a chart too big for the history's gate). Answers null exactly when `cleanObject(raw)` is an object.
 */
export function whyNotChart(raw: unknown): string | null {
  if (!isRecord(raw) || raw.t !== 'chart') return 'that is not a chart: give title, kind, x_label, y_label and series';
  if (!oneLine(raw.title, 120)) return 'the chart needs a title: a few words saying what it shows';
  if (!KINDS.some((k) => k === raw.kind)) return `kind is line, bar or scatter (it was ${quoted(raw.kind)})`;
  if (!Array.isArray(raw.series) || raw.series.length === 0) return 'series is a list of { name, points } with at least one series';
  const out = cleanChart(raw);
  if (!out) {
    const bad = raw.series.findIndex((s) => !isRecord(s) || !Array.isArray(s.points) || !s.points.slice(0, MAX_POINTS).some((p) => finite(p) || (Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]))));
    return `series ${bad + 1} has no point the chart can draw: a point is a number (y; its x is its position) or a pair [x, y], every number finite and below 1e12`;
  }
  const size = JSON.stringify(out).length;
  if (size > OBJECT_JSON_MAX) return `the chart is too big (${size} characters, at most ${OBJECT_JSON_MAX} after cleaning): send fewer points or fewer series, or round the numbers`;
  return null;
}

/** What `cleanChart` left out of what it was given (series and points that were not numbers, or over the limits), so that the model does not describe a chart that is not the one drawn. */
export function chartDropped(raw: unknown, chart: ChartObject): string {
  if (!isRecord(raw) || !Array.isArray(raw.series)) return '';
  const series = raw.series.length - chart.series.length;
  const given = raw.series.reduce((n: number, s) => n + (isRecord(s) && Array.isArray(s.points) ? s.points.length : 0), 0);
  const kept = chart.series.reduce((n, s) => n + s.points.length, 0);
  if (series <= 0 && given <= kept) return '';
  return `Left out of the chart: ${Math.max(series, 0)} of ${raw.series.length} series and ${Math.max(given - kept, 0)} of ${given} points (not numbers, or over the limits of ${MAX_SERIES} series, ${MAX_POINTS} points a series and ${MAX_CATEGORIES} bars).`;
}
