// The card of a run of the student's code: the pure parts (the line classifier, the badge, the duration, the lines a selection covers, what reports the selection to the view), and the card itself
// built into a small stand-in for the DOM (what it holds, how it folds, what it copies, that nothing a program printed becomes markup). The look of it, the selection with a mouse and a finger and
// the sideways scroll are checked in a browser (docs/RUN_CARDS.md).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { objectRow, setObjectHelpers } from './objects.js';
import {
  FOLD_LINES,
  MAX_SELECTED_LINES,
  QUOTE_CHARS,
  SETTLE_MS,
  badgeOf,
  classifyLine,
  createReporter,
  durationLabel,
  foldable,
  linesOfOffsets,
  outputLines,
  quoteOfLines,
  runSelectionOf,
  showAllLabel,
  shownLines,
} from './runcard.js';

describe('the line classifier of go test output', () => {
  it('colours ok, PASS and --- PASS green', () => {
    for (const line of ['ok  \tsandbox\t0.012s', 'ok  sandbox 0.01s', 'ok  \tsandbox\t(cached)', 'PASS', '--- PASS: TestX (0.00s)', '    --- PASS: TestX/sub (0.00s)', '\t--- PASS: TestY (0.01s)']) {
      expect(classifyLine(line), JSON.stringify(line)).toBe('pass');
    }
  });

  it('colours FAIL, --- FAIL and panic: red, and the race detector and Go\'s fatal error with them', () => {
    for (const line of ['FAIL', 'FAIL\tsandbox\t0.4s', 'FAIL: x', '--- FAIL: TestX (0.00s)', '    --- FAIL: TestX/sub (0.00s)', 'panic: runtime error: index out of range [3] with length 3', 'fatal error: all goroutines are asleep - deadlock!', 'WARNING: DATA RACE']) {
      expect(classifyLine(line), JSON.stringify(line)).toBe('fail');
    }
  });

  it('leaves everything else plain, including words that only start like them', () => {
    for (const line of ['', '   ', '=== RUN   TestX', '=== PAUSE TestX', 'hello', 'ok', 'okay, done', 'PASSED', 'FAILED to connect', 'failure', 'passes', 'no panic: here', '?   \tsandbox\t[no test files]', 'goroutine 1 [running]:', '    main.go:12: got 3 want 4', 'the test said FAIL']) {
      expect(classifyLine(line), JSON.stringify(line)).toBe('');
    }
  });

  it('is not fooled by white space in front, and never throws', () => {
    expect(classifyLine('   \t  --- FAIL: TestX')).toBe('fail');
    expect(classifyLine(undefined)).toBe('');
    expect(classifyLine(null)).toBe('');
    expect(classifyLine(42)).toBe('');
  });
});

describe('the badge', () => {
  it('says exit 0 calmly, another exit code as failed, a time-out as a warning, and a run that did not happen as idle: always in words', () => {
    expect(badgeOf({ ok: true, exitCode: 0, timedOut: false })).toEqual({ text: 'exit 0', tone: 'ok' });
    expect(badgeOf({ ok: true, exitCode: 1, timedOut: false })).toEqual({ text: 'exit 1', tone: 'fail' });
    expect(badgeOf({ ok: true, exitCode: 137, timedOut: false })).toEqual({ text: 'exit 137', tone: 'fail' });
    expect(badgeOf({ ok: true, exitCode: null, timedOut: true })).toEqual({ text: 'timed out', tone: 'warn' });
    expect(badgeOf({ ok: true, exitCode: 0, timedOut: true })).toEqual({ text: 'timed out', tone: 'warn' });
    expect(badgeOf({ ok: true, exitCode: null, timedOut: false })).toEqual({ text: 'stopped', tone: 'warn' });
    expect(badgeOf({ ok: false, exitCode: null, timedOut: false })).toEqual({ text: 'did not run', tone: 'idle' });
    expect(badgeOf(undefined)).toEqual({ text: 'did not run', tone: 'idle' });
    expect(badgeOf({})).toEqual({ text: 'did not run', tone: 'idle' });
  });
});

describe('how long a run took', () => {
  it('is seconds with a tenth under ten, whole seconds under a minute, then minutes', () => {
    expect(durationLabel(120)).toBe('0.1 s');
    expect(durationLabel(400)).toBe('0.4 s');
    expect(durationLabel(1234)).toBe('1.2 s');
    expect(durationLabel(9949)).toBe('9.9 s');
    expect(durationLabel(14_200)).toBe('14 s');
    expect(durationLabel(45_000)).toBe('45 s');
    expect(durationLabel(65_000)).toBe('1 min 5 s');
    expect(durationLabel(600_000)).toBe('10 min 0 s');
  });

  it('is nothing for a card with no time', () => {
    for (const bad of [0, -5, Number.NaN, Infinity, undefined, null, '12', {}]) expect(durationLabel(bad)).toBe('');
  });
});

describe('the lines of an output', () => {
  it('are numbered the way the host numbers them: split at the line breaks, the first line 1, blank lines counted', () => {
    expect(outputLines('a\nb\n\nc')).toEqual(['a', 'b', '', 'c']);
    expect(outputLines('one line')).toEqual(['one line']);
    // the host's runLines (src/chat-objects/view.ts): output.split('\n').slice(a - 1, b)
    const output = 'x\ny\nz\n\nw';
    expect(outputLines(output).slice(2 - 1, 3)).toEqual(output.split('\n').slice(2 - 1, 3));
  });

  it('are none when nothing was printed or the output is not text', () => {
    for (const none of ['', undefined, null, 42, {}, []]) expect(outputLines(none)).toEqual([]);
  });

  it('fold at 24 lines, with a button that says how many there are', () => {
    expect(FOLD_LINES).toBe(24);
    expect(foldable(24)).toBe(false);
    expect(foldable(25)).toBe(true);
    expect(shownLines(30, false)).toBe(24);
    expect(shownLines(30, true)).toBe(30);
    expect(shownLines(10, false)).toBe(10);
    expect(showAllLabel(31)).toBe('Show all 31 lines');
  });
});

describe('the lines a selection covers', () => {
  const text = 'one\ntwo\nthree\nfour';
  //          012 3 456 7 89012 3 4567    (the offsets: one 0-2, break 3, two 4-6, break 7, three 8-12, break 13, four 14-17)

  it('are the line of a word, the lines a drag crosses, and all of them for everything', () => {
    expect(linesOfOffsets(text, 4, 7)).toEqual([2, 2]);          // "two"
    expect(linesOfOffsets(text, 5, 11)).toEqual([2, 3]);         // "wo\nthr"
    expect(linesOfOffsets(text, 0, text.length)).toEqual([1, 4]);
    expect(linesOfOffsets(text, 15, 16)).toEqual([4, 4]);
    expect(linesOfOffsets(text, 0, 1)).toEqual([1, 1]);
  });

  it('do not count the line break at an end of the selection: a triple click ends at the start of the next line, a drag may begin at the end of one', () => {
    expect(linesOfOffsets(text, 4, 8)).toEqual([2, 2]);          // line two and its break
    expect(linesOfOffsets(text, 4, 14)).toEqual([2, 3]);         // two lines whole
    expect(linesOfOffsets(text, 3, 6)).toEqual([2, 2]);          // begins at the end of line one
    expect(linesOfOffsets(text, 3, 14)).toEqual([2, 3]);
    expect(linesOfOffsets(text, 7, 9)).toEqual([3, 3]);
  });

  it('are none when no character of a line is selected', () => {
    expect(linesOfOffsets(text, 3, 4)).toBeNull();               // only a line break
    expect(linesOfOffsets(text, 5, 5)).toBeNull();               // nothing
    expect(linesOfOffsets(text, 8, 4)).toBeNull();               // backwards
    expect(linesOfOffsets('\n\n\n', 0, 3)).toBeNull();
    expect(linesOfOffsets('', 0, 0)).toBeNull();
  });

  it('keep a blank line inside a selection and count it', () => {
    const blank = 'a\n\nb\nc';
    expect(linesOfOffsets(blank, 0, blank.length)).toEqual([1, 4]);
    expect(linesOfOffsets(blank, 3, 4)).toEqual([3, 3]);
  });

  it('stay inside the text and are none for offsets that are not numbers or not in it', () => {
    expect(linesOfOffsets(text, -5, 1000)).toEqual([1, 4]);
    expect(linesOfOffsets(text, 1000, 2000)).toBeNull();
    expect(linesOfOffsets(text, Number.NaN, 5)).toBeNull();
    expect(linesOfOffsets(text, 0, undefined)).toBeNull();
    expect(linesOfOffsets(undefined, 0, 5)).toBeNull();
    expect(linesOfOffsets(42, 0, 5)).toBeNull();
  });

  it('are cut to the most the view keeps: a span of 400 lines or more is cut to 400 lines from where it began', () => {
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
    expect(MAX_SELECTED_LINES).toBe(400);
    expect(linesOfOffsets(long, 0, long.length)).toEqual([1, 400]);
    const start = long.indexOf('line 100');
    expect(linesOfOffsets(long, start, long.length)).toEqual([101, 500]);
    const [a, b] = linesOfOffsets(long, 0, long.indexOf('line 399') + 3);
    expect(b - a).toBeLessThan(MAX_SELECTED_LINES);
  });

  it('agree with the host: the lines it quotes are the lines selected', () => {
    const output = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join('\n');
    const lines = outputLines(output);
    const from = output.indexOf('row 7');
    const to = output.indexOf('row 10') + 'row 10'.length;
    const [a, b] = linesOfOffsets(output, from, to);
    expect([a, b]).toEqual([7, 10]);
    expect(lines.slice(a - 1, b)).toEqual(['row 7', 'row 8', 'row 9', 'row 10']);
  });
});

describe('what is quoted of the lines', () => {
  it('is the lines themselves, cut at QUOTE_CHARS with an ellipsis', () => {
    const lines = ['alpha', '  indented', 'gamma'];
    expect(quoteOfLines(lines, 2, 3)).toBe('  indented\ngamma');
    expect(quoteOfLines(lines, 1, 1)).toBe('alpha');
    const long = ['x'.repeat(2000)];
    const cut = quoteOfLines(long, 1, 1);
    expect(cut.length).toBeLessThanOrEqual(QUOTE_CHARS);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('what reports a selection to the view', () => {
  function harness(find) {
    let t = 0;
    const timers = [];
    const sets = [];
    let obj;
    const view = {
      set: (part) => {
        sets.push(part);
        if ('obj' in part) obj = part.obj === null ? undefined : part.obj;
      },
      get: () => ({ v: 1, ...(obj ? { obj } : {}) }),
    };
    const reporter = createReporter({
      view,
      find,
      setTimer: (fn, wait) => {
        const handle = { fn, at: t + wait, live: true };
        timers.push(handle);
        return handle;
      },
      clearTimer: (handle) => {
        if (handle) handle.live = false;
      },
    });
    const advance = (ms) => {
      t += ms;
      for (const handle of timers.splice(0)) {
        if (!handle.live) continue;
        if (handle.at <= t) handle.fn();
        else timers.push(handle);
      }
    };
    return { reporter, view, sets, advance, setObj: (value) => (obj = value) };
  }

  it('reports the lines once the selection has been still, and not before: a drag is one report', () => {
    let selected = { n: 7, a: 2, b: 3 };
    const h = harness(() => selected);
    h.reporter.changed();
    h.advance(SETTLE_MS - 1);
    expect(h.sets).toEqual([]);
    selected = { n: 7, a: 2, b: 5 };
    h.reporter.changed();                                   // the drag goes on: the wait starts again
    h.advance(SETTLE_MS - 1);
    expect(h.sets).toEqual([]);
    h.advance(1);
    expect(h.sets).toEqual([{ obj: { n: 7, lines: [2, 5] } }]);
  });

  it('takes its report back when the selection empties or leaves the card, once, and says nothing when there was nothing to take back', () => {
    let selected = { n: 7, a: 1, b: 1 };
    const h = harness(() => selected);
    h.reporter.changed();
    h.advance(SETTLE_MS);
    selected = null;
    h.reporter.changed();
    h.advance(SETTLE_MS);
    expect(h.sets).toEqual([{ obj: { n: 7, lines: [1, 1] } }, { obj: null }]);
    h.reporter.changed();
    h.advance(SETTLE_MS);
    expect(h.sets).toHaveLength(2);
  });

  it('moves its report to the card that is selected now', () => {
    let selected = { n: 7, a: 1, b: 2 };
    const h = harness(() => selected);
    h.reporter.changed();
    h.advance(SETTLE_MS);
    selected = { n: 12, a: 4, b: 4 };
    h.reporter.changed();
    h.advance(SETTLE_MS);
    expect(h.sets).toEqual([{ obj: { n: 7, lines: [1, 2] } }, { obj: { n: 12, lines: [4, 4] } }]);
  });

  it('never takes back what is not its own: a chart card that has set `obj` since keeps it', () => {
    let selected = { n: 7, a: 1, b: 2 };
    const h = harness(() => selected);
    h.reporter.changed();
    h.advance(SETTLE_MS);
    h.setObj({ n: 9, series: 0, index: 3 });                // a chart on line 9 set the part
    selected = null;
    h.reporter.changed();
    h.advance(SETTLE_MS);
    expect(h.sets).toEqual([{ obj: { n: 7, lines: [1, 2] } }]);
    // and a part of the same card without lines (the card's own other report) is not taken either
    selected = { n: 7, a: 1, b: 2 };
    h.reporter.changed();
    h.advance(SETTLE_MS);
    h.setObj({ n: 7, step: 2 });
    selected = null;
    h.reporter.changed();
    h.advance(SETTLE_MS);
    expect(h.sets.filter((s) => s.obj === null)).toEqual([]);
  });

  it('survives a finder that throws: it is as if nothing were selected', () => {
    let boom = false;
    const h = harness(() => {
      if (boom) throw new Error('no selection api');
      return { n: 7, a: 1, b: 1 };
    });
    h.reporter.changed();
    h.advance(SETTLE_MS);
    boom = true;
    h.reporter.changed();
    h.advance(SETTLE_MS);
    expect(h.sets).toEqual([{ obj: { n: 7, lines: [1, 1] } }, { obj: null }]);
  });

  it('is told the page has no selection api: nothing is found', () => {
    expect(runSelectionOf(null)).toBeNull();
    expect(runSelectionOf(undefined)).toBeNull();
    expect(runSelectionOf({ rangeCount: 0 })).toBeNull();
    expect(runSelectionOf({ rangeCount: 1, isCollapsed: true })).toBeNull();
    expect(runSelectionOf({ rangeCount: 1, isCollapsed: false, getRangeAt: () => { throw new Error('x'); } })).toBeNull();
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
    this.title = '';
    this.type = '';
    this.tabIndex = -1;
  }
  append(...items) {
    this.children.push(...items);
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
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
  /** Every element below this one, depth first. */
  all() {
    return this.children.flatMap((c) => (typeof c === 'string' ? [] : [c, ...c.all()]));
  }
  find(className) {
    return this.all().find((n) => n.className.split(' ').includes(className));
  }
  findAll(className) {
    return this.all().filter((n) => n.className.split(' ').includes(className));
  }
  async click() {
    for (const fn of this.listeners.click || []) await fn({});
  }
}
const el = (tag, className, text) => new Node_(tag, className, text);
const helpers = () => ({ el, fullTime: (t) => `at ${new Date(t).toISOString()}`, view: { set: () => {}, get: () => ({ v: 1 }) } });

/** The history line of a run card: what the host writes (src/chat-objects/run.ts) and the page receives. */
const entryOf = (obj, extra = {}) => ({ n: 41, ts: '2026-11-07T10:15:00.000Z', role: 'assistant', text: 'Ran go test ./... (exit 1, 1.2 s)', kind: 'object', obj: { t: 'run', command: 'go test ./...', ok: true, exitCode: 1, timedOut: false, durationMs: 1234, output: 'a\nb', truncated: false, ...obj }, ...extra });
const draw = (obj, extra) => {
  setObjectHelpers(helpers());
  const row = objectRow(entryOf(obj, extra));
  expect(row).not.toBeNull();
  return row;
};
const manyLines = (n) => Array.from({ length: n }, (_, i) => `--- PASS: TestCase${i + 1} (0.00s)`).join('\n');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setObjectHelpers(null);
});

describe('the card of a run', () => {
  it('is a row of the conversation of the card\'s type, numbered, with the line\'s summary as the text a search and a copy have', () => {
    const row = draw({});
    expect(row.tag).toBe('li');
    expect(row.className).toBe('row object');
    expect(row.dataset).toEqual({ n: 41, type: 'run' });
    expect(row._text).toBe('Ran go test ./... (exit 1, 1.2 s)');
    const card = row.children[0];
    expect(card.className).toBe('runcard');
    expect(card.dataset.n).toBe('41');
    expect(card.dataset.tone).toBe('fail');
    expect(card.attrs['aria-live']).toBe('off');                 // the conversation reads out what is added to it: not a card, line by line
  });

  it('has a header with the command, the badge in words, and how long it took, with the time of day as its tooltip', () => {
    const card = draw({}).children[0];
    const head = card.find('rc-head');
    expect(head.find('rc-cmd').textContent).toBe('go test ./...');
    expect(head.find('rc-cmd').title).toBe('go test ./...');
    expect(head.find('rc-badge').textContent).toBe('exit 1');
    expect(head.find('rc-badge').dataset.tone).toBe('fail');
    expect(head.find('rc-time').textContent).toBe('1.2 s');
    expect(head.find('rc-time').title).toBe('at 2026-11-07T10:15:00.000Z');
    const calm = draw({ exitCode: 0 }).children[0];
    expect(calm.find('rc-badge').textContent).toBe('exit 0');
    expect(calm.find('rc-badge').dataset.tone).toBe('ok');
    const slow = draw({ exitCode: null, timedOut: true, durationMs: 20_000 }).children[0];
    expect(slow.find('rc-badge').textContent).toBe('timed out');
    expect(slow.find('rc-badge').dataset.tone).toBe('warn');
    expect(slow.find('rc-time').textContent).toBe('20 s');
    expect(draw({ durationMs: 0 }).children[0].find('rc-time')).toBeUndefined();
  });

  it('shows the output as numbered lines in a region the keyboard can reach, named for its command, with the numbers in a column of their own', () => {
    const card = draw({ output: 'ok  \tsandbox\t0.01s\nPASS\nFAIL' }).children[0];
    const body = card.find('rc-body');
    expect(body.attrs.role).toBe('region');
    expect(body.attrs['aria-label']).toBe('Output of go test ./..., 3 lines');
    expect(body.tabIndex).toBe(0);
    const nums = card.find('rc-nums');
    expect(nums.textContent).toBe('1\n2\n3');
    expect(nums.attrs['aria-hidden']).toBe('true');
    const code = card.find('rc-code');
    expect(code.tag).toBe('pre');
    expect(code.textContent).toBe('ok  \tsandbox\t0.01s\nPASS\nFAIL');          // exactly the output: no numbers in it
    expect(body.find('rc-nums')).toBeDefined();
    expect(code.textContent).not.toMatch(/^1\n/);
    expect(draw({ output: 'one' }).children[0].find('rc-body').attrs['aria-label']).toBe('Output of go test ./..., 1 line');
  });

  it('colours the lines of go test output by the classifier, and the words stay the signal', () => {
    const card = draw({ output: '=== RUN   TestX\n--- FAIL: TestX (0.00s)\n    --- PASS: TestX/sub (0.00s)\nFAIL\nok  \tsandbox\t0.01s\nplain' }).children[0];
    const spans = card.find('rc-code').findAll('rc-line');
    expect(spans.map((s) => s.className)).toEqual(['rc-line', 'rc-line rc-fail', 'rc-line rc-pass', 'rc-line rc-fail', 'rc-line rc-pass', 'rc-line']);
    expect(spans.map((s) => s.textContent)).toEqual(['=== RUN   TestX', '--- FAIL: TestX (0.00s)', '    --- PASS: TestX/sub (0.00s)', 'FAIL', 'ok  \tsandbox\t0.01s', 'plain']);
  });

  it('keeps blank lines as lines, numbered like the host numbers them', () => {
    const card = draw({ output: 'a\n\nb' }).children[0];
    expect(card.find('rc-nums').textContent).toBe('1\n2\n3');
    expect(card.find('rc-code').textContent).toBe('a\n\nb');
  });
});

describe('folding the output', () => {
  it('shows the first 24 lines and a button for all of them, when there are more', () => {
    const card = draw({ output: manyLines(31) }).children[0];
    expect(card.find('rc-code').findAll('rc-line')).toHaveLength(24);
    expect(card.find('rc-nums').textContent.split('\n')).toHaveLength(24);
    expect(card.find('rc-nums').textContent.split('\n')[23]).toBe('24');
    const button = card.find('rc-fold');
    expect(button.textContent).toBe('Show all 31 lines');
    expect(button.tag).toBe('button');
    expect(button.type).toBe('button');
    expect(button.attrs['aria-expanded']).toBe('false');
    expect(card.dataset.folded).toBe('true');
    expect(card.find('rc-body').attrs['aria-label']).toBe('Output of go test ./..., 31 lines');   // the region says how many there are, folded or not
  });

  it('unfolds to every line and folds back', async () => {
    const card = draw({ output: manyLines(31) }).children[0];
    const button = card.find('rc-fold');
    await button.click();
    expect(card.find('rc-code').findAll('rc-line')).toHaveLength(31);
    expect(card.find('rc-nums').textContent.split('\n')).toHaveLength(31);
    expect(card.find('rc-code').textContent.split('\n')).toHaveLength(31);
    expect(button.attrs['aria-expanded']).toBe('true');
    expect(button.textContent).toBe('Show the first 24 lines');
    expect(card.dataset.folded).toBe('false');
    await button.click();
    expect(card.find('rc-code').findAll('rc-line')).toHaveLength(24);
    expect(button.textContent).toBe('Show all 31 lines');
    expect(button.attrs['aria-expanded']).toBe('false');
  });

  it('has no button when it all fits', () => {
    for (const n of [1, 12, 24]) {
      const card = draw({ output: manyLines(n) }).children[0];
      expect(card.find('rc-fold'), `${n} lines`).toBeUndefined();
      expect(card.find('rc-code').findAll('rc-line')).toHaveLength(n);
      expect(card.dataset.folded).toBe('false');
    }
  });

  it('draws a very long output in pieces, not as one call with thousands of arguments', async () => {
    const card = draw({ output: Array.from({ length: 9000 }, (_, i) => `line ${i}`).join('\n') }).children[0];
    await card.find('rc-fold').click();
    expect(card.find('rc-code').findAll('rc-line')).toHaveLength(9000);
    expect(card.find('rc-nums').textContent.split('\n')).toHaveLength(9000);
  });
});

describe('what a card says when there is nothing to show', () => {
  it('says that the program printed nothing, with no output region and nothing to copy', () => {
    const card = draw({ output: '', exitCode: 0 }).children[0];
    expect(card.find('rc-empty').textContent).toBe('The program printed nothing.');
    expect(card.find('rc-body')).toBeUndefined();
    expect(card.find('rc-copy')).toBeUndefined();
    expect(card.find('rc-fold')).toBeUndefined();
  });

  it('says that nothing was run, in grey words, with the host\'s sentence as the reason', () => {
    const card = draw({ ok: false, exitCode: null, output: '', durationMs: 0, note: 'The sandbox is busy.' }).children[0];
    expect(card.find('rc-badge').textContent).toBe('did not run');
    expect(card.dataset.tone).toBe('idle');
    expect(card.find('rc-empty')).toBeUndefined();               // (the sentence stands where the output would be)
    expect(card.find('rc-note').textContent).toBe('The sandbox is busy.');
    const bare = draw({ ok: false, exitCode: null, output: '', durationMs: 0 }).children[0];
    expect(bare.find('rc-empty').textContent).toBe('Nothing was run.');
    expect(bare.find('rc-note')).toBeUndefined();
  });

  it('puts the host\'s note under the output of a run that did happen', () => {
    const card = draw({ note: 'It ran out of memory (512 MB) and was stopped; the output is what it printed before.' }).children[0];
    expect(card.find('rc-note').textContent).toMatch(/ran out of memory/);
    expect(draw({}).children[0].find('rc-note')).toBeUndefined();
  });

  it('is still a card for a line whose object is odd: no command, a number for the output, a note of spaces, no time', () => {
    const card = draw({ command: undefined, output: 5, note: '   ', durationMs: 'x', exitCode: 'x' }, { ts: 'not a time' }).children[0];
    expect(card.find('rc-cmd').textContent).toBe('go');
    expect(card.find('rc-empty')).toBeDefined();
    expect(card.find('rc-note')).toBeUndefined();
    expect(card.find('rc-time')).toBeUndefined();
    expect(card.find('rc-badge').textContent).toBe('stopped');
    const bare = objectRow({ n: 3, ts: 'x', role: 'assistant', text: 'a run', kind: 'object', obj: { t: 'run' } });
    expect(bare.children[0].find('rc-badge').textContent).toBe('did not run');
  });
});

describe('what the program printed is text, never markup', () => {
  it('goes in as the text of spans: a program that prints tags, scripts and attributes makes no element', () => {
    const hostile = '<img src=x onerror=alert(1)>\n<script>alert(2)</script>\n"><svg onload=alert(3)>\n&lt;b&gt;bold&lt;/b&gt;';
    const card = draw({ output: hostile, command: 'go run ./<b>x</b>', note: '<i>note</i>' }).children[0];
    const everything = [card, ...card.all()];
    expect([...new Set(everything.map((n) => n.tag))].sort()).toEqual(['button', 'code', 'div', 'p', 'pre', 'span']);       // no img, script, svg, b or i came out of the text
    expect(card.find('rc-code').findAll('rc-line')).toHaveLength(4);
    expect(card.find('rc-code').textContent).toBe(hostile);
    expect(card.find('rc-cmd').textContent).toBe('go run ./<b>x</b>');
    expect(card.find('rc-note').textContent).toBe('<i>note</i>');
    for (const node of everything) {
      expect('innerHTML' in node).toBe(false);
      expect('outerHTML' in node).toBe(false);
    }
  });
});

describe('copying the output', () => {
  it('copies the output exactly as it is, says so, and goes back to Copy', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const output = manyLines(40);
    const card = draw({ output }).children[0];
    const copy = card.find('rc-copy');
    expect(copy.textContent).toBe('Copy');
    expect(copy.attrs['aria-label']).toBe('Copy the output of go test ./...');
    await copy.click();
    expect(writeText).toHaveBeenCalledWith(output);          // the whole output, folded or not
    expect(copy.textContent).toBe('Copied');
    const status = card.find('sr-only');
    expect(status.attrs.role).toBe('status');
    expect(status.attrs['aria-live']).toBe('polite');
    expect(status.textContent).toBe('Copied the output');
    await vi.advanceTimersByTimeAsync(1700);
    expect(copy.textContent).toBe('Copy');
    expect(status.textContent).toBe('');
  });

  it('says what to do when the browser will not copy, and does not throw', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    const card = draw({ output: 'a\nb' }).children[0];
    const copy = card.find('rc-copy');
    await copy.click();
    expect(copy.textContent).toBe('Press Ctrl+C');
    expect(card.find('sr-only').textContent).toMatch(/Could not copy/);
    await vi.advanceTimersByTimeAsync(1700);
    expect(copy.textContent).toBe('Copy');
  });
});

describe('copying a selection inside the card', () => {
  it('puts the text of the selection on the clipboard as plain text and nothing else, and leaves the browser\'s own copy alone when nothing is selected', () => {
    const card = draw({ output: 'a\nb' }).children[0];
    const copy = card.listeners.copy[0];
    const setData = vi.fn();
    const preventDefault = vi.fn();
    vi.stubGlobal('getSelection', () => ({ toString: () => 'b\nc' }));
    copy({ clipboardData: { setData }, preventDefault });
    expect(setData).toHaveBeenCalledWith('text/plain', 'b\nc');
    expect(setData).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    vi.stubGlobal('getSelection', () => ({ toString: () => '' }));
    const other = { setData: vi.fn(), preventDefault: vi.fn() };
    copy({ clipboardData: { setData: other.setData }, preventDefault: other.preventDefault });
    expect(other.setData).not.toHaveBeenCalled();
    expect(other.preventDefault).not.toHaveBeenCalled();
    vi.stubGlobal('getSelection', () => {
      throw new Error('no selection');
    });
    expect(() => copy({ clipboardData: { setData }, preventDefault })).not.toThrow();
    expect(() => copy({})).not.toThrow();
  });
});

describe('the registry', () => {
  it('hands the card its helpers: nothing about the page is reached for but what it was given', () => {
    setObjectHelpers({ el, view: undefined });
    const row = objectRow(entryOf({}));
    expect(row).not.toBeNull();                              // no view, no fullTime: still a card
    expect(row.children[0].find('rc-time').title).toBe('');
  });
});
