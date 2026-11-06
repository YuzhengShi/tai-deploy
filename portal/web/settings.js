// Settings: what the account menu's Settings entry opens, and the page's sign of life for the server.
//
//  - Notifications: "Notify me in this browser" asks the browser's permission only when it is clicked, subscribes this browser to the server's
//    push (sw.js shows what arrives), and says plainly when the browser cannot, was refused, or (on an iPhone) when the page must first be on
//    the Home Screen. Drawn only when the server says features.push: a switch that cannot work is not drawn.
//  - Voice speed: Slower / Normal / Faster, kept by the server (POST api/prefs) for the next call. Drawn only where voice calls are on.
//  - Time zone: shown, read only, as this device says it; the page sends it to the server by itself after sign-in when it differs from the one
//    the server has (the quiet hours of a notification are the student's own).
//  - The page's sign of life: every poll says whether this tab is in front (and so does a short request when the tab changes), so the server
//    does not push a message to a page that is looking at it. See src/notify/presence.ts.
//
// The pure parts are exported and tested (settings.test.js); createSettings and createPresence are the DOM and network around them.
// What the server sends goes on the page as text, never as HTML.

/** The three speeds of TAi's voice the dialog offers. The server accepts 0.8 to 1.4 in steps of 0.05; what is stored is shown as the nearest of these. */
export const SPEEDS = [
  { label: 'Slower', value: 0.85 },
  { label: 'Normal', value: 1 },
  { label: 'Faster', value: 1.2 },
];

/** The speed of SPEEDS that is nearest to a stored one (Normal for anything that is not a number). */
export function nearestSpeed(value) {
  const n = typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return SPEEDS[1];
  return SPEEDS.reduce((best, option) => (Math.abs(option.value - n) < Math.abs(best.value - n) ? option : best));
}

const sameSpeed = (a, b) => Math.abs(a - b) < 1e-9;

/**
 * The options of the voice speed select. With the deployment's own pace (`GET api/prefs`, `defaults.voiceSpeed`: what a call runs at until the student
 * chooses) among the speeds the dialog can store, that option is marked "(default)"; one that is not among the three is added as "Default (1.1x)",
 * between the others. A default outside what the server accepts (0.8 to 1.4) is not offered: nothing could be stored for it.
 */
export function speedChoices(defaultSpeed) {
  const options = SPEEDS.map((s) => ({ label: s.label, value: s.value, isDefault: false }));
  const d = typeof defaultSpeed === 'number' && Number.isFinite(defaultSpeed) ? Math.round(defaultSpeed * 20) / 20 : NaN;
  if (d >= 0.8 - 1e-9 && d <= 1.4 + 1e-9) {
    const same = options.find((o) => sameSpeed(o.value, d));
    if (same) same.isDefault = true;
    else options.splice(options.findIndex((o) => o.value > d) < 0 ? options.length : options.findIndex((o) => o.value > d), 0, { label: 'Default', value: d, isDefault: true });
  }
  return options.map((o) => ({ ...o, label: o.isDefault ? (o.label === 'Default' ? `Default (${o.value}×)` : `${o.label} (default)`) : o.label }));
}

/** The option of `choices` that shows a student's setting: the one they chose (the nearest, for a stored value the dialog does not offer), or, when they have chosen nothing, the default's. */
export function selectedChoice(choices, stored) {
  if (typeof stored === 'number' && Number.isFinite(stored)) return choices.reduce((best, o) => (Math.abs(o.value - stored) < Math.abs(best.value - stored) ? o : best));
  return choices.find((o) => o.isDefault) || choices.find((o) => sameSpeed(o.value, 1)) || choices[0];
}

/** Which sections of the dialog are drawn, from the raw `features` of GET api/me: notifications (push), voice speed (calls), e-mail; and whether there is anything to open. */
export function visibleSections(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const on = f.prefs === true;
  const sections = { push: on && f.push === true, voice: on && f.voiceCalls === true, email: on && f.email === true };
  return { ...sections, any: sections.push || sections.voice || sections.email };
}

/** The bytes of unpadded base64url (a VAPID public key, as the server serves it): what pushManager.subscribe wants as applicationServerKey. */
export function urlBase64ToBytes(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(text).length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whether two keys (ArrayBuffer or Uint8Array, or nothing) are the same bytes. */
export function sameKey(a, b) {
  if (!a || !b) return false;
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  return x.length === y.length && x.every((byte, i) => byte === y[i]);
}

/** The name the server gives a subscription: the first 16 hex digits of the SHA-256 of its endpoint (src/notify/webpush.ts, endpointHash). */
export async function endpointId(endpoint, subtle) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** An iPhone or iPad (an iPad that says it is a Mac is told by its touch screen). */
export function isIos(nav) {
  if (!nav) return false;
  return /iPhone|iPad|iPod/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

/** Whether the page was opened from the Home Screen (as an installed web app), where iOS allows it to be sent notifications. */
export function isStandalone(nav, win) {
  if (nav && nav.standalone === true) return true;
  try {
    return !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches);
  } catch {
    return false;
  }
}

const IOS_TEXT = 'On iPhone and iPad, add this page to your Home Screen first: tap Share, then Add to Home Screen. Open TAi from there and turn this on again.';
const UNSUPPORTED_TEXT = 'This browser cannot show notifications from a web page.';
const OLD_IOS_TEXT = 'This iPhone cannot show notifications from a web page. It needs iOS 16.4 or later.';
const BLOCKED_TEXT = "Notifications are blocked for this site. Allow them in your browser's settings for this site, then come back here.";

/** Whether this browser can show a pushed notification, and if not, what to tell the student. */
export function pushSupport({ nav, win, standalone }) {
  const serviceWorker = !!nav && 'serviceWorker' in nav;
  const push = !!win && 'PushManager' in win && 'Notification' in win;
  if (serviceWorker && push) return { ok: true };
  if (isIos(nav)) return { ok: false, reason: standalone ? 'old-ios' : 'ios-home-screen', text: standalone ? OLD_IOS_TEXT : IOS_TEXT };
  return { ok: false, reason: 'unsupported', text: UNSUPPORTED_TEXT };
}

/**
 * What the notifications switch looks like: on or off, whether it can be pressed, and the line under it. `problem` is what went wrong the last
 * time it was pressed; it stays until the next press.
 */
export function notifyView({ support, permission, subscribedHere, busy = false, problem = '', loaded = true }) {
  if (!support.ok) return { checked: false, disabled: true, tone: 'plain', note: support.text };
  if (permission === 'denied') return { checked: false, disabled: true, tone: 'plain', note: BLOCKED_TEXT };
  if (!loaded) return { checked: false, disabled: true, tone: problem ? 'problem' : 'plain', note: problem || 'Checking…' };
  if (problem) return { checked: !!subscribedHere, disabled: busy, tone: 'problem', note: problem };
  if (subscribedHere) return { checked: true, disabled: busy, tone: 'plain', note: 'On in this browser.' };
  return { checked: false, disabled: busy, tone: 'plain', note: 'Off in this browser.' };
}

const minutesWords = (n) => (n === 1 ? 'a minute' : n === 60 ? 'an hour' : n > 60 && n % 60 === 0 ? `${n / 60} hours` : `${n} minutes`);

/** What the e-mail switch looks like and says (as notifyView does for the notifications). */
export function emailView({ enabled, busy = false, problem = '', loaded = true }) {
  if (!loaded) return { checked: false, disabled: true, tone: problem ? 'problem' : 'plain', note: problem || 'Checking…' };
  if (problem) return { checked: !!enabled, disabled: busy, tone: 'problem', note: problem };
  return { checked: !!enabled, disabled: busy, tone: 'plain', note: enabled ? 'On: TAi will email you.' : 'Off.' };
}

/** What the e-mail section says: where it goes (the address the student signed in with, never another), when, how often, and what is in it. */
export function emailHint(address, limits) {
  const after = limits && Number.isInteger(limits.emailAfterMinutes) && limits.emailAfterMinutes > 0 ? limits.emailAfterMinutes : 60;
  const max = limits && Number.isInteger(limits.emailDailyMax) && limits.emailDailyMax > 0 ? limits.emailDailyMax : 1;
  return (
    `TAi emails you ${address ? `at ${address}` : 'at the address you signed in with'} when it has written to you on its own and you have not looked at this page for ${minutesWords(after)}, ` +
    `at most ${max === 1 ? 'one a day' : `${max} a day`}. The email only says that there is a message, and links here. A reply to something you wrote is never emailed.`
  );
}

/** "22:00" as "10 pm", "08:30" as "8:30 am", "00:00" as "midnight". */
export function clockWords(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text));
  if (!match) return '';
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours === 0 && minutes === 0) return 'midnight';
  if (hours === 12 && minutes === 0) return 'noon';
  const hour = hours % 12 || 12;
  return `${hour}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''} ${hours < 12 ? 'am' : 'pm'}`;
}

/** What the notifications section says about when TAi notifies, from the server's own limits (GET api/prefs, `limits`). */
export function hintOf(limits) {
  const max = limits && Number.isInteger(limits.dailyMax) ? limits.dailyMax : 3;
  const base = 'A notification only says that TAi has a new message.';
  if (max <= 0) return `${base} You get one when a reply takes a while and this page is not in front of you.`;
  const quiet = limits && limits.quietStart && limits.quietEnd && limits.quietStart !== limits.quietEnd ? `${clockWords(limits.quietStart)} and ${clockWords(limits.quietEnd)}` : '';
  return (
    `${base} TAi's own messages, such as reminders and check-ins, come as one when this page is not in front of you, at most ${max} a day` +
    `${quiet ? `; the ones that come between ${quiet} wait for the morning` : ''}. ` +
    'A reply to something you wrote does too, if it takes a while.'
  );
}

/** The device's time zone as the browser names it, or '' when it names none that the server could take. */
export function detectZone(intl = Intl) {
  try {
    const zone = intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(zone) ? zone : '';
  } catch {
    return '';
  }
}

/** Whether the page should tell the server this device's zone: it has one and the server has not got that one. */
export function needsZoneUpdate(stored, detected) {
  return !!detected && stored !== detected;
}

// ---------------------------------------------------------------- the page's sign of life

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An id for this page load, in the form the server accepts (a version 4 UUID). */
export function makePageId(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl && typeof cryptoImpl.randomUUID === 'function') return cryptoImpl.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoImpl && typeof cryptoImpl.getRandomValues === 'function') cryptoImpl.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The page's part of src/notify/presence.ts. `query()` is what each poll adds to its address (`&c=<this page's id>&v=<1 when the tab is in front>`);
 * `watch(isSignedIn)` sends the server a zero-wait poll with the new state whenever the tab goes behind another or comes back (the poll that is held
 * at the time began with the old state and may be held for 25 s), as a `keepalive` request so that it also leaves when the tab is being closed.
 */
export function createPresence({ doc = document, fetchImpl = (...args) => fetch(...args), id = makePageId() } = {}) {
  const visible = () => (doc.visibilityState === 'hidden' ? 0 : 1);
  return {
    id,
    query: () => `&c=${id}&v=${visible()}`,
    watch(isSignedIn) {
      doc.addEventListener('visibilitychange', () => {
        if (!isSignedIn()) return;
        // `after` is far beyond any message number, so the answer is empty whatever the conversation holds
        Promise.resolve(fetchImpl(`api/poll?after=999999999999&wait=0&c=${id}&v=${visible()}`, { keepalive: true, credentials: 'same-origin', cache: 'no-store' })).catch(() => undefined);
      });
    },
  };
}

// ---------------------------------------------------------------- the dialog

/**
 * The Settings dialog (`<dialog id="settings">` of index.html) and its entry in the account menu (`#menu-settings`). `api(path, {method, body})` is the
 * page's own call (it answers { status, data }); `onSignedOut()` shows the sign-in when the session has ended; `closeMenus()` closes the account menu
 * and `avatar` is the button that opened it (the focus goes back there when the dialog closes: the menu item itself is gone by then).
 */
export function createSettings({ api, toast, onSignedOut, closeMenus, avatar, doc = document, nav = navigator, win = window }) {
  const $ = (id) => doc.getElementById(id);
  const dialog = $('settings');
  const menuItem = $('menu-settings');
  if (!dialog || !menuItem) return { start() {}, leave: async () => {}, open() {}, close() {} };
  const closeButton = $('settings-close');
  const notifySection = $('set-notify');
  const notifySwitch = $('set-notify-switch');
  const notifyNote = $('set-notify-note');
  const notifyHint = $('set-notify-hint');
  const voiceSection = $('set-voice');
  const speedSelect = $('set-speed');
  const emailSection = $('set-email');
  const emailSwitch = $('set-email-switch');
  const emailNote = $('set-email-note');
  const emailHintText = $('set-email-hint');
  const zoneText = $('set-zone');
  const zoneHint = $('set-zone-hint');

  let features = { prefs: false, push: false, voice: false, email: false };
  let address = '';                   // the address the student signed in with: where e-mail goes, and the only place it can go
  let emailBusy = false;
  let emailProblem = '';
  let prefs = null;                   // the server's last answer to GET api/prefs
  let registration = null;            // the promise of the service worker's registration, made when the dialog opens (Safari wants no wait before a tap's own work)
  let key = null;                     // and of the server's public key
  let busy = false;
  let problem = '';
  let run = 0;

  const subtle = () => (win.crypto && win.crypto.subtle) || (globalThis.crypto && globalThis.crypto.subtle);

  function ensureRegistration() {
    if (!registration) {
      registration = nav.serviceWorker.register('sw.js').then(() => nav.serviceWorker.ready);
      registration.catch(() => (registration = null));
    }
    return registration;
  }

  function ensureKey() {
    if (!key) {
      key = api('api/push/key').then((reply) => {
        if (reply.status !== 200 || !reply.data || typeof reply.data.key !== 'string') throw new Error('no key');
        return urlBase64ToBytes(reply.data.key);
      });
      key.catch(() => (key = null));
    }
    return key;
  }

  /** The subscription this browser holds for the page, if any (without making a registration or waiting for one). */
  async function currentSubscription() {
    if (!nav.serviceWorker) return null;
    const existing = await nav.serviceWorker.getRegistration();
    return existing && existing.pushManager ? existing.pushManager.getSubscription() : null;
  }

  async function refresh() {
    const reply = await api('api/prefs');
    if (reply.status === 200 && reply.data) prefs = reply.data;
    else if (reply.status === 401 || reply.status === 403) onSignedOut();
    return reply;
  }

  async function renderNotify() {
    notifySection.hidden = !features.push;
    if (!features.push) return;
    const mine = ++run;
    const support = pushSupport({ nav, win, standalone: isStandalone(nav, win) });
    const permission = support.ok ? win.Notification.permission : 'default';
    let subscribedHere = false;
    if (support.ok && prefs && Array.isArray(prefs.notify && prefs.notify.push)) {
      try {
        const subscription = await currentSubscription();
        if (subscription && subtle()) {
          const id = await endpointId(subscription.endpoint, subtle());
          subscribedHere = prefs.notify.push.some((entry) => entry.id === id);
        }
      } catch {
        /* no way to look: shown as off */
      }
    }
    if (mine !== run) return;
    const view = notifyView({ support, permission, subscribedHere, busy, problem, loaded: !!prefs });
    notifySwitch.setAttribute('aria-checked', String(view.checked));
    notifySwitch.disabled = view.disabled;
    notifyNote.textContent = view.note;
    notifyNote.dataset.tone = view.tone;
    notifyHint.textContent = prefs ? hintOf(prefs.limits) : '';
  }

  function renderVoice() {
    voiceSection.hidden = !features.voice;
    if (!features.voice) return;
    // the options say which speed a call uses until the student chooses (the deployment's own pace, from the server); a stored choice shows as itself
    const choices = speedChoices(prefs && prefs.defaults ? prefs.defaults.voiceSpeed : undefined);
    speedSelect.replaceChildren(
      ...choices.map((choice) => {
        const option = doc.createElement('option');
        option.value = String(choice.value);
        option.textContent = choice.label;
        return option;
      }),
    );
    speedSelect.value = String(selectedChoice(choices, prefs && typeof prefs.voiceSpeed === 'number' ? prefs.voiceSpeed : undefined).value);
  }

  function renderEmail() {
    emailSection.hidden = !features.email;
    if (!features.email) return;
    const view = emailView({ enabled: !!(prefs && prefs.notify && prefs.notify.email && prefs.notify.email.enabled), busy: emailBusy, problem: emailProblem, loaded: !!prefs });
    emailSwitch.setAttribute('aria-checked', String(view.checked));
    emailSwitch.disabled = view.disabled;
    emailNote.textContent = view.note;
    emailNote.dataset.tone = view.tone;
    emailHintText.textContent = emailHint(address, prefs && prefs.limits);
  }

  async function toggleEmail() {
    const want = emailSwitch.getAttribute('aria-checked') !== 'true';
    emailBusy = true;
    emailProblem = '';
    renderEmail();
    try {
      const reply = await api('api/prefs', { method: 'POST', body: { notify: { email: { enabled: want } } } });
      if (reply.status === 200 && reply.data) prefs = reply.data;
      else if (reply.status === 401 || reply.status === 403) onSignedOut();
      else if (reply.data && reply.data.error === 'email-off') emailProblem = 'Email notifications are not switched on just now.';
      else emailProblem = reply.status === 0 ? 'I cannot be reached right now. Check your connection.' : 'That did not go through. Try again in a moment.';
    } finally {
      emailBusy = false;
      renderEmail();
    }
  }

  function renderZone() {
    zoneText.textContent = detectZone() || 'Not known';
    zoneHint.textContent = features.push ? 'Taken from this device. TAi uses it for quiet hours: its reminders and check-ins wait for the morning when they come late at night.' : 'Taken from this device.';
  }

  async function render() {
    renderZone();
    renderVoice();
    renderEmail();
    await renderNotify();
  }

  function say(text) {
    problem = text;
    return render();
  }

  async function turnOn() {
    const support = pushSupport({ nav, win, standalone: isStandalone(nav, win) });
    if (!support.ok) return say(support.text);
    busy = true;
    problem = '';
    notifySwitch.disabled = true;
    let created = false;
    let subscription = null;
    try {
      // The permission is asked for first, straight from the tap: Safari wants it to be the tap's own work, so nothing is awaited before it.
      // (The registration and the server's key were asked for when the dialog opened.)
      let permission = win.Notification.permission;
      if (permission === 'default') {
        permission = await new Promise((resolve) => {
          const asked = win.Notification.requestPermission(resolve);
          if (asked && typeof asked.then === 'function') asked.then(resolve, () => resolve('default'));
        });
      }
      if (permission === 'denied') return await say(BLOCKED_TEXT);
      if (permission !== 'granted') return await say('Notifications were not allowed, so none will be sent. You can turn this on again whenever you like.');
      const [ready, applicationServerKey] = await Promise.all([ensureRegistration(), ensureKey()]);
      subscription = await ready.pushManager.getSubscription();
      // a subscription made for another key (the server's was replaced) cannot be used: it is taken away and made again
      if (subscription && !sameKey(subscription.options && subscription.options.applicationServerKey, applicationServerKey)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      if (!subscription) {
        subscription = await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        created = true;
      }
      const reply = await api('api/push/subscribe', { method: 'POST', body: subscription.toJSON() });
      if (reply.status === 200) {
        await refresh();
        problem = '';
        return;
      }
      if (reply.status === 401 || reply.status === 403) onSignedOut();
      if (created) await subscription.unsubscribe().catch(() => undefined);
      const error = reply.data && reply.data.error;
      return await say(
        error === 'bad-endpoint'
          ? "This browser's notification service is not one TAi can send to."
          : reply.status === 429
            ? 'That was tried a lot just now. Wait a few minutes, then try again.'
            : reply.status === 0
              ? 'I cannot be reached right now. Check your connection.'
              : 'Notifications could not be turned on. Try again in a moment.',
      );
    } catch (err) {
      if (created && subscription) await subscription.unsubscribe().catch(() => undefined);
      return await say(err && err.name === 'NotAllowedError' ? BLOCKED_TEXT : 'Notifications could not be turned on in this browser. Try again in a moment.');
    } finally {
      busy = false;
      await render();
    }
  }

  async function turnOff() {
    busy = true;
    problem = '';
    notifySwitch.disabled = true;
    try {
      const subscription = await currentSubscription();
      if (subscription) {
        const reply = await api('api/push/unsubscribe', { method: 'POST', body: { endpoint: subscription.endpoint } });
        if (reply.status === 401 || reply.status === 403) onSignedOut();
        else if (reply.status !== 200) {
          problem = 'Notifications could not be turned off just now. Try again in a moment.';
          return;
        }
        await subscription.unsubscribe().catch(() => undefined);
      }
      await refresh();
    } catch {
      problem = 'Notifications could not be turned off just now. Try again in a moment.';
    } finally {
      busy = false;
      await render();
    }
  }

  async function chooseSpeed() {
    const value = Number(speedSelect.value);
    const before = prefs && typeof prefs.voiceSpeed === 'number' ? prefs.voiceSpeed : undefined;
    speedSelect.disabled = true;
    const reply = await api('api/prefs', { method: 'POST', body: { voiceSpeed: value } });
    speedSelect.disabled = false;
    if (reply.status === 200 && reply.data) {
      prefs = reply.data;
      return;
    }
    renderVoice();                                          // back to what is stored (or, with nothing stored, to the default)
    if (reply.status === 401 || reply.status === 403) return onSignedOut();
    toast(reply.status === 0 ? 'I cannot be reached right now. Check your connection.' : "That didn't go through. Try again in a moment.");
  }

  /** After sign-in: the device's zone goes to the server when the server has another (or none). Nothing is shown. */
  async function syncZone() {
    const reply = await refresh();
    const detected = detectZone();
    if (reply.status === 200 && reply.data && needsZoneUpdate(reply.data.tz, detected)) {
      const updated = await api('api/prefs', { method: 'POST', body: { tz: detected } });
      if (updated.status === 200 && updated.data) prefs = updated.data;
    }
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    closeMenus();
    closeButton.focus();
    problem = '';
    if (features.push && nav.serviceWorker) {
      ensureRegistration().catch(() => undefined);
      ensureKey().catch(() => undefined);
    }
    render();
    refresh().then((reply) => {
      if (!prefs && reply.status !== 401 && reply.status !== 403) problem = 'Your settings could not be loaded just now. Close this and open it again in a moment.';
      return render();
    });
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  menuItem.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();                 // the dark around the dialog
  });
  dialog.addEventListener('close', () => {
    run++;
    if (avatar && avatar.isConnected) avatar.focus();
  });
  notifySwitch.addEventListener('click', () => {
    if (busy) return;
    (notifySwitch.getAttribute('aria-checked') === 'true' ? turnOff : turnOn)();
  });
  speedSelect.addEventListener('change', chooseSpeed);
  emailSwitch.addEventListener('click', () => {
    if (!emailBusy) toggleEmail();
  });

  return {
    /** After sign-in, with the raw `features` of GET api/me and the signed-in `user`: shows the menu entry when there is something to set, and tells the server the zone. */
    start(raw, user) {
      const f = raw && typeof raw === 'object' ? raw : {};
      const sections = visibleSections(raw);
      features = { prefs: f.prefs === true, push: sections.push, voice: sections.voice, email: sections.email };
      address = user && typeof user.email === 'string' ? user.email : '';
      prefs = null;
      registration = null;
      key = null;
      menuItem.hidden = !sections.any;
      if (features.prefs) syncZone().catch(() => undefined);
      if (features.push && nav.serviceWorker) ensureRegistration().catch(() => undefined);
    },
    /** Signing out turns this browser's notifications off for this student: a computer that someone else signs in on next must not keep theirs. */
    async leave() {
      if (!features.push || !nav.serviceWorker) return;
      try {
        const subscription = await currentSubscription();
        if (!subscription) return;
        const reply = await api('api/push/unsubscribe', { method: 'POST', body: { endpoint: subscription.endpoint } });
        if (reply.status === 200 && reply.data && reply.data.removed) await subscription.unsubscribe();
      } catch {
        /* signing out goes on */
      }
    },
    open,
    close,
  };
}
