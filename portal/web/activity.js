// The activity list: what happened for the student that is worth finding again (a call, a note TAi kept, a reminder it set, a step of
// progress, a change in the course), shown as a compact card in the conversation and as rows grouped by day in a sheet, the way an agent's
// activity view is. All of it comes from the history lines of kind `activity` (and from the long call summaries that older histories hold
// as kind `voice`), and goes on the page as text, never as HTML.
// The sheet's rows come from GET api/activity (src/portal/server.ts); docs/PORTAL.md, "Activity", says what each part is.

import { itemsOf, reviewList } from './review.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DAY = 24 * 60 * 60 * 1000;

/** What a line may be about: the three kinds of call, a note TAi kept, a reminder it set, a topic that moved on a step, a change in the course. */
export const TYPES = ['voice', 'talk', 'interview', 'memory', 'reminder', 'progress', 'course'];

// the icon of each kind, drawn like the page's others (24 x 24, a line); `note` is for a kind this page does not know
const PATHS = {
  voice: ['M4.5 14v-2a7.5 7.5 0 0 1 15 0v2', 'M3.5 13h4v6.5h-4z', 'M16.5 13h4v6.5h-4z'],
  talk: ['M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3z', 'M5.5 11.5a6.5 6.5 0 0 0 13 0', 'M12 18v2.5'],
  interview: ['M9 4.5h6V7H9z', 'M8 6H6.5A1.5 1.5 0 0 0 5 7.5v11A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 17.5 6H16', 'M8.5 11.5h7', 'M8.5 15h5'],
  memory: ['M7 4.5h10v15.5l-5-3.6L7 20z'],
  reminder: ['M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5L18.8 18H5.2z', 'M10 20.5a2 2 0 0 0 4 0'],
  progress: ['m3.5 17 5.7-5.7 3.6 3.6 7.7-7.4', 'M15.5 7.5h5v5'],
  course: ['M5 5.5h14A1.5 1.5 0 0 1 20.5 7v11.5A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z', 'M3.5 10h17', 'M8 3.5v4', 'M16 3.5v4'],
  note: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'm8.5 12.3 2.6 2.6 4.5-5'],
  chevron: ['m6 9 6 6 6-6'],
};

const TITLES = { voice: 'Voice call', talk: 'Talk it through', interview: 'Mock interview', memory: 'Remembered', reminder: 'Reminder', progress: 'Progress updated', course: 'Course update', note: 'Activity' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The icon of a kind of activity, as an SVG node. */
export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name] || PATHS.note) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** The first sentence of a text on one line, cut at a word with an ellipsis when it is longer than `max`. */
export function firstSentence(text, max = 110) {
  const flat = oneLine(text);
  if (!flat) return '';
  const found = /^(.+?[.!?])(?=\s|$)/.exec(flat);
  const sentence = found ? found[1] : flat;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, '')}…`;
}

/** The prefix the old call summaries began with ("Voice session, 4 min (talk-it-through): "), which a card's title already says. */
const OLD_PREFIX = /^Voice session, \d+ min(?: \([^)]*\))?:\s*/;

/**
 * What a history line is as a card, or null when it is not one. An `activity` line has its title, its one line and (when it has one) its detail;
 * a `voice` line is the long summary that older histories hold: a card titled "Voice call" with the summary's first sentence as its line and the
 * whole summary as its detail.
 */
export function cardOf(entry) {
  if (!entry || typeof entry !== 'object' || entry.role === 'user') return null;
  if (entry.kind === 'activity') {
    const type = TYPES.includes(entry.type) ? entry.type : 'note';
    const detail = typeof entry.detail === 'string' ? entry.detail.replace(/\r\n/g, '\n').trim() : '';
    // a mock interview's questions (review.js lists them in the card's detail); a line without any, which is every older one, has no such key
    const items = itemsOf(entry.items);
    return { n: entry.n, ts: entry.ts, type, title: oneLine(entry.title) || TITLES[type], text: oneLine(entry.text), detail, legacy: false, ...(items.length ? { items } : {}) };
  }
  if (entry.kind === 'voice') {
    const whole = String(entry.text ?? '').replace(/\r\n/g, '\n').trim();
    const body = firstSentence(whole.replace(OLD_PREFIX, '') || whole);
    return { n: entry.n, ts: entry.ts, type: 'voice', title: TITLES.voice, text: body.charAt(0).toUpperCase() + body.slice(1), detail: whole, legacy: true };
  }
  return null;
}

function startOfDay(ms) {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** The heading of a day's rows: "Today", "Yesterday", then a date as "Mon, Oct 27" (with the year when it is not this one). */
export function dayHeading(ms, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const then = new Date(ms);
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return then.toLocaleDateString([], sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** The time of day on a card: "12:26 pm" (whichever way the reader's locale writes the half of the day: "PM", "p.m."). */
export function clockText(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s*([ap])\.?m\.?$/i, (_, half) => ` ${half.toLowerCase()}m`);
}

/** Cards, newest first, as the days they belong to (one group for each run of cards on the same day): [{ heading, cards }]. */
export function groupByDay(cards, now = Date.now()) {
  const groups = [];
  let day = null;
  for (const card of cards) {
    const ms = Date.parse(card.ts) || now;
    const key = startOfDay(ms);
    if (day !== key) {
      groups.push({ heading: dayHeading(ms, now), cards: [] });
      day = key;
    }
    groups[groups.length - 1].cards.push(card);
  }
  return groups;
}

/**
 * One card. `variant` is "in-chat" (in the conversation) or "in-list" (a row of the sheet; neither is a bare "chat" or "list", which the page's own
 * styles already use for other things). The head is a button that opens the detail when there is one;
 * `decorate(detailNode, card)` lets the page put its own in the detail (the sheet's button to the conversation) and answers whether it did, so
 * a card with nothing to open is not drawn as one that opens. Returns the node and what the page needs to open it from outside.
 */
export function createCard(card, { variant = 'in-chat', id, decorate } = {}) {
  const root = el('div', `acard ${variant}`);
  root.dataset.type = card.type;
  const detail = el('div', 'acard-detail');
  detail.id = id;
  detail.hidden = true;
  if (card.detail) detail.append(el('p', 'acard-detail-text', card.detail));
  // the questions of a mock interview, each with its "Practise this" (review.js): a card with items opens even when it has no words of its own
  const review = card.items && card.items.length ? reviewList(card.items) : null;
  if (review) detail.append(review);
  const decorated = decorate ? decorate(detail, card) === true : false;
  const openable = !!card.detail || !!review || decorated;
  const head = el(openable ? 'button' : 'div', 'acard-head');
  if (openable) {
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    head.setAttribute('aria-controls', id);
  }
  const tile = el('span', 'acard-tile');
  tile.append(icon(card.type));
  const main = el('span', 'acard-main');
  main.append(el('span', 'acard-title', card.title));
  if (card.text) main.append(el('span', 'acard-text', card.text));
  head.append(tile, main);
  const ms = Date.parse(card.ts);
  if (Number.isFinite(ms)) {
    const time = el('time', 'acard-time', clockText(ms));
    time.dateTime = new Date(ms).toISOString();
    head.append(time);
  }
  if (openable) {
    const chev = icon('chevron');
    chev.classList.add('acard-chev');
    head.append(chev);
  }
  root.append(head, detail);
  const view = {
    node: root,
    head,
    detail,
    openable,
    isOpen: () => !detail.hidden,
    /** Opens or closes the detail (`force`: true or false; nothing: the other of the two). A card with nothing to open stays as it is. */
    toggle(force) {
      if (!openable) return false;
      const open = force === undefined ? detail.hidden : !!force;
      detail.hidden = !open;
      head.setAttribute('aria-expanded', String(open));
      root.classList.toggle('open', open);
      return open;
    },
  };
  if (openable) head.addEventListener('click', () => view.toggle());
  return view;
}

/**
 * The Activity sheet. `dialog` is the <dialog id="activity"> of index.html, `api(path)` the page's own call (it answers { status, data }),
 * `toast(message)` its small message, `onSignedOut()` what to do when the server says the session is over. `canShow(n)` says whether the
 * conversation holds the line with that number and `showInChat(n)` takes the reader to it; `onToggle(open)` is told when the sheet opens and
 * when it closes, however it closes (the rail's button looks pressed while it is open).
 */
export function createActivityPanel({ dialog, api, toast, onSignedOut, canShow, showInChat, onToggle }) {
  const body = dialog.querySelector('#activity-body');
  const live = dialog.querySelector('#activity-live');
  const closeButton = dialog.querySelector('#activity-close');
  const PAGE = 30;
  let opener = null;
  let run = 0;                       // a load that was started before the sheet was closed (or opened again) is not shown
  let cards = [];                    // what the sheet holds, newest first
  let more = false;
  let loading = false;
  const opened = new Set();          // the numbers of the cards whose detail is open, kept while the list is drawn again

  const announce = (text) => {
    live.textContent = '';
    live.textContent = text;
  };

  /** A row whose line is in the conversation has a button that takes the reader there (so every such row opens). */
  function decorate(detail, card) {
    if (!canShow || !canShow(card.n)) return false;
    const show = el('button', 'acard-show', 'Show in the conversation');
    show.type = 'button';
    show.addEventListener('click', () => {
      close();
      showInChat(card.n);
    });
    detail.append(show);
    return true;
  }

  function row(card) {
    const item = el('li', 'act-item');
    item.dataset.n = card.n;
    const view = createCard(card, { variant: 'in-list', id: `activity-detail-${card.n}`, decorate });
    if (opened.has(card.n)) view.toggle(true);
    view.head.addEventListener('click', () => (view.isOpen() ? opened.add(card.n) : opened.delete(card.n)));
    item.append(view.node);
    return item;
  }

  function draw() {
    if (!cards.length) {
      body.replaceChildren(el('p', 'act-empty', 'Nothing yet. Calls, notes TAi keeps and reminders show up here.'));
      return;
    }
    const sections = groupByDay(cards).map((group) => {
      const section = el('section', 'act-day');
      section.append(el('h3', undefined, group.heading));
      const list = el('ul', 'act-list');
      for (const card of group.cards) list.append(row(card));
      section.append(list);
      return section;
    });
    body.replaceChildren(...sections);
    if (more) {
      const button = el('button', 'btn-plain act-more', 'Show more');
      button.type = 'button';
      button.addEventListener('click', loadMore);
      body.append(button);
    }
  }

  function problem(text) {
    const retry = el('button', 'btn-plain', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', load);
    body.replaceChildren(el('p', 'act-empty', text), retry);
  }

  function signedOut() {
    run++;
    if (dialog.open) dialog.close();
    onSignedOut();
  }

  /** The lines the server answered, as cards that are not on the sheet yet (a line that came by the poll meanwhile is not shown twice). */
  function fresh(entries) {
    const have = new Set(cards.map((card) => card.n));
    const out = [];
    for (const entry of entries) {
      const card = cardOf(entry);
      if (card && !have.has(card.n)) {
        have.add(card.n);
        out.push(card);
      }
    }
    return out;
  }

  const newestFirst = (a, b) => b.n - a.n;

  async function load() {
    const mine = ++run;
    const status = el('p', 'act-empty', 'Loading…');
    status.setAttribute('role', 'status');
    body.replaceChildren(status);
    const reply = await api(`api/activity?limit=${PAGE}`);
    if (mine !== run || !dialog.open) return;
    if (reply.status === 200 && reply.data && Array.isArray(reply.data.entries)) {
      cards = [];
      cards = fresh(reply.data.entries).sort(newestFirst);
      more = reply.data.more === true;
      return draw();
    }
    if (reply.status === 401 || reply.status === 403) return signedOut();
    problem(reply.status === 0 ? 'I cannot be reached right now. Check your connection.' : 'I could not load that. Try again in a moment.');
  }

  async function loadMore() {
    if (loading || !cards.length) return;
    loading = true;
    const mine = run;
    const button = body.querySelector('.act-more');
    if (button) button.disabled = true;
    const reply = await api(`api/activity?limit=${PAGE}&before=${cards[cards.length - 1].n}`);
    loading = false;
    if (mine !== run || !dialog.open) return;
    if (reply.status === 200 && reply.data && Array.isArray(reply.data.entries)) {
      const added = fresh(reply.data.entries);
      cards = [...cards, ...added].sort(newestFirst);
      more = reply.data.more === true;
      draw();
      if (added.length) body.querySelector(`.act-item[data-n="${added[0].n}"] .acard-head`)?.focus({ preventScroll: false });
      return;
    }
    if (reply.status === 401 || reply.status === 403) return signedOut();
    if (button) button.disabled = false;
    toast(reply.status === 429 ? 'You are going quickly. Wait a moment, then try again.' : "That didn't go through. Try again in a moment.");
  }

  /** A line that arrives while the sheet is open (a call that has just ended): it joins the top, and a screen reader is told. */
  function push(entry) {
    if (!dialog.open) return;
    const added = fresh([entry]);
    if (!added.length) return;
    cards = [...cards, ...added].sort(newestFirst);
    draw();
    announce(`New: ${added[0].title}`);
  }

  function open(from) {
    opener = from || null;
    opened.clear();
    if (!dialog.open) dialog.showModal();
    if (onToggle) onToggle(true);
    closeButton.focus();
    load();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  closeButton.addEventListener('click', close);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();                // the dark around the sheet
  });
  dialog.addEventListener('close', () => {
    run++;
    if (onToggle) onToggle(false);
    const back = opener;
    opener = null;
    if (back && back.isConnected) back.focus();
  });

  return { open, close, push, isOpen: () => dialog.open };
}
