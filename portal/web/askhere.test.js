// "Ask about this": the words a selection becomes (what the view carries, what is quoted, what the chip shows), and the decisions of the chip (when it comes and goes, what the button does in a
// call and out of one, that a tap on the chip cannot undo the selection it is about). The DOM around it (the chip above the message box, a real selection with a mouse and a finger) is
// checked in a browser (docs/RUN_CARDS.md).
import { describe, expect, it, vi } from 'vitest';

import { oneLine as hostOneLine } from '../../src/chat-objects/text.ts';
import {
  CHIP_CHARS,
  HOLD_MAX_MS,
  HOLD_MS,
  MAX_QUOTE_CHARS,
  MAX_VIEW_TEXT,
  SETTLE_MS,
  TEXT_LABEL,
  VOICE_LABEL,
  VOICE_PROMPT,
  chipOf,
  cleanSelection,
  createAskModel,
  initAskHere,
  oneLineOf,
  quoteText,
  shorten,
} from './askhere.js';

describe('the words of a selection', () => {
  it('are one line for the view: white space single, control characters gone, at most 400 characters', () => {
    expect(cleanSelection('  What do   you\n think\tabout\u0000 it?  ')).toBe('What do you think about it?');
    expect(cleanSelection('')).toBe('');
    expect(cleanSelection(undefined)).toBe('');
    expect(cleanSelection(42)).toBe('');
    expect(MAX_VIEW_TEXT).toBe(400);
    const cut = cleanSelection('word '.repeat(200));
    expect(cut.length).toBeLessThanOrEqual(MAX_VIEW_TEXT);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('are cut where the host cuts them, so that what fits reaches the model as it is and what does not is cut the same way', () => {
    const samples = ['short words', 'a'.repeat(399), 'a'.repeat(400), 'a'.repeat(401), 'word '.repeat(200), `line one\nline two\t${'x'.repeat(500)}`, '  ', '\u202eflipped\u200b zero width', 'é'.repeat(450)];
    for (const text of samples) expect(cleanSelection(text), JSON.stringify(text.slice(0, 20))).toBe(hostOneLine(text, MAX_VIEW_TEXT));
    expect(cleanSelection('a'.repeat(400))).toBe('a'.repeat(400));
    expect(oneLineOf('abcdef', 4)).toBe(hostOneLine('abcdef', 4));
  });

  it('keep their lines for a quotation, with white space inside a line made single, blank runs made one, and at most 1200 characters', () => {
    expect(quoteText('First line   here\n\n\n\n\nSecond\tline\r\nThird')).toBe('First line here\n\nSecond line\nThird');
    expect(quoteText('  padded  ')).toBe('padded');
    expect(quoteText(undefined)).toBe('');
    const long = quoteText('x'.repeat(5000));
    expect(long.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(quoteText('a\u0000b\u202ec')).toBe('a b c');
  });

  it('are shortened for the chip, on one line, with an ellipsis', () => {
    expect(shorten('short')).toBe('short');
    expect(shorten('word '.repeat(60)).length).toBeLessThanOrEqual(CHIP_CHARS);
    expect(shorten('word '.repeat(60)).endsWith('…')).toBe(true);
    expect(shorten('line one\nline two')).toBe('line one line two');
    expect(shorten('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('what the chip offers', () => {
  it('is the words of one of TAi\'s lines: the view\'s one line and the quotation\'s own, under a key that tells selections apart', () => {
    const a = chipOf({ kind: 'msg', n: 12, text: 'What do you think\nshares that map?', quote: 'What do you think\nshares that map?' });
    expect(a).toMatchObject({ kind: 'msg', n: 12, label: 'Selected', text: 'What do you think shares that map?', preview: 'What do you think shares that map?', quote: 'What do you think\nshares that map?' });
    const same = chipOf({ kind: 'msg', n: 12, text: 'What do you think shares that map?' });
    expect(same.key).toBe(a.key);
    expect(chipOf({ kind: 'msg', n: 13, text: 'What do you think shares that map?' }).key).not.toBe(a.key);
    expect(chipOf({ kind: 'msg', n: 12, text: 'Something else' }).key).not.toBe(a.key);
    expect(chipOf({ kind: 'msg', n: 12, text: 'only words' }).quote).toBe('only words');         // no separate quotation: the words themselves
  });

  it('is the lines of a run card: where they are, the first of them for the chip, and a quotation that says which run they are from', () => {
    const chip = chipOf({ kind: 'lines', n: 7, a: 3, b: 5, text: 'FAIL TestX\n  at store.go:24\n  at get.go:18', command: 'go test -race ./...' });
    expect(chip).toMatchObject({ kind: 'lines', n: 7, label: 'Lines 3-5', key: 'lines:7:3:5' });
    expect(chip.preview).toBe('FAIL TestX at store.go:24 at get.go:18');
    expect(chip.quote).toBe('Lines 3-5 of go test -race ./...:\nFAIL TestX\n  at store.go:24\n  at get.go:18');
    const one = chipOf({ kind: 'lines', n: 7, a: 4, b: 4, text: '--- PASS: TestX', command: 'go test ./...' });
    expect(one.label).toBe('Line 4');
    expect(one.quote).toBe('Line 4 of go test ./...:\n--- PASS: TestX');
    expect(chipOf({ kind: 'lines', n: 7, a: 4, b: 4, text: 'x' }).quote).toBe('Line 4 of the output:\nx');
  });

  it('is nothing for what is not a selection of words or lines, however it is built', () => {
    for (const bad of [null, undefined, {}, 5, 'x', { kind: 'msg' }, { kind: 'msg', n: 0, text: 'x' }, { kind: 'msg', n: 1.5, text: 'x' }, { kind: 'msg', n: 3, text: '   ' }, { kind: 'msg', n: 3, text: 42 },
      { kind: 'lines', n: 3, a: 0, b: 1, text: 'x' }, { kind: 'lines', n: 3, a: 5, b: 4, text: 'x' }, { kind: 'lines', n: 3, a: 1, b: 1, text: '' }, { kind: 'lines', n: 3, a: 1, b: 1 }, { kind: 'chart', n: 3 }]) {
      expect(chipOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- the decisions

/** A clock and timers the test turns by hand, a view that remembers what was set, and what the model calls. */
function harness({ inCall = false, desktop = true, snapshot = null } = {}) {
  let t = 0;
  const timers = [];
  const state = { snapshot, inCall, desktop, msg: undefined };
  const sets = [];
  const view = {
    set: (part) => {
      sets.push(part);
      if ('msg' in part) state.msg = part.msg === null ? undefined : part.msg;
    },
    get: () => ({ v: 1, ...(state.msg ? { msg: state.msg } : {}) }),
  };
  const calls = { quote: [], toast: [], cleared: 0, chips: [] };
  const model = createAskModel({
    view,
    read: () => {
      if (state.snapshot instanceof Error) throw state.snapshot;
      return state.snapshot;
    },
    quote: (text, opts) => calls.quote.push({ text, opts }),
    toast: (message) => calls.toast.push(message),
    inCall: () => state.inCall,
    desktop: () => state.desktop,
    clearSelection: () => {
      calls.cleared++;
      state.snapshot = null;
    },
    onChange: (chip) => calls.chips.push(chip && chip.key),
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
      if (handle.at <= t) {
        handle.live = false;
        handle.fn();
      } else timers.push(handle);
    }
  };
  /** The browser's selection changes to this (or to nothing), and the model is told. */
  const select = (snap) => {
    state.snapshot = snap;
    model.selectionChanged();
  };
  return { model, state, sets, calls, advance, select };
}
const words = (n = 12, text = 'What do you think shares that map between the two goroutines?') => ({ kind: 'msg', n, text, quote: text });
const lines = (n = 7, a = 3, b = 5) => ({ kind: 'lines', n, a, b, text: 'FAIL\nat a\nat b', command: 'go test ./...' });

describe('when the chip comes and goes', () => {
  it('comes after the selection has been still for 300 ms, not before, and puts the words in the view then', () => {
    const h = harness();
    h.select(words());
    h.advance(SETTLE_MS - 1);
    expect(h.model.current()).toBeNull();
    expect(h.sets).toEqual([]);
    h.advance(1);
    expect(h.model.current()).toMatchObject({ kind: 'msg', n: 12 });
    expect(h.sets).toEqual([{ msg: { n: 12, text: 'What do you think shares that map between the two goroutines?' } }]);
    expect(SETTLE_MS).toBe(300);
  });

  it('follows a drag as one selection: each change starts the wait again, and only the last words are acted on', () => {
    const h = harness();
    h.select(words(12, 'What'));
    h.advance(200);
    h.select(words(12, 'What do you'));
    h.advance(200);
    h.select(words(12, 'What do you think shares'));
    h.advance(SETTLE_MS - 1);
    expect(h.sets).toEqual([]);
    h.advance(1);
    expect(h.sets).toEqual([{ msg: { n: 12, text: 'What do you think shares' } }]);
    expect(h.calls.chips).toEqual(['msg:12:What do you think shares']);
  });

  it('goes after the selection has gone, after the same wait, and takes the words out of the view', () => {
    const h = harness();
    h.select(words());
    h.advance(SETTLE_MS);
    h.select(null);
    h.advance(SETTLE_MS - 1);
    expect(h.model.current()).not.toBeNull();                 // (a tap that clears the selection for a moment must not take the chip away before the click)
    h.advance(1);
    expect(h.model.current()).toBeNull();
    expect(h.sets[h.sets.length - 1]).toEqual({ msg: null });
    expect(h.state.msg).toBeUndefined();
    expect(h.calls.chips.at(-1)).toBeNull();
  });

  it('stays, and does not set the view again, while the same words stay selected, and changes with the words', () => {
    const h = harness();
    h.select(words(12, 'one two'));
    h.advance(SETTLE_MS);
    h.select(words(12, 'one two'));
    h.advance(SETTLE_MS);
    expect(h.calls.chips).toEqual(['msg:12:one two']);
    h.select(words(12, 'one two three'));
    h.advance(SETTLE_MS);
    expect(h.calls.chips).toEqual(['msg:12:one two', 'msg:12:one two three']);
    h.select(words(14, 'one two three'));
    h.advance(SETTLE_MS);
    expect(h.state.msg).toEqual({ n: 14, text: 'one two three' });
  });

  it('puts nothing in the view for a selection of a card\'s lines (the card does), offers the chip, and takes back the words of a message it moves on from', () => {
    const h = harness();
    h.select(words());
    h.advance(SETTLE_MS);
    h.select(lines());
    h.advance(SETTLE_MS);
    expect(h.model.current()).toMatchObject({ kind: 'lines', n: 7, label: 'Lines 3-5' });
    expect(h.sets).toEqual([{ msg: { n: 12, text: 'What do you think shares that map between the two goroutines?' } }, { msg: null }]);
    h.select(null);
    h.advance(SETTLE_MS);
    expect(h.sets).toHaveLength(2);                            // nothing of its own to take back
    expect(h.model.current()).toBeNull();
    const only = harness();
    only.select(lines());
    only.advance(SETTLE_MS);
    expect(only.sets).toEqual([]);                             // never touched the view's `msg`
  });

  it('is nothing for what is not offered: a selection outside TAi\'s words, and a reader that throws', () => {
    const h = harness();
    h.select(null);
    h.advance(SETTLE_MS);
    expect(h.model.current()).toBeNull();
    expect(h.sets).toEqual([]);
    h.select(new Error('no selection api'));
    h.advance(SETTLE_MS);
    expect(h.model.current()).toBeNull();
    h.select({ kind: 'msg', n: 0, text: 'bad' });
    h.advance(SETTLE_MS);
    expect(h.model.current()).toBeNull();
  });

  it('survives a drawing that throws: the decision is made anyway', () => {
    const h = harness();
    const model = createAskModel({
      view: { set: () => undefined },
      read: () => words(),
      quote: () => undefined,
      toast: () => undefined,
      onChange: () => {
        throw new Error('no DOM');
      },
      setTimer: (fn) => {
        fn();
        return 1;
      },
      clearTimer: () => undefined,
    });
    expect(() => model.selectionChanged()).not.toThrow();
    expect(model.current()).toMatchObject({ n: 12 });
    expect(h.model.current()).toBeNull();
  });
});

describe('the button', () => {
  it('quotes the words in the message box out of a call, takes the chip and the selection away, and focuses the box only where it may', () => {
    for (const desktop of [true, false]) {
      const h = harness({ desktop });
      h.select(words(12, 'What do you think\nshares that map?'));
      h.advance(SETTLE_MS);
      h.model.ask();
      expect(h.calls.quote).toEqual([{ text: 'What do you think\nshares that map?', opts: { focus: desktop } }]);
      expect(h.model.current()).toBeNull();
      expect(h.calls.cleared).toBe(1);
      expect(h.state.msg).toBeUndefined();                    // the quotation carries the words now
      expect(h.calls.toast).toEqual([]);
      h.advance(SETTLE_MS);                                   // (the selection is gone: nothing comes back)
      expect(h.model.current()).toBeNull();
    }
  });

  it('quotes the lines of a card with the card\'s own header', () => {
    const h = harness();
    h.select(lines(7, 3, 5));
    h.advance(SETTLE_MS);
    h.model.ask();
    expect(h.calls.quote).toEqual([{ text: 'Lines 3-5 of go test ./...:\nFAIL\nat a\nat b', opts: { focus: true } }]);
  });

  it('only tells the student to speak in a call: no quotation, and the chip, the selection and the view stay, because TAi hears it on its next turn', () => {
    const h = harness({ inCall: true });
    h.select(words());
    h.advance(SETTLE_MS);
    expect(h.model.voice()).toBe(true);
    h.model.ask();
    expect(h.calls.toast).toEqual([VOICE_PROMPT]);
    expect(VOICE_PROMPT).toBe('Now say your question');
    expect(h.calls.quote).toEqual([]);
    expect(h.calls.cleared).toBe(0);
    expect(h.model.current()).not.toBeNull();
    expect(h.state.msg).toEqual({ n: 12, text: 'What do you think shares that map between the two goroutines?' });
    expect(VOICE_LABEL).toBe('Ask TAi by voice');
    expect(TEXT_LABEL).toBe('Ask TAi');
  });

  it('does what the call is NOW: a call that ended since the chip came gets the quotation', () => {
    const h = harness({ inCall: true });
    h.select(words());
    h.advance(SETTLE_MS);
    h.state.inCall = false;
    expect(h.model.voice()).toBe(false);
    h.model.ask();
    expect(h.calls.quote).toHaveLength(1);
    expect(h.calls.toast).toEqual([]);
  });

  it('does nothing when there is no chip', () => {
    const h = harness();
    h.model.ask();
    expect(h.calls.quote).toEqual([]);
    expect(h.calls.toast).toEqual([]);
    expect(h.calls.cleared).toBe(0);
  });
});

describe('sending the chip away', () => {
  it('hides it and takes the words out of the view, and does not offer the same selection again while it is there', () => {
    const h = harness();
    h.select(words());
    h.advance(SETTLE_MS);
    h.model.dismiss();
    expect(h.model.current()).toBeNull();
    expect(h.state.msg).toBeUndefined();
    expect(h.calls.cleared).toBe(0);                          // the selection itself is the student's: it stays
    h.select(words());                                        // the browser says again that the same words are selected
    h.advance(SETTLE_MS);
    expect(h.model.current()).toBeNull();
    expect(h.state.msg).toBeUndefined();
  });

  it('offers another selection, and the same words again once the selection has gone and come back', () => {
    const h = harness();
    h.select(words(12, 'first'));
    h.advance(SETTLE_MS);
    h.model.dismiss();
    h.select(words(12, 'second'));
    h.advance(SETTLE_MS);
    expect(h.model.current()).toMatchObject({ text: 'second' });
    h.model.dismiss();
    h.select(null);
    h.advance(SETTLE_MS);
    h.select(words(12, 'second'));
    h.advance(SETTLE_MS);
    expect(h.model.current()).toMatchObject({ text: 'second' });
  });

  it('does nothing when there is no chip', () => {
    const h = harness();
    h.model.dismiss();
    expect(h.sets).toEqual([]);
  });
});

describe('a tap on the chip', () => {
  it('does not undo the selection it is about: while a pointer is down on the chip, changes of the selection are not acted on, nor the selection that is gone', () => {
    const h = harness({ inCall: true });
    h.select(words());
    h.advance(SETTLE_MS);
    h.model.hold(true);
    h.select(null);                                           // the tap cleared it
    h.advance(SETTLE_MS * 3);
    expect(h.model.current()).not.toBeNull();
    expect(h.state.msg).toBeDefined();
    h.model.hold(false);
    h.advance(100);
    h.select(null);
    h.advance(SETTLE_MS);                                     // (acted on 300 ms later, still inside the hold that follows the pointer being let go of: the click is on its way)
    expect(h.model.current()).not.toBeNull();
    h.advance(HOLD_MS);                                       // the hold is over
    h.select(null);
    h.advance(SETTLE_MS);
    expect(h.model.current()).toBeNull();                     // acted on again
    expect(h.state.msg).toBeUndefined();
  });

  it('is left alone for good only as long as the pointer is down: one that is dragged off and never let go of on the chip is forgotten after a while', () => {
    const h = harness();
    h.select(words());
    h.advance(SETTLE_MS);
    h.model.hold(true);
    h.advance(HOLD_MAX_MS - 1000);
    h.select(null);
    h.advance(SETTLE_MS);
    expect(h.model.current()).not.toBeNull();                 // (still held: the pointer may be down)
    h.advance(HOLD_MAX_MS);                                   // far past the longest a pointer is trusted to be down
    h.select(null);
    h.advance(SETTLE_MS);
    expect(h.model.current()).toBeNull();
    expect(HOLD_MAX_MS).toBeGreaterThan(HOLD_MS);
  });
});

describe('the page', () => {
  it('has no chip, and no error, where there is no page or no message box to put it above', () => {
    const noop = () => undefined;
    expect(initAskHere()).toBeNull();
    expect(initAskHere({})).toBeNull();
    expect(initAskHere({ view: { set: noop }, messages: null, quote: noop })).toBeNull();
    expect(initAskHere({ view: { set: noop }, messages: {}, quote: noop })).toBeNull();      // (this test runs without a document)
    expect(initAskHere({ view: { set: noop }, messages: {} })).toBeNull();
  });
});

describe('the whole of it', () => {
  it('with a call that starts and stops between selections', () => {
    const h = harness();
    h.select(words());
    h.advance(SETTLE_MS);
    h.model.ask();                                            // out of a call: quoted
    expect(h.calls.quote).toHaveLength(1);
    h.state.inCall = true;
    h.select(words(13, 'a later line'));
    h.advance(SETTLE_MS);
    h.model.ask();                                            // in one: told to speak
    expect(h.calls.toast).toEqual([VOICE_PROMPT]);
    expect(h.calls.quote).toHaveLength(1);
    expect(h.state.msg).toEqual({ n: 13, text: 'a later line' });
    h.state.inCall = false;
    h.select(null);
    h.advance(SETTLE_MS);
    expect(h.state.msg).toBeUndefined();
    expect(vi.isMockFunction(h.model.ask)).toBe(false);
  });
});
