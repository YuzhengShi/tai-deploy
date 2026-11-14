// Chat objects on the page (docs/CHAT_OBJECTS.md): the cards that live in the conversation beside the words (a run of the student's code, a document, a chart, a trace, a
// prediction), and the one viewer that documents open in. A line of the history with kind 'object' carries `obj` (its `t` names the type) and `text` (its one-line summary).
//
// This file is the registry and nothing else: each type has a module of its own that registers a renderer on import (runcard.js, doccard.js, ...), and app.js imports them all, so
// adding a type never touches app.js. A renderer is `(entry, helpers) => ({ node, text?, destroy? })`; `helpers` is what app.js hands over once (`setObjectHelpers`): the DOM builder,
// the icons, the markdown renderer, the shared view state (view-state.js), and the viewer. Everything a renderer puts on the page is DOM built from text: never HTML, never SVG markup.
//
// The viewer (viewer.js) registers itself with `registerViewer`; until it has, `viewerApi` does nothing, so a page without it (or a test) still draws the cards.

const renderers = new Map();
let helpers = null;

/** What the rest of the page may ask of the viewer; viewer.js replaces the parts it has. */
export const viewerApi = {
  /** Opens a prepared document at a page (1-based). Answers whether a viewer is there to open it. */
  open: () => false,
  /** The server's `show` and `point` and `doc_state` messages of a call (src/voice/session.ts): the viewer goes to a page, draws boxes, shows that a document is being prepared. */
  screen: () => {},
  /** The document and page that are open ({ doc, page }), or null. */
  current: () => null,
  /** Whether the viewer is on (a card draws no Open button or thumbnail when it is not). */
  enabled: () => false,
};

export function registerViewer(impl) {
  Object.assign(viewerApi, impl);
}

/** Called once by app.js when it has what renderers need. */
export function setObjectHelpers(value) {
  helpers = value;
}

export function registerObject(type, factory) {
  renderers.set(type, factory);
}

export const hasObjectRenderer = (type) => renderers.has(type);

export const objectTypes = () => [...renderers.keys()];

/**
 * The row of an object line, or null when there is nothing to draw (no object, a type this page has no renderer for, a renderer that threw: a card must never take the
 * conversation down with it). The row is a list item like the others; it is no reply of TAi's (no emoji, no unread count).
 */
export function objectRow(entry) {
  const obj = entry && entry.obj;
  if (!obj || typeof obj !== 'object' || !helpers) return null;
  const factory = renderers.get(obj.t);
  if (!factory) return null;
  let made;
  try {
    made = factory(entry, helpers);
  } catch {
    return null;
  }
  if (!made || !made.node) return null;
  const row = helpers.el('li', 'row object');
  row.dataset.n = entry.n;
  row.dataset.type = obj.t;
  row._text = typeof made.text === 'string' ? made.text : entry.text || '';
  row._object = made;
  row.append(made.node);
  return row;
}
