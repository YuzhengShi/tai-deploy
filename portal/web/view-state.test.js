// The page's report of where the student is looking: what is sent, how often, and that an empty view is said once.
import { describe, expect, it } from 'vitest';

import { createViewState } from './view-state.js';

/** A clock and a timer the test turns by hand. */
function harness(options = {}) {
  let t = 1000;
  const pending = [];
  const sent = [];
  const state = createViewState({
    send: (view) => sent.push(view),
    now: () => t,
    setTimer: (fn, wait) => {
      const handle = { fn, at: t + wait, live: true };
      pending.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      if (handle) handle.live = false;
    },
    ...options,
  });
  const advance = (ms) => {
    t += ms;
    for (const handle of pending.splice(0)) {
      if (!handle.live) continue;
      if (handle.at <= t) handle.fn();
      else pending.push(handle);
    }
  };
  return { state, sent, advance, setNow: (value) => (t = value) };
}

const DOC = 'a'.repeat(32);

describe('createViewState', () => {
  it('sends the whole view once the changes have been quiet for a moment', () => {
    const { state, sent, advance } = harness();
    state.set({ doc: { id: DOC, page: 2 } });
    state.set({ sel: { doc: DOC, page: 2, from: 3, to: 5 } });
    expect(sent).toEqual([]);
    advance(249);
    expect(sent).toEqual([]);
    advance(1);
    expect(sent).toEqual([{ v: 1, doc: { id: DOC, page: 2 }, sel: { doc: DOC, page: 2, from: 3, to: 5 } }]);
  });

  it('does not send a view that is the same as the last one it sent', () => {
    const { state, sent, advance } = harness();
    state.set({ doc: { id: DOC, page: 2 } });
    advance(300);
    state.set({ doc: { id: DOC, page: 2 } });
    advance(1000);
    state.set({ sel: { doc: DOC, page: 2, from: 1, to: 1 } });
    state.set({ sel: null });
    advance(1000);
    expect(sent).toHaveLength(1);
  });

  it('keeps two reports at least minGap apart', () => {
    const { state, sent, advance } = harness();
    state.set({ doc: { id: DOC, page: 1 } });
    advance(250);
    expect(sent).toHaveLength(1);
    state.set({ doc: { id: DOC, page: 2 } });
    advance(250);
    expect(sent).toHaveLength(1);
    advance(550);
    expect(sent).toHaveLength(2);
    expect(sent[1].doc.page).toBe(2);
  });

  it('takes a part away when it is set to null, and says once that the view is empty', () => {
    const { state, sent, advance } = harness();
    state.set({ doc: { id: DOC, page: 1 }, msg: { n: 3, text: 'hello there' } });
    advance(300);
    state.clear();
    advance(2000);
    expect(sent).toEqual([{ v: 1, doc: { id: DOC, page: 1 }, msg: { n: 3, text: 'hello there' } }, { v: 1 }]);
    state.clear();
    advance(2000);
    expect(sent).toHaveLength(2);
  });

  it('says nothing when it was never given anything', () => {
    const { state, sent, advance } = harness();
    state.clear();
    state.set({ sel: null });
    state.flush();
    advance(5000);
    expect(sent).toEqual([]);
  });

  it('ignores parts it does not know', () => {
    const { state, sent, advance } = harness();
    state.set({ weird: 1 });
    advance(5000);
    expect(sent).toEqual([]);
    expect(state.get()).toEqual({ v: 1 });
  });

  it('flush sends at once', () => {
    const { state, sent } = harness();
    state.set({ obj: { n: 4, lines: [1, 2] } });
    state.flush();
    expect(sent).toEqual([{ v: 1, obj: { n: 4, lines: [1, 2] } }]);
  });

  it('resend makes the next report go out even if nothing changed', () => {
    const { state, sent, advance } = harness();
    state.set({ doc: { id: DOC, page: 1 } });
    advance(300);
    state.resend();
    advance(2000);
    expect(sent).toHaveLength(2);
  });

  it('tells its listeners of each local change, and stops when asked', () => {
    const { state } = harness();
    const seen = [];
    const stop = state.onChange((view) => seen.push(view));
    state.set({ doc: { id: DOC, page: 1 } });
    state.set({ doc: { id: DOC, page: 1 } });
    stop();
    state.set({ doc: { id: DOC, page: 2 } });
    expect(seen).toEqual([{ v: 1, doc: { id: DOC, page: 1 } }]);
  });

  it('says the same view again every two minutes while something is open', () => {
    const { state, sent, advance } = harness({ hidden: () => false });
    state.set({ doc: { id: DOC, page: 4 } });
    advance(300);
    expect(sent).toHaveLength(1);
    advance(119_000);
    expect(sent).toHaveLength(1);
    advance(1_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    advance(120_000);
    expect(sent).toHaveLength(3);
  });

  it('does not say it again while the tab is hidden, and goes on when it is not', () => {
    let hide = true;
    const { state, sent, advance } = harness({ hidden: () => hide });
    state.set({ doc: { id: DOC, page: 4 } });
    advance(300);
    advance(120_000);
    expect(sent).toHaveLength(1);
    hide = false;
    advance(120_000);
    expect(sent).toHaveLength(2);
  });

  it('stops saying it once the view is empty, and a change restarts it', () => {
    const { state, sent, advance } = harness({ hidden: () => false });
    state.set({ obj: { n: 3, lines: [1, 2] } });
    advance(300);
    state.clear();
    advance(1000);
    expect(sent).toEqual([{ v: 1, obj: { n: 3, lines: [1, 2] } }, { v: 1 }]);
    advance(600_000);
    expect(sent).toHaveLength(2);
    state.set({ obj: { n: 3, lines: [4, 4] } });
    advance(300);
    advance(120_000);
    expect(sent).toHaveLength(4);
  });

  it('can be switched off', () => {
    const { state, sent, advance } = harness({ keepAliveMs: 0, hidden: () => false });
    state.set({ doc: { id: DOC, page: 4 } });
    advance(300);
    advance(600_000);
    expect(sent).toHaveLength(1);
  });
  it('is not broken by a send that throws', () => {
    const { state, advance } = harness({
      send: () => {
        throw new Error('socket closed');
      },
    });
    state.set({ doc: { id: DOC, page: 1 } });
    expect(() => advance(300)).not.toThrow();
  });
});
