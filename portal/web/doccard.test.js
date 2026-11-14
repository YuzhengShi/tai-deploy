// The document card: what it shows of its object, what its button says for each state of the viewer, and that it is drawn as DOM built from text and follows the viewer through the view.
import { describe, expect, it, vi } from 'vitest';

import { createViewState } from './view-state.js';
import { cardModel, metaText, openLabel, pagesText, thumbUrl } from './doccard.js';
import { objectRow, setObjectHelpers } from './objects.js';

const DOC = 'c'.repeat(32);
const OBJ = { t: 'doc', doc: DOC, title: 'Homework 5 spec.pdf', pages: 4, page: 1, origin: 'upload' };

/** A node that remembers how it was made: enough DOM for the card, with a click that runs the handlers. */
class FakeNode {
  constructor(tag, className, text) {
    this.tag = tag;
    this.className = className || '';
    this.textContent = text === undefined ? '' : text;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.handlers = {};
    this.removed = false;
  }

  append(...kids) {
    this.children.push(...kids);
  }

  setAttribute(name, value) {
    this.attrs[name] = value;
  }

  addEventListener(type, fn) {
    (this.handlers[type] ||= []).push(fn);
  }

  fire(type) {
    for (const fn of this.handlers[type] || []) fn({ type });
  }

  remove() {
    this.removed = true;
  }

  find(className) {
    for (const kid of this.children) {
      if (kid.className.split(' ').includes(className)) return kid;
      const deeper = kid.find ? kid.find(className) : null;
      if (deeper) return deeper;
    }
    return null;
  }
}

const el = (tag, className, text) => new FakeNode(tag, className, text);

/** What app.js hands the cards, with a real view state (nothing is sent) and a viewer that records what it was asked. */
function helpers({ enabled = true, opens = true } = {}) {
  const view = createViewState({ send: () => undefined });
  const asked = [];
  const toast = vi.fn();
  const viewer = { open: (doc, page) => (asked.push([doc, page]), opens) };
  if (enabled !== undefined) viewer.enabled = () => enabled;
  const icon = (name) => new FakeNode('svg', `icon-${name}`);
  return { h: { el, icon, fullTime: () => '', renderMarkdown: () => null, view, viewer, toast }, view, asked, toast };
}

function draw(obj = OBJ, options) {
  const made = helpers(options);
  setObjectHelpers(made.h);
  const row = objectRow({ n: 5, ts: '2026-11-07T10:00:00Z', role: 'assistant', text: 'Document: Homework 5 spec.pdf (4 pages)', kind: 'object', obj });
  return { row, card: row ? row.children[0] : null, ...made };
}

describe('cardModel', () => {
  it('takes the document, title, page count and the page it opens at', () => {
    expect(cardModel(OBJ)).toEqual({ doc: DOC, title: 'Homework 5 spec.pdf', pages: 4, page: 1, origin: 'upload' });
    expect(cardModel({ ...OBJ, page: 3 }).page).toBe(3);
    expect(cardModel({ t: 'doc', doc: DOC, title: 'Deck', pages: 12 })).toEqual({ doc: DOC, title: 'Deck', pages: 12, page: 1, origin: null });
  });

  it('puts a page outside the document back at page 1 and a missing title as "Document"', () => {
    expect(cardModel({ ...OBJ, page: 9 }).page).toBe(1);
    expect(cardModel({ ...OBJ, page: 0 }).page).toBe(1);
    expect(cardModel({ ...OBJ, page: 'two' }).page).toBe(1);
    expect(cardModel({ ...OBJ, title: '  ' }).title).toBe('Document');
    expect(cardModel({ ...OBJ, title: 'a\nb' }).title).toBe('a b');
  });

  it('is nothing for an object that is not a document card', () => {
    for (const bad of [null, undefined, 'doc', {}, { t: 'run' }, { ...OBJ, doc: 'short' }, { ...OBJ, doc: 7 }, { ...OBJ, pages: 0 }, { ...OBJ, pages: 'four' }, { ...OBJ, pages: 2.5 }]) expect(cardModel(bad)).toBeNull();
  });
});

describe('the words of a card', () => {
  it('counts pages', () => {
    expect(pagesText(1)).toBe('1 page');
    expect(pagesText(4)).toBe('4 pages');
  });

  it('says how many pages, where the card opens when it is not the first, and where the file came from', () => {
    expect(metaText(cardModel({ ...OBJ, origin: undefined }))).toBe('4 pages');
    expect(metaText(cardModel({ ...OBJ, page: 3, origin: 'canvas' }))).toBe('4 pages · opens at page 3 · from Canvas');
    expect(metaText(cardModel({ ...OBJ, origin: 'course', pages: 1 }))).toBe('1 page · course material');
  });

  it('asks for the first page as a picture', () => {
    expect(thumbUrl(DOC)).toBe(`api/doc/page?d=${DOC}&p=1`);
  });
});

describe('openLabel', () => {
  const model = cardModel({ ...OBJ, page: 2 });

  it('reads "Open" while the viewer is closed or has another document', () => {
    expect(openLabel(model, null)).toMatchObject({ text: 'Open', state: 'closed' });
    expect(openLabel(model, { id: 'd'.repeat(32), page: 2 })).toMatchObject({ text: 'Open', state: 'closed' });
  });

  it('reads "Showing" when the viewer is on the page the card opens at, and "Open page" when it has the document at another page', () => {
    expect(openLabel(model, { id: DOC, page: 2 })).toMatchObject({ text: 'Showing', state: 'showing' });
    expect(openLabel(model, { id: DOC, page: 1 })).toMatchObject({ text: 'Open page', state: 'elsewhere' });
    expect(openLabel(model, { id: DOC, page: 4 }).label).toBe('Open page 2 of Homework 5 spec.pdf');
  });

  it('names the document for a screen reader in each state', () => {
    for (const shown of [null, { id: DOC, page: 2 }, { id: DOC, page: 3 }]) expect(openLabel(model, shown).label).toContain('Homework 5 spec.pdf');
  });
});

describe('the card as it is drawn', () => {
  it('is an object row with a tile, the title, the pages and an Open button', () => {
    const { row, card } = draw();
    expect(row.tag).toBe('li');
    expect(row.className).toBe('row object');
    expect(row.dataset.type).toBe('doc');
    expect(row._text).toBe('Document: Homework 5 spec.pdf (4 pages)');
    expect(card.className).toBe('doccard');
    expect(card.attrs['aria-label']).toBe('Document: Homework 5 spec.pdf, 4 pages');
    expect(card.find('doccard-title').textContent).toBe('Homework 5 spec.pdf');
    expect(card.find('doccard-meta').textContent).toBe('4 pages · your file');
    const open = card.find('doccard-open');
    expect(open.tag).toBe('button');
    expect(open.type).toBe('button');
    expect(open.textContent).toBe('Open');
  });

  it('has a page-shaped icon and the first page as a lazy, hidden-until-loaded picture in a tile of its own', () => {
    const { card } = draw();
    const tile = card.find('doccard-thumb');
    expect(tile.attrs['aria-hidden']).toBe('true');
    expect(tile.children[0].className).toBe('icon-file');
    const picture = tile.children[1];
    expect(picture.tag).toBe('img');
    expect(picture.src).toBe(thumbUrl(DOC));
    expect(picture.loading).toBe('lazy');
    expect(picture.alt).toBe('');
    picture.fire('load');
    expect(picture.dataset.ready).toBe('1');
  });

  it('takes a picture that does not come away, leaving the icon', () => {
    const { card } = draw();
    const picture = card.find('doccard-thumb').children[1];
    picture.fire('error');
    expect(picture.removed).toBe(true);
  });

  it('puts the words it was given on the page as text and nothing else (hostile markup stays words)', () => {
    const hostile = '<img src=x onerror="window.__pwned=1"> **not bold**';
    const { card } = draw({ ...OBJ, title: hostile });
    expect(card.find('doccard-title').textContent).toBe(hostile);
    expect(card.attrs['aria-label']).toContain(hostile);
    const everything = JSON.stringify(card, (key, value) => (key === 'handlers' ? undefined : value));
    expect(everything).not.toContain('innerHTML');
  });

  it('is not drawn for an object that is not a document card, and has no emoji and no count', () => {
    expect(draw({ t: 'doc', doc: 'x', title: 'No id', pages: 2 }).row).toBeNull();
    const { card } = draw();
    expect(card.find('doccard-react')).toBeNull();
    expect(card.find('actions')).toBeNull();
    expect(card.find('count')).toBeNull();
  });

  it('opens the viewer at the card\'s page when the button is pressed, and says so in a toast when there is no viewer', () => {
    const { card, asked, toast } = draw({ ...OBJ, page: 3 });
    card.find('doccard-open').fire('click');
    expect(asked).toEqual([[DOC, 3]]);
    expect(toast).not.toHaveBeenCalled();
    const none = draw(OBJ, { opens: false });
    none.card.find('doccard-open').fire('click');
    expect(none.toast).toHaveBeenCalledWith('The document viewer is not available right now.');
  });

  it('follows the viewer: Open, then Showing at its page, Open page elsewhere, Open when it closes', () => {
    const { card, view } = draw({ ...OBJ, page: 2 });
    const open = card.find('doccard-open');
    expect(open.textContent).toBe('Open');
    view.set({ doc: { id: DOC, page: 2 } });
    expect(open.textContent).toBe('Showing');
    expect(open.dataset.state).toBe('showing');
    view.set({ doc: { id: DOC, page: 4 } });
    expect(open.textContent).toBe('Open page');
    view.set({ doc: { id: 'e'.repeat(32), page: 1 } });
    expect(open.textContent).toBe('Open');
    view.set({ doc: { id: DOC, page: 2 } });
    view.set({ doc: null });
    expect(open.textContent).toBe('Open');
  });

  it('starts from the document that is open already, and stops listening when it is taken down', () => {
    const made = helpers();
    made.view.set({ doc: { id: DOC, page: 1 } });
    setObjectHelpers(made.h);
    const row = objectRow({ n: 6, text: 'Document: x', obj: OBJ });
    const open = row.children[0].find('doccard-open');
    expect(open.textContent).toBe('Showing');
    row._object.destroy();
    made.view.set({ doc: null });
    expect(open.textContent).toBe('Showing');      // no longer listening
  });

  it('is only a description, with no button and no picture, while the viewer is switched off', () => {
    const { card } = draw(OBJ, { enabled: false });
    expect(card.find('doccard-open')).toBeNull();
    expect(card.find('doccard-thumb').children).toHaveLength(1);
    expect(card.find('doccard-title').textContent).toBe('Homework 5 spec.pdf');
  });
});
