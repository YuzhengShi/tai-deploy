// The page's report of where the student is looking (docs/CHAT_OBJECTS.md, "The view"). One instance for the page: the viewer, the cards and the selection helper each `set` the part of
// the view they own (`doc`, `sel`, `point`, `msg`, `obj`), and this sends the WHOLE current view, debounced, through the function it was given: during a call the call's socket
// (voice.js), otherwise `POST api/view` (app.js). The server replaces its copy each time and describes it for the model when it is wanted.
//
// Sending is cheap and bounded on purpose: a change waits `delay` ms for the next one (a drag over words is one report, not forty), two reports are never closer than `minGap`,
// a view that is the same as the last one sent is not sent again, and a view that has become empty is sent once (so the server forgets) and then nothing until something changes.
//
// A view that has not changed is still true: while something is open the same view is sent again every `keepAliveMs` (two minutes), unless the tab is hidden, so that a student who reads one slide
// for four minutes and then asks about it is still 'looking' there for the server (which keeps a view three minutes for a text message and ten for a call after the last report).

const KEYS = ['doc', 'sel', 'point', 'msg', 'obj'];

export function createViewState({ send, now = Date.now, delay = 250, minGap = 800, keepAliveMs = 120_000, hidden = () => typeof document !== 'undefined' && document.hidden === true, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const view = {};
  let lastSent = null;
  let lastAt = -Infinity;
  let timer = null;
  let alive = null;
  const listeners = new Set();

  const current = () => ({ v: 1, ...view });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /** The keep-alive: armed while something is open, after each report; taken down when the view is empty. */
  function arm() {
    if (alive !== null) clearTimer(alive);
    alive = null;
    if (!keepAliveMs || Object.keys(view).length === 0) return;
    alive = setTimer(beat, keepAliveMs);
  }

  function beat() {
    alive = null;
    if (Object.keys(view).length === 0) return;
    if (!hidden()) {
      lastSent = null;                     // the same view, said again
      transmit();
    }
    arm();
  }

  function transmit() {
    timer = null;
    const next = current();
    if (lastSent !== null && same(next, lastSent)) return;
    if (lastSent === null && Object.keys(view).length === 0) return;
    lastSent = next;
    lastAt = now();
    try {
      if (typeof send === 'function') send(next);
    } catch {
      /* a report that cannot be sent is not worth breaking the page for */
    }
    arm();
  }

  function schedule() {
    if (timer !== null) clearTimer(timer);
    const wait = Math.max(delay, lastAt + minGap - now());
    timer = setTimer(transmit, wait);
  }

  const api = {
    /** `set({ sel: {...} })` sets those parts; a part given as null or undefined is taken away. */
    set(part) {
      let changed = false;
      for (const key of KEYS) {
        if (!part || !(key in part)) continue;
        const value = part[key];
        if (value === null || value === undefined) {
          if (key in view) {
            delete view[key];
            changed = true;
          }
        } else if (!same(view[key], value)) {
          view[key] = value;
          changed = true;
        }
      }
      if (!changed) return;
      for (const fn of listeners) fn(current());
      schedule();
    },
    /** Takes away one part, or (no argument) all of them. */
    clear(key) {
      api.set(key ? { [key]: null } : Object.fromEntries(KEYS.map((k) => [k, null])));
    },
    get: current,
    /** Sends now what has not been sent. */
    flush() {
      if (timer !== null) clearTimer(timer);
      transmit();
    },
    /** `fn(view)` after each local change (before it is sent). Answers the function that takes the listener away. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Forgets what was sent, so that the next report goes out even if nothing changed (a call began: the server's copy is new). */
    resend() {
      lastSent = null;
      if (timer === null && Object.keys(view).length > 0) schedule();
    },
  };
  return api;
}
