// The card of a run of the student's code (a chat object of type 'run': docs/CHAT_OBJECTS.md, docs/RUN_CARDS.md). The host leaves one in the chat for every run that happened (src/sandbox/run-card.ts):
// the command, how it ended, how long it took, and what the program printed, as a small terminal. It registers on import (objects.js); app.js imports it.
//
// Everything on the card is DOM built from text (the renderer's `el` and `append` with strings): nothing the program printed is ever markup. The line numbers are their own column, not text of the
// output, so that a selection and a copy never carry them; a few lines of `go test` output are coloured by a classifier of a line each (the words are the signal, the colour only helps); the output is
// folded to its first FOLD_LINES lines with a button for the rest; the Copy button copies the output as it is.
//
// What the student selects in the output is part of the view (docs/CHAT_OBJECTS.md, "The view"): the lines of it, as `obj: { n, lines: [a, b] }`, numbered the way the host numbers them (the output split at
// its line breaks, the first line 1). One listener of the page's selectionchange serves every card; it reports once the selection has stopped changing, and takes its report back when the selection
// empties or leaves the card (and only its own: a chart card may have set `obj` since). askhere.js asks `runSelectionOf` for the same selection to offer "Ask TAi".
//
// The pure parts (the line classifier, the badge, the duration, the line range of a selection) are exported and tested in runcard.test.js; the DOM is checked in a browser.
import { registerObject } from './objects.js';

/** The output is shown folded to this many lines until the student asks for the rest. */
export const FOLD_LINES = 24;
/** The view keeps a line range only when it is under this many lines long (src/chat-objects/view.ts parseViewState): a longer selection is cut to it. */
export const MAX_SELECTED_LINES = 400;
/** The most of the selected lines "Ask TAi" quotes (the host reads at most 600 characters of them too). */
export const QUOTE_CHARS = 600;
/** A selection is reported once it has been still for this long (a drag over lines is one report, not forty). */
export const SETTLE_MS = 300;
const COPIED_MS = 1600;

// ---------------------------------------------------------------- the pure parts

/** One line of text for a header or a label: control, format and line-separator characters are spaces, white space is single, at most `max` characters. */
function oneLine(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The lines of an output as the host numbers them (src/chat-objects/view.ts runLines): split at the line breaks, the first line 1. Nothing printed is no lines. */
export function outputLines(output) {
  return typeof output === 'string' && output !== '' ? output.split('\n') : [];
}

const PASS_LINE = /^(?:ok\s+\S|PASS\b|--- PASS\b)/;
const FAIL_LINE = /^(?:FAIL\b|--- FAIL\b|panic:|fatal error:|WARNING: DATA RACE\b)/;

/**
 * 'pass', 'fail' or '' for one line of `go test` output: `ok  pkg 0.01s`, `PASS` and `--- PASS` are green; `FAIL`, `--- FAIL` and `panic:` are red, and so are Go's `fatal error:` and the race
 * detector's `WARNING: DATA RACE`; the rest is plain. Leading white space does not matter (a subtest's line is indented).
 */
export function classifyLine(text) {
  const line = String(text).trimStart();
  if (FAIL_LINE.test(line)) return 'fail';
  if (PASS_LINE.test(line)) return 'pass';
  return '';
}

/** What the badge says and its tone. The words are always there: the colour is never the only signal. */
export function badgeOf(obj) {
  if (!obj || obj.ok !== true) return { text: 'did not run', tone: 'idle' };
  if (obj.timedOut === true) return { text: 'timed out', tone: 'warn' };
  if (obj.exitCode === 0) return { text: 'exit 0', tone: 'ok' };
  if (typeof obj.exitCode === 'number') return { text: `exit ${obj.exitCode}`, tone: 'fail' };
  return { text: 'stopped', tone: 'warn' };
}

/** How long a run took, for the header: `0.4 s`, `1.2 s`, `14 s`, `1 min 5 s`; nothing when the card has no time. */
export function durationLabel(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const tenths = Math.round(ms / 100) / 10;
  if (tenths < 10) return `${tenths.toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** How many lines are shown: all of them, or the first FOLD_LINES. */
export const shownLines = (total, expanded) => (expanded ? total : Math.min(total, FOLD_LINES));

export const foldable = (total) => total > FOLD_LINES;

/** The words on the button that unfolds the output. */
export const showAllLabel = (total) => `Show all ${total} lines`;

/**
 * The lines, 1-based and inclusive, that a selection covers, from the characters it holds: `from` and `to` are offsets into `text` (the shown output, its lines joined by one line break), `to` the
 * offset after the last selected character. The line breaks at either end of a selection hold no line of their own (a triple click ends at the start of the next line, a drag may begin at the end of
 * one), so they do not count. A span over MAX_SELECTED_LINES lines is cut to it. null when no character of a line is selected.
 */
export function linesOfOffsets(text, from, to) {
  if (typeof text !== 'string' || text === '' || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  let start = Math.max(0, Math.min(Math.trunc(from), text.length));
  let end = Math.max(0, Math.min(Math.trunc(to), text.length));
  while (start < end && text[start] === '\n') start++;
  while (end > start && text[end - 1] === '\n') end--;
  if (end <= start) return null;
  const breaksBefore = (index) => {
    let count = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) count++;
    return count;
  };
  const a = 1 + breaksBefore(start);
  const b = 1 + breaksBefore(end - 1);
  return [a, Math.min(b, a + MAX_SELECTED_LINES - 1)];
}

/** The selected lines as words to quote: the lines themselves, at most QUOTE_CHARS characters of them. */
export function quoteOfLines(lines, a, b) {
  const text = lines.slice(a - 1, b).join('\n');
  return text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS - 1).trimEnd()}…` : text;
}

// ---------------------------------------------------------------- the selection, in a browser

/** What each card on the page holds that a selection needs: its chat line, its lines, and the element its text is in. */
const cards = new WeakMap();

const elementOf = (node) => (node && node.nodeType === 1 ? node : node && node.parentElement) || null;

/** The character offset of a boundary point of a range inside `code`, counted in the characters `code` holds (its text nodes' data). */
function offsetIn(code, container, offset) {
  const upTo = document.createRange();
  upTo.setStart(code, 0);
  upTo.setEnd(container, offset);
  return upTo.toString().length;
}

/**
 * The lines of a run card that a selection covers, or null when it is not in one: `{ n, a, b, text, command }` (the card's line of the chat, the lines, their text for a quotation, and the
 * card's command). A selection that starts before the output and ends in it, or the other way round, counts from the edge of the output; one that is not inside a single card is none.
 */
export function runSelectionOf(selection) {
  try {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const card = elementOf(range.commonAncestorContainer)?.closest('.runcard');
    const held = card ? cards.get(card) : undefined;
    if (!held || !held.code.isConnected) return null;
    const { code, lines, shown } = held.view();
    const probe = document.createRange();
    probe.selectNodeContents(code);
    // the selection must hold something of the output: it starts before the output's end and ends after its start
    if (range.compareBoundaryPoints(Range.END_TO_START, probe) >= 0 || range.compareBoundaryPoints(Range.START_TO_END, probe) <= 0) return null;
    const text = lines.slice(0, shown).join('\n');
    const from = range.compareBoundaryPoints(Range.START_TO_START, probe) > 0 ? offsetIn(code, range.startContainer, range.startOffset) : 0;
    const to = range.compareBoundaryPoints(Range.END_TO_END, probe) < 0 ? offsetIn(code, range.endContainer, range.endOffset) : text.length;
    const found = linesOfOffsets(text, from, to);
    if (!found) return null;
    return { n: held.n, a: found[0], b: found[1], text: quoteOfLines(lines, found[0], found[1]), command: held.command };
  } catch {
    return null;
  }
}

/**
 * What reports the lines a student selected in a card to the shared view. `find()` answers what is selected now (`runSelectionOf`'s answer: `{ n, a, b }` or null) and `changed()` is told of every
 * change of the browser's selection: it reports once the selection has been still for SETTLE_MS, and when the selection has emptied or left the card it takes the report back, but only if `obj`
 * is still the one it set (a chart or a trace card may have set its own since: batch C).
 */
export function createReporter({ view, find, setTimer = setTimeout, clearTimer = clearTimeout, settleMs = SETTLE_MS }) {
  /** The chat line of the card this last reported lines of. */
  let reported = null;
  let timer = null;
  const report = () => {
    timer = null;
    let found = null;
    try {
      found = find();
    } catch {
      found = null;
    }
    if (found) {
      reported = found.n;
      view.set({ obj: { n: found.n, lines: [found.a, found.b] } });
      return;
    }
    if (reported === null) return;
    const current = view.get().obj;
    if (current && current.n === reported && current.lines) view.set({ obj: null });
    reported = null;
  };
  return {
    changed() {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(report, settleMs);
    },
  };
}

/** The one listener of the page's selection for every card: set up when the first card is drawn, with the shared view. */
let watching = false;
function watchSelection(view) {
  if (watching || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  watching = true;
  const reporter = createReporter({ view, find: () => runSelectionOf(typeof getSelection === 'function' ? getSelection() : null) });
  document.addEventListener('selectionchange', () => reporter.changed());
}

// ---------------------------------------------------------------- the card

/** Copies text, with the clipboard API where the page may use it and a hidden box otherwise. Whether it worked. */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const box = document.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.append(box);
      box.select();
      const done = document.execCommand('copy');
      box.remove();
      return done;
    } catch {
      return false;
    }
  }
}

/** Puts `parts` in `node` a few hundred at a time (a long output is thousands of children, and a call takes them as arguments). */
function fill(node, parts) {
  node.textContent = '';
  for (let i = 0; i < parts.length; i += 500) node.append(...parts.slice(i, i + 500));
}

registerObject('run', (entry, h) => {
  const obj = entry && entry.obj && typeof entry.obj === 'object' ? entry.obj : {};
  const lines = outputLines(obj.output);
  const badge = badgeOf(obj);
  const command = oneLine(obj.command, 200) || 'go';
  const duration = durationLabel(obj.durationMs);
  const note = oneLine(obj.note, 300);
  const when = Date.parse(entry && entry.ts);

  const node = h.el('div', 'runcard');
  node.dataset.n = String(entry && entry.n);
  node.dataset.tone = badge.tone;
  // The conversation is a polite live region that reads out what is added to it: a card is not read out line by line as it arrives (its words are in the chat history, and TAi says what it showed),
  // the way a spoken line of a call is not either. The region of the output and the buttons are found by moving through the page; the Copy button's own status below is still said.
  node.setAttribute('aria-live', 'off');

  // the header: the command, how it ended (words first), how long it took (the time of day it ran is its tooltip)
  const head = h.el('div', 'rc-head');
  const cmd = h.el('code', 'rc-cmd', command);
  cmd.title = command;
  const mark = h.el('span', 'rc-badge', badge.text);
  mark.dataset.tone = badge.tone;
  head.append(cmd, mark);
  if (duration) {
    const took = h.el('span', 'rc-time', duration);
    if (Number.isFinite(when) && typeof h.fullTime === 'function') took.title = h.fullTime(when);
    head.append(took);
  }
  node.append(head);

  // the output: numbered lines in a region the keyboard can reach and scroll
  let expanded = false;
  let nums = null;
  let code = null;
  let fold = null;
  if (lines.length > 0) {
    const body = h.el('div', 'rc-body');
    body.tabIndex = 0;
    body.setAttribute('role', 'region');
    body.setAttribute('aria-label', `Output of ${command}, ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`);
    const grid = h.el('div', 'rc-grid');
    nums = h.el('div', 'rc-nums');
    nums.setAttribute('aria-hidden', 'true');
    code = h.el('pre', 'rc-code');
    grid.append(nums, code);
    body.append(grid);
    node.append(body);
  } else {
    // (a run that did not happen has the host's sentence for a reason, and that is what stands here; the words say nothing was run only when there is no sentence)
    if (obj.ok === true) node.append(h.el('p', 'rc-empty', 'The program printed nothing.'));
    else if (!note) node.append(h.el('p', 'rc-empty', 'Nothing was run.'));
  }
  if (note) node.append(h.el('p', 'rc-note', note));

  const draw = () => {
    if (!code) return;
    const shown = shownLines(lines.length, expanded);
    const parts = [];
    for (let i = 0; i < shown; i++) {
      const kind = classifyLine(lines[i]);
      parts.push(h.el('span', kind ? `rc-line rc-${kind}` : 'rc-line', lines[i]));
      if (i < shown - 1) parts.push('\n');
    }
    fill(code, parts);
    nums.textContent = Array.from({ length: shown }, (_, i) => String(i + 1)).join('\n');
    if (fold) {
      fold.textContent = expanded ? `Show the first ${FOLD_LINES} lines` : showAllLabel(lines.length);
      fold.setAttribute('aria-expanded', String(expanded));
    }
    node.dataset.folded = String(foldable(lines.length) && !expanded);
  };

  // the foot: the rest of the output, and Copy
  if (lines.length > 0) {
    const foot = h.el('div', 'rc-foot');
    if (foldable(lines.length)) {
      fold = h.el('button', 'rc-btn rc-fold', showAllLabel(lines.length));
      fold.type = 'button';
      fold.setAttribute('aria-expanded', 'false');
      fold.addEventListener('click', () => {
        expanded = !expanded;
        draw();
      });
      foot.append(fold);
    }
    const copy = h.el('button', 'rc-btn rc-copy', 'Copy');
    copy.type = 'button';
    copy.setAttribute('aria-label', `Copy the output of ${command}`);
    const status = h.el('span', 'sr-only');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    let back = null;
    copy.addEventListener('click', async () => {
      const done = await copyToClipboard(obj.output);
      copy.textContent = done ? 'Copied' : 'Press Ctrl+C';
      status.textContent = done ? 'Copied the output' : 'Could not copy: select the output and press Ctrl+C';
      if (!done && code && typeof getSelection === 'function') {
        const selection = getSelection();
        if (selection) selection.selectAllChildren(code);
      }
      if (back !== null) clearTimeout(back);
      back = setTimeout(() => {
        copy.textContent = 'Copy';
        status.textContent = '';
        back = null;
      }, COPIED_MS);
    });
    foot.append(copy, status);
    node.append(foot);
    draw();
    cards.set(node, {
      n: Number(entry.n),
      command,
      code,
      view: () => ({ code, lines, shown: shownLines(lines.length, expanded) }),
    });
    if (h.view && typeof h.view.set === 'function' && typeof h.view.get === 'function') watchSelection(h.view);
  }

  // A copy of what is selected in the card is the text of the selection and nothing else: the numbers are not text of the output (user-select: none keeps them out of a selection), but a browser's
  // copy can carry the card's markup too, and a paste into an editor must not bring the numbers with it.
  node.addEventListener('copy', (event) => {
    try {
      const selection = typeof getSelection === 'function' ? getSelection() : null;
      const text = selection ? selection.toString() : '';
      if (!text || !event.clipboardData) return;
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    } catch {
      /* the browser's own copy goes ahead */
    }
  });

  return { node, text: entry && entry.text };
});
