// "Looked at" (sources.js): which chips of a history line the page draws, the links it allows, and that the line is built from text only. The node is built
// into a small fake document here (the dev server shows the real one).
import { describe, expect, it } from 'vitest';

import { KIND_NAMES, MAX_CHIPS, chipText, cleanChips, lookedAt, safeHref } from './sources.js';

/** Enough of a document to build the line: elements that record what they were given. Reading or writing innerHTML is an error. */
function fakeDocument() {
  const make = (tag) => ({
    tag,
    className: '',
    textContent: undefined,
    children: [],
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    get innerHTML() {
      throw new Error('innerHTML is never read');
    },
    set innerHTML(_value) {
      throw new Error('innerHTML is never set');
    },
  });
  return { createElement: make };
}

describe('a link a chip may have', () => {
  it('is https, with no user name, password or port, no white space, and short', () => {
    expect(safeHref('https://canvas.example.edu/courses/1/assignments/107')).toBe('https://canvas.example.edu/courses/1/assignments/107');
    for (const bad of ['http://canvas.example.edu/a', 'javascript:alert(1)', 'data:text/html,hi', '//canvas.example.edu/a', 'https://u:p@canvas.example.edu/a', 'https://canvas.example.edu:8443/a', 'https://canvas.example.edu/a b', `https://canvas.example.edu/${'x'.repeat(400)}`, 'canvas', '', null, undefined, 7]) {
      expect(safeHref(bad), String(bad)).toBeNull();
    }
  });
});

describe('the chips of a history line', () => {
  it('are the kinds the page knows, with a label of one line, at most four', () => {
    const chips = cleanChips([
      { kind: 'canvas', label: '  Homework\n 6\u0007 ', url: 'https://canvas.example.edu/a' },
      { kind: 'github', label: 'ann/hw3' },
      { kind: 'piazza', label: '@45 Raft timeouts' },
      { kind: 'course', label: 'Raft_lecture' },
      { kind: 'canvas', label: 'a fifth' },
    ]);
    expect(chips).toHaveLength(MAX_CHIPS);
    expect(chips[0]).toEqual({ kind: 'canvas', label: 'Homework 6', href: 'https://canvas.example.edu/a' });
    expect(chips[1]).toEqual({ kind: 'github', label: 'ann/hw3' });
  });

  it('leave out what is not usable: an unknown kind, no label, not an object, a name that is on the prototype', () => {
    expect(cleanChips([{ kind: 'bogus', label: 'x' }, { kind: 'canvas', label: '' }, { kind: 'canvas' }, 'x', null, { kind: 'toString', label: 'x' }, { kind: '__proto__', label: 'x' }])).toEqual([]);
    expect(cleanChips(undefined)).toEqual([]);
    expect(cleanChips('canvas')).toEqual([]);
    expect(cleanChips({ kind: 'canvas', label: 'x' })).toEqual([]);
  });

  it('keep the label and drop a link that is not safe; strip what reorders text; cut a long label to 80', () => {
    const [bad] = cleanChips([{ kind: 'canvas', label: 'x', url: 'javascript:alert(1)' }]);
    expect(bad).toEqual({ kind: 'canvas', label: 'x' });
    const [odd] = cleanChips([{ kind: 'canvas', label: `a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x200b)}c` }]);
    expect(odd.label).toBe('a b c');
    const [long] = cleanChips([{ kind: 'canvas', label: 'y'.repeat(200) }]);
    expect(long.label).toHaveLength(80);
    expect(long.label.endsWith('…')).toBe(true);
  });

  it('say their kind and their label', () => {
    expect(chipText({ kind: 'canvas', label: 'Homework 6' })).toBe('Canvas · Homework 6');
    expect(chipText({ kind: 'course', label: 'Raft_lecture' })).toBe('Course materials · Raft_lecture');
    expect(Object.keys(KIND_NAMES)).toEqual(['canvas', 'github', 'piazza', 'course']);
  });
});

describe('the line under a reply', () => {
  it('is nothing when the turn looked at nothing, or the chips are all unusable', () => {
    const doc = fakeDocument();
    expect(lookedAt(undefined, doc)).toBeNull();
    expect(lookedAt([], doc)).toBeNull();
    expect(lookedAt([{ kind: 'bogus', label: 'x' }], doc)).toBeNull();
  });

  it('says "Looked at" and shows each chip: a link that opens in a new tab and keeps the page to itself, or a label', () => {
    const line = lookedAt(
      [
        { kind: 'canvas', label: 'Homework 6: Scalability?', url: 'https://canvas.example.edu/courses/1/assignments/107' },
        { kind: 'piazza', label: '@45 Raft timeouts' },
      ],
      fakeDocument(),
    );
    expect(line.className).toBe('looked');
    expect(line.attrs.role).toBe('group');
    const [lead, link, plain] = line.children;
    expect(lead.textContent).toBe('Looked at');
    expect(link.tag).toBe('a');
    expect(link.textContent).toBe('Canvas · Homework 6: Scalability?');
    expect(link.attrs).toMatchObject({ href: 'https://canvas.example.edu/courses/1/assignments/107', target: '_blank', rel: 'noopener noreferrer' });
    expect(link.children[0].textContent).toBe(' (opens in a new tab)');
    expect(link.children[0].className).toBe('sr-only');
    expect(plain.tag).toBe('span');
    expect(plain.textContent).toBe('Piazza · @45 Raft timeouts');
    expect(plain.attrs.href).toBeUndefined();
  });

  it('puts markup in a label on the page as it is: text, never HTML (the fake document throws if innerHTML is touched)', () => {
    const line = lookedAt([{ kind: 'canvas', label: '<img src=x onerror=alert(1)>' }], fakeDocument());
    expect(line.children[1].textContent).toBe('Canvas · <img src=x onerror=alert(1)>');
  });

  it('never links a chip whose address is not safe', () => {
    const line = lookedAt([{ kind: 'github', label: 'x', url: 'http://github.com/a' }, { kind: 'github', label: 'y', url: 'javascript:alert(1)' }], fakeDocument());
    expect(line.children.slice(1).map((c) => c.tag)).toEqual(['span', 'span']);
  });
});
