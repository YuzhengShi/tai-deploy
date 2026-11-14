// "Ask about this" (docs/CHAT_OBJECTS.md, docs/RUN_CARDS.md): what the student selects in TAi's messages becomes part of the view (`msg`: line n of the chat and its words), what they select in a run card is
// the card's own business for the view (runcard.js sets `obj`), and a small chip above the message box offers to ask about either one.
//
// The chip is above the message box, not a button at the selection: selection handles and the browser's own toolbar make a floating one unreliable on a phone. It is drawn over the conversation,
// not into it, so it never moves the conversation when it comes and goes. It shows the words (shortened) with an "Ask TAi" button, which puts them in the message box as a quotation, and a way to
// send it away. In a voice call the button says "Ask TAi by voice" and only tells the student to speak: the view already carries the selection, and TAi hears it on its next turn.
//
// A selection is read once it has stopped changing for SETTLE_MS (a drag is one selection, not forty), and the chip goes away when the selection does, after the same wait. Tapping the chip itself
// must not undo the selection it is about (a tap can clear it before the click lands): while a pointer is down on the chip, changes of the selection are not acted on.
//
// The decisions are `createAskModel` (pure: tested in askhere.test.js with a clock the test turns), the words are small pure functions, and `initAskHere` is the DOM around them. Nothing here
// throws into the page: a page that cannot find its message box has no chip.
import { runSelectionOf } from './runcard.js';

/** The words of a selection that go into the view are one line of at most this many characters (src/chat-objects/view.ts VIEW_MAX_TEXT: the host cuts at the same place). */
export const MAX_VIEW_TEXT = 400;
/** The most a quotation of a message's words holds. */
export const MAX_QUOTE_CHARS = 1200;
/** A selection is acted on once it has been still for this long. */
export const SETTLE_MS = 300;
/** How much of the words the chip shows. */
export const CHIP_CHARS = 80;
/** After a pointer lets go of the chip, its selection is left alone this much longer (the click arrives a moment after the pointer is up). */
export const HOLD_MS = 800;
/** A pointer that went down on the chip and was never let go of there (it was dragged off): the selection is acted on again after this long anyway. */
export const HOLD_MAX_MS = 5000;
/** What the button of a voice call says and what the student is told when they press it. */
export const VOICE_LABEL = 'Ask TAi by voice';
export const VOICE_PROMPT = 'Now say your question';
export const TEXT_LABEL = 'Ask TAi';

/** Where TAi's words are on the page: the text of its messages, and the lines it said in a call. */
const BODIES = 'li.row.assistant[data-n] .md, li.row.speech.tai[data-n] .say-text';

// ---------------------------------------------------------------- the words

/** One line of at most `max` characters, cut the way the host cuts (src/chat-objects/text.ts oneLine), so that words of at most `max` characters reach the model as they are. */
export function oneLineOf(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** What the view carries of a selection of a message's words. */
export const cleanSelection = (text) => oneLineOf(text, MAX_VIEW_TEXT);

/** What the quotation holds of a selection of a message's words: its lines, white space inside a line made single, blank runs made one, at most MAX_QUOTE_CHARS characters. */
export function quoteText(text) {
  if (typeof text !== 'string') return '';
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => (ch === '\n' ? ch : ' '))
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());
  const flat = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return flat.length > MAX_QUOTE_CHARS ? `${flat.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…` : flat;
}

/** The words as the chip shows them: one line, cut with an ellipsis. */
export const shorten = (text, max = CHIP_CHARS) => oneLineOf(text, max);

const rangeLabel = (a, b) => (a === b ? `line ${a}` : `lines ${a}-${b}`);

/**
 * What the chip offers for what is selected: `snapshot` is `{ kind: 'msg', n, text, quote? }` (words of TAi's line n) or `{ kind: 'lines', n, a, b, text, command? }` (lines of a run card on line n).
 * `key` tells one selection from another; `label` says where, `preview` is the words for the chip, `quote` is what "Ask TAi" puts in the message box.
 */
export function chipOf(snapshot) {
  if (!snapshot || !Number.isInteger(snapshot.n) || snapshot.n < 1) return null;
  if (snapshot.kind === 'lines') {
    if (!Number.isInteger(snapshot.a) || !Number.isInteger(snapshot.b) || snapshot.a < 1 || snapshot.b < snapshot.a || typeof snapshot.text !== 'string' || snapshot.text === '') return null;
    const where = rangeLabel(snapshot.a, snapshot.b);
    const command = oneLineOf(snapshot.command, 120);
    return {
      key: `lines:${snapshot.n}:${snapshot.a}:${snapshot.b}`,
      kind: 'lines',
      n: snapshot.n,
      label: where.charAt(0).toUpperCase() + where.slice(1),
      preview: shorten(snapshot.text),
      quote: `${where.charAt(0).toUpperCase() + where.slice(1)} of ${command || 'the output'}:\n${snapshot.text}`,
    };
  }
  if (snapshot.kind === 'msg') {
    const text = cleanSelection(snapshot.text);
    if (!text) return null;
    return { key: `msg:${snapshot.n}:${text}`, kind: 'msg', n: snapshot.n, label: 'Selected', preview: shorten(text), quote: quoteText(snapshot.quote) || text, text };
  }
  return null;
}

// ---------------------------------------------------------------- the decisions

/**
 * The state of the chip and of `msg` in the view. `read()` answers what is selected now (a snapshot, or null: nothing, or something that is not TAi's words or a run card's output);
 * `selectionChanged()` is told of every change of the browser's selection and acts on what `read()` says once it has stopped changing. `onChange(chip)` is told of each change of what the
 * chip offers (a chip, or null). Only `msg` is this model's part of the view: a run card's `obj` is runcard.js's.
 */
export function createAskModel({
  view,
  read,
  quote,
  toast,
  inCall = () => false,
  desktop = () => false,
  clearSelection = () => {},
  onChange = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  settleMs = SETTLE_MS,
  holdMs = HOLD_MS,
}) {
  let chip = null;
  /** The key of the selection the student sent away with the X: it is not offered again until the selection is another. */
  let dismissed = null;
  /** `msg` in the view is this model's. */
  let owned = false;
  let timer = null;
  let holding = false;
  let release = null;

  const tell = () => {
    try {
      onChange(chip);
    } catch {
      /* what draws the chip is not what decides it */
    }
  };
  const takeBackMsg = () => {
    if (!owned) return;
    owned = false;
    view.set({ msg: null });
  };
  const hide = () => {
    if (!chip) return;
    chip = null;
    tell();
  };

  function apply(snapshot) {
    if (holding) return;
    const next = snapshot ? chipOf(snapshot) : null;
    if (!next) {
      dismissed = null;
      takeBackMsg();
      hide();
      return;
    }
    if (next.key === dismissed) return;
    dismissed = null;
    if (next.kind === 'msg') {
      view.set({ msg: { n: next.n, text: next.text } });
      owned = true;
    } else {
      takeBackMsg();
    }
    if (chip && chip.key === next.key) return;
    chip = next;
    tell();
  }

  const model = {
    /** The browser's selection changed: act on it once it is still. */
    selectionChanged() {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        let snapshot = null;
        try {
          snapshot = read();
        } catch {
          snapshot = null;
        }
        apply(snapshot);
      }, settleMs);
    },
    /** What the chip offers now. */
    current: () => chip,
    /** Whether the button says "by voice": a call is on. */
    voice: () => !!inCall(),
    /** The student pressed the button. In a call they are told to speak (the view carries the selection); otherwise the words are quoted into the message box. */
    ask() {
      if (!chip) return;
      if (inCall()) {
        toast(VOICE_PROMPT);
        return;
      }
      quote(chip.quote, { focus: !!desktop() });
      dismissed = chip.key;
      takeBackMsg();
      hide();
      clearSelection();
    },
    /** The student sent the chip away: the words are not offered again until another selection, and the view takes them back. */
    dismiss() {
      if (!chip) return;
      dismissed = chip.key;
      takeBackMsg();
      hide();
    },
    /**
     * A pointer is down on the chip (true) or has been let go of (false: acted on again after HOLD_MS). A pointer that is never let go of where the chip can hear it (it was dragged away) must not
     * leave the selection ignored for ever: the hold ends by itself after HOLD_MAX_MS.
     */
    hold(on) {
      if (release !== null) {
        clearTimer(release);
        release = null;
      }
      if (on) {
        holding = true;
        release = setTimer(() => {
          release = null;
          holding = false;
        }, HOLD_MAX_MS);
        return;
      }
      release = setTimer(() => {
        release = null;
        holding = false;
      }, holdMs);
    },
  };
  return model;
}

// ---------------------------------------------------------------- the page

const elementOf = (node) => (node && node.nodeType === 1 ? node : node && node.parentElement) || null;

/** What is selected on the page now: words of one message of TAi's, lines of one run card, or null. */
function readSelection(messages) {
  const selection = typeof getSelection === 'function' ? getSelection() : null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const lines = runSelectionOf(selection);
  if (lines) return { kind: 'lines', n: lines.n, a: lines.a, b: lines.b, text: lines.text, command: lines.command };
  const range = selection.getRangeAt(0);
  const from = elementOf(range.startContainer)?.closest(BODIES);
  const to = elementOf(range.endContainer)?.closest(BODIES);
  // it starts in the words of a message of TAi's and ends in the same message or after it (never in another one: that is a drag over several messages)
  if (!from || !messages.contains(from) || (to && to !== from)) return null;
  // A triple click on a paragraph ends at the start of the NEXT block, which can be outside these words (the next message, a card): the selection is the part of it that is inside them.
  const words = document.createRange();
  words.selectNodeContents(from);
  const inside = range.cloneRange();
  if (inside.compareBoundaryPoints(Range.END_TO_END, words) > 0) inside.setEnd(words.endContainer, words.endOffset);
  const row = from.closest('[data-n]');
  const n = Number(row && row.dataset.n);
  const raw = inside.toString();
  return Number.isInteger(n) && n >= 1 && cleanSelection(raw) ? { kind: 'msg', n, text: raw, quote: raw } : null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function crossIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M6 6l12 12M18 6 6 18');
  svg.append(path);
  return svg;
}

/**
 * Called once by app.js with `view` (the shared view state), `messages` (the conversation's list), `quote(text, { focus })` (puts words in the message box, as a quotation; `focus` is false where the
 * keyboard would cover the conversation: a phone), `inCall()` and `toast`. Answers the model (tests and the console), or null when the page has no message box to put the chip above.
 */
export function initAskHere({ view, messages, quote, inCall, toast } = {}) {
  try {
    if (typeof document === 'undefined' || !view || !messages || typeof quote !== 'function') return null;
    const chat = typeof messages.closest === 'function' ? messages.closest('.chat') : null;
    const dock = (chat && chat.querySelector('.dock-inner')) || document.querySelector('.dock-inner');
    if (!dock) return null;

    const box = make('div', 'askchip');
    box.hidden = true;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Ask TAi about what you selected');
    const words = make('span', 'askchip-words');
    const label = make('span', 'askchip-label');
    const preview = make('span', 'askchip-text');
    words.append(label, preview);
    const go = make('button', 'askchip-go', TEXT_LABEL);
    go.type = 'button';
    const away = make('button', 'askchip-x');
    away.type = 'button';
    away.setAttribute('aria-label', 'Dismiss');
    away.title = 'Dismiss';
    away.append(crossIcon());
    box.append(words, go, away);
    // said politely when the chip comes: a live region that is always there (one that is added with its words in it is not reliably announced)
    const live = make('span', 'sr-only');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    dock.prepend(box, live);

    const desktop = () => typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches;
    const model = createAskModel({
      view,
      quote,
      toast: typeof toast === 'function' ? toast : () => {},
      inCall: typeof inCall === 'function' ? inCall : () => false,
      desktop,
      read: () => readSelection(messages),
      clearSelection: () => {
        const selection = typeof getSelection === 'function' ? getSelection() : null;
        if (selection) selection.removeAllRanges();
      },
      onChange: (chip) => {
        if (!chip) {
          box.hidden = true;
          live.textContent = '';
          return;
        }
        label.textContent = chip.label;
        preview.textContent = `“${chip.preview}”`;
        box.title = chip.preview;
        go.textContent = model.voice() ? VOICE_LABEL : TEXT_LABEL;
        box.hidden = false;
        live.textContent = model.voice()
          ? `${chip.label}: ${chip.preview}. TAi can see it. Say your question aloud.`
          : `${chip.label}: ${chip.preview}. Press Ask TAi to quote it in your message.`;
      },
    });

    document.addEventListener('selectionchange', () => model.selectionChanged());
    // a mouse button down on the chip would clear the selection it is about before the click: not allowed to; a touch cannot be stopped, so the selection is left alone while it lasts
    box.addEventListener('mousedown', (event) => event.preventDefault());
    box.addEventListener('pointerdown', () => {
      model.hold(true);
      // let go anywhere: a pointer dragged off the chip is not let go of on it
      const end = () => {
        model.hold(false);
        document.removeEventListener('pointerup', end, true);
        document.removeEventListener('pointercancel', end, true);
      };
      document.addEventListener('pointerup', end, true);
      document.addEventListener('pointercancel', end, true);
    });
    go.addEventListener('click', () => {
      go.textContent = model.voice() ? VOICE_LABEL : TEXT_LABEL;
      model.ask();
    });
    away.addEventListener('click', () => model.dismiss());
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') model.dismiss();
    });
    return model;
  } catch {
    return null;
  }
}
