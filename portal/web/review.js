// The review of a mock interview: what the interview's card lists when it is opened (activity.js puts it in the card's detail). Each question TAi
// asked is there with a paraphrase of what the student said, how it went in a WORD (never a score: students see words), one sentence on a stronger
// way to say it, and a "Practise this" button. The lines come from the activity line's `items` (src/voice/review.ts makes them when the call ends,
// src/portal/history.ts keeps at most eight); an older line has none and its card is what it was.
//
// "Practise this" is the student's own click and nothing happens before it: it starts a "Talk it through" call on that question when voice calls
// are on (and no call is going), and otherwise puts the student's own message "Let's practise: <question>" into the chat. What it does is the
// page's (app.js registers it with setPractise, because it needs the call and the message box); this file chooses between the two (practiceOf).
//
// Everything on screen is text, never HTML: the questions and the sentences are model-written, from a student's words.

const MAX_ITEMS = 8;
const FIELD_CHARS = 240;
const TOPIC_CHARS = 120;
/** What voice.js keeps of the topic a "Talk it through" call is started with (startMessage). */
const CALL_TOPIC_CHARS = 200;
/** A button pressed twice does not start two things: it is out of use for a moment. */
const PRESSED_MS = 1500;

export const SAID_LABEL = 'You said: ';
export const BETTER_LABEL = 'A stronger way to say it: ';
export const PRACTISE_LABEL = 'Practise this';
export const TITLE = 'Questions from this interview';

/** How it went, in the words the page uses for where something stands (src/voice/competency.ts levelWord), and the tone each is drawn in. */
const TONES = { solid: 'good', 'getting there': 'mid', 'just started': 'low', 'not started': 'low' };

const oneLine = (value, max) => {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/**
 * The items of an activity line as the card may list them: at most eight, each with a question (one without says nothing and is dropped), every
 * field a string on one line of at most 240 characters, and a band only when it is a word (a number is no band). The server cleans the same
 * way; this is for the page not to trust a line it was handed, whatever wrote it. Never throws.
 */
export function itemsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (out.length >= MAX_ITEMS) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const question = oneLine(entry.question, FIELD_CHARS);
    if (!question) continue;
    const band = oneLine(entry.band, 24).toLowerCase();
    out.push({ question, said: oneLine(entry.said, FIELD_CHARS), band: /^[a-z][a-z -]*$/.test(band) ? band : '', better: oneLine(entry.better, FIELD_CHARS), topic: oneLine(entry.topic, TOPIC_CHARS) });
  }
  return out;
}

/** The tone a band is drawn in: good (solid), mid (getting there), low (just started, not started), or none for a word this page does not know. */
export const toneOf = (band) => TONES[band] || 'none';

/**
 * What the card says of one item, as text in order: the question, "You said: ..." and "A stronger way to say it: ..." (each only when there is
 * something to say), the band word and its tone, and the topic. A line is the label and the words after it, so a screen reader reads one sentence.
 */
export function viewOf(item) {
  const part = (label, text) => (text ? { label, text } : null);
  return { question: item.question, said: part(SAID_LABEL, item.said), better: part(BETTER_LABEL, item.better), band: item.band, tone: toneOf(item.band), topic: item.topic };
}

/** The question cut at a word to what a call's topic may be (200 characters): the call hears it as what the student wants to talk through. */
export function topicOf(item) {
  const question = item.question;
  if (question.length <= CALL_TOPIC_CHARS) return question;
  const cut = question.slice(0, CALL_TOPIC_CHARS);
  const at = cut.lastIndexOf(' ');
  return (at > CALL_TOPIC_CHARS * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, '');
}

/** The student's own message when "Practise this" goes to the chat. */
export const practiceText = (item) => `Let's practise: ${item.question}`;

/**
 * What "Practise this" does. With voice calls on and no call going: a "Talk it through" call on the question (`mode: 'talk'` and a `topic`, as voice.js
 * starts one). Otherwise (voice off, or a call is on already: what is typed during a call joins it): the student's message in the chat. Never both,
 * and never anything without the click that asks for it.
 */
export function practiceOf({ voiceCalls = false, callActive = false } = {}, item) {
  if (voiceCalls && !callActive) return { kind: 'call', mode: 'talk', topic: topicOf(item) };
  return { kind: 'chat', text: practiceText(item) };
}

let registered = null;

/** What the button does, registered once by the page (it needs the call and the message box): `fn(item)` runs inside the click itself. */
export function setPractise(fn) {
  registered = typeof fn === 'function' ? fn : null;
}

/**
 * The list of a card's items, as a node. `practise(item)` is what a button runs (default: what the page registered); without either there is no
 * button, because nothing is drawn that does not work. `doc` is the document (tests hand a small one).
 */
export function reviewList(items, { practise = registered, doc = document } = {}) {
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = el('div', 'review');
  root.append(el('p', 'review-title', TITLE));
  const list = el('ol', 'review-list');
  for (const item of items) {
    const view = viewOf(item);
    const row = el('li', 'review-item');
    row.dataset.tone = view.tone;
    // the band and the topic, small, above the question: either may be missing, and then so is the line
    const tags = [];
    if (view.band) {
      const chip = el('span', 'review-band', view.band);
      chip.dataset.tone = view.tone;
      tags.push(chip);
    }
    if (view.topic) tags.push(el('span', 'review-topic', view.topic));
    if (tags.length) {
      const head = el('div', 'review-head');
      head.append(...tags);
      row.append(head);
    }
    row.append(el('p', 'review-q', view.question));
    for (const [name, part] of [['review-said', view.said], ['review-better', view.better]]) {
      if (!part) continue;
      const line = el('p', name);
      line.append(el('span', 'review-label', part.label), doc.createTextNode(part.text));
      row.append(line);
    }
    if (practise) {
      const button = el('button', 'review-practise', PRACTISE_LABEL);
      button.type = 'button';
      button.setAttribute('aria-label', `${PRACTISE_LABEL}: ${view.question}`);
      button.addEventListener('click', () => {
        // inside the click itself: starting a call needs the gesture (the microphone, and the sound on iOS)
        practise(item);
        button.disabled = true;
        setTimeout(() => {
          button.disabled = false;
        }, PRESSED_MS);
      });
      row.append(button);
    }
    list.append(row);
  }
  root.append(list);
  return root;
}
