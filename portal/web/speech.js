// What a voice call leaves in the conversation (docs/PORTAL.md, "Voice calls"). The words said aloud are history lines of kind `speech`
// (role user: the student, assistant: TAi; the final text of one turn, with the id of the call), drawn as bubbles among the typed ones with a
// small waveform that tells spoken from typed; the start of a call, a switch of its kind and its end are marker lines (an `event`, no words),
// drawn as small dividers. A speech line is not a message: it never counts as unread, in the Chats drawer's message counts, as something a
// student can react to, or as something said that closes the options of a quick check. The call's own socket still sends its transcripts, but
// they are not drawn (every line would appear twice): the history is the one source of the words.
// The pure parts are here (what a line says, how long a call was, when a bubble is long, how the "..." of a student who is speaking holds and
// goes), tested by speech.test.js; app.js draws the rows.

export const LONG_CHARS = 600;           // a spoken bubble longer than this is folded, with "...more"
export const HOLD_MS = 4000;             // how long the "..." of a student who is speaking stays after the last sign of it
const EVENTS = new Set(['start', 'mode', 'end']);
const MODES = new Map([['conversational', 'Voice call'], ['interviewer', 'Mock interview'], ['listener', 'Talk it through']]);

/** Whether a history line is part of a call (its words, or a marker). */
export const isSpeech = (entry) => !!entry && typeof entry === 'object' && entry.kind === 'speech';

/** `start`, `mode` or `end` for a marker line; '' for the words of a call, and for anything else. */
export const eventOf = (entry) => (isSpeech(entry) && EVENTS.has(entry.event) ? entry.event : '');

/** What a kind of call is called ("Voice call" for the plain one and for any kind this page does not know). */
export const modeName = (mode) => MODES.get(mode) || 'Voice call';

/** How long a call was, the way a marker says it: "45 s", "8 min", "1 h 5 min"; '' when the server gave no usable length. */
export function durationText(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total < 0) return '';
  if (total < 60) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The words of a marker line: "Voice call · 3:42 PM" (`clock`, the time, as the page writes it), "Switched to Mock interview", "Call ended · 8 min". */
export function markerText(entry, clock = '') {
  const event = eventOf(entry);
  if (event === 'start') return clock ? `${modeName(entry.mode)} · ${clock}` : modeName(entry.mode);
  if (event === 'mode') return `Switched to ${modeName(entry.mode)}`;
  if (event === 'end') {
    const length = durationText(entry.seconds);
    return length ? `Call ended · ${length}` : 'Call ended';
  }
  return '';
}

/** The spoken line as the page draws it: who, the words, and whether they are long enough to be folded. Null for a marker, or a line with no words. */
export function spokenOf(entry) {
  if (!isSpeech(entry) || eventOf(entry)) return null;
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';
  if (!text) return null;
  return { you: entry.role === 'user', text, long: text.length > LONG_CHARS };
}

/** What the Chats drawer's search looks through in a call's lines: the words (a marker has none). */
export const spokenSearchText = (entry) => {
  const spoken = spokenOf(entry);
  return spoken ? spoken.text : '';
};

/** How many spoken lines (not markers) a list of history lines holds, for a day's count in the drawer. */
export const countSpoken = (entries) => entries.reduce((n, entry) => n + (spokenOf(entry) ? 1 : 0), 0);

/**
 * The "..." that stands for words being said that have not come back as a line yet. `started` (the call says the student began to speak) puts it
 * up; `voice` (their microphone is audibly in use) and `heard` (the call has the words, the line follows) only keep it up, they never put it up
 * themselves, so a noise or a late transcript cannot make it flash. It goes when the line arrives (`arrived`), when the call stops or the
 * microphone is muted (`stop`), and `holdMs` after the last sign of speech: while the student goes on talking it stays, without a flicker.
 */
export function createSpeaking({ show, hide, holdMs = HOLD_MS, now = () => Date.now(), later = setTimeout, cancel = clearTimeout }) {
  let on = false;
  let until = 0;
  let timer = 0;

  function off() {
    cancel(timer);
    timer = 0;
    if (!on) return;
    on = false;
    hide();
  }

  function keep(ms) {
    until = Math.max(until, now() + ms);
    cancel(timer);
    timer = later(() => (now() >= until ? off() : keep(0)), Math.max(0, until - now()));
  }

  return {
    started() {
      if (!on) {
        on = true;
        show();
      }
      keep(holdMs);
    },
    voice() {
      if (on) keep(holdMs);
    },
    heard() {
      if (on) keep(holdMs);
    },
    arrived: off,
    stop: off,
    visible: () => on,
  };
}
