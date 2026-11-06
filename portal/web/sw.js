// TAi's service worker. It does two things and nothing else: it shows a notification when the server pushes one (src/notify), and when the
// student clicks it, it takes them to the page. It caches nothing and answers no request: the page is always the server's.
//
// Its scope is the page's base path (the file is served from there), so it never sees anything else on the host. What a push says is
// generic by default, {"t":"TAi","b":"TAi has a new message"}; a payload that is missing, broken or odd shows the same words. The server
// is the only party that can encrypt a message for this browser (it holds the VAPID key the subscription was made for), so the text is
// trusted for what it is, a few characters of display, and never for where a click goes: that is always the page itself.
'use strict';

const DEFAULT_TITLE = 'TAi';
const DEFAULT_BODY = 'TAi has a new message';
// one tag: a second notification replaces the first instead of stacking up, so a student who was away sees one line, not five. Chromium replaces a
// notification of the same tag silently unless `renotify` is set, so a later push (an urgent reply) would make no sound while an earlier one is unread:
// show() sets it (it needs the tag, which this is) for every push that is not shown quietly.
const TAG = 'tai-message';

/** The words of a push: the generic ones unless the payload is JSON with a title (`t`) and a body (`b`) that are text. */
function messageOf(event) {
  let title = DEFAULT_TITLE;
  let body = DEFAULT_BODY;
  try {
    const data = event.data ? event.data.json() : null;
    if (data && typeof data === 'object') {
      if (typeof data.t === 'string' && data.t.trim()) title = data.t.trim().slice(0, 60);
      if (typeof data.b === 'string' && data.b.trim()) body = data.b.trim().slice(0, 160);
    }
  } catch (err) {
    /* not JSON: the generic words */
  }
  return { title, body };
}

/** Whether a page of this site is in front and has the focus: the message is on its screen already, so the notification makes no sound. */
async function pageInFront() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.some((client) => client.visibilityState === 'visible' && client.focused);
}

async function show(event) {
  const { title, body } = messageOf(event);
  // Every push shows a notification, even to a page that is in front (the server tries not to push then): a browser that is sent a push and
  // shows nothing may take the subscription away (Safari does, after a few), so the rare one that arrives anyway is shown quietly.
  let quiet = false;
  try {
    quiet = await pageInFront();
  } catch (err) {
    /* no way to look: show it with its sound */
  }
  const icon = new URL('icon-192.png', self.registration.scope).href;
  await self.registration.showNotification(title, { body, tag: TAG, icon, badge: icon, silent: quiet, renotify: !quiet });
}

/** Takes the student to the page: the one that is open (focused), or a new window at the base path. Never to an address a push names. */
async function openPage() {
  const scope = self.registration.scope;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const mine = windows.find((client) => client.url.startsWith(scope));
  if (mine && typeof mine.focus === 'function') {
    try {
      return await mine.focus();
    } catch (err) {
      /* it was closed in the meantime: open one */
    }
  }
  return self.clients.openWindow(scope);
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil(show(event));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openPage());
});
