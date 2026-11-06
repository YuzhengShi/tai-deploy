// A page file the server does not serve is a page that does not start: app.js imports its modules by name, and the server hands out only the names
// of PAGE_FILES (src/portal/start.ts). This reads both and says which module is missing from the list.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(file, 'utf-8');

/** The names a module imports from its own directory: `from './activity.js'`, or a worklet's `addModule('voice-worklet.js')`. */
function importedBy(file) {
  const text = read(path.join(here, file));
  const names = [...text.matchAll(/from\s+'\.\/([A-Za-z0-9_.-]+\.js)'/g)].map((m) => m[1]);
  for (const m of text.matchAll(/addModule\(\s*['"]([A-Za-z0-9_.-]+\.js)['"]/g)) names.push(m[1]);
  for (const m of text.matchAll(/serviceWorker\.register\(\s*['"]([A-Za-z0-9_.-]+\.js)['"]/g)) names.push(m[1]);       // the service worker (settings.js)
  return names;
}

describe('the page files the server serves', () => {
  const start = read(path.join(here, '..', '..', 'src', 'portal', 'start.ts'));
  const list = /export const PAGE_FILES = \[([^\]]*)\]/.exec(start);
  const served = list ? [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

  it('can be read from src/portal/start.ts', () => {
    expect(served).toContain('index.html');
    expect(served).toContain('app.js');
  });

  it('hold every module the page imports, and the files index.html names', () => {
    const wanted = new Set(['index.html', 'style.css', 'mark.svg', 'app.js', 'voice.js']);
    const queue = ['app.js', 'voice.js'];
    for (let file = queue.shift(); file; file = queue.shift()) {
      for (const name of importedBy(file)) {
        if (!wanted.has(name)) {
          wanted.add(name);
          queue.push(name);
        }
      }
    }
    const html = read(path.join(here, 'index.html'));
    for (const m of html.matchAll(/(?:src|href)="([A-Za-z0-9_.-]+\.(?:js|css|svg|png|webmanifest))"/g)) wanted.add(m[1]);
    const missing = [...wanted].filter((name) => !served.includes(name));
    expect(missing, `served: ${served.join(', ')}`).toEqual([]);
  });

  it('name no file that is not there', () => {
    const absent = served.filter((name) => !fs.existsSync(path.join(here, name)));
    expect(absent).toEqual([]);
  });

  it('are the same list as the dev server serves: a page file missing there starts a page that cannot load its own modules', () => {
    const dev = read(path.join(here, '..', 'qa', 'dev_server.mjs'));
    const devList = /const PAGE_FILES = \[([^\]]*)\]/.exec(dev);
    const devServed = devList ? [...devList[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
    expect(devServed.length).toBeGreaterThan(0);
    expect([...devServed].sort()).toEqual([...served].sort());
  });
});
