// The service worker, run as the browser runs it (a script that only registers handlers) with a stand-in for `self`: what a push shows, and
// where a click on the notification goes.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'sw.js'), 'utf-8');
const SCOPE = 'https://tai.example/tai/';

function load({ windows = [], matchAllFails = false } = {}) {
  const handlers = {};
  const shown = [];
  const self = {
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => {
        if (matchAllFails) throw new Error('no clients');
        return windows;
      }),
      openWindow: vi.fn(async (url) => ({ url })),
    },
    registration: { scope: SCOPE, showNotification: vi.fn(async (title, options) => void shown.push({ title, options })) },
  };
  vm.runInNewContext(source, { self, URL });
  return { handlers, self, shown };
}

/** Fires an event the way the browser does and waits for what the handler handed to waitUntil. */
async function fire(handlers, type, event = {}) {
  let pending;
  handlers[type]({ ...event, waitUntil: (promise) => (pending = promise) });
  await pending;
}

const pushOf = (data) => ({ data: data === undefined ? null : { json: () => (typeof data === 'function' ? data() : data) } });

describe('the service worker', () => {
  it('registers its four handlers, takes over at once and caches nothing', async () => {
    const { handlers, self } = load();
    expect(Object.keys(handlers).sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
    handlers.install();
    expect(self.skipWaiting).toHaveBeenCalled();
    await fire(handlers, 'activate');
    expect(self.clients.claim).toHaveBeenCalled();
    expect(source).not.toMatch(/caches\.|addEventListener\('fetch'/);
  });

  describe('a push', () => {
    it('shows the generic notification the server sends: TAi, TAi has a new message', async () => {
      const { handlers, shown } = load();
      await fire(handlers, 'push', pushOf({ v: 1, t: 'TAi', b: 'TAi has a new message', tag: 'tai-message', ts: 1 }));
      expect(shown).toEqual([{ title: 'TAi', options: { body: 'TAi has a new message', tag: 'tai-message', icon: `${SCOPE}icon-192.png`, badge: `${SCOPE}icon-192.png`, silent: false, renotify: true } }]);
    });

    it('shows the same words when the payload is missing, is not JSON, or says something that is not text', async () => {
      for (const data of [undefined, () => { throw new SyntaxError('not JSON'); }, null, 'text', 5, [], {}, { t: 5, b: { x: 1 } }, { t: '  ', b: '' }]) {
        const { handlers, shown } = load();
        await fire(handlers, 'push', pushOf(data));
        expect(shown, JSON.stringify(data)).toHaveLength(1);
        expect(shown[0].title).toBe('TAi');
        expect(shown[0].options.body).toBe('TAi has a new message');
      }
    });

    it('shows a preview when the server sent one, cut to a notification\'s size and as plain text', async () => {
      const { handlers, shown } = load();
      await fire(handlers, 'push', pushOf({ t: 'T'.repeat(200), b: `<b>HW6</b> ${'x'.repeat(500)}` }));
      expect(shown[0].title).toHaveLength(60);
      expect(shown[0].options.body).toHaveLength(160);
      expect(shown[0].options.body.startsWith('<b>HW6</b>')).toBe(true);                  // text: a notification does not read markup
    });

    it('always shows something with one tag, so that two do not pile up, and never needs a page', async () => {
      const { handlers, shown } = load();
      await fire(handlers, 'push', pushOf({ b: 'one' }));
      await fire(handlers, 'push', pushOf({ b: 'two' }));
      expect(shown.map((s) => s.options.tag)).toEqual(['tai-message', 'tai-message']);
    });

    it('alerts again when a push replaces one that is still unread (same tag, renotify: Chromium replaces it silently otherwise), and not when it is shown quietly', async () => {
      const loud = load();
      await fire(loud.handlers, 'push', pushOf({ b: 'one' }));
      await fire(loud.handlers, 'push', pushOf({ b: 'two' }));
      for (const { options } of loud.shown) {
        expect(options.tag).toBe('tai-message');                      // renotify needs a tag: the browser refuses it without one
        expect(options.renotify).toBe(true);
        expect(options.silent).toBe(false);
      }
      const quiet = load({ windows: [{ url: SCOPE, visibilityState: 'visible', focused: true }] });
      await fire(quiet.handlers, 'push', pushOf({ b: 'x' }));
      expect(quiet.shown[0].options).toMatchObject({ silent: true, renotify: false });   // nothing to alert with, and a quiet one must not
    });

    it('shows it without a sound when a page of this site is in front and has the focus, and with one for a page that is behind or not focused', async () => {
      const front = load({ windows: [{ url: `${SCOPE}`, visibilityState: 'visible', focused: true }] });
      await fire(front.handlers, 'push', pushOf({ b: 'x' }));
      expect(front.shown).toHaveLength(1);
      expect(front.shown[0].options.silent).toBe(true);
      expect(front.self.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
      for (const window of [{ visibilityState: 'hidden', focused: false }, { visibilityState: 'visible', focused: false }]) {
        const behind = load({ windows: [{ url: SCOPE, ...window }] });
        await fire(behind.handlers, 'push', pushOf({ b: 'x' }));
        expect(behind.shown[0].options.silent).toBe(false);
      }
    });

    it('still shows it when the browser will not say which pages are open', async () => {
      const { handlers, shown } = load({ matchAllFails: true });
      await fire(handlers, 'push', pushOf({ b: 'x' }));
      expect(shown).toHaveLength(1);
      expect(shown[0].options.silent).toBe(false);
    });
  });

  describe('a click on the notification', () => {
    const click = (extra = {}) => ({ notification: { close: vi.fn(), data: undefined, ...extra } });

    it('closes it and takes the student to the page that is open', async () => {
      const focus = vi.fn(async () => undefined);
      const { handlers, self } = load({ windows: [{ url: 'https://tai.example/other/', focus: vi.fn() }, { url: `${SCOPE}`, focus }] });
      const event = click();
      await fire(handlers, 'notificationclick', event);
      expect(event.notification.close).toHaveBeenCalled();
      expect(focus).toHaveBeenCalled();
      expect(self.clients.openWindow).not.toHaveBeenCalled();
    });

    it('opens the page when it is not open, or the one that was open cannot be focused', async () => {
      const none = load({ windows: [{ url: 'https://tai.example/other/', focus: vi.fn() }] });
      await fire(none.handlers, 'notificationclick', click());
      expect(none.self.clients.openWindow).toHaveBeenCalledWith(SCOPE);
      const closed = load({ windows: [{ url: SCOPE, focus: vi.fn(async () => { throw new Error('closed'); }) }] });
      await fire(closed.handlers, 'notificationclick', click());
      expect(closed.self.clients.openWindow).toHaveBeenCalledWith(SCOPE);
    });

    it('goes to the page and nowhere else, whatever the notification carries', async () => {
      const { handlers, self } = load();
      await fire(handlers, 'notificationclick', click({ data: { url: 'https://evil.example/phish' } }));
      expect(self.clients.openWindow).toHaveBeenCalledTimes(1);
      expect(self.clients.openWindow).toHaveBeenCalledWith(SCOPE);
    });
  });
});
