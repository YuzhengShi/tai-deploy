// The prediction card: the pure parts (the guess's validity, the folding, the result line, the button's state, the phases, the plain words for a refusal, the batching of the state requests), and the
// card itself built into a small stand-in for the DOM (what it holds, that Run waits for a guess, what a press does in each way it can end, what a reload shows, that nothing the model wrote or the
// program printed becomes markup). How it looks, with a keyboard and at phone width, is checked in a browser (docs/PREDICT.md).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PREDICT_WORDS } from '../../src/portal/predict-routes.ts';
import { objectRow, setObjectHelpers } from './objects.js';
import {
  FOLD_LINES,
  GUESS_MAX,
  NEED_CHOICE,
  NEED_GUESS,
  POLL_TRIES,
  REFUSAL_WORDS,
  RUN_NOTE,
  STATE_BATCH,
  buildCard,
  buttonState,
  cleanCard,
  codeLines,
  commandOf,
  createStateLoader,
  failureOf,
  foldPlan,
  foldable,
  guessPrompt,
  guessProblem,
  guessReady,
  nextPhase,
  normalizeGuess,
  oneLine,
  resultLine,
  showAllLabel,
  totalLines,
} from './predictcard.js';

// ---------------------------------------------------------------- the pure parts

describe('the guess', () => {
  it('is one line: control and line-separator characters are spaces, white space is single, nothing at the ends', () => {
    expect(oneLine('  a\tb\nc  ', 10)).toBe('a b c');
    expect(oneLine('x'.repeat(20), 10)).toBe('xxxxxxxxx…');
    expect(oneLine(7, 10)).toBe('');
    expect(normalizeGuess('  4\n')).toBe('4');
    expect(normalizeGuess('a' + String.fromCharCode(0x2028) + 'b' + String.fromCharCode(0x200b) + 'c')).toBe('a b c');
    expect(normalizeGuess(undefined)).toBe('');
  });

  it('can be sent when it is not empty, at most GUESS_MAX characters, and one of the options when there are some', () => {
    expect(GUESS_MAX).toBe(200);
    expect(guessProblem('')).toBe('empty');
    expect(guessProblem('  \t ')).toBe('empty');
    expect(guessProblem(undefined)).toBe('empty');
    expect(guessProblem('x'.repeat(200))).toBe('');
    expect(guessProblem('x'.repeat(201))).toBe('long');
    expect(guessProblem('4', [])).toBe('');
    expect(guessProblem('4', ['4', '22'])).toBe('');
    expect(guessProblem(' 22 ', ['4', '22'])).toBe('');
    expect(guessProblem('5', ['4', '22'])).toBe('not-a-choice');
    expect(guessReady('4')).toBe(true);
    expect(guessReady('', ['4', '22'])).toBe(false);
  });

  it('is asked for in the words of a program that prints or a test that passes', () => {
    expect(guessPrompt('run')).toBe('What do you think it prints?');
    expect(guessPrompt('test')).toBe('Will it pass? What will it say?');
  });
});

describe('the card as the page draws it', () => {
  it('is bounded and made of text: six files of 6000 characters, options only when there are two or more, defaults for what is missing', () => {
    const card = cleanCard({
      question: '  What  prints?\n',
      action: 'test',
      pkg: '',
      files: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.go`, content: 'x'.repeat(7000) })).concat([{ path: 5, content: 'no' }, null, 'text']),
      choices: ['one'],
    });
    expect(card.question).toBe('What prints?');
    expect(card).toMatchObject({ action: 'test', pkg: './...', choices: [] });
    expect(card.files).toHaveLength(6);
    expect(card.files.every((f) => f.content.length === 6000)).toBe(true);
    expect(cleanCard({ choices: ['a', 'b', '', 'c'] }).choices).toEqual(['a', 'b', 'c']);
    expect(cleanCard({ choices: Array.from({ length: 9 }, (_, i) => `o${i}`) }).choices).toHaveLength(6);
    expect(cleanCard(null)).toEqual({ question: '', action: 'run', pkg: '.', files: [], choices: [] });
    expect(commandOf({ action: 'run', pkg: '.' })).toBe('go run .');
    expect(commandOf({ action: 'test', pkg: './...' })).toBe('go test ./...');
  });
});

describe('the program\'s lines and the fold', () => {
  const file = (n, path = 'main.go') => ({ path, content: Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n' });

  it('are the lines of each file: the newline that ends a file is not a line, and a carriage return is not part of one', () => {
    expect(codeLines('a\nb\n')).toEqual(['a', 'b']);
    expect(codeLines('a\r\nb')).toEqual(['a', 'b']);
    expect(codeLines('')).toEqual(['']);
    expect(codeLines('\n')).toEqual(['']);
    expect(codeLines(undefined)).toEqual(['']);
    expect(totalLines([file(3), file(4, 'b.go')])).toBe(7);
  });

  it('show the first FOLD_LINES of the whole program until the student asks for the rest', () => {
    expect(FOLD_LINES).toBe(24);
    expect(foldable([file(24)])).toBe(false);
    expect(foldable([file(25)])).toBe(true);
    expect(foldPlan([file(40)], false)).toEqual([{ path: 'main.go', total: 40, shown: 24 }]);
    expect(foldPlan([file(40)], true)).toEqual([{ path: 'main.go', total: 40, shown: 40 }]);
    expect(foldPlan([file(20, 'a.go'), file(20, 'b.go'), file(5, 'c.go')], false)).toEqual([
      { path: 'a.go', total: 20, shown: 20 },
      { path: 'b.go', total: 20, shown: 4 },
      { path: 'c.go', total: 5, shown: 0 },
    ]);
    expect(showAllLabel(57)).toBe('Show all 57 lines');
  });
});

describe('what a run is said to have done', () => {
  it('is the server\'s own line when it gave one, and else made from the exit code, and never says a guess was right or wrong', () => {
    expect(resultLine('run', { summary: 'It printed: 4', exitCode: 0 })).toBe('It printed: 4');
    expect(resultLine('run', { summary: '  It   printed:\n 4 ' })).toBe('It printed: 4');
    expect(resultLine('run', { exitCode: 0 })).toBe('It ran.');
    expect(resultLine('run', { exitCode: 2 })).toBe('It stopped with exit code 2.');
    expect(resultLine('run', { timedOut: true })).toBe('It was stopped at the time limit.');
    expect(resultLine('test', { exitCode: 0 })).toBe('It passed.');
    expect(resultLine('test', { exitCode: 1 })).toBe('It failed.');
    expect(resultLine('test', {})).toBe('It ran.');
    expect(resultLine('run', null)).toBe('It ran.');
    for (const line of [resultLine('run', { exitCode: 0 }), resultLine('run', { exitCode: 1 }), resultLine('test', { exitCode: 0 }), resultLine('test', { exitCode: 1 })]) expect(line).not.toMatch(/right|wrong|correct|incorrect|well done|good job/i);
  });
});

describe('the Run button and the phases', () => {
  it('is disabled until there is a guess, keeps the focus while a run goes (only said to be disabled), and ends as done', () => {
    expect(buttonState({ phase: 'asking', ready: false, blocked: false })).toEqual({ disabled: true, busy: false, label: 'Run it' });
    expect(buttonState({ phase: 'asking', ready: true, blocked: false })).toEqual({ disabled: false, busy: false, label: 'Run it' });
    expect(buttonState({ phase: 'refused', ready: true, blocked: false })).toEqual({ disabled: false, busy: false, label: 'Run it' });
    expect(buttonState({ phase: 'refused', ready: true, blocked: true }).disabled).toBe(true);
    expect(buttonState({ phase: 'running', ready: true, blocked: false })).toEqual({ disabled: true, busy: true, label: 'Running…' });
    expect(buttonState({ phase: 'ran', ready: true, blocked: false })).toEqual({ disabled: true, busy: false, label: 'Done' });
  });

  it('moves asking to running to ran or refused, from a refusal to running again, and never out of ran', () => {
    expect(nextPhase('asking', 'press')).toBe('running');
    expect(nextPhase('refused', 'press')).toBe('running');
    expect(nextPhase('running', 'ran')).toBe('ran');
    expect(nextPhase('running', 'refused')).toBe('refused');
    expect(nextPhase('asking', 'running')).toBe('running');
    expect(nextPhase('asking', 'ran')).toBe('ran');
    expect(nextPhase('asking', 'something else')).toBe('asking');
    for (const event of ['press', 'running', 'ran', 'refused', 'x']) expect(nextPhase('ran', event)).toBe('ran');
  });
});

describe('a press that did not end in a run', () => {
  it('is the server\'s refusal in its own words, a session or rate problem in the page\'s, and anything unreadable is unknown', () => {
    expect(failureOf(503, { error: 'busy', message: 'The sandbox is busy.' })).toEqual({ kind: 'refused', code: 'busy', text: 'The sandbox is busy.', blocked: false });
    expect(failureOf(503, { error: 'busy' })).toMatchObject({ kind: 'refused', code: 'busy', text: REFUSAL_WORDS.busy });
    expect(failureOf(429, { error: 'limit' })).toMatchObject({ code: 'limit', text: REFUSAL_WORDS.limit });
    expect(failureOf(404, { error: 'not-found', message: 'gone' })).toMatchObject({ code: 'not-found', blocked: true, text: 'gone' });
    expect(failureOf(409, { error: 'running' })).toMatchObject({ code: 'running' });
    expect(failureOf(502, { error: 'something new' })).toMatchObject({ kind: 'refused', text: REFUSAL_WORDS.failed });
    expect(failureOf(401, { error: 'unauthorized' })).toMatchObject({ code: 'session', text: REFUSAL_WORDS.session });
    expect(failureOf(403, { error: 'csrf' })).toMatchObject({ code: 'forbidden', text: REFUSAL_WORDS.forbidden });
    expect(failureOf(429, { error: 'rate-limited' })).toMatchObject({ code: 'rate-limited', text: REFUSAL_WORDS['rate-limited'] });
    for (const unknown of [failureOf(0, null), failureOf(504, null), failureOf(502, '<html>bad gateway</html>'), failureOf(200, { ok: false }), failureOf(500, [])]) expect(unknown).toEqual({ kind: 'unknown' });
  });

  it('says in the page\'s fallback the same sentences the server does, and none of them is written for a model', () => {
    const same = { 'bad-request': 'badRequest', 'bad-guess': 'badGuess', 'not-found': 'notFound', running: 'running', going: 'going', off: 'off', busy: 'busy', failed: 'failed', refused: 'refused', unsaved: 'unsaved' };
    for (const [code, key] of Object.entries(same)) expect(REFUSAL_WORDS[code], code).toBe(PREDICT_WORDS[key]);
    expect(PREDICT_WORDS.hourly.startsWith('You have used your')).toBe(true);
    for (const words of Object.values(REFUSAL_WORDS)) expect(words).not.toMatch(/say so|go on by|the model|instruction/i);
  });
});

describe('the batching of the state requests', () => {
  const later = () => {
    const queue = [];
    return { schedule: (fn) => queue.push(fn), run: () => queue.splice(0).forEach((fn) => fn()) };
  };

  it('sends every card asked about in the same moment as one request, and gives each its own entry (or null)', async () => {
    const calls = [];
    const timer = later();
    const loader = createStateLoader({ get: async (numbers) => (calls.push(numbers), { 12: { state: 'ran', guess: '4' }, 14: { state: 'new' } }), schedule: timer.schedule });
    const asked = [loader.load(12), loader.load(14), loader.load(15), loader.load(12)];
    expect(calls).toHaveLength(0);                                   // nothing goes out until the moment is over
    timer.run();
    expect(await Promise.all(asked)).toEqual([{ state: 'ran', guess: '4' }, { state: 'new' }, null, { state: 'ran', guess: '4' }]);
    expect(calls).toEqual([[12, 14, 15]]);
    const again = loader.load(14);                                   // a later moment is a later request
    timer.run();
    await again;
    expect(calls).toHaveLength(2);
  });

  it('answers null for every card when the request fails or answers nonsense, and splits a crowd into requests of at most STATE_BATCH', async () => {
    const timer = later();
    const broken = createStateLoader({ get: async () => { throw new Error('offline'); }, schedule: timer.schedule });
    const a = broken.load(1);
    timer.run();
    expect(await a).toBeNull();
    const odd = createStateLoader({ get: async () => 'nonsense', schedule: timer.schedule });
    const b = odd.load(1);
    timer.run();
    expect(await b).toBeNull();
    const sizes = [];
    const many = createStateLoader({ get: async (numbers) => (sizes.push(numbers.length), {}), schedule: timer.schedule });
    const all = Array.from({ length: STATE_BATCH * 2 + 3 }, (_, i) => many.load(i + 1));
    timer.run();
    await Promise.all(all);
    expect(sizes).toEqual([STATE_BATCH, STATE_BATCH, 3]);
  });
});

// ---------------------------------------------------------------- the card, in a stand-in for the DOM

class Node_ {
  constructor(tag, className, text) {
    this.tag = tag;
    this.className = className || '';
    this.text = text === undefined ? '' : text;
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.tabIndex = -1;
    this.value = '';
  }
  append(...items) {
    this.children.push(...items);
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attrs[name];
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
  all() {
    return this.children.flatMap((c) => (typeof c === 'string' ? [] : [c, ...c.all()]));
  }
  find(className) {
    return this.all().find((n) => n.className.split(' ').includes(className));
  }
  findAll(className) {
    return this.all().filter((n) => n.className.split(' ').includes(className));
  }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, ...event });
  }
}
const el = (tag, className, text) => new Node_(tag, className, text);
const helpers = () => ({ el, fullTime: (t) => String(t), view: { set: () => {}, get: () => ({ v: 1 }) } });

const PROGRAM = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(2 + 2)\n}\n';
const cardObj = (extra = {}) => ({ t: 'predict', question: 'What does this print?', action: 'run', pkg: '.', files: [{ path: 'main.go', content: PROGRAM }], ...extra });
const entryOf = (obj = cardObj(), extra = {}) => ({ n: 12, ts: '2026-11-07T10:15:00.000Z', role: 'assistant', text: 'Prediction: What does this print?', kind: 'object', obj, ...extra });

const ranAnswer = (extra = {}) => ({ status: 200, body: { ok: true, ran: true, guess: '4', exitCode: 0, timedOut: false, summary: 'It printed: 4', told: true, card: true, ...extra } });

/** A stand-in for the server: what a press answers, what the state says, and a clock that does not wait. */
function fakeNet({ post, states = [] } = {}) {
  const asked = { posts: [], loads: 0 };
  const queue = [...states];
  return {
    asked,
    post: vi.fn(async (n, guess) => {
      asked.posts.push([n, guess]);
      return post ? post(n, guess) : ranAnswer();
    }),
    loader: { load: vi.fn(async () => (asked.loads++, queue.length ? queue.shift() : null)) },
    sleep: vi.fn(async () => undefined),
  };
}

/** Lets the promises that are waiting run (the card asks the server as soon as it is drawn). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function draw(obj, net = fakeNet()) {
  const built = buildCard(entryOf(obj), helpers(), net);
  return { built, node: built.node, net, ask: built.node.find('pc-ask'), run: built.node.find('pc-run'), input: built.node.find('pc-input') };
}

const typeGuess = (card, text) => {
  card.input.value = text;
  card.input.fire('input');
};

afterEach(() => {
  setObjectHelpers(null);
  vi.unstubAllGlobals();
});

describe('the prediction card', () => {
  it('is a row of the conversation of its type, a labelled group whose summary is the text a search has, and is not read out as it arrives', () => {
    setObjectHelpers(helpers());
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ cards: {} }) }));
    const row = objectRow(entryOf());
    expect(row).not.toBeNull();
    expect(row.className).toBe('row object');
    expect(row.dataset).toEqual({ n: 12, type: 'predict' });
    expect(row._text).toBe('Prediction: What does this print?');
    const node = row.children[0];
    expect(node.className).toBe('predictcard');
    expect(node.dataset.n).toBe('12');
    expect(node.attrs).toMatchObject({ role: 'group', 'aria-label': 'Prediction: What does this print?', 'aria-live': 'off' });
  });

  it('shows the question and the program with its file name, numbered lines that are not part of the text, and what it runs as', () => {
    const { node } = draw();
    expect(node.find('pc-question').textContent).toBe('What does this print?');
    expect(node.find('pc-fname').textContent).toBe('main.go');
    const body = node.find('pc-body');
    expect(body.attrs).toMatchObject({ role: 'region', 'aria-label': 'Code of main.go, 7 lines' });
    expect(body.tabIndex).toBe(0);
    expect(node.find('pc-nums').textContent).toBe('1\n2\n3\n4\n5\n6\n7');
    expect(node.find('pc-nums').attrs['aria-hidden']).toBe('true');
    expect(node.find('pc-code').tag).toBe('pre');
    expect(node.find('pc-code').textContent).toBe(PROGRAM.slice(0, -1));          // exactly the program: no numbers in it
    expect(node.find('pc-cmd').textContent).toBe('Runs as go run .');
    expect(node.find('pc-fold')).toBeUndefined();
    expect(node.dataset.folded).toBe('false');
    expect(draw(cardObj({ action: 'test', pkg: './...' })).node.find('pc-cmd').textContent).toBe('Runs as go test ./...');
  });

  it('colours Go with the page\'s own scanner and leaves other files plain, and the text is the text either way', () => {
    const { node } = draw(cardObj({ files: [{ path: 'main.go', content: PROGRAM }, { path: 'go.mod', content: 'module sandbox\n\ngo 1.22\n' }] }));
    const [go, mod] = node.findAll('pc-code');
    expect(go.findAll('hl-keyword').map((s) => s.textContent)).toContain('package');
    expect(go.textContent).toBe(PROGRAM.slice(0, -1));
    expect(mod.all()).toEqual([]);
    expect(mod.textContent).toBe('module sandbox\n\ngo 1.22');
    expect(node.findAll('pc-fname').map((n) => n.textContent)).toEqual(['main.go', 'go.mod']);
  });

  it('folds a long program to its first 24 lines with "Show all N lines", unfolds it, and folds it again', () => {
    const long = Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n';
    const { node } = draw(cardObj({ files: [{ path: 'long.go', content: long }] }));
    const fold = node.find('pc-fold');
    expect(fold.textContent).toBe('Show all 40 lines');
    expect(fold.attrs['aria-expanded']).toBe('false');
    expect(node.dataset.folded).toBe('true');
    expect(node.find('pc-code').textContent.split('\n')).toHaveLength(24);
    expect(node.find('pc-nums').textContent.split('\n')).toHaveLength(24);
    expect(node.find('pc-body').attrs['aria-label']).toBe('Code of long.go, 40 lines');
    fold.fire('click');
    expect(node.find('pc-code').textContent.split('\n')).toHaveLength(40);
    expect(node.find('pc-fold').textContent).toBe('Show the first 24 lines');
    expect(node.find('pc-fold').attrs['aria-expanded']).toBe('true');
    expect(node.dataset.folded).toBe('false');
    node.find('pc-fold').fire('click');
    expect(node.find('pc-code').textContent.split('\n')).toHaveLength(24);
  });

  it('asks for a typed guess with a labelled one-line field of at most 200 characters, and keeps Run disabled, with the reason, until there is one', () => {
    const card = draw();
    expect(card.input.tag).toBe('input');
    expect(card.input.type).toBe('text');
    expect(card.input.maxLength).toBe(200);
    expect(card.input.autocomplete).toBe('off');
    const label = card.ask.find('pc-legend');
    expect(label.tag).toBe('label');
    expect(label.textContent).toBe('What do you think it prints?');
    expect(label.htmlFor).toBe(card.input.id);
    expect(card.run.type).toBe('submit');
    expect(card.run.textContent).toBe('Run it');
    expect(card.run.disabled).toBe(true);
    expect(card.run.attrs['aria-describedby']).toBe(card.node.find('pc-hint').id);
    expect(card.node.find('pc-hint').textContent).toBe(NEED_GUESS);
    expect(card.node.find('pc-hint').hidden).toBe(false);
    expect(card.node.find('pc-note').textContent).toBe(RUN_NOTE);
    typeGuess(card, '   ');
    expect(card.run.disabled).toBe(true);
    typeGuess(card, '4');
    expect(card.run.disabled).toBe(false);
    expect(card.run.attrs['aria-describedby']).toBeUndefined();
    expect(card.node.find('pc-hint').hidden).toBe(true);
    typeGuess(card, '');
    expect(card.run.disabled).toBe(true);
    expect(draw(cardObj({ action: 'test', pkg: './...' })).ask.find('pc-legend').textContent).toBe('Will it pass? What will it say?');
  });

  it('asks for a pick with real radio buttons in a fieldset when the card has options, each in its own label, one group', () => {
    const card = draw(cardObj({ choices: ['4', '22', 'It does not compile'] }));
    expect(card.input).toBeUndefined();
    const set = card.ask.find('pc-set');
    expect(set.tag).toBe('fieldset');
    expect(set.find('pc-legend').tag).toBe('legend');
    expect(set.find('pc-legend').textContent).toBe('What do you think it prints?');
    const radios = card.node.findAll('pc-radio');
    expect(radios.map((r) => r.value)).toEqual(['4', '22', 'It does not compile']);
    expect(radios.every((r) => r.type === 'radio' && r.name === radios[0].name && r.id)).toBe(true);
    expect(card.node.findAll('pc-choice').every((label) => label.tag === 'label' && label.children.some((c) => c === radios[0] || radios.includes(c)))).toBe(true);
    expect(card.node.findAll('pc-choice-text').map((t) => t.textContent)).toEqual(['4', '22', 'It does not compile']);
    expect(card.run.disabled).toBe(true);
    expect(card.node.find('pc-hint').textContent).toBe(NEED_CHOICE);
    radios[1].fire('change');
    expect(card.run.disabled).toBe(false);
  });

  it('runs on a press: asks the server with the card\'s number and the guess only, says Running politely, and then shows what was guessed and what happened, without a verdict', async () => {
    let release;
    const net = fakeNet({ post: () => new Promise((resolve) => (release = resolve)) });
    const card = draw(cardObj(), net);
    typeGuess(card, '  4 ');
    card.ask.fire('submit');
    expect(net.asked.posts).toEqual([[12, '4']]);
    expect(card.node.dataset.phase).toBe('running');
    expect(card.run.textContent).toBe('Running…');
    expect(card.run.attrs).toMatchObject({ 'aria-busy': 'true', 'aria-disabled': 'true' });
    expect(card.run.disabled).toBe(false);                                  // it keeps the focus; a second press is ignored
    expect(card.input.readOnly).toBe(true);
    expect(card.node.find('sr-only').textContent).toBe('Running. This can take up to a minute.');
    card.ask.fire('submit');
    expect(net.asked.posts).toHaveLength(1);
    release(ranAnswer());
    await vi.waitFor(() => expect(card.node.dataset.phase).toBe('ran'));
    expect(card.ask.hidden).toBe(true);
    const record = card.node.find('pc-record');
    expect(record.hidden).toBe(false);
    expect(record.find('pc-guessed').textContent).toBe('You guessed: 4');
    expect(record.find('pc-guess').textContent).toBe('4');
    expect(record.find('pc-result').textContent).toBe('It printed: 4');
    expect(record.textContent).toContain('The exact output is in the run card in the chat.');
    expect(record.textContent).not.toMatch(/right|wrong|correct|well done/i);
    expect(card.node.find('sr-only').textContent).toBe('You guessed 4. It printed: 4');
    card.ask.fire('submit');
    expect(net.asked.posts).toHaveLength(1);                                // a card runs once
  });

  it('says so when TAi could not be reached or the chat has no run card for it, and the record stays', async () => {
    const card = draw(cardObj(), fakeNet({ post: () => ranAnswer({ told: false, card: false }) }));
    typeGuess(card, '4');
    await card.built.press();
    const text = card.node.find('pc-record').textContent;
    expect(text).toContain('The exact output could not be put in the chat.');
    expect(text).toContain('TAi could not be reached just now');
  });

  it('refuses in plain words, keeps the guess, and lets the student press again; a card that is gone cannot be run', async () => {
    const answers = [
      { status: 503, body: { error: 'busy', message: PREDICT_WORDS.busy } },
      { status: 429, body: { error: 'limit', message: PREDICT_WORDS.hourly } },
      { status: 401, body: { error: 'unauthorized' } },
      ranAnswer(),
    ];
    const net = fakeNet({ post: () => answers.shift() });
    const card = draw(cardObj(), net);
    typeGuess(card, '4');
    await card.built.press();
    expect(card.node.dataset.phase).toBe('refused');
    expect(card.node.find('pc-msg').textContent).toBe(PREDICT_WORDS.busy);
    expect(card.node.find('pc-msg').hidden).toBe(false);
    expect(card.run.disabled).toBe(false);
    expect(card.run.textContent).toBe('Run it');
    expect(card.input.readOnly).toBe(false);
    expect(card.input.value).toBe('4');
    expect(card.node.find('sr-only').textContent).toBe(PREDICT_WORDS.busy);
    await card.built.press();
    expect(card.node.find('pc-msg').textContent).toBe(PREDICT_WORDS.hourly);
    await card.built.press();
    expect(card.node.find('pc-msg').textContent).toBe(REFUSAL_WORDS.session);
    await card.built.press();
    expect(card.node.dataset.phase).toBe('ran');
    expect(card.node.find('pc-msg').hidden).toBe(true);
    expect(net.asked.posts).toHaveLength(4);

    const gone = draw(cardObj(), fakeNet({ post: () => ({ status: 404, body: { error: 'not-found', message: PREDICT_WORDS.notFound } }) }));
    typeGuess(gone, '4');
    await gone.built.press();
    expect(gone.node.find('pc-msg').textContent).toBe(PREDICT_WORDS.notFound);
    expect(gone.run.disabled).toBe(true);
    expect(gone.input.readOnly).toBe(true);
    expect(gone.node.find('pc-hint').hidden).toBe(true);                    // the reason is the message, not "make a guess"
    await gone.built.press();
    expect(gone.net.asked.posts).toHaveLength(1);
  });

  it('follows a run that is already going (a second press, a second tab) until it is over, and shows it as ran', async () => {
    const net = fakeNet({
      post: () => ({ status: 409, body: { error: 'running', message: PREDICT_WORDS.running } }),
      states: [null, { state: 'running' }, { state: 'ran', guess: '4', exitCode: 0, timedOut: false, summary: 'It printed: 4', card: true }],
    });
    const card = draw(cardObj(), net);
    await settle();                                                          // the state asked for as the card was drawn: nothing known
    typeGuess(card, '4');
    await card.built.press();
    expect(card.node.dataset.phase).toBe('ran');
    expect(card.node.find('pc-result').textContent).toBe('It printed: 4');
    expect(net.sleep).toHaveBeenCalledTimes(2);
  });

  it('asks the server what became of the run when no readable answer came back, and says what it can', async () => {
    const lost = draw(cardObj(), fakeNet({ post: () => ({ status: 0, body: null }), states: [null, { state: 'ran', guess: '4', exitCode: 0, summary: 'It printed: 4' }] }));
    await settle();
    typeGuess(lost, '4');
    await lost.built.press();
    expect(lost.node.dataset.phase).toBe('ran');

    const proxy = draw(cardObj(), fakeNet({ post: () => ({ status: 504, body: null }), states: [null, { state: 'new' }] }));
    await settle();
    typeGuess(proxy, '4');
    await proxy.built.press();
    expect(proxy.node.dataset.phase).toBe('refused');
    expect(proxy.node.find('pc-msg').textContent).toBe(REFUSAL_WORDS.lost);
    expect(proxy.run.disabled).toBe(false);

    const offline = draw(cardObj(), fakeNet({ post: () => ({ status: 0, body: null }), states: [null, null] }));
    await settle();
    typeGuess(offline, '4');
    await offline.built.press();
    expect(offline.node.find('pc-msg').textContent).toBe(REFUSAL_WORDS.offline);

    const slow = draw(cardObj(), fakeNet({ post: () => ({ status: 0, body: null }), states: [null, { state: 'running' }, ...Array.from({ length: POLL_TRIES }, () => ({ state: 'running' }))] }));
    await settle();
    typeGuess(slow, '4');
    await slow.built.press();
    expect(slow.node.dataset.phase).toBe('refused');
    expect(slow.node.find('pc-msg').textContent).toBe(REFUSAL_WORDS.slow);
  });

  it('is drawn as ran after a reload, with the guess and the result from the server, and as running when a run is going', async () => {
    const ran = draw(cardObj(), fakeNet({ states: [{ state: 'ran', guess: '22', exitCode: 0, timedOut: false, summary: 'It printed: 4', card: true }] }));
    await settle();
    expect(ran.node.dataset.phase).toBe('ran');
    expect(ran.node.find('pc-guessed').textContent).toBe('You guessed: 22');
    expect(ran.node.find('pc-result').textContent).toBe('It printed: 4');
    expect(ran.ask.hidden).toBe(true);
    expect(ran.net.asked.posts).toEqual([]);

    const going = draw(cardObj(), fakeNet({ states: [{ state: 'running' }, { state: 'ran', guess: '4', exitCode: 0, summary: 'It printed: 4' }] }));
    await settle();
    await vi.waitFor(() => expect(going.node.dataset.phase).toBe('ran'));

    const none = draw(cardObj(), fakeNet({ states: [{ state: 'none' }] }));
    await settle();
    expect(none.node.dataset.phase).toBe('refused');
    expect(none.node.find('pc-msg').textContent).toBe(REFUSAL_WORDS['not-found']);
    expect(none.run.disabled).toBe(true);

    const fresh = draw(cardObj(), fakeNet({ states: [{ state: 'new' }] }));
    await settle();
    expect(fresh.node.dataset.phase).toBe('asking');
    const unknown = draw(cardObj(), fakeNet({ states: [null] }));
    await settle();
    expect(unknown.node.dataset.phase).toBe('asking');                       // a state that could not be asked for leaves the card usable: the press itself is checked by the server
  });

  it('stops asking the server once it is taken off the page', async () => {
    const gates = [];
    const net = fakeNet({ states: [{ state: 'running' }] });
    net.sleep = vi.fn(() => new Promise((resolve) => gates.push(resolve)));
    const card = draw(cardObj(), net);
    await settle();
    expect(card.node.dataset.phase).toBe('running');
    expect(gates).toHaveLength(1);                                           // waiting to ask again
    card.built.destroy();
    gates[0]();
    await settle();
    expect(net.loader.load).toHaveBeenCalledTimes(1);                        // only the question asked as the card was drawn
    expect(net.sleep).toHaveBeenCalledTimes(1);
  });

  it('makes nothing the model wrote or a program printed into markup: every node it builds is a plain element made from text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const card = draw(cardObj({ question: hostile, files: [{ path: `${hostile}.go`, content: `package main // ${hostile}\n` }], choices: [hostile, '</fieldset><script>alert(2)</script>'] }));
    const text = card.node.textContent;
    expect(text).toContain(hostile);
    expect(text).toContain('</fieldset><script>alert(2)</script>');
    const tags = new Set(card.node.all().map((n) => n.tag));
    expect([...tags].every((tag) => ['div', 'span', 'p', 'pre', 'form', 'fieldset', 'legend', 'label', 'input', 'button'].includes(tag))).toBe(true);
    card.node.findAll('pc-radio')[0].fire('change');
    card.ask.fire('submit');
    await vi.waitFor(() => expect(card.node.dataset.phase).toBe('ran'));
    expect(card.node.find('pc-guess').textContent).toBe('4');
    const answered = draw(cardObj(), fakeNet({ post: () => ranAnswer({ guess: hostile, summary: `It printed: ${hostile}` }) }));
    typeGuess(answered, 'x');
    await answered.built.press();
    expect(answered.node.find('pc-record').textContent).toContain(`You guessed: ${hostile}`);
    expect(answered.node.find('pc-record').all().every((n) => ['p', 'span'].includes(n.tag))).toBe(true);
  });

  it('asks the real server as the page does: POST api/predict/run with the page\'s header and only the number and the guess, and GET api/predict/state for a drawn card', async () => {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init = {}) => {
      calls.push({ url, init });
      if (String(url).includes('api/predict/state')) return { ok: true, json: async () => ({ cards: { 12: { state: 'new' } } }) };
      return { status: 200, ok: true, json: async () => ({ ok: true, ran: true, guess: '4', exitCode: 0, summary: 'It printed: 4', told: true, card: true }) };
    });
    setObjectHelpers(helpers());
    const row = objectRow(entryOf());
    const node = row.children[0];
    await vi.waitFor(() => expect(calls.some((c) => String(c.url).includes('api/predict/state'))).toBe(true));
    expect(calls[0].url).toBe('http://localhost/api/predict/state?n=12');
    expect(calls[0].init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    node.find('pc-input').value = '4';
    node.find('pc-input').fire('input');
    node.find('pc-ask').fire('submit');
    await vi.waitFor(() => expect(node.dataset.phase).toBe('ran'));
    const post = calls.find((c) => String(c.url).endsWith('api/predict/run'));
    expect(post.init.method).toBe('POST');
    expect(post.init.headers).toEqual({ 'content-type': 'application/json', 'x-tai': '1' });
    expect(post.init.credentials).toBe('same-origin');
    expect(JSON.parse(post.init.body)).toEqual({ n: 12, guess: '4' });          // no code, no folder, no command
  });
});
