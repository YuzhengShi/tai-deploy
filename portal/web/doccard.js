// The card of a prepared document in the conversation (a chat object of type 'doc', docs/CHAT_OBJECTS.md): a small page-shaped tile (the first page's picture when it loads), the title, how
// many pages, and a button that opens the viewer on it. The button follows the viewer through the shared view state: "Open" while the document is closed, "Showing" while it is on this
// card's page, "Open page" while the viewer has it open at another one. Everything is DOM built from text; the card is no reply (no emoji, no unread count: objectRow draws it as an object).
import { registerObject } from './objects.js';
import { DOC_ID, oneLine } from './viewer.js';

/** What a card shows of its object, checked again here (the history's gate checked it once): null when it is not a usable document card. */
export function cardModel(obj) {
  if (!obj || typeof obj !== 'object' || obj.t !== 'doc') return null;
  if (typeof obj.doc !== 'string' || !DOC_ID.test(obj.doc)) return null;
  if (!Number.isInteger(obj.pages) || obj.pages < 1) return null;
  const page = Number.isInteger(obj.page) && obj.page >= 1 && obj.page <= obj.pages ? obj.page : 1;
  return { doc: obj.doc, title: oneLine(obj.title, 120) || 'Document', pages: obj.pages, page, origin: ['upload', 'canvas', 'course'].includes(obj.origin) ? obj.origin : null };
}

export const pagesText = (pages) => `${pages} page${pages === 1 ? '' : 's'}`;

const ORIGINS = { upload: 'your file', canvas: 'from Canvas', course: 'course material' };

/** The line under the title: how many pages, where the card opens when that is not the first, and where the file came from. */
export function metaText(model) {
  const parts = [pagesText(model.pages)];
  if (model.page > 1) parts.push(`opens at page ${model.page}`);
  if (model.origin) parts.push(ORIGINS[model.origin]);
  return parts.join(' · ');
}

/**
 * The button of a card, for what the viewer shows (`shown` is the view's `doc`, `{ id, page }`, or null when the viewer is closed): "Open" when the viewer is closed or has another
 * document, "Showing" when it is on this card's page, "Open page" when it has this document open at another page.
 */
export function openLabel(model, shown) {
  if (!shown || shown.id !== model.doc) return { text: 'Open', state: 'closed', label: `Open ${model.title}` };
  if (shown.page === model.page) return { text: 'Showing', state: 'showing', label: `${model.title} is open in the viewer at page ${model.page}. Press to go back to it.` };
  return { text: 'Open page', state: 'elsewhere', label: `Open page ${model.page} of ${model.title}` };
}

export const thumbUrl = (doc) => `api/doc/page?d=${doc}&p=1`;

registerObject('doc', (entry, h) => {
  const model = cardModel(entry.obj);
  if (!model) return null;
  const on = typeof h.viewer.enabled !== 'function' || h.viewer.enabled();

  const node = h.el('div', 'doccard');
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', `Document: ${model.title}, ${pagesText(model.pages)}`);

  // a tile that has its size before the picture arrives; the page-shaped icon is what is there when the picture does not come
  const tile = h.el('span', 'doccard-thumb');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(h.icon('file'));
  if (on) {
    const picture = h.el('img');
    picture.alt = '';
    picture.loading = 'lazy';
    picture.decoding = 'async';
    picture.addEventListener('load', () => {
      picture.dataset.ready = '1';
    });
    picture.addEventListener('error', () => picture.remove());
    picture.src = thumbUrl(model.doc);
    tile.append(picture);
  }

  const main = h.el('div', 'doccard-main');
  main.append(h.el('div', 'doccard-title', model.title), h.el('div', 'doccard-meta', metaText(model)));
  node.append(tile, main);

  let off = () => undefined;
  if (on) {
    const open = h.el('button', 'doccard-open');
    open.type = 'button';
    const paint = (shown) => {
      const label = openLabel(model, shown);
      open.textContent = label.text;
      open.dataset.state = label.state;
      open.setAttribute('aria-label', label.label);
    };
    open.addEventListener('click', () => {
      if (!h.viewer.open(model.doc, model.page)) h.toast('The document viewer is not available right now.');
    });
    paint(h.view && typeof h.view.get === 'function' ? h.view.get().doc || null : null);
    if (h.view && typeof h.view.onChange === 'function') off = h.view.onChange((view) => paint(view.doc || null));
    node.append(open);
  }
  return { node, text: entry.text, destroy: off };
});
