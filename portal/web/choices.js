// Options a student can tap: a multiple-choice question TAi asks (a quick check of something they have learned), or a few ways to answer a
// question it asks them (src/choices.ts on the server says what an option is). The question is the line's own text; the options ride on the
// same line as `choices` (two to six, each a letter and its words), and a line that is a quick check says `quiz`. The answer TAi marked is
// never in a line: the server grades a tap and says whether it was right (`correct`, only when TAi marked an answer).
// The pure parts are here (what a line's options are, how they stand, what the buttons look like, what copying gives, what a tap says), tested
// by choices.test.js; createChoices draws the buttons and repaints them in place, so a poll that redraws them never moves the focus. Everything
// the server sends goes on the page as text, never as HTML. docs/PORTAL.md, "Options and quick checks", says what each part does.

const SVG_NS = 'http://www.w3.org/2000/svg';
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
const LABELS = 'ABCDEF';

const flat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * The options of a line of TAi's, as the page may draw them: two to six, each with its letter and its words; null when the line has none (or
 * what it has is not a list of options: fewer than two or more than six, an option with no words).
 */
export function optionsOf(entry) {
  if (!entry || typeof entry !== 'object' || entry.role === 'user' || (entry.kind && entry.kind !== 'text')) return null;
  const list = entry.choices;
  if (!Array.isArray(list) || list.length < MIN_OPTIONS || list.length > MAX_OPTIONS) return null;
  const options = list.map((option, i) => ({
    label: option && typeof option.label === 'string' && /^[A-F]$/.test(option.label) ? option.label : LABELS[i],
    text: flat(option && typeof option.text === 'string' ? option.text : ''),
  }));
  return options.every((option) => option.text) ? options : null;
}

/** Whether a line is something said, which closes the options before it: the student's words or voice note, TAi's words or picture. */
const isSaid = (line) => (line.role === 'user' ? !line.kind || line.kind === 'text' || line.kind === 'audio' : !line.kind || line.kind === 'text' || line.kind === 'image');

/**
 * How the options of the line numbered `n` stand, from the lines the page holds (the server works it out the same way): `open` while nothing
 * has been said since; `answered` once a later line of the student's is a tap on it (`chosen` is the option, `correct` whether it was the
 * answer TAi marked, when TAi marked one); `closed` when something else has been said first. An emoji, a thumb, TAi's own emoji and the
 * cards of the activity list are not something said. `said` is true while a message of the student's is on its way and has no number yet.
 */
export function standOf(lines, n, { said = false } = {}) {
  const later = (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line.n === 'number' && line.n > n).sort((a, b) => a.n - b.n);
  for (const line of later) {
    if (line.role === 'user' && line.choice && line.choice.to === n) {
      const chosen = Number.isInteger(line.choice.index) ? line.choice.index : -1;
      return { state: 'answered', chosen, ...(typeof line.choice.correct === 'boolean' ? { correct: line.choice.correct } : {}) };
    }
    if (isSaid(line)) return { state: 'closed' };
  }
  return { state: said ? 'closed' : 'open' };
}

/** What a verdict is called, for the eye and for a screen reader ('' when TAi marked no answer: a pick is only a pick). */
export const verdictOf = (correct) => (correct === true ? 'Correct' : correct === false ? 'Not quite' : '');

/**
 * What the buttons look like. `stand` is standOf's answer; `local` is what only this page knows: `picked` (the option just tapped, whose answer
 * is on its way) and `closed` (the server said it could not take the tap: something had been said that the page had not heard of yet).
 * Returns the phase (`open`, `pending`, `answered`, `closed`), the state of each button (`open`, `pending`, `right`, `wrong`, `chosen`, `dim`,
 * `closed`), whether they are all off, and the verdict to say. A wrong pick never shows which one was right: the others are only dimmed.
 */
export function viewOf(options, stand, local = {}) {
  const count = options.length;
  const all = (state) => Array.from({ length: count }, () => state);
  if (stand.state === 'answered' && stand.chosen >= 0 && stand.chosen < count) {
    const mark = stand.correct === true ? 'right' : stand.correct === false ? 'wrong' : 'chosen';
    return { phase: 'answered', disabled: true, states: all('dim').map((state, i) => (i === stand.chosen ? mark : state)), verdict: verdictOf(stand.correct), chosen: stand.chosen };
  }
  if (stand.state === 'open' && Number.isInteger(local.picked) && local.picked >= 0 && local.picked < count) {
    return { phase: 'pending', disabled: true, states: all('dim').map((state, i) => (i === local.picked ? 'pending' : state)), verdict: '', chosen: local.picked };
  }
  if (stand.state !== 'open' || local.closed) return { phase: 'closed', disabled: true, states: all('closed'), verdict: '' };
  return { phase: 'open', disabled: false, states: all('open'), verdict: '' };
}

/** What copying such a message gives: the question, then the options as lines, "A. ...". */
export function copyTextOf(entry, options) {
  const lines = options.map((option) => `${option.label}. ${option.text}`);
  const question = String(entry && entry.text ? entry.text : '').trim();
  return question ? `${question}\n\n${lines.join('\n')}` : lines.join('\n');
}

/** What a tap says as the student's own message: the letter and the option, as the server records it (the page shows it at once, and the poll's line matches it). */
export const tapText = (option) => `${option.label}. ${option.text}`;

function icon(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const MARKS = { right: ['M5 12.5l4.5 4.5L19 7.5'], wrong: ['M7 7l10 10', 'M17 7 7 17'] };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The buttons of a line's options, for the inside of TAi's bubble. `onPick(index)` is told of a tap on a button that is on. `paint(view)` sets
 * the look and the state of every button in place (viewOf's answer), so nothing is rebuilt and the focus stays where it is: a button that has
 * it is only marked off (`aria-disabled`), the others are disabled. `announce(text)` says a verdict politely.
 */
export function createChoices(entry, options, { onPick }) {
  const wrap = el('div', 'choices');
  if (entry.quiz === true) wrap.append(el('p', 'choices-label', 'Quick check'));
  const list = el('div', 'choices-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Options');
  const buttons = options.map((option, index) => {
    const button = el('button', 'choice');
    button.type = 'button';
    button.dataset.index = String(index);
    button.dataset.state = 'open';
    button.append(el('span', 'choice-chip', option.label), el('span', 'choice-text', option.text), el('span', 'choice-mark'));
    button.addEventListener('click', () => {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return;
      onPick(index);
    });
    list.append(button);
    return button;
  });
  const live = el('span', 'sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  wrap.append(list, live);
  let phase = 'open';
  return {
    node: wrap,
    buttons,
    phase: () => phase,
    paint(view) {
      phase = view.phase;
      wrap.dataset.phase = view.phase;
      list.setAttribute('aria-busy', String(view.phase === 'pending'));
      buttons.forEach((button, i) => {
        const state = view.states[i];
        const keepsFocus = button === document.activeElement;
        button.dataset.state = state;
        button.disabled = view.disabled && !keepsFocus;                // the one the focus is on stays reachable (it only says it is off)
        button.setAttribute('aria-disabled', String(view.disabled));
        if (state === 'right' || state === 'wrong' || state === 'chosen' || state === 'pending') button.setAttribute('aria-current', 'true');       // "your answer"
        else button.removeAttribute('aria-current');
        const mark = button.querySelector('.choice-mark');
        // the tick and the cross have their words for a screen reader too, so one that comes to the option after a reload still hears if it was right
        const said = state === 'right' ? verdictOf(true) : state === 'wrong' ? verdictOf(false) : '';
        mark.replaceChildren(...(MARKS[state] ? [icon(MARKS[state])] : []), ...(said ? [el('span', 'sr-only', said)] : []));
      });
    },
    announce(text) {
      live.textContent = '';
      live.textContent = text;
    },
  };
}
