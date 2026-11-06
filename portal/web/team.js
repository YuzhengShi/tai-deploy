// The teaching view: the class as TAi sees it, drawn for the owner (and for nobody else: every number comes from GET api/team/overview and
// api/team/student, which the server refuses to anyone who is not the owner; a signed-out visitor is sent to the main page, any other account is
// told the page is not for it). Plain DOM: everything the server sends goes on the page as text, never as markup. docs/TEAM_VIEW.md says what each
// panel is and where its numbers come from; the pure parts (ordering, filtering, wording, the CSV) are team-data.js, tested by team.test.js.
import {
  FORBIDDEN_WORDS,
  GAP_GLYPH,
  LEVELS,
  RECORD_WORDS,
  agoText,
  cellInfo,
  cellWords,
  csvName,
  decisionWord,
  dayText,
  describeCell,
  heatmapCsv,
  levelOf,
  matches,
  minutesText,
  orderStudents,
  percent,
  plural,
  questionRows,
  reasonText,
  sortRows,
  viewForStatus,
} from './team-data.js';

const $ = (selector, root = document) => root.querySelector(selector);

/** An element with its attributes and children; a string child is a text node, so no value here is ever read as HTML. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** A day of the files as the page says it, counted from the server's day. */
const when = (day) => dayText(day, state.data ? state.data.class.today : '');

const state = {
  data: null,
  filter: '',
  staff: false,
  order: 'name',
  concept: { key: 'mean', dir: 'asc' },
  students: { key: 'name', dir: 'asc' },
  quick: { min: 1, key: 'answers', dir: 'desc' },
  loadId: 0,
  inspected: null,
};

function storage(action, key, value) {
  try {
    if (action === 'get') return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    /* storage can be blocked: the theme just does not stay */
  }
  return null;
}

// ---------------------------------------------------------------- theme

const isDark = () => {
  const forced = document.documentElement.dataset.theme;
  return forced === 'dark' || (forced !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
};

function applyTheme(choice) {
  document.documentElement.dataset.theme = choice === 'light' || choice === 'dark' ? choice : 'auto';
  $('#theme').textContent = isDark() ? 'Light' : 'Dark';
}

// ---------------------------------------------------------------- loading

function show(which, why) {
  $('#state').hidden = which !== 'loading';
  $('#forbidden').hidden = which !== 'forbidden';
  $('#failed').hidden = which !== 'failed';
  $('#content').hidden = which !== 'content';
  if (which === 'failed') $('#failed-why').textContent = why || 'TAi did not answer.';
}

async function call(path) {
  try {
    const res = await fetch(new URL(path, document.baseURI), { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

const isOverview = (data) => !!data && Array.isArray(data.students) && Array.isArray(data.concepts) && !!data.class && !!data.patrol && !!data.quickChecks && !!data.voice;

async function load() {
  const id = ++state.loadId;
  $('#refresh').disabled = true;
  if (!state.data) show('loading');
  const reply = await call(`api/team/overview${state.staff ? '?staff=1' : ''}`);
  if (id !== state.loadId) return;
  $('#refresh').disabled = false;
  const view = viewForStatus(reply.status);
  if (view === 'signin') return void location.replace('./');
  if (view === 'forbidden') return show('forbidden');
  if (view !== 'ok' || !isOverview(reply.data)) {
    return show('failed', reply.status === 0 ? 'The connection to TAi dropped.' : 'TAi could not make the numbers just now. Try again in a moment.');
  }
  state.data = reply.data;
  show('content');
  renderAll();
}

// ---------------------------------------------------------------- small drawing helpers

const th = (text, props = {}) => el('th', { scope: 'col', ...props, text });
const td = (content, cls) => el('td', { class: cls }, content);

/** A column header that sorts: a button, with the direction said in `aria-sort`. */
function sortHeader(label, key, current, onSort, cls) {
  const active = current.key === key;
  const header = el('th', { scope: 'col', class: cls, 'aria-sort': active ? (current.dir === 'asc' ? 'ascending' : 'descending') : 'none' });
  const button = el('button', { class: 'sort', type: 'button' }, label, el('span', { class: 'arrow', 'aria-hidden': 'true', text: active ? (current.dir === 'asc' ? '▲' : '▼') : '' }));
  button.addEventListener('click', () => onSort(key, active && current.dir === 'asc' ? 'desc' : 'asc'));
  header.append(button);
  return header;
}

function scrolling(label, table, extra = '') {
  return el('div', { class: `scroll ${extra}`.trim(), tabindex: 0, role: 'region', 'aria-label': `${label} (scrolls)` }, table);
}

function studentButton(id, name) {
  const button = el('button', { class: 'who', type: 'button', 'data-id': id, text: name });
  button.addEventListener('click', () => openDetail(id, button));
  return button;
}

const empty = (words) => el('p', { class: 'empty', text: words });

function count(shown, all, noun) {
  return shown === all ? plural(all, noun) : `${shown} of ${plural(all, noun)}`;
}

// ---------------------------------------------------------------- the panels

function renderStamp() {
  const d = state.data;
  const at = new Date(d.generatedAt);
  $('#stamp').textContent = `Numbers as of ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} (the server keeps them up to ${d.cacheSeconds} seconds)`;
}

function renderNotes() {
  const { class: c, patrol } = state.data;
  const notes = [];
  if (c.students === 0) notes.push('Nobody from the class is on the allowlist yet, so there is nothing to show.');
  if (c.staffHidden > 0 && !c.includeStaff) notes.push(`${plural(c.staffHidden, 'teaching-team account')} ${c.staffHidden === 1 ? 'is' : 'are'} not counted in the class. Tick the box above to count ${c.staffHidden === 1 ? 'it' : 'them'}.`);
  if (c.canvas.state === 'missing') notes.push('There is no Canvas snapshot, so deadlines cannot be shown.');
  if (c.canvas.state === 'stale') notes.push('The Canvas snapshot is out of date, so deadlines are not shown.');
  if (c.skipped.records > 0) notes.push(`${plural(c.skipped.records, 'competency file')} could not be read and ${c.skipped.records === 1 ? 'was' : 'were'} skipped: ${c.skipped.records === 1 ? 'that student shows' : 'those students show'} no concepts.`);
  if (c.skipped.histories > 0) notes.push(`${plural(c.skipped.histories, 'chat history')} could not be read: their quick checks are missing.`);
  if (c.skipped.voiceUsage) notes.push('The voice usage file could not be read: no minutes are shown.');
  if (!patrol.available) notes.push('The patrol panel needs the orchestrator’s database, which is not connected to this page.');
  $('#notes').replaceChildren(...notes.map((words) => el('li', { text: words })));
  $('#notes').hidden = notes.length === 0;
  $('#staff').checked = c.includeStaff;
}

function renderCards() {
  const d = state.data;
  const c = d.class;
  const confirmedStudents = d.attention.filter((a) => a.reasons.some((r) => r.kind === 'misconception')).length;
  const q = d.quickChecks;
  const right = percent(q.right, q.graded);
  const voiceMinutes = d.voice.students.reduce((sum, s) => sum + s.total, 0);
  const cards = [
    [String(c.students), 'Students', `${c.withRecord} with a record, ${c.noRecord} with none yet${c.unreadable ? `, ${c.unreadable} unreadable` : ''}`],
    [String(d.attention.length), 'Need attention', c.students ? `of ${c.students}: quiet, a deadline, or a mix-up left open` : 'nobody to count'],
    [String(confirmedStudents), 'With a confirmed mix-up', `${plural(d.misconceptions.filter((m) => m.confirmed > 0).length, 'concept')} involved`],
    d.patrol.available ? [String(d.patrol.runs), `Patrol runs, ${d.patrol.days} days`, `the model ran ${d.patrol.ranModel} (${d.patrol.failed} failed), the gate skipped ${d.patrol.skipped}`] : ['–', 'Patrol runs', 'no database here'],
    [right === null ? '–' : `${right}%`, 'Quick checks right', `${plural(q.answered, 'answer')} to ${plural(q.questions.length, 'question')}${q.answered > q.graded ? `; ${q.answered - q.graded} not graded` : ''}`],
    [minutesText(Math.round(voiceMinutes)), 'Voice minutes', `${plural(d.voice.students.length, 'student')}, ${plural(d.voice.students.reduce((sum, s) => sum + s.calls, 0), 'call')} on file`],
  ];
  $('#cards').replaceChildren(
    ...cards.map(([n, label, sub]) => el('li', { class: 'card' }, el('span', { class: 'card-n', text: n }), el('span', { class: 'card-l', text: label }), el('span', { class: 'card-s', text: sub }))),
  );
}

function renderAttention() {
  const d = state.data;
  $('#attention-lead').textContent = `Students who have not written or called for ${plural(d.class.inactiveDays, 'day')} or more (or never have), who have a deadline whose last patrol is next, or who hold a confirmed misconception nobody has remediated. The deadlines are the ones the patrol's gate sees in Canvas.`;
  const rows = d.attention.filter((a) => matches(`${a.name} ${a.reasons.map(reasonText).join(' ')}`, state.filter));
  const host = $('#attention');
  if (d.attention.length === 0) return host.replaceChildren(empty(d.students.length ? 'Nobody needs attention right now.' : 'No students to look at.'));
  if (rows.length === 0) return host.replaceChildren(empty('No student matches the filter.'));
  const table = el('table', { class: 'data' }, el('caption', { text: `Who needs attention (${count(rows.length, d.attention.length, 'student')})` }));
  table.append(el('thead', {}, el('tr', {}, th('Student'), th('Why'))));
  table.append(
    el('tbody', {}, ...rows.map((a) => el('tr', {}, el('th', { scope: 'row' }, studentButton(a.id, a.name)), td(el('ul', { class: 'why' }, ...a.reasons.map((r) => el('li', { text: reasonText(r) }))))))),
  );
  host.replaceChildren(scrolling('Who needs attention', table));
}

// ---- the heat map

const conceptValue = {
  name: (r) => r.name,
  touched: (r) => r.touched,
  mean: (r) => r.mean,
  noVerbal: (r) => (r.touched ? r.noVerbal : null),
  last: (r) => r.last,
};

function shownConcepts() {
  const indexed = state.data.concepts.map((row, i) => ({ row, i }));
  return sortRows(indexed, (x) => conceptValue[state.concept.key](x.row), state.concept.dir).filter((x) => matches(`${x.row.name} ${x.row.group}`, state.filter));
}

function renderHeat() {
  const d = state.data;
  const host = $('#heat');
  const shown = shownConcepts();
  $('#csv').textContent = state.filter.trim() ? 'Download CSV (filtered)' : 'Download CSV';
  $('#csv').disabled = shown.length === 0;
  const met = d.concepts.filter((c) => c.touched > 0).length;
  $('#heat-lead').textContent = d.students.length
    ? `A row for each concept, a column for each student, the concepts the class is weakest on first. ${met} of ${plural(d.concepts.length, 'concept')} ${met === 1 ? 'has' : 'have'} evidence from anyone; a blank cell means TAi has none for that student. Click a student's name to open their page.`
    : 'Nothing to draw until students are on the allowlist.';
  $('#legend').replaceChildren(
    ...[
      ['lv3', LEVELS.solid.glyph, `solid (${d.bands.solid} and up)`],
      ['lv2', LEVELS.getting.glyph, `getting there (${d.bands.gettingThere} to ${d.bands.solid})`],
      ['lv1', LEVELS.started.glyph, `just started (under ${d.bands.gettingThere})`],
      ['none', '', 'blank: no evidence yet'],
      ['gap', GAP_GLYPH, 'in a cell: knows it (0.3 or more) and has not explained it out loud'],
    ].map(([cls, glyph, words]) => el('li', {}, el('span', { class: `swatch ${cls}`, 'aria-hidden': 'true', text: glyph }), words)),
  );
  if (d.students.length === 0) return host.replaceChildren(empty('No students.'));
  if (shown.length === 0) return host.replaceChildren(empty('No concept matches the filter.'));
  const order = orderStudents(d.students, state.order);
  const onSort = (key, dir) => {
    state.concept = { key, dir };
    renderHeat();
  };
  const table = el('table', { class: 'data heat' }, el('caption', { text: `Competency by concept and student (${count(shown.length, d.concepts.length, 'concept')}, ${plural(d.students.length, 'student')})` }));
  const cornerButton = el('button', { class: 'sort', type: 'button', 'aria-label': 'Sort by concept name' }, 'Concept');
  cornerButton.addEventListener('click', () => onSort('name', state.concept.key === 'name' && state.concept.dir === 'asc' ? 'desc' : 'asc'));
  const head = el('tr', {}, el('th', { scope: 'col', class: 'corner', 'aria-sort': state.concept.key === 'name' ? (state.concept.dir === 'asc' ? 'ascending' : 'descending') : 'none' }, cornerButton));
  head.append(
    sortHeader('Assessed', 'touched', state.concept, onSort, 'stat'),
    sortHeader('Mean', 'mean', state.concept, onSort, 'stat'),
    sortHeader('Not said aloud', 'noVerbal', state.concept, onSort, 'stat'),
    sortHeader('Last evidence', 'last', state.concept, onSort, 'stat'),
  );
  for (const at of order) {
    const student = d.students[at];
    head.append(el('th', { scope: 'col', class: `stu${student.staff ? ' staff' : ''}`, 'data-s': at, title: `Open ${student.name}` }, el('span', { text: student.name })));
  }
  table.append(el('thead', {}, head));
  const body = el('tbody');
  for (const { row, i } of shown) {
    const tr = el('tr', { 'data-r': i });
    tr.append(el('th', { scope: 'row', class: 'concept' }, row.name, row.group ? el('small', { text: row.group }) : null));
    tr.append(
      el('td', { class: 'stat', text: row.touched ? `${row.touched}` : '–' }),
      el('td', { class: 'stat', text: row.mean === null ? '–' : row.mean.toFixed(2) }),
      el('td', { class: 'stat', text: row.touched ? `${row.noVerbal}` : '–' }),
      el('td', { class: 'stat', text: row.last ? when(row.last) : '–' }),
    );
    for (const at of order) {
      const cell = row.cells[at];
      const info = cellInfo(cell);
      const lv = info ? levelOf(info.confidence, d.bands) : 'none';
      const node = el('td', { class: `cell${info ? ` lv${lv === 'solid' ? 3 : lv === 'getting' ? 2 : 1}` : ''}`, 'data-r': i, 'data-s': at });
      if (info) {
        node.append(el('span', { 'aria-hidden': 'true', text: LEVELS[lv].glyph }));
        if (info.gap) node.append(el('span', { class: 'gap', 'aria-hidden': 'true', text: GAP_GLYPH }));
        node.append(el('span', { class: 'sr-only', text: cellWords(cell, d.bands) }));
      }
      tr.append(node);
    }
    body.append(tr);
  }
  table.append(body);
  host.replaceChildren(scrolling('Competency heat map', table, 'heat-scroll'));
  state.inspected = null;
  $('#heat-note').textContent = 'Point at a cell, or click it, to read it here.';
}

function inspect(cellNode) {
  const d = state.data;
  const row = d.concepts[Number(cellNode.dataset.r)];
  const student = d.students[Number(cellNode.dataset.s)];
  if (!row || !student) return;
  if (state.inspected && state.inspected !== cellNode) state.inspected.classList.remove('is-on');
  cellNode.classList.add('is-on');
  state.inspected = cellNode;
  $('#heat-note').textContent = describeCell(student.name, row.name, row.cells[Number(cellNode.dataset.s)], d.bands);
}

function downloadCsv() {
  const shown = shownConcepts().map((x) => x.row);
  const blob = new Blob(['﻿', heatmapCsv(state.data, shown)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: csvName(), hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- misconceptions

function renderMisconceptions() {
  const d = state.data;
  const host = $('#misconceptions');
  $('#mis-lead').textContent =
    'Grouped by the concept each one contradicts. The words a student used are not shown; open a row to see who. The patrol’s own rule decides the state: confirmed (said so, or seen three times, and not closed), candidate, or remediated. A resolved mix-up is often moved out of the file, so remediated is a floor.';
  if (d.misconceptions.length === 0) return host.replaceChildren(empty('No misconceptions are recorded. TAi finds them in conversation; none is pre-loaded.'));
  const rows = d.misconceptions.filter((m) => matches(`${m.concept} ${m.who.map((w) => w.name).join(' ')}`, state.filter));
  if (rows.length === 0) return host.replaceChildren(empty('No misconception matches the filter.'));
  const table = el('table', { class: 'data' }, el('caption', { text: `Misconceptions by concept (${count(rows.length, d.misconceptions.length, 'concept')})` }));
  table.append(el('thead', {}, el('tr', {}, th('Concept'), th('Students', { class: 'num' }), th('Confirmed', { class: 'num' }), th('Candidate', { class: 'num' }), th('Remediated', { class: 'num' }))));
  const body = el('tbody');
  rows.forEach((m, i) => {
    const detailId = `mis-${i}`;
    const button = el('button', { class: 'expand', type: 'button', 'aria-expanded': 'false', 'aria-controls': detailId, text: m.concept });
    const names = el('tr', { class: 'names', id: detailId, hidden: true }, el('td', { colspan: 5 }, el('ul', {}, ...m.who.map((w) => el('li', {}, el('button', { class: 'who', type: 'button', text: w.name, 'data-id': w.id }), ' ', el('span', { class: `tag ${w.status}`, text: w.status }))))));
    for (const who of names.querySelectorAll('.who')) who.addEventListener('click', () => openDetail(who.dataset.id, who));
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      names.hidden = !open;
    });
    body.append(
      el('tr', {}, el('th', { scope: 'row' }, button), td(String(m.students), 'num'), td(String(m.confirmed), 'num'), td(String(m.candidate), 'num'), td(String(m.remediated), 'num')),
      names,
    );
  });
  table.append(body);
  host.replaceChildren(scrolling('Misconceptions by concept', table));
}

// ---- patrol

function renderPatrol() {
  const { patrol } = state.data;
  const host = $('#patrol');
  if (!patrol.available) {
    $('#patrol-lead').textContent = '';
    return host.replaceChildren(empty('The patrol’s runs are in the orchestrator’s database, which is not connected to this page.'));
  }
  $('#patrol-lead').textContent = `The last ${patrol.days} days: ${plural(patrol.runs, 'patrol run')}. The model ran ${patrol.ranModel} (${patrol.failed} failed${patrol.shadow ? `, ${patrol.shadow} in shadow mode, where the gate would have skipped it` : ''}); the gate skipped ${patrol.skipped} because nothing new had come up. The reasons are the gate's own words (ids, counts and dates), never what a student wrote.`;
  const parts = [];
  const days = el('table', { class: 'data' }, el('caption', { text: 'Runs by day' }));
  days.append(el('thead', {}, el('tr', {}, th('Day'), th('The model ran', { class: 'num' }), th('Skipped by the gate', { class: 'num' }), th('Failed', { class: 'num' }))));
  days.append(el('tbody', {}, ...patrol.byDay.map((r) => el('tr', {}, el('th', { scope: 'row', text: when(r.day) || r.day }), td(String(r.ranModel), 'num'), td(String(r.skipped), 'num'), td(String(r.failed), 'num')))));
  parts.push(scrolling('Patrol runs by day', days));
  if (patrol.skipReasons.length) {
    const reasons = el('table', { class: 'data' }, el('caption', { text: 'Why the gate skipped (dates and ids taken out)' }));
    reasons.append(el('thead', {}, el('tr', {}, th('Reason'), th('Times', { class: 'num' }))));
    reasons.append(el('tbody', {}, ...patrol.skipReasons.map((r) => el('tr', {}, el('th', { scope: 'row', text: r.reason }), td(String(r.count), 'num')))));
    parts.push(el('h3', { text: 'Why runs were skipped' }), scrolling('Why the gate skipped', reasons));
  }
  const log = patrol.interventions;
  if (log.available) {
    const rows = log.students.filter((s) => matches(s.name, state.filter));
    const table = el('table', { class: 'data' }, el('caption', { text: `What each student’s intervention log says, last ${patrol.days} days (${count(rows.length, log.students.length, 'student')})` }));
    table.append(el('thead', {}, el('tr', {}, th('Student'), th('Reached out', { class: 'num' }), th('No action', { class: 'num' }), th('Other', { class: 'num' }), th('Latest decision'))));
    table.append(
      el('tbody', {}, ...rows.map((s) => el('tr', {}, el('th', { scope: 'row' }, studentButton(s.id, s.name)), td(String(s.intervene), 'num'), td(String(s.noAction), 'num'), td(String(s.other), 'num'), td(s.last ? `${decisionWord(s.last.decision)}, ${when(s.last.date) || s.last.date}` : '')))),
    );
    parts.push(el('h3', { text: 'Decisions the patrol wrote down' }), scrolling('Intervention logs', table));
  }
  if (patrol.recent.length) {
    const rows = patrol.recent.filter((r) => matches(`${r.student} ${r.kind} ${r.reason || ''}`, state.filter));
    const table = el('table', { class: 'data' }, el('caption', { text: `Recent runs, newest first (${count(rows.length, patrol.recent.length, 'run')})` }));
    table.append(el('thead', {}, el('tr', {}, th('Day'), th('Student'), th('What happened'), th('The gate’s words'))));
    const words = { skipped: 'skipped by the gate', shadow: 'ran (the gate would have skipped it)', ran: 'the model ran', failed: 'the model ran and failed' };
    table.append(el('tbody', {}, ...rows.map((r) => el('tr', {}, td(when(r.day) || r.day), td(r.student), td(words[r.kind] || r.kind), td(r.reason || '')))));
    parts.push(el('details', { class: 'more' }, el('summary', { text: `Recent runs (${patrol.recent.length})` }), scrolling('Recent patrol runs', table)));
  }
  host.replaceChildren(...parts);
}

// ---- quick checks

function renderQuick() {
  const { quickChecks: q } = state.data;
  const host = $('#quick');
  const right = percent(q.right, q.graded);
  $('#quick-lead').textContent = `${plural(q.asked, 'quick check')} asked, ${q.answered} answered${right === null ? '' : `, ${right}% of the ${q.graded} that TAi had marked an answer for were right`}. Each row is one question, as TAi worded it; answers are counted without the students who gave them.`;
  if (q.questions.length === 0) return host.replaceChildren(empty('No quick check has been answered yet.'));
  const rows = questionRows(q.questions, { ...state.quick, query: state.filter });
  if (rows.length === 0) return host.replaceChildren(empty('No question matches.'));
  const onSort = (key, dir) => {
    state.quick = { ...state.quick, key, dir };
    renderQuick();
  };
  const current = { key: state.quick.key, dir: state.quick.dir };
  const table = el('table', { class: 'data' }, el('caption', { text: `Quick checks by question (${count(rows.length, q.questions.length, 'question')})` }));
  table.append(
    el('thead', {}, el('tr', {}, sortHeader('Question', 'question', current, onSort), sortHeader('Answers', 'answers', current, onSort, 'num'), th('Graded', { class: 'num' }), sortHeader('Right', 'right', current, onSort, 'num'))),
  );
  table.append(
    el('tbody', {}, ...rows.map((r) => el('tr', {}, el('th', { scope: 'row', text: r.question }), td(String(r.answers), 'num'), td(String(r.graded), 'num'), td(r.percentRight === null ? 'not graded' : `${r.percentRight}%`, 'num')))),
  );
  host.replaceChildren(scrolling('Quick checks by question', table));
}

// ---- voice

function renderVoice() {
  const { voice } = state.data;
  const host = $('#voice');
  const cap = voice.capMinutes ? ` The daily cap is ${voice.capMinutes} minutes per student.` : '';
  $('#voice-lead').textContent = `Minutes of voice connection per student per day (two weeks are kept), and the calls on file (the newest thirty of each student).${cap}`;
  const rows = voice.students.filter((s) => matches(s.name, state.filter));
  if (voice.students.length === 0) return host.replaceChildren(empty('No voice calls yet.'));
  if (rows.length === 0) return host.replaceChildren(empty('No student matches the filter.'));
  const shortDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const table = el('table', { class: 'data' }, el('caption', { text: `Voice by student (${count(rows.length, voice.students.length, 'student')})` }));
  table.append(el('thead', {}, el('tr', {}, th('Student'), th('Calls', { class: 'num' }), th('Last call'), th('Minutes', { class: 'num' }), ...voice.days.map((day) => th(shortDay(day), { class: 'num' })))));
  const near = (minutes) => (voice.capMinutes && minutes >= voice.capMinutes ? ' (at the cap)' : '');
  table.append(
    el(
      'tbody',
      {},
      ...rows.map((s) =>
        el('tr', {}, el('th', { scope: 'row' }, studentButton(s.id, s.name)), td(String(s.calls), 'num'), td(s.lastCall ? when(s.lastCall) : '–'), td(minutesText(s.total), 'num'), ...s.minutes.map((m) => el('td', { class: 'num', text: `${minutesText(m)}${near(m)}` }))),
      ),
    ),
  );
  table.append(el('tfoot', {}, el('tr', {}, el('th', { scope: 'row', text: 'The class' }), td('', 'num'), td(''), td(minutesText(Math.round(voice.totals.reduce((a, b) => a + b, 0) * 10) / 10), 'num'), ...voice.totals.map((m) => td(minutesText(m), 'num')))));
  host.replaceChildren(scrolling('Voice by student', table));
}

// ---- the students

const studentValue = {
  name: (s) => s.name,
  record: (s) => RECORD_WORDS[s.record],
  touched: (s) => s.touched,
  mean: (s) => s.mean,
  verbalGaps: (s) => (s.touched ? s.verbalGaps : null),
  lastEvidence: (s) => s.lastEvidence,
  quietDays: (s) => (s.quietDays === null ? Infinity : s.quietDays),
};

function renderStudents() {
  const d = state.data;
  const host = $('#students');
  $('#students-lead').textContent = 'Every student on the allowlist. Click a name to open their concepts, the patrol’s decisions about them and their voice.';
  if (d.students.length === 0) return host.replaceChildren(empty('No students.'));
  const rows = sortRows(d.students, studentValue[state.students.key], state.students.dir).filter((s) => matches(s.name, state.filter));
  if (rows.length === 0) return host.replaceChildren(empty('No student matches the filter.'));
  const onSort = (key, dir) => {
    state.students = { key, dir };
    renderStudents();
  };
  const table = el('table', { class: 'data' }, el('caption', { text: `Students (${count(rows.length, d.students.length, 'student')})` }));
  table.append(
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        sortHeader('Student', 'name', state.students, onSort),
        sortHeader('Record', 'record', state.students, onSort),
        sortHeader('Concepts met', 'touched', state.students, onSort, 'num'),
        sortHeader('Mean', 'mean', state.students, onSort, 'num'),
        sortHeader('Not said aloud', 'verbalGaps', state.students, onSort, 'num'),
        sortHeader('Last evidence', 'lastEvidence', state.students, onSort),
        sortHeader('Last wrote or called', 'quietDays', state.students, onSort),
      ),
    ),
  );
  table.append(
    el(
      'tbody',
      {},
      ...rows.map((s) =>
        el(
          'tr',
          {},
          el('th', { scope: 'row' }, studentButton(s.id, s.name), s.staff ? el('span', { class: 'muted', text: ' (teaching team)' }) : null),
          td(RECORD_WORDS[s.record].replace(/^./, (c) => c.toUpperCase())),
          td(s.touched ? String(s.touched) : '–', 'num'),
          td(s.mean === null ? '–' : s.mean.toFixed(2), 'num'),
          td(s.touched ? String(s.verbalGaps) : '–', 'num'),
          td(s.lastEvidence ? when(s.lastEvidence) : '–'),
          td(agoText(s.quietDays)),
        ),
      ),
    ),
  );
  host.replaceChildren(scrolling('Students', table));
}

// ---------------------------------------------------------------- one student

let detailOpener = null;
let detailId = 0;

function detailTable(label, headers, rows) {
  const table = el('table', { class: 'data' }, el('caption', { class: 'sr-only', text: label }));
  table.append(el('thead', {}, el('tr', {}, ...headers.map((h) => th(h)))), el('tbody', {}, ...rows));
  return scrolling(label, table);
}

function drawDetail(detail, bands) {
  const body = $('#detail-body');
  $('#detail-title').textContent = `${detail.name}${detail.staff ? ' (teaching team)' : ''}`;
  const parts = [];
  parts.push(
    el(
      'div',
      { class: 'facts' },
      el('span', { text: `Record: ${RECORD_WORDS[detail.record]}` }),
      el('span', { text: `Last wrote or called: ${agoText(detail.quietDays)}` }),
      el('span', { text: `Calls on file: ${detail.voice.calls}${detail.voice.lastCall ? `, the last ${when(detail.voice.lastCall)}` : ''}` }),
    ),
  );
  parts.push(el('h3', { text: 'Needs attention' }));
  parts.push(detail.attention.length ? el('ul', { class: 'why' }, ...detail.attention.map((r) => el('li', { text: reasonText(r) }))) : el('p', { class: 'muted', text: 'Nothing right now.' }));
  parts.push(el('h3', { text: `Concepts, weakest first (${detail.concepts.length} with evidence)` }));
  if (detail.concepts.length === 0) parts.push(el('p', { class: 'muted', text: detail.record === 'ok' ? 'TAi has no evidence on any concept yet.' : `No concepts: ${RECORD_WORDS[detail.record]}.` }));
  else {
    parts.push(
      detailTable(
        'Concepts of this student',
        ['Concept', 'Level', 'Confidence', 'Stability', 'Context', 'Last evidence', 'Said aloud'],
        detail.concepts.map((c) =>
          el(
            'tr',
            {},
            el('th', { scope: 'row' }, c.name, c.group ? el('small', { class: 'muted', text: ` · ${c.group}` }) : null),
            td(`${LEVELS[levelOf(c.confidence, bands)].glyph} ${c.level}`),
            td(c.confidence.toFixed(2), 'num'),
            td(c.stability.toFixed(2), 'num'),
            td(c.scope.join(', ') || '–'),
            td(c.last ? when(c.last) : '–'),
            td(c.verbalGap ? 'not yet (mock interview risk)' : c.scope.includes('verbal') ? 'yes' : '–'),
          ),
        ),
      ),
    );
  }
  parts.push(el('h3', { text: 'Misconceptions' }));
  parts.push(
    detail.misconceptions.length
      ? el('ul', { class: 'plain' }, ...detail.misconceptions.map((m) => el('li', {}, `${m.concept} `, el('span', { class: `tag ${m.status}`, text: m.status }))))
      : el('p', { class: 'muted', text: 'None recorded.' }),
  );
  const patrol = detail.patrol;
  parts.push(el('h3', { text: 'The patrol, last 7 days' }));
  if (!patrol.available) parts.push(el('p', { class: 'muted', text: 'No database connected, so no runs to count.' }));
  else parts.push(el('p', { text: `The model ran ${patrol.ranModel} time${patrol.ranModel === 1 ? '' : 's'} (${patrol.failed} failed); the gate skipped ${patrol.skipped}.` }));
  if (patrol.decisions.length) {
    parts.push(
      detailTable(
        'What the patrol wrote down about this student',
        ['Day', 'Decision', 'Reason'],
        patrol.decisions.map((x) => el('tr', {}, td(when(x.date) || x.date), td(decisionWord(x.decision)), td(x.reason))),
      ),
    );
  }
  parts.push(el('h3', { text: 'Voice' }));
  parts.push(
    detail.voice.minutes.length
      ? el('p', { text: detail.voice.minutes.map((m) => `${when(m.day) || m.day}: ${minutesText(m.minutes)} min`).join(' · ') })
      : el('p', { class: 'muted', text: 'No voice minutes in the last two weeks.' }),
  );
  body.replaceChildren(...parts);
}

async function openDetail(id, opener) {
  const dialog = $('#detail');
  const mine = ++detailId;
  detailOpener = opener || null;
  $('#detail-title').textContent = 'Loading…';
  $('#detail-body').replaceChildren();
  if (!dialog.open) dialog.showModal();
  const reply = await call(`api/team/student?folder=${encodeURIComponent(id)}`);
  if (mine !== detailId) return;
  const view = viewForStatus(reply.status);
  if (view === 'signin') return void location.replace('./');
  if (view === 'ok' && reply.data && Array.isArray(reply.data.concepts)) return drawDetail(reply.data, state.data.bands);
  $('#detail-title').textContent = view === 'forbidden' ? FORBIDDEN_WORDS : 'Could not load this student';
  $('#detail-body').replaceChildren(el('p', { class: 'muted', text: reply.status === 404 ? 'This student is no longer on the allowlist.' : 'TAi could not make the page just now. Close this and try again.' }));
}

function closeDetail() {
  const dialog = $('#detail');
  if (dialog.open) dialog.close();
}

// ---------------------------------------------------------------- the whole

function renderFiltered() {
  renderAttention();
  renderHeat();
  renderMisconceptions();
  renderPatrol();
  renderQuick();
  renderVoice();
  renderStudents();
}

function renderAll() {
  renderStamp();
  renderNotes();
  renderCards();
  renderFiltered();
}

function wire() {
  let timer = 0;
  $('#filter').addEventListener('input', (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.filter = event.target.value;
      if (state.data) renderFiltered();
    }, 140);
  });
  $('#staff').addEventListener('change', (event) => {
    state.staff = event.target.checked;
    state.data = null;
    load();
  });
  $('#order').addEventListener('change', (event) => {
    state.order = event.target.value;
    if (state.data) renderHeat();
  });
  $('#csv').addEventListener('click', () => state.data && downloadCsv());
  $('#quick-min').addEventListener('change', (event) => {
    state.quick = { ...state.quick, min: event.target.checked ? 2 : 1 };
    if (state.data) renderQuick();
  });
  $('#refresh').addEventListener('click', load);
  $('#retry').addEventListener('click', load);
  $('#theme').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    applyTheme(next);
    storage('set', 'tai.theme', next);
  });
  const heat = $('#heat');
  heat.addEventListener('mouseover', (event) => {
    const cell = event.target.closest('td.cell');
    if (cell) inspect(cell);
  });
  heat.addEventListener('click', (event) => {
    const cell = event.target.closest('td.cell');
    if (cell) return inspect(cell);
    const header = event.target.closest('th.stu');
    if (header && state.data) openDetail(state.data.students[Number(header.dataset.s)].id, header);
  });
  const dialog = $('#detail');
  $('#detail-close').addEventListener('click', closeDetail);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDetail();                   // a click on the dark around it
  });
  dialog.addEventListener('close', () => {
    detailId++;
    if (detailOpener && detailOpener.isConnected) detailOpener.focus();
    detailOpener = null;
  });
}

function start() {
  applyTheme(storage('get', 'tai.theme'));
  wire();
  load();
}

if (typeof document !== 'undefined') start();
