// What the page says while TAi works on a message: "Checking Canvas…" next to the dots, "Waiting for a free slot" when the message is in line, and
// the seconds as before. The server sends `status` ({ state: 'working' | 'queued', label?, ahead? }, src/turn-status.ts) in /api/me and /api/poll,
// only while TAi works or waits; docs/PROGRESS.md says where each word comes from. Everything here is a pure function (the DOM is app.js's).
//
// The words are a fixed list, the same as the server's (src/turn-status.ts STATUS_LABELS; status.test.js reads that file and compares): a label that
// is not in it is shown as "Working", so nothing a payload carries can put its own text in the bubble. A place in line is said only when the
// server gave one.

/** Every label the server may send, as it sends them. */
export const LABELS = [
  'Checking Canvas',
  'Looking at your GitHub',
  'Searching Piazza',
  'Looking in the course materials',
  'Drawing a diagram',
  'Reading your file',
  'Reading a web page',
  'Thinking',
  'Working',
];

export const QUEUED_TEXT = 'Waiting for a free slot';

const MAX_AHEAD = 1000;

/**
 * What the typing bubble shows beside its dots for a status, or null for the dots alone (nothing is known, or the status is not one this page knows).
 * `text` is what is drawn, `spoken` what a screen reader is told (no ellipsis, a comma for the dot between the parts).
 */
export function statusView(status) {
  if (!status || typeof status !== 'object') return null;
  if (status.state === 'queued') {
    const known = Number.isInteger(status.ahead) && status.ahead >= 0 && status.ahead < MAX_AHEAD;
    const place = !known ? '' : status.ahead === 0 ? "you're next" : `${status.ahead} ahead`;
    return { state: 'queued', text: place ? `${QUEUED_TEXT} · ${place}` : QUEUED_TEXT, spoken: place ? `${QUEUED_TEXT}, ${place}` : QUEUED_TEXT };
  }
  if (status.state !== 'working') return null;
  if (status.label === undefined) return null;
  const label = LABELS.includes(status.label) ? status.label : 'Working';
  return { state: 'working', text: `${label}…`, spoken: label };
}

/** The longest preview of a reply the page will draw (the server never sends more: src/portal/server.ts PARTIAL_MAX). */
export const PREVIEW_MAX = 4000;

/**
 * The words of the reply TAi is writing (TAI_PORTAL_STREAM, docs/STREAMING.md): `status.partial`, which the host has already filtered like the final
 * reply and cut at a sentence. '' for none: the flag is off (the field is never there), the status is not "working" (a message that waits in line
 * has no words), or the field is not a plain string of a sane length. The caller draws it as a growing bubble where the dots are, and as text only.
 */
export function previewText(status) {
  if (!status || typeof status !== 'object' || status.state !== 'working') return '';
  const words = status.partial;
  return typeof words === 'string' && words.trim() !== '' && words.length <= PREVIEW_MAX ? words : '';
}

/** The status without its preview: for a response that carries the reply itself (the words are then in the conversation, and drawn twice they would be a duplicate). */
export function withoutPreview(status) {
  if (!status || typeof status !== 'object') return status || null;
  const { partial: _preview, ...rest } = status;
  return rest;
}

/**
 * The longest thing the bubble can say: an invisible copy of it gives the label's box its width, so the bubble does not change size when the words do
 * (the longest label, or the place in line with two digits).
 */
export const LONGEST_TEXT = [...LABELS.map((label) => `${label}…`), `${QUEUED_TEXT} · 99 ahead`].reduce((a, b) => (b.length > a.length ? b : a));

/**
 * The note beside the bubble: nothing for the first seconds, then how long it has been. Waiting in line is not "still working": the words say what is
 * true. (`view` is statusView's.)
 */
export function noteText(view, seconds) {
  const waiting = !!view && view.state === 'queued';
  if (seconds < 8) return '';
  if (seconds < 120) return waiting ? `Waiting… ${seconds} s` : `Still working… ${seconds} s`;
  return waiting ? 'Your message is in line. The reply will appear here.' : 'This is taking longer than usual. Your message arrived; the reply will appear here.';
}

/**
 * Says what TAi is doing to a screen reader without chattering: `say(text)` writes it at once when nothing was said in the last `gapMs` (4 s),
 * and otherwise keeps only the newest text and writes it when the gap is over (if it is still different from what was said). `clear()` empties the
 * region (what is said next, even the same words, is read again) and drops what was waiting. The clock and the timers are injectable.
 */
export function createAnnouncer({ write, gapMs = 4000, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) }) {
  let lastText = '';
  let lastAt = -Infinity;
  let pending = null;
  let timer = null;

  const speak = (text) => {
    lastText = text;
    lastAt = now();
    write(text);
  };
  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    pending = null;
  };

  return {
    say(text) {
      if (typeof text !== 'string' || text === '') return this.clear();
      if (text === lastText) {
        pending = null;                         // it went somewhere and came back inside the gap: what was said is still the truth
        return undefined;
      }
      const wait = lastAt + gapMs - now();
      if (wait <= 0) {
        stopTimer();
        speak(text);
        return undefined;
      }
      pending = text;
      if (timer === null) {
        timer = setTimer(() => {
          timer = null;
          const next = pending;
          pending = null;
          if (next !== null && next !== lastText) speak(next);
        }, wait);
      }
      return undefined;
    },
    clear() {
      stopTimer();
      if (lastText !== '') {
        lastText = '';
        write('');
      }
    },
  };
}
