// The registry of chat objects: which renderer draws a line, and that a card can never take the page down.
import { describe, expect, it } from 'vitest';

import { hasObjectRenderer, objectRow, objectTypes, registerObject, registerViewer, setObjectHelpers, viewerApi } from './objects.js';

function fakeEl(tag, className, text) {
  return { tag, className, text, dataset: {}, children: [], append(...kids) { this.children.push(...kids); } };
}

describe('objectRow', () => {
  it('is a list item of the type, numbered, holding what the renderer made', () => {
    setObjectHelpers({ el: fakeEl });
    const node = fakeEl('div', 'card');
    registerObject('probe', (entry) => ({ node, text: `copy of ${entry.text}` }));
    const row = objectRow({ n: 7, text: 'summary', obj: { t: 'probe' } });
    expect(row.tag).toBe('li');
    expect(row.className).toBe('row object');
    expect(row.dataset).toEqual({ n: 7, type: 'probe' });
    expect(row._text).toBe('copy of summary');
    expect(row.children).toEqual([node]);
  });

  it('copies the line\'s summary when the renderer gives no text', () => {
    setObjectHelpers({ el: fakeEl });
    registerObject('plain', () => ({ node: fakeEl('div') }));
    expect(objectRow({ n: 1, text: 'the summary', obj: { t: 'plain' } })._text).toBe('the summary');
  });

  it('is null for a line without an object, a type that has no renderer, or a renderer that throws or gives nothing', () => {
    setObjectHelpers({ el: fakeEl });
    registerObject('boom', () => {
      throw new Error('broken card');
    });
    registerObject('empty', () => null);
    for (const entry of [null, {}, { n: 1, obj: null }, { n: 1, obj: 'run' }, { n: 1, obj: { t: 'nothing-draws-this' } }, { n: 1, obj: { t: 'boom' } }, { n: 1, obj: { t: 'empty' } }]) {
      expect(objectRow(entry)).toBeNull();
    }
  });

  it('is null before the page has handed over its helpers', () => {
    setObjectHelpers(null);
    registerObject('late', () => ({ node: fakeEl('div') }));
    expect(objectRow({ n: 1, obj: { t: 'late' } })).toBeNull();
  });
});

describe('the registry', () => {
  it('says which types have a renderer', () => {
    registerObject('seen', () => ({ node: fakeEl('div') }));
    expect(hasObjectRenderer('seen')).toBe(true);
    expect(hasObjectRenderer('unseen')).toBe(false);
    expect(objectTypes()).toContain('seen');
  });
});

describe('viewerApi', () => {
  it('does nothing until a viewer registers, and then is what the viewer gave', () => {
    expect(viewerApi.open('a'.repeat(32), 1)).toBe(false);
    expect(viewerApi.current()).toBeNull();
    expect(() => viewerApi.screen({ type: 'show' })).not.toThrow();
    registerViewer({ open: () => true, current: () => ({ doc: 'x', page: 3 }) });
    expect(viewerApi.open('a'.repeat(32), 1)).toBe(true);
    expect(viewerApi.current()).toEqual({ doc: 'x', page: 3 });
  });
});
