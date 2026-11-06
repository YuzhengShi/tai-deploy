// The page's side of the reply preview (status.js previewText and withoutPreview, the hook in app.js, status.css; docs/STREAMING.md): the words of the
// reply TAi is writing, a sentence at a time, where the dots are. Pure functions here; the DOM is app.js's, which a few source checks pin down (the
// real look is the dev server's, portal/qa/dev_server.mjs /partial).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PREVIEW_MAX, previewText, statusView, withoutPreview } from './status.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => fs.readFileSync(path.join(here, ...parts), 'utf-8');

describe('the words of the reply being written', () => {
  it('are the status\'s partial while TAi works', () => {
    expect(previewText({ state: 'working', label: 'Thinking', partial: 'Raft elects a leader. A candidate needs votes.' })).toBe('Raft elects a leader. A candidate needs votes.');
    expect(previewText({ state: 'working', partial: 'One is first.\n\nTwo is second.' })).toBe('One is first.\n\nTwo is second.');
  });

  it('are nothing without the flag (the field is never there), for a message in line, or for anything that is not a plain string', () => {
    expect(previewText({ state: 'working', label: 'Thinking' })).toBe('');
    expect(previewText({ state: 'queued', ahead: 1, partial: 'Not while waiting.' })).toBe('');
    for (const partial of ['', '  \n ', 7, null, ['x'], { text: 'x' }, true]) expect(previewText({ state: 'working', partial }), JSON.stringify(partial)).toBe('');
    for (const status of [undefined, null, 'working', 42, []]) expect(previewText(status), JSON.stringify(status)).toBe('');
    expect(previewText({ state: 'working', partial: 'x'.repeat(PREVIEW_MAX + 1) })).toBe('');
    expect(previewText({ state: 'working', partial: 'x'.repeat(PREVIEW_MAX) })).toHaveLength(PREVIEW_MAX);
  });

  it('do not change what the label says: the label logic is the same with a preview in the status', () => {
    const plain = { state: 'working', label: 'Checking Canvas' };
    expect(statusView({ ...plain, partial: 'Words here. And more.' })).toEqual(statusView(plain));
    expect(statusView({ state: 'working', partial: 'Words here.' })).toBeNull();
  });

  it('are taken out of a status that arrives with the reply itself, and nothing else is touched', () => {
    expect(withoutPreview({ state: 'working', label: 'Thinking', partial: 'Words here.' })).toEqual({ state: 'working', label: 'Thinking' });
    const plain = { state: 'working', label: 'Thinking' };
    expect(withoutPreview(plain)).toEqual(plain);
    expect(withoutPreview(undefined)).toBeNull();
    expect(withoutPreview(null)).toBeNull();
    const original = { state: 'working', partial: 'Words here.' };
    withoutPreview(original);
    expect(original.partial).toBe('Words here.');                          // a copy: the caller's status is not changed
  });

  it('are held to the same length on the page, at the server and at the host', () => {
    const server = /const PARTIAL_MAX = (\d+);/.exec(read('..', '..', 'src', 'portal', 'server.ts'));
    const host = /export const PREVIEW_MAX_INPUT = (\d+);/.exec(read('..', '..', 'src', 'stream-preview.ts'));
    expect(Number(server?.[1])).toBe(PREVIEW_MAX);
    expect(Number(host?.[1])).toBe(PREVIEW_MAX);
  });
});

describe('the page', () => {
  const app = read('app.js');
  const css = read('status.css');

  it('draws the words as text (the markdown renderer builds nodes), never read aloud, with the room of the reaction button kept', () => {
    expect(app).toMatch(/draftBox = el\('div', 'md draft'\);\s*draftBox\.setAttribute\('aria-hidden', 'true'\);/);
    expect(app).toMatch(/draftBox\.replaceChildren\(renderMarkdown\(draft\)\)/);
    expect(app).toMatch(/const ghost = actionBar\(true\);\s*ghost\.classList\.add\('ghost'\);\s*ghost\.setAttribute\('aria-hidden', 'true'\);\s*ghost\.inert = true;/);
    expect(app).not.toMatch(/draftBox\.(innerHTML|insertAdjacentHTML|outerHTML)/);
  });

  it('lets the reply that arrives take the place without fading in again, and ignores the words that come with it', () => {
    expect(app).toMatch(/classList\.contains\('has-preview'\)\) row\.classList\.add\('no-rise'\)/);
    expect(app).toMatch(/some\(\(e\) => e\.role !== 'user' && !isActivityLine\(e\) && showable\(e\)\)/);
    expect(css).toMatch(/\.row\.no-rise \{ animation: none; \}/);
  });

  it('gives the preview the padding of a reply\'s bubble, and takes the dots, the label and the note out while the words are there', () => {
    expect(css).toMatch(/\.row\.typing\.has-preview \.bubble, \.row\.typing\.has-preview \.bubble\.has-label \{[^}]*padding: 14px 20px;/);
    expect(css).toMatch(/\.row\.typing\.has-preview \.typing-note \{ display: none; \}|\.typing-note \{ display: none; \}/);
    expect(css).toMatch(/\.actions\.ghost \{ visibility: hidden;/);
    // style.css's reply bubble has this padding: if it ever changes, the preview's box must change with it
    expect(read('style.css')).toMatch(/\.bubble \{[^}]*padding: 14px 20px;/);
  });
});
