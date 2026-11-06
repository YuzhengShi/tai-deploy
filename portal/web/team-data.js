// The teaching view's pure parts: what a heat-map cell says, how rows are ordered and filtered, the words for a reason a student needs attention,
// and the CSV of the heat map (with the guard against a spreadsheet taking a cell for a formula). No DOM here: team.js draws, and
// team.test.js tests these. The shapes are the ones GET api/team/overview answers with (src/portal/team.ts, docs/TEAM_VIEW.md).

const DAY = 24 * 60 * 60 * 1000;

/** The four levels of a concept, in the words the student's page uses; the glyph is what a heat-map cell shows besides its colour. */
export const LEVELS = {
  solid: { word: 'solid', glyph: '●' },
  getting: { word: 'getting there', glyph: '◐' },
  started: { word: 'just started', glyph: '○' },
  none: { word: 'not started', glyph: '' },
};
/** A mark on a cell that knows the concept and has not said it out loud: the mock-interview risk. */
export const GAP_GLYPH = '▾';

/** Where a confidence stands, by the bands the server sent (`bands.solid`, `bands.gettingThere`: the numbers the student's page and a call use). */
export function levelOf(confidence, bands) {
  if (!(confidence > 0)) return 'none';
  if (confidence >= bands.solid) return 'solid';
  if (confidence >= bands.gettingThere) return 'getting';
  return 'started';
}

/** A cell `[confidence, stability, scopes, last, gap]` as an object, or null for no evidence. */
export function cellInfo(cell) {
  if (!Array.isArray(cell)) return null;
  return { confidence: Number(cell[0]) || 0, stability: Number(cell[1]) || 0, scope: Array.isArray(cell[2]) ? cell[2].map(String) : [], last: cell[3] ? String(cell[3]) : '', gap: cell[4] === 1 };
}

const two = (n) => (Math.round(n * 100) / 100).toFixed(2);

/** What a cell holds, in words and without whose it is (a screen reader has already read the student and the concept when it reaches the cell). */
export function cellWords(cell, bands) {
  const info = cellInfo(cell);
  if (!info) return 'no evidence yet';
  const parts = [`${LEVELS[levelOf(info.confidence, bands)].word} (confidence ${two(info.confidence)}, stability ${two(info.stability)})`];
  parts.push(info.scope.length ? `shown in ${info.scope.join(' and ')}` : 'no context recorded');
  if (info.gap) parts.push('has not explained it out loud (mock interview risk)');
  parts.push(info.last ? `last evidence ${info.last}` : 'no date');
  return parts.join('; ');
}

/** The sentence of a cell for the inspector under the table: whose, which concept, and what it holds. */
export function describeCell(student, concept, cell, bands) {
  return `${student}, ${concept}: ${cellWords(cell, bands)}.`;
}

// ---------------------------------------------------------------- filtering and ordering

const norm = (text) => String(text ?? '').toLowerCase();

/** Whether every word of `query` is in `text` (case does not matter); an empty query matches everything. */
export function matches(text, query) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = norm(text);
  return words.every((w) => hay.includes(w));
}

/** null and undefined go last whichever way the column is sorted; numbers by value, words by `localeCompare`. */
function compare(a, b, dir) {
  const missing = (x) => x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x));
  if (missing(a) && missing(b)) return 0;
  if (missing(a)) return 1;
  if (missing(b)) return -1;
  const order = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'en', { sensitivity: 'base' });
  return dir === 'desc' ? -order : order;
}

/** A sorted copy: `value(row)` is what the column holds; equal rows keep the order they came in. */
export function sortRows(rows, value, dir = 'asc') {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => compare(value(x.row), value(y.row), dir) || x.i - y.i)
    .map((x) => x.row);
}

/** The order the students' columns are drawn in, as indexes into `students` ('name': as the server sent them; 'weakest': the lowest mean first; 'quiet': never wrote, then the longest quiet). */
export function orderStudents(students, by) {
  const idx = students.map((_, i) => i);
  if (by === 'weakest') return sortRows(idx, (i) => students[i].mean, 'asc');
  if (by === 'quiet') return sortRows(idx, (i) => (students[i].quietDays === null ? Infinity : students[i].quietDays), 'desc');
  return idx;
}

// ---------------------------------------------------------------- words

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "20 hours", or "3 days" from a day and a half on. */
export function hoursText(hours) {
  return hours < 36 ? plural(hours, 'hour') : plural(Math.round(hours / 24), 'day');
}

/** The reason a student needs attention, as a sentence without its subject. */
export function reasonText(reason) {
  switch (reason.kind) {
    case 'quiet':
      return reason.days === null ? 'has not written to TAi yet' : `has not written or called for ${plural(reason.days, 'day')}`;
    case 'deadline':
      return `Canvas assignment ${reason.assignment} is due in about ${hoursText(reason.hours)} and nothing is turned in (the last patrol before it)`;
    case 'overdue':
      return `Canvas assignment ${reason.assignment} was due about ${hoursText(reason.hours)} ago and nothing is turned in`;
    case 'misconception':
      return `${plural(reason.concepts.length, 'confirmed misconception')} not remediated: ${reason.concepts.join('; ')}`;
    default:
      return '';
  }
}

/** What the patrol decided, in the page's words ("reached out": a message went to the student). */
export const decisionWord = (decision) => (decision === 'intervene' ? 'reached out' : decision === 'no-action' ? 'no action' : decision === 'failed' ? 'the run failed' : 'noted');

export const RECORD_WORDS ={ ok: 'has a record', none: 'no record yet', unreadable: 'record could not be read' };

/** "today", "yesterday", "5 days ago" for a number of days; "never" for none. */
export function agoText(days) {
  if (days === null || days === undefined) return 'never';
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

/** A day, "2026-11-03", as UTC midnight in milliseconds (null for anything else): days are counted by the calendar, never by a clock or a zone. */
function parseDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day ?? ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * A day as "today", "yesterday" or "Nov 3" ("Jan 2, 2025" in another year than `today`'s). `today` is the server's day (class.today): the days in the
 * files are the orchestrator's, so the page does not ask the browser's clock what day it is. What is not a day comes back as it is.
 */
export function dayText(day, today) {
  const at = parseDay(day);
  if (at === null) return day ? String(day) : '';
  const now = parseDay(today);
  const ago = now === null ? null : Math.round((now - at) / DAY);
  if (ago === 0) return 'today';
  if (ago === 1) return 'yesterday';
  const otherYear = now !== null && new Date(now).getUTCFullYear() !== new Date(at).getUTCFullYear();
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...(otherYear ? { year: 'numeric' } : {}) });
}

export const percent = (right, graded) => (graded > 0 ? Math.round((right / graded) * 100) : null);

/** Minutes for a table cell: nothing as a dash, a whole number without a decimal. */
export function minutesText(minutes) {
  if (!minutes) return '–';
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
}

/** What the page does with the status of the server's answer: draw it, go to the sign-in, say it is not for this account, or say it did not work. */
export function viewForStatus(status) {
  if (status === 200) return 'ok';
  if (status === 401) return 'signin';
  if (status === 403) return 'forbidden';
  return 'error';
}

export const FORBIDDEN_WORDS = 'This page is for the teaching team';

// ---------------------------------------------------------------- the quick checks

/** The questions with at least `min` answers, in the order a column asks for ('answers' or 'right', most or fewest first). */
export function questionRows(rows, { min = 1, key = 'answers', dir = 'desc', query = '' } = {}) {
  const shown = rows.filter((q) => q.answers >= min && matches(q.question, query));
  const value = key === 'right' ? (q) => q.percentRight : key === 'question' ? (q) => q.question : (q) => q.answers;
  return sortRows(shown, value, dir);
}

// ---------------------------------------------------------------- CSV

/**
 * One field of a CSV. A text that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is what a spreadsheet takes for a formula when the file
 * is opened (a concept or a student named `=HYPERLINK(...)`): it gets a quote mark in front, which the spreadsheet shows as nothing and does not
 * run. Then RFC 4180: a field with a comma, a quote or a line break is in quotes, and a quote inside is doubled. A finite number is written as it is.
 */
export function csvField(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (value === null || value === undefined || value === false) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvRow = (values) => values.map(csvField).join(',');

export const CSV_HEADER = ['Student', 'Concept', 'Group', 'Confidence', 'Stability', 'Level', 'Context', 'Last evidence', 'Verbal gap'];

/** The heat map as a CSV, one row for each student and concept with evidence (the cells that are empty are not rows); `concepts` are the rows shown. */
export function heatmapCsv(overview, concepts = overview.concepts) {
  const lines = [csvRow(CSV_HEADER)];
  for (const concept of concepts) {
    concept.cells.forEach((cell, at) => {
      const info = cellInfo(cell);
      if (!info) return;
      const student = overview.students[at];
      lines.push(
        csvRow([student.name, concept.name, concept.group, info.confidence, info.stability, LEVELS[levelOf(info.confidence, overview.bands)].word, info.scope.join('; '), info.last, info.gap ? 'yes' : 'no']),
      );
    });
  }
  return lines.join('\r\n') + '\r\n';
}

/** "tai-competency-2026-11-04.csv" */
export const csvName = (now = new Date()) => `tai-competency-${now.toISOString().slice(0, 10)}.csv`;
