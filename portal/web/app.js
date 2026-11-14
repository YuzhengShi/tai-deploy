// TAi's page: sign in with Google, then one conversation laid out like a messaging app. Everything the server (or a model) sends is put
// on the page as text or through markdown.js, never as HTML. The voice call and the voice-note recorder live in voice.js, the voice note's
// bubble (play, waveform, words) in notes.js, the activity list in activity.js, the options a student can tap in choices.js, what a voice call
// leaves in the conversation in speech.js; this file gives them the few hooks they need (a toast, what to do with a recording, what a tap sends).
import { cardOf, createActivityPanel, createCard } from './activity.js';
import { copyTextOf, createChoices, optionsOf, standOf, tapText, viewOf } from './choices.js';
import { renderMarkdown } from './markdown.js';
import { createVoiceNote, stopPlaying } from './notes.js';
import { createSpeaking, eventOf, isSpeech, markerText, spokenOf, spokenSearchText } from './speech.js';
import { createCall, createNoteRecorder } from './voice.js';
import { practiceOf, setPractise } from './review.js';
import { createPresence, createSettings } from './settings.js';
import { lookedAt } from './sources.js';
import { LONGEST_TEXT, createAnnouncer, noteText, previewText, statusView, withoutPreview } from './status.js';
import { objectRow, setObjectHelpers, viewerApi } from './objects.js';
import { createViewState } from './view-state.js';
import './runcard.js';                      // the cards register their renderers on import (objects.js)
import './doccard.js';
import './chartcard.js';
import './tracecard.js';
import './predictcard.js';
import { initViewer, offerOpen } from './viewer.js';
import { initAskHere } from './askhere.js';

// The mock interview's link (/interview/<token>, behind the page's base path) opens this page. The token is read here, before anything
// else runs, kept in memory only (never in storage, an address or a log), and taken out of the address bar and the session history at once.
const BASE_PATH = new URL('.', document.baseURI).pathname;
let interviewToken = (() => {
  const rest = location.pathname.startsWith(BASE_PATH) ? location.pathname.slice(BASE_PATH.length) : '';
  const match = /^interview\/([A-Za-z0-9_.-]{1,2000})$/.exec(rest);
  if (!match) return '';
  history.replaceState(null, '', BASE_PATH);
  return match[1];
})();

const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const els = {
  chat: $('#chat'), scroller: $('#scroller'), messages: $('#messages'), banner: $('#banner'), toast: $('#toast'), ring: $('#avatar-ring'),
  input: $('#input'), send: $('#send'), mic: $('#mic'), composer: $('#composer'), count: $('#count'), plus: $('#plus'),
  jump: $('#jump'), jumpText: $('#jump-text'), jumpLive: $('#jump-live'),
  account: $('#account'), avatar: $('#avatar'), avatarLetter: $('#avatar-letter'), avatarName: $('#avatar-name'), menu: $('#menu'), menuName: $('#menu-name'), menuEmail: $('#menu-email'),
  railMain: $('#rail-main'), railActivity: $('#rail-activity'), chatsBtn: $('#chats-btn'),
  drawer: $('#drawer'), drawerList: $('#drawer-list'), drawerActivity: $('#drawer-activity'), scrim: $('#scrim'), searchInput: $('#search-input'),
  fileInput: $('#file-input'), tray: $('#tray'),
  dropzone: $('#dropzone'), callGroup: $('#call-group'), callBtn: $('#call-btn'), callMore: $('#call-more'), callMenu: $('#call-menu'),
  activity: $('#activity'),
  lightbox: $('#lightbox'), lightboxImg: $('#lightbox-img'), lightboxClose: $('#lightbox-close'),
  interview: $('#interview'), interviewStart: $('#interview-start'), interviewLater: $('#interview-later'),
  statusLive: $('#status-live'),
};

const POLL_WAIT_SECONDS = 25;
const STAMP_GAP_MS = 30 * 60 * 1000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MEDIA_ID = /^[0-9a-f]{32}$/;
const MAX_FILES = 5;                       // what one message may carry (the server's limit too)
const AWAY_PX = 80;                        // further than this from the latest message, and the way down is offered
const LONG_PRESS_MS = 480;                 // a press this long on one of TAi's messages (on a touch screen) opens the choice of emoji
// what the student may put on one of TAi's messages: the same six as the server takes
const REACTIONS = [['👍', 'thumbs up'], ['❤️', 'heart'], ['😂', 'laughing'], ['😮', 'surprised'], ['😢', 'sad'], ['🙏', 'thank you']];
const PICTURE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const ICONS = {
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  reply: ['M10 6 4 12l6 6', 'M4 12h9a7 7 0 0 1 7 7'],
  calendar: ['M5 7h14v12H5z', 'M5 11h14', 'M9 4v4', 'M15 4v4'],
  help: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M9.6 9.7a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1.1.9-1.1 1.7', 'M12 16.6h.01'],
  code: ['M8 8l-4 4 4 4', 'M16 8l4 4-4 4', 'M13.5 6l-3 12'],
  bolt: ['M9 18h6', 'M10 21h4', 'M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.1 1 1.9V16h5.2v-.3c0-.8.4-1.4 1-1.9A6 6 0 0 0 12 3z'],
  file: ['M7 3.5h6.5L18 8v12.5H7z', 'M13.5 3.5V8H18'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  smile: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M8.4 13.4a4.3 4.3 0 0 0 7.2 0', 'M9.2 9.7h.01', 'M14.8 9.7h.01'],
  wave: ['M4 10v4', 'M8 7v10', 'M12 4v16', 'M16 8v8', 'M20 11v2'],
};
// where a student can start: the first one sends at once, the others leave the sentence in the box to be finished; the last starts a voice
// call (only where the server offers calls) in which TAi listens while the student explains something out loud
const STARTERS = [
  { icon: 'calendar', title: "What's due this week?", sub: 'Deadlines, and how you are doing, from Canvas', send: "What's due this week, and how am I doing so far?" },
  { icon: 'help', title: 'Help me get unstuck', sub: 'Talk a concept or a bug through', fill: "I'm stuck on " },
  { icon: 'code', title: 'Look at my GitHub repo', sub: 'Feedback on your code', fill: 'Can you look at my repo ' },
  { icon: 'bolt', title: 'Quiz me', sub: 'Practice before an exam', fill: 'Quiz me on ' },
  { icon: 'wave', title: 'Talk it through out loud', sub: 'Explain it by voice and TAi listens', call: 'talk' },
];
// what the server may switch on (GET api/me says); with all of it off the page is the text chat and its Activity list
const NO_FEATURES = { files: false, pictures: false, voiceNotes: false, voiceCalls: false, activity: false, choices: false, viewer: false, maxUploadBytes: 0, voiceNoteSeconds: 180, accept: [] };

const state = {
  user: null,
  unread: 0,               // answers that arrived while this tab was behind another: the tab's title counts them
  epoch: 0,                // changes at sign-out: a poll from before it must not touch what comes after
  last: 0,                 // the newest message number we hold
  maxChars: 6000,
  features: NO_FEATURES,
  config: { enabled: false, clientId: '' },
  nonce: '',
  nonceTimer: 0,
  slot: null,              // where Google's button is drawn
  entries: [],             // every message we hold, oldest first (the drawer's days and its search read these)
  rows: new Map(),         // message number -> its row
  reactions: new Map(),    // a student message's number -> TAi's emoji on it
  myReactions: new Map(),  // one of TAi's messages' number -> the student's own emoji on it
  reactBusy: new Map(),    // message number -> how many of the student's emoji changes on it are still on their way to the server
  reactChain: Promise.resolve(),   // the changes go one after another, so the server ends up with the last one
  picker: null,            // the open choice of emoji: { row, opener }
  unseen: new Set(),       // rows of TAi's that arrived while the reader was away from the bottom and whose bottom edge has not been in view since
  toEnd: false,            // a smooth scroll to the latest message is under way (the pill stays out of its way)
  notes: new Set(),        // the voice notes on the page (their players are let go when the conversation is cleared)
  blobUrls: new Set(),     // local copies of recordings that were sent from this page
  lastUserN: 0,            // the student's newest numbered message
  callWasOn: false,        // the call was going the last time the layout was drawn (a call that begins makes the view be reported again)
  pending: [],             // sent, not yet numbered: { text, files, row, n? }
  awaiting: false,         // a message of ours has no reply yet
  serverTyping: false,
  status: null,            // what TAi is doing for us, as the server says (status.js): { state, label?, ahead? }, only while it works or waits
  sv: 0,                   // the version of it we have seen: the poll comes back at once when there is a newer one
  sentAt: 0,
  stick: true,             // follow the newest message while the reader is at the bottom
  tick: 0,
  typingRow: null,
  speakRow: null,          // the "..." of words being said in a call that have not come back as a line yet
  lastRole: null,
  lastTs: 0,
  noteRow: null,
  tray: [],                // files chosen for the next message: { key, file, name, size, phase: uploading|done|failed, ... }
  trayKey: 0,
  lightboxOpener: null,
};

// ---------------------------------------------------------------- small helpers

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function storage(action, key, value) {
  try {
    if (action === 'set') localStorage.setItem(key, value);
    else if (action === 'remove') localStorage.removeItem(key);
    else return localStorage.getItem(key);
  } catch {
    /* private window or blocked storage: the page works without */
  }
  return null;
}

/** What every POST of the page carries: its type, and the header a form on another site cannot set. */
const postHeaders = (type) => ({ 'content-type': type, 'x-tai': '1' });

/** Where the message box's unsent words are kept, so a reload does not lose them. */
const DRAFT_KEY = 'tai.draft';

async function api(path, { method = 'GET', body, bytes, type } = {}) {
  let headers = {};
  let payload;
  if (method !== 'GET') {
    headers = postHeaders(type || (bytes ? 'application/octet-stream' : 'application/json'));
    payload = bytes || JSON.stringify(body ?? {});
  }
  try {
    const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

function toast(message, ms = 4500) {
  // above whatever sits over the message box (files, a call, a recording, the "N messages" pill), so it never covers them
  const top = els.composer.parentElement.getBoundingClientRect().top;
  els.toast.style.bottom = top > 0 ? `${Math.round(innerHeight - top + (els.jump.hidden ? 12 : 64))}px` : '';
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (els.toast.hidden = true), ms);
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** An upload's or a voice note's error answer, as a sentence (never the code). */
function uploadProblem(status, data) {
  const error = data && data.error;
  if (error === 'voice-notes-off') return 'Voice notes are switched off right now. Type your message instead.';
  if (error === 'unavailable') return 'TAi could not be reached just now. Try again in a moment.';
  if (status === 413) return error === 'quota' ? 'Your space for files on TAi is full. Ask the teaching team to make room.' : `That file is too big for TAi (the limit is ${humanSize(state.features.maxUploadBytes || 5 * 1024 * 1024)}).`;
  if (status === 415) return "TAi can't read that kind of file.";
  if (status === 429) return error === 'too-many-pending' ? 'You have too many files waiting. Send them with a message first.' : 'You are sending a lot at once. Wait a few minutes, then try again.';
  if (status === 401) return 'Your session ended. Sign in again.';
  if (status === 0) return 'I cannot be reached right now. Check your connection.';
  return 'That did not work. Try again in a moment.';
}

const isDark = () => {
  const forced = document.documentElement.dataset.theme;
  return forced === 'dark' || (forced !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
};

function applyTheme(choice) {
  document.documentElement.dataset.theme = choice || 'auto';
}

/** What a voice note's failed upload says: the file words of uploadProblem, with the voice note's own for too big and a full space. */
function voiceNoteProblem(status, data) {
  const error = data && data.error;
  if (status === 413) return error === 'quota' ? 'Your space for voice notes on TAi is full. Ask the teaching team to make room.' : 'That voice note is too big to send. Record a shorter one.';
  if (status === 415) return "TAi can't play that recording.";
  return uploadProblem(status, data);
}

// the voice call (an orb above the message box, its buttons in the box) and the voice-note recorder (takes the box's place while it records):
// voice.js. Its words are not drawn there: they are lines of the conversation (speech.js), which addEntries draws like any other
const call = createCall({
  toast,
  onChange: () => {
    drawFeatures();
    callLayout();
  },
  // what the call tells of the student speaking: the "..." that stands for their words until the line arrives
  onSpeaking: (kind) => {
    const act = { started: speaking.started, voice: speaking.voice, heard: speaking.heard, stop: speaking.stop }[kind];
    if (act) act();
  },
  // what TAi does to the student's screen in a call: `show` (go to a page), `point` (draw boxes), `doc_state` (a document is being prepared): the viewer's
  onScreen: (message) => viewerApi.screen(message),
});

// where the student is looking (view-state.js): the call's socket during a call, a POST otherwise; the server describes it to TAi when it is wanted
const viewState = createViewState({
  send: (view) => {
    if (call.active() && typeof call.sendView === 'function' && call.sendView(view)) return;
    api('api/view', { method: 'POST', body: view });
  },
});
const speaking = createSpeaking({ show: () => showSpeaking(), hide: () => hideSpeaking() });
const recorder = createNoteRecorder({
  toast,
  // a recording is sent as it is: it shows in the conversation at once, as the student's own message, and goes up from there
  onSend: (note) => sendVoiceNote(note),
  onChange: (recording) => {
    els.composer.hidden = recording;
    updateSend();
    if (!recording && matchMedia('(hover: hover)').matches) els.input.focus();      // (not on a phone: the keyboard would cover the conversation)
  },
});

// what happened for the student, day by day: calls, the notes TAi kept, reminders, progress, news of the course; a sheet that the rail's
// Activity button opens (on a phone, which has no rail, the Chats drawer's entry does). A card of it is also in the conversation, at the place
// where it happened (activity.js). The rail's button looks pressed while the sheet is open.
const activityPanel = createActivityPanel({
  dialog: els.activity,
  api,
  toast,
  onSignedOut: () => showSignIn('Your session ended. Sign in again to carry on.'),
  canShow: (n) => state.rows.has(n),
  showInChat: (n) => showCard(n),
  onToggle: (open) => els.railActivity.setAttribute('aria-expanded', String(open)),
});

// the account menu's Settings (notifications in this browser, the voice's speed, the time zone) and the page's sign of life for the server, which
// does not push a message to a page that is open and in front (settings.js; docs/NOTIFICATIONS.md)
const presence = createPresence();
const settings = createSettings({
  api,
  toast,
  onSignedOut: () => showSignIn('Your session ended. Sign in again to carry on.'),
  closeMenus: () => closeMenus(),
  avatar: els.avatar,
});

function setView(name) {
  const signedIn = name === 'chat';
  app.dataset.state = name;
  $('#loading').hidden = name !== 'loading';
  els.chat.hidden = name === 'loading';
  els.chat.dataset.mode = signedIn ? 'chat' : 'gate';
  els.account.hidden = !signedIn;
  els.chatsBtn.hidden = !signedIn;
  els.railMain.hidden = !signedIn;
  els.input.disabled = !signedIn;
  els.plus.disabled = !signedIn;
  els.input.placeholder = signedIn ? 'Message' : 'Sign in to message TAi';
  if (!signedIn) {
    els.send.disabled = true;
    closeDrawer();
    closeMenus();
  }
  drawFeatures();
}

/** The controls of what the server switched on, and nothing else: a button that does nothing is not drawn. */
function drawFeatures() {
  const on = app.dataset.state === 'chat' ? state.features : NO_FEATURES;
  els.plus.hidden = !on.files;                                // "attach a file": not there when the server has no files
  els.railActivity.hidden = !on.activity;                     // the Activity list: the rail's button, and the Chats drawer's entry (a phone has no rail)
  els.drawerActivity.hidden = !on.activity;
  $('#menu-team').hidden = !on.team;                          // the teaching view: only the owner's account menu has it (the server answers it to no one else)
  els.callGroup.hidden = !on.voiceCalls || call.active();     // the call button and the way to its other kind
  if (els.callGroup.hidden) closeCallMenu(false);
  const accept = on.accept.map((ext) => `.${ext}`);
  if (on.pictures) accept.push(...new Set(Object.values(PICTURE_TYPES)));
  els.fileInput.accept = accept.join(',');
  updateSend();                                               // the microphone is drawn only when voice notes are on
}

function readFeatures(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const max = Number(f.maxUploadBytes) || 0;
  const listed = Array.isArray(f.accept) ? f.accept.filter((x) => typeof x === 'string' && /^[A-Za-z0-9]{1,10}$/.test(x)).map((x) => x.toLowerCase()) : [];
  const files = f.files === true && listed.length > 0 && max > 0;
  const pictures = files && f.pictures === true;
  // the server lists the picture extensions whether or not it can keep pictures: without pictures they are not offered
  const seconds = Number(f.voiceNoteSeconds);
  return {
    files, pictures, voiceNotes: f.voiceNotes === true, voiceCalls: f.voiceCalls === true, activity: f.activity === true, choices: f.choices === true, maxUploadBytes: max,
    voiceNoteSeconds: seconds > 0 ? Math.min(600, Math.floor(seconds)) : NO_FEATURES.voiceNoteSeconds,
    team: f.team === true,
    viewer: f.viewer === true,                                // the document viewer and what it reports (docs/CHAT_OBJECTS.md)
    accept: files ? listed.filter((x) => pictures || !PICTURE_TYPES[x]) : [],
  };
}

/** The tab's title: "TAi", and how many answers came while the tab was behind another one. */
function showTitle() {
  document.title = `${state.unread ? `(${state.unread}) ` : ''}TAi`;
}

// ---------------------------------------------------------------- rows

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const stampText = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fullTime = (ts) => new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function dayLabel(date) {
  if (date.toDateString() === new Date().toDateString()) return 'Today';
  if (date.toDateString() === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function stamp(ts) {
  return el('li', 'stamp', stampText(ts));
}

/**
 * Puts a row at the end: a time stamp first when the day changes or it has been quiet a while, more room when the speaker changes. Answers the
 * time stamp it put there (or null), for a row that is taken away again.
 */
function place(row, role, ts) {
  // what floats at the end (TAi's dots, the "..." of the student speaking) stays last: a row goes in before it
  const floating = [state.speakRow, state.typingRow].filter((node) => node && node.isConnected);
  for (const node of floating) node.remove();
  let added = null;
  if (state.lastTs === 0 || !sameDay(state.lastTs, ts) || ts - state.lastTs > STAMP_GAP_MS) {
    added = stamp(ts);
    els.messages.append(added);
  }
  row.classList.toggle('turn', state.lastRole !== null && state.lastRole !== role);
  els.messages.append(row);
  state.lastRole = role;
  state.lastTs = Math.max(ts, state.lastTs);
  for (const node of floating) els.messages.append(node);
  return added;
}

/**
 * What can be done with a reply, beside its bubble: add an emoji (`canReact`: for a text or a picture of TAi's that the server has numbered),
 * copy it, quote it in the message box.
 */
function actionBar(canReact, canQuote = true) {
  const bar = el('div', 'actions');
  const buttons = [['copy', 'Copy this reply', 'copy']];
  if (canQuote) buttons.push(['quote', 'Quote this reply in your message', 'reply']);
  if (canReact) buttons.unshift(['react', 'Add a reaction', 'smile']);
  for (const [act, label, name] of buttons) {
    const button = el('button', 'act');
    button.type = 'button';
    button.dataset.act = act;
    button.title = label;
    button.setAttribute('aria-label', label);
    if (act === 'react') {
      button.setAttribute('aria-haspopup', 'true');
      button.setAttribute('aria-expanded', 'false');
    }
    button.append(icon(name));
    bar.append(button);
  }
  return bar;
}

/** A picture's description for a screen reader: the first sentence of what TAi wrote with it, without the Markdown. */
function altText(caption) {
  const plain = String(caption || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const first = /^.{1,200}?[.!?](?=\s|$)/.exec(plain);
  const sentence = (first ? first[0] : plain).trim();
  if (!sentence) return 'A picture from TAi';
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}

/**
 * A picture in a fixed frame (its size is set before the bytes arrive, so a picture loading never moves what is on the screen); a click
 * enlarges it. `kind` is "pic" (TAi's diagram) or "thumb" (a picture the student attached).
 */
function picture(media, alt, kind) {
  const button = el('button', kind);
  button.type = 'button';
  button.setAttribute('aria-label', `Enlarge the picture: ${alt}`);
  const img = el('img');
  img.alt = alt;
  img.decoding = 'async';
  img.loading = 'lazy';
  img.addEventListener('load', () => button.classList.add('loaded'), { once: true });
  img.addEventListener('error', () => {
    button.classList.add('broken');
    button.disabled = true;
    button.removeAttribute('aria-label');
    button.replaceChildren(el('span', 'pic-missing', kind === 'pic' ? 'The picture could not be loaded.' : alt));
  }, { once: true });
  img.src = `api/media/${media}`;
  button.append(img);
  return button;
}

/** Can this assistant line be shown at all: words, or a picture. */
const showable = (entry) => !!(entry.text || (entry.kind === 'image' && MEDIA_ID.test(entry.media || '')) || (entry.kind === 'object' && entry.obj));

/** An activity line of TAi's (a call, a note it kept, a reminder), or a call summary of the older kind: a card, not something TAi said. */
const isActivityLine = (entry) => entry.role !== 'user' && (entry.kind === 'activity' || entry.kind === 'voice');

function assistantRow(entry, ts) {
  const row = el('li', 'row assistant');
  const text = entry.text || '';
  let bubble;
  if (entry.kind === 'image') {
    // a diagram is TAi's whole answer: the picture and the words under it are one message
    bubble = el('div', 'bubble has-pic');
    if (MEDIA_ID.test(entry.media || '')) bubble.append(picture(entry.media, altText(text), 'pic'));
    if (text) {
      const md = el('div', 'md');
      md.append(renderMarkdown(text));
      bubble.append(md);
    }
  } else {
    // the words in a box of their own inside the bubble: an emoji on the bubble's corner is its last child, and must not be what the
    // markdown's "last child has no margin below" rule takes for the last paragraph
    bubble = el('div', 'bubble');
    const md = el('div', 'md');
    md.append(renderMarkdown(text));
    bubble.append(md);
  }
  bubble.title = fullTime(ts);
  row._text = text;
  // what TAi opened for this reply ("Looked at", sources.js): under its words, before any options; the copy above is the words alone
  const looked = lookedAt(entry.sources);
  if (looked) bubble.append(looked);
  if (entry.n !== undefined) row.dataset.n = entry.n;
  // a question with options to tap (a quick check, or ways to answer): buttons in the bubble, painted from the lines the page holds
  const options = state.features.choices && entry.n !== undefined ? optionsOf(entry) : null;
  if (options) {
    const choices = createChoices(entry, options, { onPick: (index) => chooseOption(row, index) });
    bubble.append(choices.node);
    row.classList.add('has-choices');
    row._choices = { options, view: choices, local: { picked: null, closed: false } };
    row._text = copyTextOf(entry, options);
  }
  // a text or a picture of TAi's can be reacted to (the greeting and the card of places to start have no number)
  const canReact = entry.n !== undefined;
  if (canReact) row.dataset.react = '1';
  row.append(bubble, actionBar(canReact));
  return row;
}

/**
 * The card of an activity line, in the conversation: it is no reply (no emoji, copy or quote), and counts as nothing unread. It opens when it
 * has a detail to show; one with only its title and its line is a plain card.
 */
function activityRow(entry) {
  const card = cardOf(entry);
  if (!card) return null;
  const row = el('li', 'row activity');
  row.dataset.n = entry.n;
  row.dataset.type = card.type;
  row._text = card.text;
  const view = createCard(card, { variant: 'in-chat', id: `acard-${entry.n}` });
  row._card = view;
  view.head.title = fullTime(Date.parse(entry.ts) || Date.now());
  row.append(view.node);
  return row;
}

/** Takes the reader to a card in the conversation and opens it (the Activity sheet's "Show in the conversation"). */
function showCard(n) {
  const row = state.rows.get(n);
  if (!row) return;
  goTo(n, 'center');
  if (row._card) row._card.toggle(true);
}

// ---------------------------------------------------------------- a voice call in the conversation (speech.js)

/**
 * What was said aloud in a call, as a bubble of the conversation: the student's on the right in blue, TAi's like its replies, each with a small
 * waveform that tells spoken from typed. It is not a message (no reaction, no quote; TAi's can be copied), and it is not read out by a screen
 * reader: the call said it aloud already. A long one is folded, with "...more".
 */
function speechRow(entry, ts) {
  const spoken = spokenOf(entry);
  if (!spoken) return null;
  const row = el('li', `row speech ${spoken.you ? 'you' : 'tai'}`);
  row.dataset.n = entry.n;
  row.setAttribute('aria-live', 'off');
  const bubble = el('div', 'bubble is-spoken');
  const say = el('div', 'say');
  const glyph = icon('wave');
  glyph.setAttribute('class', 'say-glyph');
  glyph.setAttribute('role', 'img');
  glyph.setAttribute('aria-label', 'Spoken');
  glyph.removeAttribute('aria-hidden');
  const words = el('span', 'say-text', spoken.text);
  say.append(glyph, words);
  bubble.append(say);
  if (spoken.long) {
    words.classList.add('is-folded');
    const more = el('button', 'say-more', '…more');
    more.type = 'button';
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => {
      const folded = words.classList.toggle('is-folded');
      more.setAttribute('aria-expanded', String(!folded));
      more.textContent = folded ? '…more' : 'less';
    });
    bubble.append(more);
  }
  bubble.title = fullTime(ts);
  row._text = spoken.text;
  row.append(bubble);
  if (!spoken.you) row.append(actionBar(false, false));
  return row;
}

/** The start of a call, a switch of its kind, its end: a small divider, not a message ("Voice call · 3:42 PM", "Call ended · 8 min"). */
function markRow(entry, ts) {
  const text = markerText(entry, new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  if (!text) return null;
  const row = el('li', 'row call-mark');
  row.dataset.n = entry.n;
  row.dataset.event = eventOf(entry);
  row.setAttribute('aria-live', 'off');
  row.title = fullTime(ts);
  row._text = text;
  row.append(el('span', 'call-mark-text', text));
  return row;
}

/** The "..." on the right while the student is speaking and the line of what they said has not arrived: grey, and gone when it does. */
function showSpeaking() {
  if (state.speakRow) return;
  const row = el('li', 'row speech you pending');
  row.setAttribute('aria-hidden', 'true');
  const bubble = el('div', 'bubble');
  const dots = el('span', 'dots');
  dots.append(el('i'), el('i'), el('i'));
  bubble.append(dots);
  row.append(bubble);
  row.classList.toggle('turn', state.lastRole !== 'user');
  state.speakRow = row;
  els.messages.append(row);
  afterAppend(false);
}

function hideSpeaking() {
  if (!state.speakRow) return;
  state.speakRow.remove();
  state.speakRow = null;
}

/**
 * The message box and the conversation for a call that has begun or ended: the box says "Type" (what is typed joins the call), the call's mute
 * and end buttons are in it in place of the microphone, and the conversation keeps its bottom while the orb's room comes or goes.
 */
function callLayout() {
  const on = call.active();
  if (on && !state.callWasOn) viewState.resend();      // the server's copy of the view belongs to the call: it is told again
  state.callWasOn = on;
  els.composer.classList.toggle('in-call', on);
  els.input.placeholder = on ? 'Type' : state.user ? 'Message' : 'Sign in to message TAi';
  if (!on) speaking.stop();
  updateSend();
  if (state.stick) scrollToEnd(false);
}

// ---------------------------------------------------------------- options to tap: a quick check, or ways to answer a question (choices.js)

/**
 * Sets the look of the options of one of TAi's lines from what the page holds: the later lines say whether they are still open, answered (and by
 * which, and whether it was right) or closed. Only the state of the buttons changes, never the buttons themselves, so a poll that comes while
 * the reader is on one leaves the focus where it was. `announce`: a verdict that has just arrived is said (not one that is only being read back).
 */
function paintChoices(row, announce) {
  const mine = row._choices;
  if (!mine) return;
  const n = Number(row.dataset.n);
  const said = state.pending.some((p) => !p.tap && !p.failed); // a message of theirs is on its way (a voice note that did not go has said nothing): the options are closed already
  const view = viewOf(mine.options, standOf(state.entries, n, { said }), mine.local);
  const before = mine.view.phase();
  mine.view.paint(view);
  if (announce && view.phase === 'answered' && before !== 'answered' && view.verdict) mine.view.announce(view.verdict);
}

function paintAllChoices(announce) {
  for (const row of els.messages.querySelectorAll('.row.has-choices')) paintChoices(row, announce);
}

/**
 * A tap on an option. The student's own message (the letter and the option) is on the page at once, as a sent message is; the buttons are all
 * off with the one tapped marked; the server grades it (`correct`, only when TAi marked an answer) and hands TAi the tap. When it could not take
 * the tap, nothing was recorded: the message goes again and the options come back, or, if they are closed now, settle to that.
 */
async function chooseOption(row, index) {
  const mine = row._choices;
  const n = Number(row.dataset.n);
  const option = mine && mine.options[index];
  if (!option || !state.user || mine.local.picked !== null) return;
  const text = tapText(option);
  const now = Date.now();
  const bubble = userRow(text, now, []);
  const item = { text, files: 0, row: bubble, tap: true };
  const lastRole = state.lastRole;
  const lastTs = state.lastTs;
  state.pending.push(item);
  const stampRow = place(bubble, 'user', now);
  state.stick = true;
  state.awaiting = !call.active();                             // in a call the answer comes by voice
  state.sentAt = now;
  afterAppend(false);
  updateStatus();
  mine.local = { picked: index, closed: false };
  paintChoices(row);
  const epoch = state.epoch;
  const reply = await api('api/choose', { method: 'POST', body: { to: n, index } });
  if (epoch !== state.epoch) return;
  if (reply.status === 200 && reply.data && reply.data.ok === true) {
    const correct = typeof reply.data.correct === 'boolean' ? reply.data.correct : undefined;
    if (item.n === undefined) {                                // the poll has not brought the line back yet
      item.n = reply.data.n;
      bubble.dataset.n = reply.data.n;
      state.rows.set(reply.data.n, bubble);
      state.lastUserN = Math.max(state.lastUserN, reply.data.n);
      state.entries.push({ n: reply.data.n, role: 'user', text, ts: new Date(now).toISOString(), choice: { to: n, index, ...(correct !== undefined ? { correct } : {}) } });
      state.pending = state.pending.filter((p) => p !== item);
      showReaction(reply.data.n, true);
    }
    mine.local = { picked: null, closed: false };
    paintChoices(row, true);
    return;
  }
  // not recorded: the message goes again (as if it had not been sent), and the options come back, or settle to what the server said
  state.pending = state.pending.filter((p) => p !== item);
  const untouched = !bubble.nextElementSibling || bubble.nextElementSibling === state.typingRow;
  bubble.remove();
  if (stampRow) stampRow.remove();
  if (untouched) {
    state.lastRole = lastRole;
    state.lastTs = lastTs;
  }
  state.awaiting = false;
  updateStatus();
  const status = reply.status;
  const error = reply.data && reply.data.error;
  mine.local = { picked: null, closed: status === 409 || status === 404 };
  paintChoices(row);
  if (status === 401) {
    toast('Your session ended. Sign in again.');
    showSignIn('Your session ended. Sign in again to carry on.');
    return;
  }
  toast(
    status === 409 ? (error === 'answered' ? 'You have answered that already.' : 'Those options are closed: something else has been said since.')
      : status === 429 ? 'You are choosing quickly. Wait a moment, then try again.'
        : status === 502 ? 'TAi could not be reached just now. Your options are still here: try again in a moment.'
          : status === 0 ? 'I cannot be reached right now. Check your connection.'
            : "That didn't go through. Try again in a moment.",
  );
}

function fileChip(file) {
  if (file.kind === 'image' && MEDIA_ID.test(file.media || '')) return picture(file.media, file.name, 'thumb');
  const chip = el('span', 'file');
  chip.title = file.name;
  chip.append(icon('file'), el('span', 'file-name', file.name), el('span', 'file-size', humanSize(file.size)));
  return chip;
}

function userRow(text, ts, files) {
  const row = el('li', 'row user');
  const attached = Array.isArray(files) ? files.filter((f) => f && typeof f.name === 'string') : [];
  let bubble;
  if (!attached.length) bubble = el('div', 'bubble', text);
  else {
    bubble = el('div', 'bubble has-files');
    const box = el('div', 'files');
    for (const file of attached) {
      const chip = fileChip(file);
      // a PDF can be opened in the viewer (viewer.js): the message's number is read when the button is pressed, because a message that was just sent gets it from the server's answer
      offerOpen(chip, { n: () => Number(row.dataset.n), index: files.indexOf(file), name: file.name, kind: file.kind });
      box.append(chip);
    }
    bubble.append(box);
    if (text) bubble.append(el('div', 'text', text));
  }
  bubble.title = fullTime(ts);
  row.append(bubble);
  return row;
}

/** A voice note the student sent, as the history holds it (a reload, another tab): the recording is played from api/media/<id>. */
function voiceNoteRow(entry, ts) {
  if (!MEDIA_ID.test(entry.mediaId || '')) return userRow(entry.text || 'Voice note', ts);           // a line with no recording: the words alone
  const peaks = Array.isArray(entry.peaks) ? entry.peaks.filter((v) => Number.isFinite(v)).slice(0, 64) : [];
  const view = createVoiceNote({
    src: `api/media/${entry.mediaId}`, duration: Number(entry.duration) || 0, peaks, seed: entry.n, words: entry.text || '', title: fullTime(ts),
    onProblem: () => toast('That voice note could not be played.'),
  });
  state.notes.add(view);
  const row = el('li', 'row user note-row');
  row.append(view.bubble);
  return row;
}

function noteBubble(text) {
  const row = el('li', 'row assistant');
  row.append(el('div', 'bubble', text));
  return row;
}

function addStarter(first) {
  const now = Date.now();
  const hello = first ? `Hi ${first}!` : 'Hi!';
  place(noteBubble(`${hello} Ask me anything about CS6650, or pick a place to start.`), 'assistant', now);
  const row = el('li', 'row assistant starter');
  const card = el('div', 'card');
  card.append(el('p', 'card-title', 'Where would you like to start?'));
  for (const s of STARTERS.filter((starter) => !starter.call || state.features.voiceCalls)) {
    const button = el('button', 'card-row');
    button.type = 'button';
    if (s.send) button.dataset.send = s.send;
    if (s.fill) button.dataset.fill = s.fill;
    if (s.call) button.dataset.call = s.call;
    const tile = el('span', 'tile');
    tile.append(icon(s.icon));
    const text = el('span', 'card-text');
    text.append(el('strong', undefined, s.title), el('span', undefined, s.sub));
    button.append(tile, text);
    card.append(button);
  }
  row.append(card);
  place(row, 'assistant', now);
}

// ---------------------------------------------------------------- TAi's emoji on a message of the student's

/**
 * A reaction is not a message: no bubble, no time stamp, nothing in the "N messages" pill or the drawer. It is a badge on the corner of
 * the student's bubble it names; a later one on the same message takes its place. It pops when it arrives, not when history is replayed.
 */
function react(entry, live) {
  if (typeof entry.emoji !== 'string' || !entry.emoji || typeof entry.to !== 'number') return;
  state.reactions.set(entry.to, entry.emoji);
  // an emoji on the student's newest message answers it (it can be TAi's whole answer): stop waiting for words; while TAi is still at
  // work the server's typing flag keeps the dots
  if (entry.to >= state.lastUserN) state.awaiting = false;
  showReaction(entry.to, live);
}

function showReaction(n, live) {
  const emoji = state.reactions.get(n);
  const row = state.rows.get(n);
  if (!emoji || !row || !row.classList.contains('user')) return;
  const bubble = row.querySelector('.bubble');
  let badge = bubble.querySelector(':scope > .react');
  if (badge && badge.dataset.emoji === emoji && !live) return;
  if (!badge) {
    badge = el('span', 'react');
    bubble.append(badge);
    row.classList.add('reacted');            // a little more room under it, when the student's next message follows at once
  }
  badge.dataset.emoji = emoji;
  badge.title = `TAi reacted ${emoji}`;
  badge.replaceChildren(el('span', 'sr-only', 'TAi reacted '), document.createTextNode(emoji));
  badge.classList.remove('pop');
  if (live) {
    void badge.offsetWidth;                // start the animation again for a replacement
    badge.classList.add('pop');
  }
}

// ---------------------------------------------------------------- the student's emoji on one of TAi's messages

/**
 * The student's own emoji on a text or a picture of TAi's: a badge on the bubble's lower right corner (a mirror of TAi's on theirs), kept by
 * the server as a line of the history so a reload and a second tab show it too. It is not a message and starts no answer. One emoji for a
 * message: a new one takes the old one's place, and the same one again (or the badge) takes it back.
 */
function myReact(entry, live) {
  if (typeof entry.to !== 'number') return;
  if (state.reactBusy.get(entry.to)) return;             // a change of ours is still on its way: what the page shows is newer than this line
  const emoji = typeof entry.emoji === 'string' ? entry.emoji : '';
  if (emoji && !REACTIONS.some(([known]) => known === emoji)) return;
  if (emoji) state.myReactions.set(entry.to, emoji);
  else state.myReactions.delete(entry.to);
  showMyReaction(entry.to, live);
}

function showMyReaction(n, live) {
  const row = state.rows.get(n);
  const bubble = row && row.classList.contains('assistant') ? row.querySelector(':scope > .bubble') : null;
  if (!bubble) return;
  const emoji = state.myReactions.get(n);
  let badge = bubble.querySelector(':scope > .react.mine');
  if (!emoji) {
    if (badge) badge.remove();
    row.classList.remove('reacted');
    return;
  }
  const changed = !badge || badge.dataset.emoji !== emoji;
  if (!badge) {
    badge = el('button', 'react mine');
    badge.type = 'button';
    badge.setAttribute('aria-haspopup', 'true');
    bubble.append(badge);
    row.classList.add('reacted');
  }
  badge.dataset.emoji = emoji;
  badge.title = `You reacted ${emoji}. Click to change or remove it`;
  badge.replaceChildren(el('span', 'sr-only', 'You reacted '), document.createTextNode(emoji));
  if (changed && live) {
    badge.classList.remove('pop');
    void badge.offsetWidth;
    badge.classList.add('pop');
  }
}

let pickerNode = null;

/** The row of six, made once and moved to the message it is for. */
function pickerElement() {
  if (pickerNode) return pickerNode;
  const picker = el('div', 'picker');
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', 'React to this message');
  for (const [emoji, name] of REACTIONS) {
    const button = el('button', 'pick');
    button.type = 'button';
    button.dataset.emoji = emoji;
    button.title = name;
    button.setAttribute('aria-label', `React with ${name}`);
    button.setAttribute('aria-pressed', 'false');
    button.append(document.createTextNode(emoji));
    picker.append(button);
  }
  picker.addEventListener('click', (event) => {
    const button = event.target.closest('.pick');
    if (!button || !state.picker) return;
    const n = Number(state.picker.row.dataset.n);
    closePicker(true);
    chooseReaction(n, button.dataset.emoji);
  });
  picker.addEventListener('keydown', (event) => {
    const buttons = [...picker.querySelectorAll('.pick')];
    const at = buttons.indexOf(document.activeElement);
    const move = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      buttons[(move + buttons.length) % buttons.length].focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);                               // Tab leaves it, back to where it was opened from
    }
  });
  pickerNode = picker;
  return picker;
}

/** Opens the six emoji beside a reply (`opener`: the button that was used, to give the focus back to; none for a long press). */
function openPicker(row, opener) {
  const n = Number(row.dataset.n);
  if (!n || !row.dataset.react) return;
  if (state.picker && state.picker.row === row) return closePicker(true);
  closePicker(false);
  const picker = pickerElement();
  const mine = state.myReactions.get(n) || '';
  for (const button of picker.children) button.setAttribute('aria-pressed', String(button.dataset.emoji === mine));
  row.append(picker);
  row.classList.add('picking');                   // the row (a stacking context of its own) is raised over the rows after it, so the six are not covered by their pictures
  // above the bubble, unless it is too near the top of the conversation (the top bar covers that part)
  const room = row.getBoundingClientRect().top - els.scroller.getBoundingClientRect().top - ($('.topbar').offsetHeight || 0);
  picker.classList.toggle('below', room < 62);
  const button = opener || row.querySelector('.act[data-act="react"]');
  if (button && button.dataset.act === 'react') button.setAttribute('aria-expanded', 'true');
  state.picker = { row, opener: button };
  (picker.querySelector('[aria-pressed="true"]') || picker.firstElementChild).focus({ preventScroll: true });
  picker.scrollIntoView({ block: 'nearest' });
}

function closePicker(refocus) {
  const open = state.picker;
  if (!open) return;
  state.picker = null;
  if (pickerNode) pickerNode.remove();
  open.row.classList.remove('picking');
  const button = open.row.querySelector('.act[data-act="react"]');
  if (button) button.setAttribute('aria-expanded', 'false');
  if (refocus && open.opener && open.opener.isConnected) open.opener.focus({ preventScroll: true });
}

/** The student picks an emoji for a message: the same as there is takes it back. The page shows it at once; the server keeps it. */
function chooseReaction(n, emoji) {
  const before = state.myReactions.get(n) || '';
  const next = before === emoji ? '' : emoji;
  if (next) state.myReactions.set(n, next);
  else state.myReactions.delete(n);
  showMyReaction(n, true);
  const epoch = state.epoch;
  state.reactBusy.set(n, (state.reactBusy.get(n) || 0) + 1);
  // one change after another (so the server ends with the last), and while any is on its way the lines the poll brings do not override the page
  state.reactChain = state.reactChain.then(async () => {
    const reply = epoch === state.epoch ? await api('api/react', { method: 'POST', body: { to: n, emoji: next } }) : { status: 200 };
    const left = (state.reactBusy.get(n) || 1) - 1;
    if (left > 0) state.reactBusy.set(n, left);
    else state.reactBusy.delete(n);
    if (epoch !== state.epoch || reply.status === 200) return;
    // not kept: back to what it was, and say so
    if ((state.myReactions.get(n) || '') === next) {
      if (before) state.myReactions.set(n, before);
      else state.myReactions.delete(n);
      showMyReaction(n, false);
    }
    toast(reply.status === 429 ? 'You are reacting quickly. Wait a moment, then try again.' : reply.status === 401 ? 'Your session ended. Sign in again.' : "That reaction didn't go through. Try again in a moment.");
    if (reply.status === 401) showSignIn('Your session ended. Sign in again to carry on.');
  });
}

/**
 * A long press on one of TAi's messages, on a touch screen, opens the same six. A finger that moves is a scroll, not a press; the menu a
 * browser offers on a long press (and the text it selects) is held back for the press that opened ours, so everywhere else it is as it was.
 */
function wireLongPress() {
  let press = null;
  let heldUntil = 0;
  const end = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  els.messages.addEventListener('pointerdown', (event) => {
    end();
    if (event.pointerType === 'mouse' || event.button > 0) return;
    const row = event.target.closest('.row.assistant[data-react]');
    if (!row || !event.target.closest('.bubble') || event.target.closest('a, button, .code')) return;
    press = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        press = null;
        heldUntil = Date.now() + 1000;
        const selection = getSelection();
        if (selection) selection.removeAllRanges();
        openPicker(row, null);
      }, LONG_PRESS_MS),
    };
  });
  els.messages.addEventListener('pointermove', (event) => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) end();
  });
  for (const name of ['pointerup', 'pointercancel', 'pointerleave']) els.messages.addEventListener(name, end);
  els.scroller.addEventListener('scroll', end, { passive: true });
  els.messages.addEventListener('contextmenu', (event) => {
    if (press || Date.now() < heldUntil) event.preventDefault();
  });
  // a click outside the six closes them (the pointer, before the click: so a press that opened them is not what closes them)
  document.addEventListener('pointerdown', (event) => {
    if (state.picker && !pickerNode.contains(event.target) && !event.target.closest('.act[data-act="react"], .react.mine')) closePicker(false);
  });
}

// ---------------------------------------------------------------- scrolling, the jump pill

const distanceFromBottom = () => els.scroller.scrollHeight - els.scroller.scrollTop - els.scroller.clientHeight;
const nearBottom = () => distanceFromBottom() < 140;

function scrollToEnd(smooth) {
  state.toEnd = !!smooth;
  clearTimeout(state.toEndTimer);
  if (smooth) {
    state.toEndTimer = setTimeout(() => {
      state.toEnd = false;
      updateJump();
    }, 1400);
  }
  els.scroller.scrollTo({ top: els.scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  state.unseen.clear();
  paintJump('hidden', 0);
}

/**
 * The pill above the message box has three states. "N new messages" while TAi's words have arrived that the reader, looking back up the
 * conversation, has not yet seen (a message is seen once its bottom edge has been in view: the reader scrolling down to it by hand clears
 * it as much as the pill does). A plain round arrow when everything has been seen but the reader is still some way above the latest.
 * Nothing at the bottom. Reactions, time stamps, the typing dots, and the student's own messages never count.
 */
function updateJump() {
  const distance = distanceFromBottom();
  const edge = els.scroller.getBoundingClientRect().bottom;
  for (const row of state.unseen) {
    if (!row.isConnected || distance < 2 || row.getBoundingClientRect().bottom <= edge + 1) state.unseen.delete(row);
  }
  if (state.toEnd) return paintJump('hidden', 0);                         // on its way down already
  if (state.unseen.size) paintJump('count', state.unseen.size);
  else paintJump(distance > AWAY_PX ? 'arrow' : 'hidden', 0);
}

function paintJump(mode, count) {
  els.jump.hidden = mode === 'hidden';
  els.jump.classList.toggle('is-arrow', mode === 'arrow');
  const text = mode === 'count' ? (count === 1 ? '1 new message' : `${count} new messages`) : '';
  if (mode === 'arrow') els.jump.setAttribute('aria-label', 'Scroll to the latest message');
  else els.jump.removeAttribute('aria-label');
  els.jumpText.textContent = text;
  // said politely, and only when the count changes (a button that comes and goes is not announced by being there)
  if (els.jumpLive.textContent !== text) els.jumpLive.textContent = text;
}

function afterAppend(instant) {
  if (instant) scrollToEnd(false);
  else if (state.stick) scrollToEnd(true);
  else updateJump();
}

// ---------------------------------------------------------------- sign in

function whenGoogle() {
  return new Promise((resolve) => {
    if (window.google && window.google.accounts && window.google.accounts.id) return resolve(window.google);
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.google && window.google.accounts && window.google.accounts.id) {
        clearInterval(timer);
        resolve(window.google);
      } else if (Date.now() - started > 15000) {
        clearInterval(timer);
        resolve(null);
      }
    }, 100);
  });
}

/** One bubble under the sign-in card that says what went wrong (or nothing, to take it away). */
function gateNote(text) {
  if (state.noteRow) state.noteRow.remove();
  state.noteRow = null;
  if (!text) return;
  state.noteRow = noteBubble(text);
  state.noteRow.classList.add('gate-note');
  place(state.noteRow, 'assistant', Date.now());
  afterAppend(true);
}

function renderGate() {
  clearConversation();
  setView('gate');
  const now = Date.now();
  if (!state.config.enabled) {
    place(noteBubble('Hi, I’m TAi, your CS6650 teaching assistant. Sign-in is not set up yet: the teaching team is still finishing this page.'), 'assistant', now);
    return;
  }
  place(noteBubble('Hi, I’m TAi, your CS6650 teaching assistant. Sign in with the Google account your teaching team has on file and we can get started.'), 'assistant', now);
  const row = el('li', 'row assistant');
  const card = el('div', 'card');
  state.slot = el('div', 'gsi-slot');
  card.append(el('p', 'card-title', 'Sign in'), state.slot);
  row.append(card);
  place(row, 'assistant', now);
}

async function showSignIn(note) {
  state.user = null;
  state.unread = 0;
  showTitle();
  state.epoch++;
  // nothing of a signed-in page outlives its session: the call, a recording, chosen files, an open picture
  call.end(true);
  recorder.cancel();
  clearTray();
  if (els.lightbox.open) els.lightbox.close();
  if (els.interview.open) els.interview.close();
  activityPanel.close();
  renderGate();
  if (note) gateNote(note);
  if (state.config.enabled) await renderGoogleButton();
}

async function renderGoogleButton() {
  clearTimeout(state.nonceTimer);
  const issued = await api('auth/nonce');
  if (issued.status !== 200) {
    gateNote(issued.status === 429 ? 'Too many attempts. Wait a minute and reload.' : 'I cannot be reached right now. Check your connection and reload.');
    return;
  }
  state.nonce = issued.data.nonce;
  const google = await whenGoogle();
  if (!google) {
    gateNote('Google sign-in did not load. A content blocker may be stopping accounts.google.com.');
    return;
  }
  google.accounts.id.initialize({ client_id: state.config.clientId, nonce: state.nonce, callback: onCredential, ux_mode: 'popup', auto_select: false, itp_support: true });
  state.slot.replaceChildren();
  // the white "outline" button in both themes: on the dark card it is the one that stands out (the slot's color-scheme keeps its frame clear)
  google.accounts.id.renderButton(state.slot, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', logo_alignment: 'left', width: 300 });
  // a nonce is good for five minutes: renew it while the button waits
  state.nonceTimer = setTimeout(() => app.dataset.state === 'gate' && renderGoogleButton(), 4 * 60 * 1000);
}

async function onCredential(response) {
  gateNote('');
  const reply = await api('auth/google', { method: 'POST', body: { credential: response.credential, nonce: state.nonce } });
  if (reply.status === 200) {
    const me = await api('api/me');
    if (me.status === 200) return enterChat(me.data);
  }
  if (reply.data && reply.data.error === 'not-enrolled') {
    gateNote(`${reply.data.email || 'That account'} is not on my list yet. Ask the teaching team to add that address, or sign in with another account.`);
  } else {
    const why = { nonce: 'That took too long. Try again.', expired: 'That sign-in expired. Try again.' }[reply.data && reply.data.reason];
    gateNote(why || (reply.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Sign-in did not work. Try again.'));
  }
  renderGoogleButton();
}

async function signOut() {
  state.epoch++;
  interviewToken = '';
  call.end(true);
  // files that are up and were not sent go back while the session still holds (signing out waits a moment for them, no longer)
  const releases = state.tray.map(release).filter(Boolean);
  if (releases.length) await Promise.race([Promise.all(releases), new Promise((resolve) => setTimeout(resolve, 1500))]);
  // this browser's notifications go off for this student while the session still holds (the next person to sign in here must not get theirs)
  await Promise.race([settings.leave(), new Promise((resolve) => setTimeout(resolve, 1500))]);
  await api('auth/logout', { method: 'POST' });
  closeMenus();
  showSignIn();
}

// ---------------------------------------------------------------- the conversation

function clearConversation() {
  closePicker(false);
  speaking.stop();
  stopPlaying();
  for (const note of state.notes) note.destroy();
  state.notes.clear();
  for (const url of state.blobUrls) URL.revokeObjectURL(url);
  state.blobUrls.clear();
  els.messages.replaceChildren();
  clearInterval(state.tick);
  Object.assign(state, { entries: [], pending: [], last: 0, lastUserN: 0, awaiting: false, serverTyping: false, status: null, sv: 0, typingRow: null, speakRow: null, lastRole: null, lastTs: 0, noteRow: null, toEnd: false });
  state.rows.clear();
  state.reactions.clear();
  state.myReactions.clear();
  state.reactBusy.clear();
  state.unseen.clear();
  els.ring.classList.remove('working');
  paintJump('hidden', 0);
}

function addEntries(entries, { instant = false } = {}) {
  let added = false;
  let unread = 0;
  // TAi's words that come while the reader is looking back up the conversation are counted by the pill until they have been in view
  const away = !instant && !state.stick;
  for (const entry of entries) {
    state.last = Math.max(state.last, entry.n);
    if (entry.kind === 'react') {
      if (entry.role === 'user') myReact(entry, !instant);                   // the student's own emoji, on one of TAi's messages
      else react(entry, !instant);                                           // TAi's, on one of the student's
      continue;
    }
    if (entry.kind === 'feedback') continue;                                 // a thumb of the student's, from when the page had them: not a message, and nothing to show
    if (isActivityLine(entry)) {
      // a call, a note TAi kept, a reminder: a compact card at its place. Not something TAi said, so it is not unread, answers nothing and
      // stops no dots; the Activity sheet, when it is open, takes it in too
      if (state.rows.has(entry.n)) continue;
      const card = activityRow(entry);
      if (!card) continue;
      state.rows.set(entry.n, card);
      state.entries.push(entry);
      place(card, 'activity', Date.parse(entry.ts) || Date.now());
      activityPanel.push(entry);
      added = true;
      continue;
    }
    if (entry.kind === 'object') {
      // a card of TAi's (a run of their code, a document, a chart ...), drawn by its own module (objects.js) at its place: it is no reply, so it is not unread, answers nothing and stops no dots
      if (state.rows.has(entry.n)) continue;
      const card = objectRow(entry);
      if (!card) continue;
      state.rows.set(entry.n, card);
      state.entries.push(entry);
      place(card, 'object', Date.parse(entry.ts) || Date.now());
      added = true;
      continue;
    }
    if (isSpeech(entry)) {
      // the words of a call, or a marker of its start, a switch of kind or its end: lines of the conversation that are not messages. They are not
      // unread, answer nothing, stop no dots and close no options; the "..." that stood for them goes when they arrive
      if (state.rows.has(entry.n)) continue;
      const at = Date.parse(entry.ts) || Date.now();
      const marker = eventOf(entry);
      const row = marker ? markRow(entry, at) : speechRow(entry, at);
      if (!row) continue;
      if (!marker) speaking.arrived();
      state.rows.set(entry.n, row);
      state.entries.push(entry);
      place(row, marker ? 'call' : entry.role === 'user' ? 'user' : 'assistant', at);
      added = true;
      continue;
    }
    if (state.rows.has(entry.n)) continue;
    const ts = Date.parse(entry.ts) || Date.now();
    if (entry.role === 'user' && entry.kind === 'audio') {
      state.lastUserN = Math.max(state.lastUserN, entry.n);
      const index = state.pending.findIndex((p) => p.audio && p.id === entry.id && p.n === undefined);
      if (index !== -1) {
        // our own voice note coming back before the upload's answer did: it is on the page already, it only gets its number and its words
        const item = state.pending[index];
        item.n = entry.n;
        item.row.dataset.n = entry.n;
        item.view.setWords(entry.text);
        state.pending.splice(index, 1);
        state.rows.set(entry.n, item.row);
        state.entries.push(entry);
        showReaction(entry.n, !instant);
        continue;
      }
      const row = voiceNoteRow(entry, ts);
      row.dataset.n = entry.n;
      state.rows.set(entry.n, row);
      state.entries.push(entry);
      place(row, 'user', ts);
    } else if (entry.role === 'user') {
      state.lastUserN = Math.max(state.lastUserN, entry.n);
      const files = Array.isArray(entry.files) ? entry.files.length : 0;
      const index = state.pending.findIndex((p) => !p.audio && p.text === entry.text && p.files === files && p.n === undefined);
      if (index !== -1) {
        // our own message coming back: it is already on the page, it only gets its number
        const item = state.pending[index];
        item.n = entry.n;
        item.row.dataset.n = entry.n;
        state.pending.splice(index, 1);
        state.rows.set(entry.n, item.row);
        state.entries.push(entry);
        showReaction(entry.n, !instant);
        continue;
      }
      const row = userRow(entry.text, ts, entry.files);
      row.dataset.n = entry.n;
      state.rows.set(entry.n, row);
      state.entries.push(entry);
      place(row, 'user', ts);
    } else {
      if (!showable(entry)) continue;
      const row = assistantRow(entry, ts);
      // the reply was on screen as it was written (status.js previewText): it takes that place, and does not fade in over it again
      if (state.typingRow && state.typingRow.classList.contains('has-preview')) row.classList.add('no-rise');
      state.awaiting = false;
      state.rows.set(entry.n, row);
      state.entries.push(entry);
      place(row, 'assistant', ts);
      if (away) state.unseen.add(row);
      if (!instant && document.hidden) unread++;
    }
    added = true;
  }
  if (added) afterAppend(instant);
  if (unread) {
    state.unread += unread;
    showTitle();
  }
  paintAllChoices(!instant);                                      // what was said, tapped or answered may have closed or settled some options
  updateStatus();
}

// tells a screen reader what TAi is doing: at most every four seconds, in a region of its own (the dots' row is not read: its label is aria-hidden)
const statusSpeech = createAnnouncer({ write: (text) => { if (els.statusLive) els.statusLive.textContent = text; } });

/**
 * The dots while TAi works, with what it is doing beside them (status.js: "Checking Canvas…", or "Waiting for a free slot · 2 ahead") and the seconds
 * once it takes a while; the face at the top pulses too. The label's box is as wide as the longest label, so nothing moves when the words change.
 */
function updateStatus() {
  const show = state.awaiting || state.serverTyping;
  clearInterval(state.tick);
  els.ring.classList.toggle('working', show);
  if (!show) {
    if (state.typingRow) state.typingRow.remove();
    state.typingRow = null;
    statusSpeech.clear();
    updateJump();
    return;
  }
  if (!state.typingRow) {
    const row = el('li', 'row assistant typing');
    const bubble = el('div', 'bubble');
    const dots = el('span', 'dots');
    dots.append(el('i'), el('i'), el('i'));
    const words = el('span', 'typing-label');
    words.setAttribute('aria-hidden', 'true');
    words.append(el('span', 'typing-label-text'), el('span', 'typing-label-size', LONGEST_TEXT));
    words.hidden = true;
    bubble.append(dots, words);
    row.append(bubble, el('span', 'typing-note'));
    row.classList.add('turn');
    state.typingRow = row;
  }
  if (!state.typingRow.isConnected) els.messages.append(state.typingRow);
  const view = statusView(state.status);
  const words = state.typingRow.querySelector('.typing-label');
  words.hidden = !view;
  words.querySelector('.typing-label-text').textContent = view ? view.text : '';
  state.typingRow.firstElementChild.classList.toggle('has-label', !!view);
  state.typingRow.classList.toggle('is-queued', !!view && view.state === 'queued');
  statusSpeech.say(view ? view.spoken : '');
  // A reply being written (TAI_PORTAL_STREAM, status.js previewText): its words, a sentence at a time, where the dots were. Never read aloud (this list is a
  // live region, and the reply is read once, when it is whole); the room of the reaction button is kept, so the reply's lines break where these did.
  const draft = previewText(state.status);
  const bubble = state.typingRow.firstElementChild;
  let draftBox = bubble.querySelector('.draft');
  if (draft) {
    if (!draftBox) {
      draftBox = el('div', 'md draft');
      draftBox.setAttribute('aria-hidden', 'true');
      bubble.prepend(draftBox);
      const ghost = actionBar(true);
      ghost.classList.add('ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.inert = true;
      state.typingRow.append(ghost);
    }
    if (draftBox._words !== draft) {
      draftBox._words = draft;
      draftBox.replaceChildren(renderMarkdown(draft));
    }
  } else if (draftBox) {
    draftBox.remove();
    state.typingRow.querySelector('.actions.ghost')?.remove();
  }
  state.typingRow.classList.toggle('has-preview', !!draft);
  const note = state.typingRow.querySelector('.typing-note');
  const render = () => {
    const seconds = Math.round((Date.now() - state.sentAt) / 1000);
    note.textContent = !state.sentAt ? '' : noteText(view, seconds);
  };
  render();
  state.tick = setInterval(render, 1000);
  if (state.stick) scrollToEnd(false);
}

async function enterChat(me) {
  state.user = me.user;
  state.unread = 0;
  state.maxChars = me.maxChars || 6000;
  state.features = readFeatures(me.features);
  settings.start(me.features, me.user);        // the account menu's Settings entry, and this device's time zone to the server
  state.epoch++;
  const epoch = state.epoch;
  clearConversation();
  state.status = me.status || null;            // (after the clearing: it starts from what the server says TAi is doing now)
  state.sv = Number.isInteger(me.sv) ? me.sv : 0;
  setView('chat');
  showTitle();
  const first = (me.user.name || '').trim().split(/\s+/)[0];
  els.avatarLetter.textContent = (me.user.name || me.user.email || '?').trim().charAt(0).toUpperCase();
  els.avatarName.textContent = first || me.user.email;
  els.menuName.textContent = me.user.name || '';
  els.menuEmail.textContent = me.user.email || '';
  els.input.value = storage('get', DRAFT_KEY) || '';
  autosize();
  const history = await api('api/history?limit=200');
  if (epoch !== state.epoch) return;
  if (history.status === 200) {
    if (history.data.entries.length === 0) addStarter(first);
    addEntries(history.data.entries, { instant: true });
    state.serverTyping = !!history.data.typing;
    updateStatus();
  }
  state.stick = true;
  scrollToEnd(false);
  els.input.focus();
  pollLoop(epoch);
  offerInterview();
}

async function pollLoop(epoch) {
  let delay = 0;
  while (epoch === state.epoch && state.user) {
    const reply = await api(`api/poll?after=${state.last}&wait=${POLL_WAIT_SECONDS}&sv=${state.sv}${presence.query()}`);
    if (epoch !== state.epoch) return;
    if (reply.status === 200) {
      delay = 0;
      els.banner.hidden = true;
      addEntries(reply.data.entries);
      state.serverTyping = !!reply.data.typing;
      // a response that brings TAi's reply (not a card of its activity) brings the words that were being written as well, if the server has not cleared them
      // yet: drawn beside the reply they would be a duplicate for a moment, so they are not drawn
      const answered = (reply.data.entries || []).some((e) => e.role !== 'user' && !isActivityLine(e) && showable(e));
      state.status = (answered ? withoutPreview(reply.data.status) : reply.data.status) || null;
      if (Number.isInteger(reply.data.sv)) state.sv = reply.data.sv;
      updateStatus();
    } else if (reply.status === 401) {
      return showSignIn('Your session ended. Sign in again to carry on.');
    } else if (reply.status === 403) {
      return showSignIn("This account is no longer on my list.");
    } else {
      els.banner.hidden = false;
      delay = Math.min(delay ? delay * 2 : 1000, 10000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function sendMessage() {
  const text = els.input.value.replace(/\r\n/g, '\n').trim();
  const ready = state.tray.filter((f) => f.phase === 'done');
  if ((!text && !ready.length) || !state.user || state.tray.some((f) => f.phase === 'uploading')) return;
  if (text.length > state.maxChars) return toast(`That message is ${text.length} characters long; the limit is ${state.maxChars}.`);
  els.input.value = '';
  storage('remove', DRAFT_KEY);
  takeTray();
  autosize();
  const now = Date.now();
  const files = ready.map((f) => ({ name: f.sent.name || f.name, size: f.sent.size ?? f.size, kind: f.sent.kind, ...(f.sent.media ? { media: f.sent.media } : {}) }));
  const row = userRow(text, now, files);
  const item = { text, files: files.length, row };
  state.pending.push(item);
  place(row, 'user', now);
  state.stick = true;
  // during a voice call what is typed joins the call and the answer comes by voice: no dots waiting for a written reply
  state.awaiting = !call.active();
  state.sentAt = now;
  afterAppend(false);
  updateStatus();
  paintAllChoices();                                           // words instead of a tap: the options before them are closed
  const reply = await api('api/send', { method: 'POST', body: files.length ? { text, files: ready.map((f) => f.sent.id) } : { text } });
  if (reply.status === 200) {
    if (item.n === undefined) {
      item.n = reply.data.n;
      row.dataset.n = reply.data.n;
      state.rows.set(reply.data.n, row);
      state.lastUserN = Math.max(state.lastUserN, reply.data.n);
      state.entries.push({ n: reply.data.n, role: 'user', text, ts: new Date(now).toISOString(), ...(files.length ? { files } : {}) });
      state.pending = state.pending.filter((p) => p !== item);
      showReaction(reply.data.n, true);
    }
    paintAllChoices();
    return;
  }
  state.pending = state.pending.filter((p) => p !== item);
  state.awaiting = false;
  updateStatus();
  paintAllChoices();                                           // (a message that did not go has said nothing: the options come back)
  row.classList.add('failed');
  const expired = reply.data && reply.data.error === 'bad-files';
  row.append(
    el('span', 'retry', reply.status === 429 ? 'You are sending quickly. Wait a moment, then send it again.' : reply.status === 401 ? 'Your session ended. Sign in again.' : expired ? 'The attached files had expired. Attach them again.' : 'Not sent. Your text is back in the box.'),
  );
  if (!els.input.value) els.input.value = text;
  if (!expired && reply.status !== 401) restoreTray(ready);
  autosize();
  if (reply.status === 401) showSignIn('Your session ended. Sign in again to carry on.');
}

/** An id for a message, which the server keeps with it (TAi's emoji name it) and which makes sending it twice one message. */
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * A voice note was recorded and sent: it is in the conversation at once as the student's own message (a play button, a waveform, its length,
 * playable from the copy the page holds), then goes up. The server keeps the recording, turns it into words (which appear under the bubble)
 * and hands TAi the words; TAi answers in text like to any message. A note that did not go says so and can be tried again (the same id: a
 * note whose answer was lost is not sent twice).
 */
async function sendVoiceNote(note) {
  if (!state.user) return;
  const limit = state.features.maxUploadBytes || 5 * 1024 * 1024;
  if (note.blob.size > limit) {
    toast(`That voice note is ${humanSize(note.blob.size)}, and TAi takes up to ${humanSize(limit)}. Record a shorter one.`);
    return;
  }
  const now = Date.now();
  const id = newId();
  const src = URL.createObjectURL(note.blob);
  state.blobUrls.add(src);
  const view = createVoiceNote({
    src, duration: note.duration, peaks: note.peaks, seed: now, status: 'sending', title: fullTime(now),
    onRetry: () => attempt(),
    onProblem: () => toast('That voice note could not be played.'),
  });
  state.notes.add(view);
  const row = el('li', 'row user note-row');
  row.append(view.bubble);
  const item = { audio: true, id, row, view, text: '', files: 0, failed: false };
  state.pending.push(item);
  place(row, 'user', now);
  state.stick = true;
  afterAppend(false);
  const epoch = state.epoch;
  const attempt = async () => {
    row.classList.remove('failed');
    view.setStatus('sending');
    item.failed = false;
    paintAllChoices();                                         // a voice note instead of a tap: the options before it are closed while it goes
    // during a voice call what is sent joins the call and the answer comes by voice: no dots waiting for a written reply
    state.awaiting = !call.active();
    state.sentAt = Date.now();
    updateStatus();
    const query = `duration=${note.duration.toFixed(1)}&peaks=${note.peaks.join(',')}&id=${id}`;
    const reply = await api(`api/voicenote?${query}`, { method: 'POST', bytes: note.blob, type: String(note.type).split(';')[0] });
    if (epoch !== state.epoch) return;
    if (reply.status === 200 && reply.data && reply.data.entry) {
      const entry = reply.data.entry;
      view.setStatus('ready');
      view.setWords(entry.text);
      if (item.n === undefined) {                                  // the poll has not brought it back yet
        item.n = entry.n;
        row.dataset.n = entry.n;
        state.rows.set(entry.n, row);
        state.lastUserN = Math.max(state.lastUserN, entry.n);
        state.entries.push(entry);
        state.pending = state.pending.filter((p) => p !== item);
        showReaction(entry.n, true);
      }
      paintAllChoices();
      return;
    }
    state.awaiting = false;
    updateStatus();
    row.classList.add('failed');
    view.setStatus('failed', voiceNoteProblem(reply.status, reply.data));         // the reason stays on the bubble, beside the button that tries again
    item.failed = true;
    paintAllChoices();                                         // (a note that did not go has said nothing: the options come back)
    if (reply.status === 401) showSignIn('Your session ended. Sign in again to carry on.');
  };
  attempt();
}

// ---------------------------------------------------------------- files for the next message: the tray above the message box
// A file goes up as soon as it is chosen (POST api/upload, its bytes as they are) and shows how far it is; the message then names the ids.

function addFiles(list) {
  if (!state.user || !state.features.files) return;
  for (const original of Array.from(list || [])) {
    if (state.tray.length >= MAX_FILES) {
      toast(`You can attach up to ${MAX_FILES} files to one message.`);
      break;
    }
    const file = named(original);
    const item = { key: ++state.trayKey, file, name: file.name, size: file.size, phase: 'uploading', progress: 0, sent: null, error: '' };
    const problem = refusal(file);
    if (problem) {
      item.phase = 'failed';
      item.error = problem;
      toast(problem);
    }
    state.tray.push(item);
    els.tray.append(chipFor(item));
    paintChip(item);
    if (!problem) upload(item);
  }
  els.tray.hidden = state.tray.length === 0;
  updateSend();
}

/** A pasted picture often has no usable name: the server knows a file's kind by its extension, so it gets one. */
function named(file) {
  if (/\.[A-Za-z0-9]{1,10}$/.test(file.name || '')) return file;
  const ext = Object.keys(PICTURE_TYPES).find((x) => PICTURE_TYPES[x] === file.type);
  return ext ? new File([file], `pasted-picture.${ext === 'jpeg' ? 'jpg' : ext}`, { type: file.type }) : file;
}

/** Why a file cannot go up, before it is sent (the server checks again, by the bytes too). */
function refusal(file) {
  const f = state.features;
  const ext = ((/\.([A-Za-z0-9]{1,10})$/.exec(file.name) || [])[1] || '').toLowerCase();
  if (ext && !f.accept.includes(ext)) return "TAi can't read that kind of file.";
  if (!file.size) return `${file.name} is empty.`;
  if (file.size > f.maxUploadBytes) return `${file.name} is ${humanSize(file.size)}: TAi takes files up to ${humanSize(f.maxUploadBytes)}.`;
  return '';
}

function upload(item) {
  const xhr = new XMLHttpRequest();          // not fetch: only this one says how far an upload has got
  item.xhr = xhr;
  xhr.open('POST', `api/upload?name=${encodeURIComponent(item.file.name)}`);
  const headers = postHeaders('application/octet-stream');
  for (const key of Object.keys(headers)) xhr.setRequestHeader(key, headers[key]);
  xhr.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    item.progress = event.loaded / event.total;
    paintChip(item);
  });
  xhr.addEventListener('load', () => {
    let data = null;
    try {
      data = JSON.parse(xhr.responseText);
    } catch {
      /* not JSON: a proxy's page */
    }
    uploaded(item, xhr.status, data);
  });
  xhr.addEventListener('error', () => uploaded(item, 0, null));
  xhr.send(item.file);
}

function uploaded(item, status, data) {
  item.xhr = null;
  if (!state.tray.includes(item)) return;     // taken away while it was going up
  if (status === 200 && data && typeof data.id === 'string') {
    item.phase = 'done';
    item.progress = 1;
    item.sent = { id: data.id, name: typeof data.name === 'string' ? data.name : item.name, size: Number(data.size) || item.size, kind: data.kind, media: MEDIA_ID.test(data.media || '') ? data.media : undefined };
  } else {
    item.phase = 'failed';
    item.error = uploadProblem(status, data);
    toast(item.error);
  }
  paintChip(item);
  updateSend();
  if (status === 401) showSignIn('Your session ended. Sign in again to carry on.');
}

function chipFor(item) {
  const chip = el('li', 'chip');
  const thumb = el('span', 'chip-thumb');
  if (state.features.pictures && /^image\/(png|jpeg|gif|webp)$/.test(item.file.type) && !item.error) {
    item.preview = URL.createObjectURL(item.file);
    const img = el('img');
    img.alt = '';
    img.addEventListener('error', () => thumb.replaceChildren(icon('file')), { once: true });   // named a picture, but is not one
    img.src = item.preview;
    thumb.append(img);
  } else {
    thumb.append(icon('file'));
  }
  const body = el('span', 'chip-body');
  body.append(el('span', 'chip-name', item.name), el('span', 'chip-meta'));
  const bar = el('span', 'chip-bar');
  bar.append(el('i'));
  const remove = el('button', 'chip-x');
  remove.type = 'button';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', `Remove ${item.name}`);
  remove.append(icon('x'));
  remove.addEventListener('click', () => removeFile(item));
  chip.append(thumb, body, bar, remove);
  item.chip = chip;
  return chip;
}

function paintChip(item) {
  const chip = item.chip;
  chip.dataset.state = item.phase;
  chip.title = item.phase === 'failed' ? `${item.name}: ${item.error}` : item.name;
  // a failed chip says why on itself (a phone has no hover, and the toast goes away)
  chip.querySelector('.chip-meta').textContent =
    item.phase === 'failed' ? `Not attached: ${item.error}` : item.phase === 'uploading' ? `Uploading… ${humanSize(item.size)}` : `Ready · ${humanSize(item.size)}`;
  chip.querySelector('.chip-bar i').style.width = `${Math.round(item.progress * 100)}%`;
}

function forget(item) {
  if (item.xhr) item.xhr.abort();
  item.xhr = null;
  if (item.preview) URL.revokeObjectURL(item.preview);
  item.preview = '';
  if (item.chip) item.chip.remove();
}

/**
 * A file that is up and was not sent, taken back: the server frees its place among the uploads that may wait, and its file (fire and forget:
 * a release that does not arrive costs nothing but that place for half an hour). A failed upload has nothing waiting; a sent one is used up.
 */
function release(item) {
  if (item.phase !== 'done' || !item.sent || !item.sent.id) return null;
  return api('api/upload/release', { method: 'POST', body: { id: item.sent.id } });
}

function removeFile(item) {
  const at = state.tray.indexOf(item);
  if (at === -1) return;
  release(item);
  forget(item);
  state.tray.splice(at, 1);
  els.tray.hidden = state.tray.length === 0;
  updateSend();
  // the focus goes to the next chip's remove button, or back to the message box
  const next = state.tray[Math.min(at, state.tray.length - 1)];
  (next ? next.chip.querySelector('.chip-x') : els.input).focus();
}

/** The tray empties into a message that is being sent (failed chips go too: they were never attached). */
function takeTray() {
  for (const item of state.tray) forget(item);
  state.tray = [];
  els.tray.hidden = true;
}

function clearTray() {
  takeTray();
  updateSend();
}

/** A message that did not go keeps its files: the same ids are good again (the server says when they are not). */
function restoreTray(items) {
  for (const old of items) {
    if (state.tray.length >= MAX_FILES) break;
    const item = { ...old, key: ++state.trayKey, xhr: null, chip: null, preview: '' };
    state.tray.push(item);
    els.tray.append(chipFor(item));
    paintChip(item);
  }
  els.tray.hidden = state.tray.length === 0;
}

// ---------------------------------------------------------------- the composer

/**
 * The round button at the right end of the message box: the microphone while the box is empty (no words, nothing in the tray) and voice notes
 * are on, the send arrow otherwise. The arrow is on when there is something to send (words, or a file that is up) and nothing is still going up.
 */
function updateSend() {
  const length = els.input.value.length;
  const ready = state.tray.some((f) => f.phase === 'done');
  const busy = state.tray.some((f) => f.phase === 'uploading');
  const empty = !els.input.value.trim() && state.tray.length === 0;
  // in a call the call's own buttons are in the microphone's place, and the arrow shows only when there is something typed to send
  showAction(app.dataset.state === 'chat' && !!state.user && state.features.voiceNotes && empty && !call.active(), call.active() && empty);
  els.send.disabled = !state.user || busy || (!els.input.value.trim() && !ready) || length > state.maxChars;
}

/** The microphone or the arrow in that place, one after the other with a small pop (only when it changes). */
function showAction(mic, neither = false) {
  const send = !mic && !neither;
  if (els.mic.hidden === !mic && els.send.hidden === !send) return;
  els.mic.hidden = !mic;
  els.send.hidden = !send;
  const shown = mic ? els.mic : send ? els.send : null;
  if (!shown) return;
  shown.classList.remove('swap');
  void shown.offsetWidth;
  shown.classList.add('swap');
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${els.input.scrollHeight}px`;
  const length = els.input.value.length;
  updateSend();
  els.count.textContent = length > state.maxChars * 0.8 ? `${length} / ${state.maxChars}` : '';
  els.count.classList.toggle('over', length > state.maxChars);
}

/** Puts words in the message box as a quotation. `focus` false (askhere.js on a phone: the keyboard would cover the conversation) leaves the box as it is. */
function quoteIntoComposer(text, { focus = true } = {}) {
  const quoted = text.split('\n').map((line) => `> ${line}`).join('\n');
  els.input.value = `${quoted}\n\n${els.input.value}`;
  autosize();
  if (!focus) return;
  els.input.focus();
  els.input.setSelectionRange(els.input.value.length, els.input.value.length);
}

function wireComposer() {
  els.input.addEventListener('input', () => {
    autosize();
    storage('set', DRAFT_KEY, els.input.value);
  });
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!els.send.disabled) sendMessage();
    }
  });
  // a file or a picture pasted into the box is attached, as if it had been chosen
  els.input.addEventListener('paste', (event) => {
    if (!state.user || !state.features.files) return;
    const files = event.clipboardData && event.clipboardData.files;
    if (!files || !files.length) return;
    event.preventDefault();
    addFiles(files);
  });
  els.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!els.send.disabled) sendMessage();
  });
  // the plus is "attach a file": it opens the file picker itself (drag and drop and paste attach too)
  els.plus.addEventListener('click', () => {
    if (state.user && state.features.files) els.fileInput.click();
  });
  els.mic.addEventListener('click', () => {
    if (state.user && state.features.voiceNotes) recorder.start(state.features.voiceNoteSeconds);
  });
  els.fileInput.addEventListener('change', () => {
    addFiles(els.fileInput.files);
    els.fileInput.value = '';
  });
  els.callBtn.addEventListener('click', () => {
    closeCallMenu(false);
    startCall('chat');
  });
  // the chevron beside the call button: the other way to talk, "Talk it through" (TAi listens while the student explains something out loud)
  els.callMore.addEventListener('click', () => {
    if (!els.callMenu.hidden) return closeCallMenu(true);
    call.warm();                           // the menu is a step before a call: the server starts the call's tool host now (fire and forget, voice.js)
    openCallMenu();
  });
  els.callMenu.addEventListener('click', (event) => {
    const item = event.target.closest('.menu-item');
    if (!item) return;
    closeCallMenu(false);
    startCall(item.dataset.call === 'talk' ? 'talk' : 'chat');
  });
  els.callMenu.addEventListener('keydown', (event) => {
    const items = [...els.callMenu.querySelectorAll('.menu-item')];
    const move = { ArrowDown: items.indexOf(document.activeElement) + 1, ArrowUp: items.indexOf(document.activeElement) - 1, Home: 0, End: items.length - 1 }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      items[(move + items.length) % items.length].focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      closeCallMenu(true);                 // Tab leaves it, back to the chevron
    }
  });
  $('#rail-chat').addEventListener('click', () => {
    els.input.focus();
    scrollToEnd(true);
  });
}

/** Files dragged onto the window are attached; nothing happens to a drag that carries no files, or when files are switched off. */
function wireDrops() {
  let depth = 0;
  const wanted = (event) => state.user && state.features.files && app.dataset.state === 'chat' && event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragenter', (event) => {
    if (!wanted(event)) return;
    event.preventDefault();
    depth++;
    els.dropzone.hidden = false;
  });
  document.addEventListener('dragover', (event) => {
    if (!wanted(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (!wanted(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) els.dropzone.hidden = true;
  });
  document.addEventListener('drop', (event) => {
    if (!wanted(event)) return;
    event.preventDefault();
    depth = 0;
    els.dropzone.hidden = true;
    addFiles(event.dataTransfer.files);
  });
}

// ---------------------------------------------------------------- a picture, enlarged; the mock interview's start

/** A voice call, as a plain call ("chat") or as "Talk it through" ("talk"): started in the click itself (the microphone and the speaker need one). */
function startCall(mode, topic) {
  if (!state.user || !state.features.voiceCalls || call.active()) return;
  recorder.cancel();
  call.start({ mode, topic });
}

// "Practise this" on a question of a mock interview's card (review.js), which only ever runs inside the student's own click: a "Talk it through" call
// on that question when voice calls are on and none is going, and otherwise their message "Let's practise: <question>" in the chat
setPractise((item) => {
  // a card in the Activity sheet (a modal dialog) lists its questions too: the sheet is put away first, inside the click, so that the call or the message is not behind it
  if (activityPanel.isOpen()) activityPanel.close();
  const action = practiceOf({ voiceCalls: !!state.user && !!state.features.voiceCalls, callActive: call.active() }, item);
  if (action.kind === 'call') return startCall(action.mode, action.topic);
  practiseInChat(action.text);
});

/** The student's message goes through the message box like any other. What they were typing, or had attached, is not sent along and not lost: they are asked to deal with it first. */
function practiseInChat(text) {
  if (!state.user) return;
  if (els.input.value.trim() || state.tray.length) {
    toast('Send or clear what you were writing first, then press Practise this again.');
    return;
  }
  els.input.value = text;
  sendMessage();
}

function openCallMenu() {
  closeMenus();
  els.callMenu.hidden = false;
  els.callMore.setAttribute('aria-expanded', 'true');
  els.callMenu.querySelector('.menu-item').focus();
}

function closeCallMenu(refocus) {
  if (els.callMenu.hidden) return;
  els.callMenu.hidden = true;
  els.callMore.setAttribute('aria-expanded', 'false');
  if (refocus) els.callMore.focus();
}

function openLightbox(img, opener) {
  state.lightboxOpener = opener;
  els.lightboxImg.src = img.currentSrc || img.src;
  els.lightboxImg.alt = img.alt;
  els.lightbox.showModal();
  els.lightboxClose.focus();
}

/** The interview link was opened: one screen that says what is about to happen, and a button (the call needs a click anyway). */
function offerInterview() {
  if (!interviewToken || app.dataset.state !== 'chat') return;
  if (!state.features.voiceCalls) {
    interviewToken = '';
    toast('Voice calls are not switched on here yet, so the mock interview cannot start. Ask TAi about it in the chat.');
    return;
  }
  if (!els.interview.open) els.interview.showModal();
  els.interviewStart.focus();
}

function wireDialogs() {
  els.lightbox.addEventListener('click', () => els.lightbox.close());       // anywhere: the picture, the dark around it, the close button
  els.lightbox.addEventListener('close', () => {
    els.lightboxImg.removeAttribute('src');
    const opener = state.lightboxOpener;
    state.lightboxOpener = null;
    if (opener && opener.isConnected) opener.focus();
  });
  els.interviewStart.addEventListener('click', () => {
    const token = interviewToken;
    interviewToken = '';
    els.interview.close();
    if (!token) return;
    recorder.cancel();
    call.start({ mode: 'interview', token });
  });
  els.interviewLater.addEventListener('click', () => {
    interviewToken = '';
    els.interview.close();
  });
  els.interview.addEventListener('cancel', () => {
    interviewToken = '';                     // Escape: not now
  });
}

// ---------------------------------------------------------------- the drawer: the days of the conversation, and a search of it

function openDrawer(focusSearch) {
  buildList('');
  els.drawer.hidden = false;
  els.scrim.hidden = false;
  if (focusSearch) els.searchInput.focus();
  else (els.drawerList.querySelector('.day') || els.searchInput).focus();
}

function closeDrawer() {
  els.drawer.hidden = true;
  els.scrim.hidden = true;
  els.searchInput.value = '';
}

function goTo(n, block) {
  const row = state.rows.get(n);
  if (!row) return;
  closeDrawer();
  row.scrollIntoView({ block, behavior: 'smooth' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1800);
}

function highlighted(text, query) {
  const out = el('span', 'hit-text');
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) {
    out.textContent = text.slice(0, 160);
    return out;
  }
  const start = Math.max(0, at - 40);
  out.append(document.createTextNode((start > 0 ? '… ' : '') + text.slice(start, at)), el('mark', undefined, text.slice(at, at + query.length)), document.createTextNode(text.slice(at + query.length, at + query.length + 90)));
  return out;
}

/** What a search looks through: the words, the names of the files a message carried, and the title and the line of an activity card. */
const searchable = (e) => {
  if (isSpeech(e)) return spokenSearchText(e);
  if (isActivityLine(e)) {
    const card = cardOf(e);
    return card ? `${card.title} ${card.text}`.trim() : '';
  }
  const words = e.text || (e.kind === 'audio' ? 'Voice note' : '');          // a voice note with no words is still one
  return Array.isArray(e.files) && e.files.length ? `${words} ${e.files.map((f) => f.name).join(' ')}`.trim() : words;
};

/** Who a search hit is from, as its label says: the student, TAi, or the activity list. */
const whoOf = (e) => (isSpeech(e) ? (e.role === 'user' ? 'You (spoken)' : 'TAi (spoken)') : e.role === 'user' ? 'You' : isActivityLine(e) ? 'Activity' : 'TAi');

function buildList(query) {
  els.drawerList.replaceChildren();
  const q = query.trim();
  if (q) {
    const hits = state.entries.filter((e) => searchable(e).toLowerCase().includes(q.toLowerCase())).reverse().slice(0, 40);
    if (!hits.length) els.drawerList.append(el('p', 'drawer-empty', 'Nothing in this conversation matches.'));
    for (const e of hits) {
      const button = el('button', 'hit');
      button.type = 'button';
      button.dataset.n = e.n;
      button.append(el('span', 'hit-who', `${whoOf(e)} · ${fullTime(Date.parse(e.ts) || Date.now())}`), highlighted(searchable(e), q));
      els.drawerList.append(button);
    }
    return;
  }
  const groups = [];
  for (const e of state.entries) {
    const date = new Date(Date.parse(e.ts) || Date.now());
    let group = groups[groups.length - 1];
    if (!group || group.key !== date.toDateString()) {
      group = { key: date.toDateString(), label: dayLabel(date), count: 0, acts: 0, spoken: 0, n: e.n, snippet: '' };
      groups.push(group);
    }
    if (isSpeech(e)) {
      if (spokenOf(e)) group.spoken++;                // what was said in a call is counted apart: spoken lines are not messages (its markers are not counted)
    } else if (isActivityLine(e)) group.acts++;       // a call or a note is on the day, and is not one of its messages
    else group.count++;
    if (!group.snippet && e.role === 'user') group.snippet = searchable(e).replace(/\s+/g, ' ');
  }
  if (!groups.length) els.drawerList.append(el('p', 'drawer-empty', 'Nothing here yet. Your conversation with TAi will be listed by day.'));
  for (const g of groups.reverse()) {
    const button = el('button', 'day');
    button.type = 'button';
    button.dataset.n = g.n;
    const counts = [g.count ? (g.count === 1 ? '1 message' : `${g.count} messages`) : '', g.spoken ? (g.spoken === 1 ? '1 spoken line' : `${g.spoken} spoken lines`) : '', g.acts ? (g.acts === 1 ? '1 activity' : `${g.acts} activities`) : ''].filter(Boolean);
    button.append(el('span', 'day-label', g.label), el('span', 'day-snippet', g.snippet || 'TAi'), el('span', 'day-count', counts.join(', ')));
    els.drawerList.append(button);
  }
}

function wireDrawer() {
  els.chatsBtn.addEventListener('click', () => openDrawer(false));
  $('#rail-search').addEventListener('click', () => openDrawer(true));
  $('#drawer-close').addEventListener('click', closeDrawer);
  els.scrim.addEventListener('click', closeDrawer);
  els.searchInput.addEventListener('input', () => buildList(els.searchInput.value));
  // the Activity list: from the rail's button (the focus goes back to it when the sheet closes), and, where there is no rail (a phone), from the
  // drawer's entry (the focus goes back to Chats)
  els.railActivity.addEventListener('click', () => activityPanel.open(els.railActivity));
  els.drawerActivity.addEventListener('click', () => {
    closeDrawer();
    activityPanel.open(els.chatsBtn);
  });
  els.drawerList.addEventListener('click', (event) => {
    const target = event.target.closest('.day, .hit');
    if (target) goTo(parseInt(target.dataset.n, 10), target.classList.contains('day') ? 'start' : 'center');
  });
}

// ---------------------------------------------------------------- menus, theme, scrolling, copying

function closeMenus() {
  els.menu.hidden = true;
  els.avatar.setAttribute('aria-expanded', 'false');
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (button) button.textContent = 'Press Ctrl+C';
    return false;
  }
}

function wireChrome() {
  const flipTheme = () => {
    const next = isDark() ? 'light' : 'dark';
    applyTheme(next);
    storage('set', 'tai.theme', next);
  };
  $('#theme').addEventListener('click', flipTheme);
  $('#menu-theme').addEventListener('click', () => {
    flipTheme();
    closeMenus();
  });
  $('#menu-team').addEventListener('click', () => location.assign('team.html'));      // the teaching view, in this tab (relative to the page's <base>)
  els.avatar.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = els.menu.hidden;
    closeMenus();
    $('#menu-theme').textContent = isDark() ? 'Switch to light mode' : 'Switch to dark mode';   // the rail's sun/moon is not there on a phone
    els.menu.hidden = !open;
    els.avatar.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (event) => {
    if (!els.menu.hidden && !els.menu.contains(event.target)) closeMenus();
    if (!els.callMenu.hidden && !els.callGroup.contains(event.target)) closeCallMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenus();
      closeCallMenu(true);
      closePicker(true);
      if (!els.drawer.hidden) closeDrawer();
    } else if (event.key === '/' && app.dataset.state === 'chat' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      event.preventDefault();
      els.input.focus();
    }
  });
  $('#signout').addEventListener('click', signOut);
  // the answers that came while this tab was behind another are read once it is in front again
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.unread) {
      state.unread = 0;
      showTitle();
    }
  });
  els.jump.addEventListener('click', () => {
    state.stick = true;
    scrollToEnd(true);
  });
  els.scroller.addEventListener('scroll', () => {
    state.stick = nearBottom();
    if (state.toEnd && distanceFromBottom() < 2) state.toEnd = false;
    updateJump();
  });
  // a reader who takes hold of the conversation while it glides down is going somewhere else
  for (const name of ['wheel', 'touchstart', 'pointerdown']) els.scroller.addEventListener(name, () => (state.toEnd = false), { passive: true });
  window.addEventListener('resize', () => {
    if (state.stick) scrollToEnd(false);
    else updateJump();
  });
  // the conversation keeps its bottom when its room changes (the orb of a call coming and going, the message box growing)
  if (typeof ResizeObserver === 'function') {
    let height = els.scroller.clientHeight;
    new ResizeObserver(() => {
      const now = els.scroller.clientHeight;
      if (now === height) return;
      height = now;
      if (state.stick) scrollToEnd(false);
      else updateJump();
    }).observe(els.scroller);
  }
  els.messages.addEventListener('click', async (event) => {
    const pic = event.target.closest('.pic, .thumb');
    if (pic) {
      const img = pic.querySelector('img');
      if (img) openLightbox(img, pic);
      return;
    }
    const mine = event.target.closest('.react.mine');
    if (mine) {
      openPicker(mine.closest('.row'), mine);                        // the student's own emoji: the six again, to change it or take it back
      return;
    }
    const act = event.target.closest('.act');
    if (act) {
      const row = act.closest('.row');
      if (act.dataset.act === 'react') return openPicker(row, act);
      const text = row._text || '';
      if (act.dataset.act === 'copy') toast((await copyText(text)) ? 'Copied' : 'Could not copy: select the text and press Ctrl+C');
      else quoteIntoComposer(text);
      return;
    }
    const starter = event.target.closest('.card-row');
    if (starter) {
      if (starter.dataset.call) {
        startCall(starter.dataset.call);
      } else if (starter.dataset.send) {
        els.input.value = starter.dataset.send;
        sendMessage();
      } else {
        els.input.value = starter.dataset.fill || '';
        autosize();
        els.input.focus();
        els.input.setSelectionRange(els.input.value.length, els.input.value.length);
      }
      return;
    }
    const copyButton = event.target.closest('.code-copy');
    if (!copyButton) return;
    const pre = copyButton.closest('.code').querySelector('pre');
    if (await copyText(pre.textContent, copyButton)) copyButton.textContent = 'Copied';
    else {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setTimeout(() => (copyButton.textContent = 'Copy'), 1600);
  });
}

// ---------------------------------------------------------------- start

async function boot() {
  applyTheme(storage('get', 'tai.theme'));
  wireChrome();
  wireComposer();
  wireDrawer();
  wireDrops();
  wireDialogs();
  wireLongPress();
  presence.watch(() => !!state.user);
  const config = await api('auth/config');
  if (config.status !== 200) {
    clearConversation();
    setView('gate');
    place(noteBubble('I cannot be reached right now. Check your connection and reload the page.'), 'assistant', Date.now());
    return;
  }
  state.config = config.data;
  const me = await api('api/me');
  if (me.status === 200) return enterChat(me.data);
  if (me.status === 403) return showSignIn('This account is not on my list. Sign in with another account.');
  showSignIn();
}

// what the cards, the viewer and the selection helper are given (objects.js, viewer.js, askhere.js)
setObjectHelpers({ el, icon, fullTime, renderMarkdown, view: viewState, viewer: viewerApi, toast });
initViewer({ root: $('#viewer'), view: viewState, api, el, icon, toast, quote: quoteIntoComposer, inCall: () => call.active(), features: () => state.features });
initAskHere({ view: viewState, messages: els.messages, quote: quoteIntoComposer, inCall: () => call.active(), toast });

boot();
