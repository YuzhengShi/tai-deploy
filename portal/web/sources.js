// "Looked at": the line under a reply that says what TAi opened to write it: an assignment on Canvas, a repository on GitHub, a Piazza post, a document of
// the course. The server puts `sources` on the history line of the reply (src/sources.ts: at most four chips, a kind, a label of one line, and a link only
// for a host the deployment names); this file draws them. It is what TAi's tools returned for that message, not what the reply cites, and the words say so.
// Everything goes on the page as text (textContent), and a link opens in a new tab with rel="noopener noreferrer". Never on a card, a spoken line or a
// reaction, and the copy button does not take it: app.js calls lookedAt() for a reply's bubble only, and the text it copies is not read from the page.

export const MAX_CHIPS = 4;
const LABEL_CHARS = 80;
const URL_CHARS = 300;

/** What a kind of chip is called in front of its label. */
export const KIND_NAMES = { canvas: 'Canvas', github: 'GitHub', piazza: 'Piazza', course: 'Course materials' };

/** One line of at most `max` characters: control, format (bidi override, zero width) and line-separator characters gone, white space collapsed. */
function oneLine(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The address as a link may carry it, or null: https, no user name or password, no port, no white space, short. (The server checks the host; this is the page's own check.) */
export function safeHref(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > URL_CHARS || /[\s\p{Cc}\p{Cf}]/u.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/** The chips of a history line as the page draws them: [{ kind, label, href? }], at most four, anything unusable left out. */
export function cleanChips(raw) {
  if (!Array.isArray(raw)) return [];
  const chips = [];
  for (const entry of raw) {
    if (chips.length >= MAX_CHIPS) break;
    if (!entry || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(KIND_NAMES, entry.kind)) continue;
    const label = oneLine(entry.label, LABEL_CHARS);
    if (!label) continue;
    const href = safeHref(entry.url);
    chips.push({ kind: entry.kind, label, ...(href ? { href } : {}) });
  }
  return chips;
}

/** What a chip says: its kind and its label ("Canvas · Homework 6"). */
export const chipText = (chip) => `${KIND_NAMES[chip.kind]} · ${chip.label}`;

/**
 * The line under a reply, as a node, or null when the turn looked at nothing. `doc` is the document (a test gives a small fake); the reply's own
 * words and the chips are text nodes, never markup.
 */
export function lookedAt(sources, doc = document) {
  const chips = cleanChips(sources);
  if (chips.length === 0) return null;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const line = make('div', 'looked');
  line.setAttribute('role', 'group');
  line.setAttribute('aria-label', 'What TAi looked at for this reply');
  line.append(make('span', 'looked-lead', 'Looked at'));
  for (const chip of chips) {
    if (chip.href) {
      const link = make('a', 'chip link', chipText(chip));
      link.setAttribute('href', chip.href);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.append(make('span', 'sr-only', ' (opens in a new tab)'));
      line.append(link);
    } else {
      line.append(make('span', 'chip', chipText(chip)));
    }
  }
  return line;
}
