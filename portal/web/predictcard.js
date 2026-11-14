// The prediction card (a chat object of type 'predict': docs/CHAT_OBJECTS.md, docs/PREDICT.md): "what will this print? guess, then run it". TAi puts a small Go program in the chat; the student reads it,
// makes a guess (picks an option, or types one line) and only then presses Run. The Run button stays disabled until there is a guess: the gap between the guess and what the program prints is the lesson.
// Pressing Run asks the server (POST api/predict/run { n, guess }): the browser never sends code, the server runs the card's own program in the sandbox and leaves the student's guess and a run card in
// the chat. The card then shows what was guessed and a short line of what happened, and says nothing about right or wrong: TAi talks that over with the student. The card stays as a record.
//
// It registers on import (objects.js); app.js imports it. Everything on it is DOM built from text: nothing the model wrote (the question, the program, the options) or the program printed is ever markup.
// A card that already ran when the page loaded (a reload, a second tab) asks the server (GET api/predict/state, one request for all the cards drawn in the same moment) and draws as ran.
// A run can take up to a minute (it waits in the sandbox's queue): the card says "Running" politely, and when the answer does not come back (a proxy that gave up, a lost connection) it asks the server
// what became of the run instead of guessing.
//
// The pure parts (the guess's validity, the folding, the result line, the button's state, the phases, the plain words for a refusal, the batching of the state requests) are exported and tested in
// predictcard.test.js, and the card itself is built there into a small stand-in for the DOM; how it looks is checked in a browser (docs/PREDICT.md).
import { registerObject } from './objects.js';
import { tokenize } from './highlight.js';

/** The program is shown folded to this many lines (all the files together) until the student asks for the rest. */
export const FOLD_LINES = 24;
/** The longest guess: the server takes no more (src/portal/predict-routes.ts PREDICT_GUESS_MAX), and the text field has the same maxlength. */
export const GUESS_MAX = 200;
/** While a run is going the card asks the server what became of it this often, this many times at most (about two minutes). */
export const POLL_MS = 3000;
export const POLL_TRIES = 40;
/** The page gives up on an answer that has not come back after this long and asks the server instead (a run is over within about a minute). */
export const RUN_TIMEOUT_MS = 100_000;
/** At most this many cards are asked about in one request (the server takes 20). */
export const STATE_BATCH = 20;

export const RUN_NOTE = 'Running it uses one of your code runs.';
export const NEED_GUESS = 'Make a guess to unlock Run: the gap between your guess and what it prints is the lesson.';
export const NEED_CHOICE = 'Pick one to unlock Run: the gap between your guess and what it prints is the lesson.';

// ---------------------------------------------------------------- the pure parts

/** One line of text for a label: control, format and line-separator characters are spaces, white space is single, at most `max` characters. */
export function oneLine(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** What the student typed as one line the server will take: control characters are spaces, white space is single, nothing at either end. */
export function normalizeGuess(raw) {
  return typeof raw === 'string' ? raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim() : '';
}

/** '' when the guess can be sent, else why not: 'empty', 'long' (over GUESS_MAX characters) or 'not-a-choice' (the card has options and this is none of them). */
export function guessProblem(raw, choices) {
  const guess = normalizeGuess(raw);
  if (!guess) return 'empty';
  if (guess.length > GUESS_MAX) return 'long';
  if (Array.isArray(choices) && choices.length > 0 && !choices.includes(guess)) return 'not-a-choice';
  return '';
}

export const guessReady = (raw, choices) => guessProblem(raw, choices) === '';

/** What the field asks: a program that prints, or a test that passes or fails. */
export const guessPrompt = (action) => (action === 'test' ? 'Will it pass? What will it say?' : 'What do you think it prints?');

/** The card as the page draws it, from whatever the history line holds: every part bounded, anything that is not text left out. */
export function cleanCard(obj) {
  const source = obj && typeof obj === 'object' ? obj : {};
  const action = source.action === 'test' ? 'test' : 'run';
  const files = (Array.isArray(source.files) ? source.files : [])
    .slice(0, 6)
    .filter((f) => f && typeof f === 'object' && typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({ path: oneLine(f.path, 80) || 'main.go', content: f.content.slice(0, 6000) }));
  const options = (Array.isArray(source.choices) ? source.choices : []).slice(0, 6).map((c) => oneLine(c, 80)).filter(Boolean);
  return {
    question: oneLine(source.question, 300),
    action,
    pkg: oneLine(source.pkg, 80) || (action === 'test' ? './...' : '.'),
    files,
    choices: options.length >= 2 ? options : [],
  };
}

/** The command the program runs as, in the host's words (src/sandbox/types.ts commandLine). */
export const commandOf = (card) => `go ${card.action} ${card.pkg}`;

/** The lines of a file as the card shows them: the newline that ends a file is not a line of its own. */
export function codeLines(content) {
  const lines = (typeof content === 'string' ? content.replace(/\r\n?/g, '\n') : '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export const totalLines = (files) => files.reduce((sum, f) => sum + codeLines(f.content).length, 0);

export const foldable = (files) => totalLines(files) > FOLD_LINES;

/** The words on the button that unfolds the program. */
export const showAllLabel = (total) => `Show all ${total} lines`;

/** How many lines of each file are shown: all of them, or the first FOLD_LINES of the program (the files together, in order). */
export function foldPlan(files, expanded, limit = FOLD_LINES) {
  let room = expanded ? Infinity : limit;
  return files.map((f) => {
    const total = codeLines(f.content).length;
    const shown = Math.min(total, room);
    room -= shown;
    return { path: f.path, total, shown };
  });
}

/** The short line of what happened, from the server's answer: its own words when it gave some, else made from the exit code. It never says a guess was right or wrong. */
export function resultLine(action, answer) {
  const given = answer && typeof answer.summary === 'string' ? oneLine(answer.summary, 240) : '';
  if (given) return given;
  if (answer && answer.timedOut === true) return 'It was stopped at the time limit.';
  const code = answer && typeof answer.exitCode === 'number' ? answer.exitCode : null;
  if (action === 'test') return code === 0 ? 'It passed.' : code === null ? 'It ran.' : 'It failed.';
  return code === null || code === 0 ? 'It ran.' : `It stopped with exit code ${code}.`;
}

/**
 * What the Run button looks like: `disabled` (a real disabled button, so it is skipped by the keyboard until there is a guess), `busy` (a run is going: the button keeps the focus and is only
 * said to be disabled), and its words. `ready` is whether there is a guess the server will take; `blocked` is a card that cannot be run any more.
 */
export function buttonState({ phase, ready, blocked }) {
  if (phase === 'running') return { disabled: true, busy: true, label: 'Running…' };
  if (phase === 'ran') return { disabled: true, busy: false, label: 'Done' };
  return { disabled: !ready || blocked === true, busy: false, label: 'Run it' };
}

/** The phases of a card: `asking` (no run yet), `running`, `ran` (the end: a card runs once) and `refused` (a press that ended without a run; the student may press again). */
export function nextPhase(phase, event) {
  if (phase === 'ran') return 'ran';
  if (event === 'press' || event === 'running') return 'running';
  if (event === 'ran') return 'ran';
  if (event === 'refused') return 'refused';
  return phase;
}

/** The plain words for a refusal (the server's `message` is the same sentence: the page has its own for when no message came). */
export const REFUSAL_WORDS = {
  'bad-request': 'That request was not understood. Reload the page and try again.',
  'bad-guess': 'Make a guess first: one line, at most 200 characters.',
  'not-found': 'This prediction is not in your chat any more, so it cannot be run.',
  running: 'This one is already running. Its answer will show here.',
  going: 'Another run of yours is still going. Wait for it to finish, then press Run.',
  off: 'Running code is not set up on this server yet.',
  busy: 'The sandbox is busy with other runs right now. Try again in a minute.',
  limit: 'You have used all the code runs you get for now. Try again later.',
  failed: 'The sandbox could not run it this time. That was the sandbox, not your guess: try again in a minute.',
  refused: 'The sandbox would not accept this program, so it cannot be run.',
  unsaved: 'It ran, but the chat could not keep the result. Try again in a minute.',
  session: 'Your session has ended. Reload the page and sign in again.',
  forbidden: 'The page was not allowed to do that. Reload it and sign in again.',
  'rate-limited': 'That was too many requests in a short time. Wait a moment and try again.',
  lost: 'The run did not finish and nothing was recorded, so you can press Run again.',
  slow: 'This is taking longer than it should. Reload the page to see whether it finished.',
  offline: 'The page could not reach the server. Check your connection, then press Run again.',
};

/**
 * What a failed press means, from the HTTP status and the JSON body (or none): `{ kind: 'refused', code, text, blocked }` for a refusal the server worded (`blocked` only for a card that is gone), or
 * `{ kind: 'unknown' }` for anything else (a lost connection, a proxy's page, a status with no JSON): then the card asks the server whether the run happened.
 */
export function failureOf(status, body) {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  const code = record && typeof record.error === 'string' ? record.error : '';
  const message = record && typeof record.message === 'string' ? oneLine(record.message, 300) : '';
  if (status === 401) return { kind: 'refused', code: 'session', text: REFUSAL_WORDS.session, blocked: false };
  if (status === 403) return { kind: 'refused', code: 'forbidden', text: REFUSAL_WORDS.forbidden, blocked: false };
  if (status === 429 && code === 'rate-limited') return { kind: 'refused', code, text: REFUSAL_WORDS['rate-limited'], blocked: false };
  if (code && typeof status === 'number' && status >= 400 && status <= 503) {
    return { kind: 'refused', code, text: message || REFUSAL_WORDS[code] || REFUSAL_WORDS.failed, blocked: code === 'not-found' };
  }
  return { kind: 'unknown' };
}

/**
 * Asks the server about cards in batches: every `load(n)` made in the same moment (the page draws a whole history in one go) goes out as one request. `get(numbers)` answers the server's `cards`
 * object (or throws); `load` answers that card's entry, or null when there was none or the request failed. `schedule(fn)` says when the batch goes out (the next tick).
 */
export function createStateLoader({ get, schedule = (fn) => setTimeout(fn, 0), batch = STATE_BATCH }) {
  let waiting = new Map();
  let scheduled = false;
  function flush() {
    scheduled = false;
    const taken = waiting;
    waiting = new Map();
    const numbers = [...taken.keys()];
    for (let i = 0; i < numbers.length; i += batch) {
      const part = numbers.slice(i, i + batch);
      Promise.resolve()
        .then(() => get(part))
        .then((cards) => {
          for (const n of part) for (const done of taken.get(n)) done(cards && typeof cards === 'object' && cards[n] && typeof cards[n] === 'object' ? cards[n] : null);
        })
        .catch(() => {
          for (const n of part) for (const done of taken.get(n)) done(null);
        });
    }
  }
  return {
    load(n) {
      return new Promise((resolve) => {
        const list = waiting.get(n);
        if (list) list.push(resolve);
        else waiting.set(n, [resolve]);
        if (!scheduled) {
          scheduled = true;
          schedule(flush);
        }
      });
    },
  };
}

// ---------------------------------------------------------------- the network (a browser)

const baseUrl = () => (typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://localhost/');

/** POST api/predict/run: `{ status, body }` (body null when it was not JSON), or `{ status: 0, body: null }` when there was no answer at all. */
async function postRun(n, guess) {
  try {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tai': '1' },
      body: JSON.stringify({ n, guess }),
      credentials: 'same-origin',
      cache: 'no-store',
    };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(RUN_TIMEOUT_MS);
    const res = await fetch(new URL('api/predict/run', baseUrl()).href, init);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

/** GET api/predict/state?n=...: the server's `cards` object. Throws when there was no usable answer. */
async function getState(numbers) {
  const res = await fetch(new URL(`api/predict/state?n=${numbers.join(',')}`, baseUrl()).href, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`state ${res.status}`);
  const body = await res.json();
  return body && typeof body === 'object' ? body.cards : null;
}

const realNet = { post: postRun, loader: createStateLoader({ get: getState }), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

// ---------------------------------------------------------------- the card

let counter = 0;

/** Puts `parts` in `node` a few hundred at a time (a call takes its children as arguments). */
function fill(node, parts) {
  node.textContent = '';
  for (let i = 0; i < parts.length; i += 500) node.append(...parts.slice(i, i + 500));
}

/** The runs of each line of a file, coloured for Go (the other kinds of file are plain), or plain text lines when the scanner has nothing. */
function scanFile(file) {
  const lines = codeLines(file.content);
  try {
    const runs = tokenize(file.path.endsWith('.go') ? 'go' : 'plain', lines.join('\n'));
    if (Array.isArray(runs) && runs.length >= lines.length) return runs;
  } catch {
    /* plain below */
  }
  return lines.map((line) => (line ? [['plain', line]] : []));
}

/**
 * The card for one history line. `h` is the page's helpers (`el` is what matters here); `net` is where the server is asked from (a browser by default, a stand-in in the tests):
 * `post(n, guess)` answers `{ status, body }`, `loader.load(n)` answers the card's state or null, `sleep(ms)` waits.
 */
export function buildCard(entry, h, net = realNet) {
  const n = Number(entry && entry.n);
  const card = cleanCard(entry && entry.obj);
  const id = `pc-${++counter}`;
  let phase = 'asking';
  let blocked = false;
  let guess = '';
  let expanded = false;
  let alive = true;
  let message = '';
  let watching = false;

  const node = h.el('div', 'predictcard');
  node.dataset.n = String(entry && entry.n);
  node.dataset.phase = phase;
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', `Prediction: ${card.question || 'what will this print?'}`);
  // the conversation is a polite live region that reads out what is added to it: the card is not read out as it arrives; its own status line below is what is said when something happens
  node.setAttribute('aria-live', 'off');

  const head = h.el('div', 'pc-head');
  head.append(h.el('span', 'pc-tag', 'Predict, then run'));
  if (card.question) head.append(h.el('p', 'pc-question', card.question));
  node.append(head);

  // the program: each file in turn with its name, numbered lines that are not part of the text, folded to the first FOLD_LINES
  const program = h.el('div', 'pc-program');
  const scans = card.files.map(scanFile);
  const files = h.el('div', 'pc-files');
  program.append(files);
  const foot = h.el('div', 'pc-foot');
  const command = h.el('span', 'pc-cmd', `Runs as ${commandOf(card)}`);
  let fold = null;
  if (foldable(card.files)) {
    fold = h.el('button', 'pc-btn pc-fold', showAllLabel(totalLines(card.files)));
    fold.type = 'button';
    fold.setAttribute('aria-expanded', 'false');
    fold.addEventListener('click', () => {
      expanded = !expanded;
      drawProgram();
    });
    foot.append(fold);
  }
  foot.append(command);
  program.append(foot);
  if (card.files.length > 0) node.append(program);

  function drawProgram() {
    const plan = foldPlan(card.files, expanded);
    const blocks = [];
    plan.forEach((part, index) => {
      if (part.shown === 0) return;
      const file = h.el('div', 'pc-file');
      const name = h.el('div', 'pc-fhead');
      name.append(h.el('span', 'pc-fname', part.path));
      const body = h.el('div', 'pc-body');
      body.tabIndex = 0;
      body.setAttribute('role', 'region');
      body.setAttribute('aria-label', `Code of ${part.path}, ${part.total} ${part.total === 1 ? 'line' : 'lines'}`);
      const grid = h.el('div', 'pc-grid');
      const nums = h.el('div', 'pc-nums');
      nums.setAttribute('aria-hidden', 'true');
      nums.textContent = Array.from({ length: part.shown }, (_, i) => String(i + 1)).join('\n');
      const code = h.el('pre', 'pc-code');
      const parts = [];
      for (let i = 0; i < part.shown; i++) {
        for (const [kind, text] of scans[index][i] || []) parts.push(kind === 'plain' ? text : h.el('span', `hl-${kind}`, text));
        if (i < part.shown - 1) parts.push('\n');
      }
      fill(code, parts);
      grid.append(nums, code);
      body.append(grid);
      file.append(name, body);
      blocks.push(file);
    });
    fill(files, blocks);
    if (fold) {
      fold.textContent = expanded ? `Show the first ${FOLD_LINES} lines` : showAllLabel(totalLines(card.files));
      fold.setAttribute('aria-expanded', String(expanded));
    }
    node.dataset.folded = String(foldable(card.files) && !expanded);
  }
  drawProgram();

  // the guess: options (real radio buttons in a fieldset with a legend) or one line of text (an input with its own label), and Run
  const ask = h.el('form', 'pc-ask');
  ask.setAttribute('novalidate', '');
  let field = null;
  const radios = [];
  let set;
  if (card.choices.length > 0) {
    set = h.el('fieldset', 'pc-set');
    set.append(h.el('legend', 'pc-legend', guessPrompt(card.action)));
    card.choices.forEach((choice, index) => {
      const label = h.el('label', 'pc-choice');
      const radio = h.el('input', 'pc-radio');
      radio.type = 'radio';
      radio.name = `${id}-guess`;
      radio.value = choice;
      radio.id = `${id}-c${index}`;
      radio.addEventListener('change', () => {
        guess = choice;
        update();
      });
      radios.push(radio);
      label.append(radio, h.el('span', 'pc-choice-text', choice));
      set.append(label);
    });
  } else {
    set = h.el('div', 'pc-set');
    field = h.el('input', 'pc-input');
    field.type = 'text';
    field.id = `${id}-guess`;
    field.maxLength = GUESS_MAX;
    field.autocomplete = 'off';
    field.spellcheck = false;
    field.setAttribute('autocapitalize', 'off');
    field.setAttribute('enterkeyhint', 'go');
    const label = h.el('label', 'pc-legend', guessPrompt(card.action));
    label.htmlFor = field.id;
    field.addEventListener('input', () => {
      guess = field.value;
      update();
    });
    set.append(label, field);
  }
  ask.append(set);

  const actions = h.el('div', 'pc-actions');
  const run = h.el('button', 'pc-run', 'Run it');
  run.type = 'submit';
  const note = h.el('p', 'pc-note', RUN_NOTE);
  const hint = h.el('p', 'pc-hint', card.choices.length > 0 ? NEED_CHOICE : NEED_GUESS);
  hint.id = `${id}-hint`;
  actions.append(run, note);
  ask.append(actions, hint);
  const msg = h.el('p', 'pc-msg');
  ask.append(msg);
  node.append(ask);

  const record = h.el('div', 'pc-record');
  record.tabIndex = -1;
  node.append(record);

  const status = h.el('span', 'sr-only');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  node.append(status);

  function update() {
    const ready = guessReady(guess, card.choices);
    const state = buttonState({ phase, ready, blocked });
    // the hint says why Run is disabled, and only then
    const needGuess = (phase === 'asking' || phase === 'refused') && !blocked && !ready;
    run.disabled = state.disabled && !state.busy;
    run.setAttribute('aria-disabled', String(state.disabled));
    run.setAttribute('aria-busy', String(state.busy));
    run.textContent = state.label;
    if (needGuess) run.setAttribute('aria-describedby', hint.id);
    else run.removeAttribute('aria-describedby');
    hint.hidden = !needGuess;
    msg.textContent = message;
    msg.hidden = message === '';
    ask.hidden = phase === 'ran';
    record.hidden = phase !== 'ran';
    node.dataset.phase = phase;
    // a field the student is typing in keeps the focus while the run goes (read-only, not disabled); radios are only set aside
    if (field) field.readOnly = phase === 'running' || blocked;
    for (const radio of radios) radio.disabled = phase === 'running' || blocked;
  }

  function say(text) {
    status.textContent = '';
    status.textContent = text;
  }

  function move(event) {
    phase = nextPhase(phase, event);
  }

  function showRan(answer) {
    move('ran');
    message = '';
    const mine = typeof answer.guess === 'string' && answer.guess ? oneLine(answer.guess, GUESS_MAX) : normalizeGuess(guess);
    const line = h.el('p', 'pc-guessed');
    line.append(h.el('span', 'pc-label', 'You guessed: '), h.el('span', 'pc-guess', mine));
    const result = h.el('p', 'pc-result', resultLine(card.action, answer));
    const rows = [line, result];
    rows.push(h.el('p', 'pc-after', answer.card === false ? 'The exact output could not be put in the chat.' : 'The exact output is in the run card in the chat.'));
    if (answer.told === false) rows.push(h.el('p', 'pc-after', 'TAi could not be reached just now: ask about it in the chat when you are ready.'));
    fill(record, rows);
    update();
    say(`You guessed ${mine}. ${resultLine(card.action, answer)}`);
    // the button the student pressed is gone: keep their place in the card instead of dropping the focus on the page
    try {
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (active && active !== document.body && node.contains(active) && typeof record.focus === 'function') record.focus({ preventScroll: true });
    } catch {
      /* the focus stays where the browser put it */
    }
  }

  function showRefused(text, opts = {}) {
    move('refused');
    if (opts.blocked) blocked = true;
    message = text;
    update();
    say(text);
  }

  function showRunning() {
    move('running');
    message = '';
    update();
    say('Running. This can take up to a minute.');
  }

  /** The run was started (by this page or another) and has not finished: ask the server until it has. */
  async function watch() {
    if (watching) return;
    watching = true;
    try {
      for (let i = 0; i < POLL_TRIES && alive; i++) {
        await net.sleep(POLL_MS);
        if (!alive) return;
        const found = await net.loader.load(n);
        if (!found) continue;                                                // no answer this time: try again
        if (found.state === 'ran') return showRan(found);
        if (found.state === 'new' || found.state === 'none') return showRefused(REFUSAL_WORDS.lost, { blocked: found.state === 'none' });
      }
      if (alive) showRefused(REFUSAL_WORDS.slow);
    } finally {
      watching = false;
    }
  }

  /** The press did not come back with an answer we can read: ask the server what became of the run. */
  async function recover() {
    const found = await net.loader.load(n);
    if (!alive) return;
    if (found && found.state === 'ran') return showRan(found);
    if (found && found.state === 'running') {
      showRunning();
      return watch();
    }
    showRefused(found ? REFUSAL_WORDS.lost : REFUSAL_WORDS.offline);
  }

  async function press() {
    const state = buttonState({ phase, ready: guessReady(guess, card.choices), blocked });
    if (state.disabled) return;
    const mine = normalizeGuess(guess);
    showRunning();
    const { status: code, body } = await net.post(n, mine);
    if (!alive) return;
    if (code === 200 && body && body.ok === true && body.ran === true) return showRan(body);
    const failed = failureOf(code, body);
    if (failed.kind === 'refused' && failed.code === 'running') {
      showRunning();
      return watch();
    }
    if (failed.kind === 'refused') return showRefused(failed.text, { blocked: failed.blocked });
    return recover();
  }

  ask.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    void press();
  });

  // a copy of what is selected is the text of the selection and nothing else: the numbers are not text of the program (user-select: none keeps them out), but a browser's copy can carry markup too
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

  update();
  // a card that ran before this page was drawn (a reload, a second tab), or is running now, says so
  void Promise.resolve(Number.isInteger(n) && n > 0 ? net.loader.load(n) : null).then((found) => {
    if (!alive || !found || phase !== 'asking') return;
    if (found.state === 'ran') showRan(found);
    else if (found.state === 'running') {
      showRunning();
      void watch();
    } else if (found.state === 'none') showRefused(REFUSAL_WORDS['not-found'], { blocked: true });
  });

  return { node, destroy: () => { alive = false; }, press, state: () => ({ phase, guess, message, blocked }) };
}

registerObject('predict', (entry, h) => {
  const built = buildCard(entry, h);
  return { node: built.node, text: entry && entry.text, destroy: built.destroy };
});
