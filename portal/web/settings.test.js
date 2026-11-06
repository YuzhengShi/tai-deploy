// The pure parts of Settings (what the notifications switch says, which browsers can be sent notifications, the speeds, the zone, the page's sign of
// life) and the files a home-screen app is made of. (The dialog itself is DOM: portal/qa/portal_e2e.py opens it.)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { endpointHash } from '../../src/notify/webpush.ts';
import {
  SPEEDS,
  clockWords,
  createPresence,
  detectZone,
  emailHint,
  emailView,
  endpointId,
  hintOf,
  isIos,
  isStandalone,
  makePageId,
  nearestSpeed,
  needsZoneUpdate,
  notifyView,
  pushSupport,
  sameKey,
  selectedChoice,
  speedChoices,
  urlBase64ToBytes,
  visibleSections,
} from './settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

describe('the voice speeds', () => {
  it('are Slower, Normal and Faster, and a stored speed shows as the nearest', () => {
    expect(SPEEDS.map((s) => s.label)).toEqual(['Slower', 'Normal', 'Faster']);
    expect(SPEEDS.map((s) => s.value)).toEqual([0.85, 1, 1.2]);
    for (const [stored, label] of [[0.85, 'Slower'], [0.8, 'Slower'], [0.9, 'Slower'], [1, 'Normal'], [1.05, 'Normal'], [1.15, 'Faster'], [1.2, 'Faster'], [1.4, 'Faster']]) {
      expect(nearestSpeed(stored).label, String(stored)).toBe(label);
    }
    for (const odd of [undefined, null, NaN, 'fast', {}, '1.2']) expect(nearestSpeed(odd).label).toBe('Normal');
  });

  it('are values the server takes (0.8 to 1.4 in steps of 0.05)', () => {
    for (const { value } of SPEEDS) {
      expect(value).toBeGreaterThanOrEqual(0.8);
      expect(value).toBeLessThanOrEqual(1.4);
      expect(Math.abs(value * 20 - Math.round(value * 20))).toBeLessThan(1e-9);
    }
  });
});

describe('what the voice speed select shows', () => {
  const pairs = (choices) => choices.map((c) => [c.value, c.label]);

  it("marks the deployment's own pace when it is one of the three, and shows it until the student has chosen", () => {
    const choices = speedChoices(1.2);
    expect(pairs(choices)).toEqual([[0.85, 'Slower'], [1, 'Normal'], [1.2, 'Faster (default)']]);
    expect(selectedChoice(choices, undefined).value).toBe(1.2);
    expect(selectedChoice(choices, null).value).toBe(1.2);
    expect(selectedChoice(choices, 1).value).toBe(1);                       // a stored "Normal" is Normal: it is a choice, and not the default
    expect(selectedChoice(choices, 0.85).value).toBe(0.85);
    expect(pairs(speedChoices(1))).toEqual([[0.85, 'Slower'], [1, 'Normal (default)'], [1.2, 'Faster']]);
    expect(selectedChoice(speedChoices(1), undefined).value).toBe(1);
  });

  it('adds a default that is none of the three, in its place, labelled by its number', () => {
    expect(pairs(speedChoices(1.1))).toEqual([[0.85, 'Slower'], [1, 'Normal'], [1.1, 'Default (1.1×)'], [1.2, 'Faster']]);
    expect(pairs(speedChoices(1.35)).at(-1)).toEqual([1.35, 'Default (1.35×)']);
    expect(pairs(speedChoices(0.8))[0]).toEqual([0.8, 'Default (0.8×)']);
    expect(selectedChoice(speedChoices(1.1), undefined).value).toBe(1.1);
    expect(selectedChoice(speedChoices(1.1), 1.15).value).toBe(1.1);          // a stored speed that is not offered shows as the nearest option
  });

  it('offers no default that the server could not store (outside 0.8 to 1.4), or none that it did not give, and then Normal is what shows', () => {
    for (const odd of [1.5, 0.7, 2, undefined, null, NaN, '1.2']) {
      expect(speedChoices(odd).every((c) => !c.isDefault), String(odd)).toBe(true);
      expect(pairs(speedChoices(odd))).toEqual([[0.85, 'Slower'], [1, 'Normal'], [1.2, 'Faster']]);
      expect(selectedChoice(speedChoices(odd), undefined).value).toBe(1);
    }
    expect(pairs(speedChoices(1.43)).length).toBe(3);                       // 1.43 rounds to 1.45: out of range
  });
});

describe('which sections of the dialog are drawn', () => {
  it('are the ones the server offers, and the entry opens only when there is one', () => {
    expect(visibleSections({ prefs: true, push: true, voiceCalls: true, email: true })).toEqual({ push: true, voice: true, email: true, any: true });
    expect(visibleSections({ prefs: true, push: false, voiceCalls: true, email: false })).toEqual({ push: false, voice: true, email: false, any: true });
    expect(visibleSections({ prefs: true, email: true })).toEqual({ push: false, voice: false, email: true, any: true });
    expect(visibleSections({ prefs: true, push: false, voiceCalls: false, email: false }).any).toBe(false);
    expect(visibleSections({ prefs: true }).any).toBe(false);
  });

  it('are none without the preferences, and for a features object that is not one', () => {
    expect(visibleSections({ push: true, voiceCalls: true, email: true }).any).toBe(false);
    for (const odd of [undefined, null, 5, 'x', []]) expect(visibleSections(odd), String(odd)).toEqual({ push: false, voice: false, email: false, any: false });
    expect(visibleSections({ prefs: true, email: 'yes' }).email).toBe(false);                 // only true is true
  });
});

describe('what the e-mail switch says', () => {
  it('is on or off, waits for the settings to load, and keeps a problem in view', () => {
    expect(emailView({ enabled: false })).toEqual({ checked: false, disabled: false, tone: 'plain', note: 'Off.' });
    expect(emailView({ enabled: true })).toEqual({ checked: true, disabled: false, tone: 'plain', note: 'On: TAi will email you.' });
    expect(emailView({ enabled: false, loaded: false })).toMatchObject({ disabled: true, note: 'Checking…' });
    expect(emailView({ enabled: true, busy: true })).toMatchObject({ checked: true, disabled: true });
    expect(emailView({ enabled: false, problem: 'No.' })).toEqual({ checked: false, disabled: false, tone: 'problem', note: 'No.' });
  });

  it('tells the student where it goes (the address they signed in with), when, how often, and that it is only a pointer', () => {
    const text = emailHint('ada@example.com', { emailAfterMinutes: 60, emailDailyMax: 1 });
    expect(text).toContain('at ada@example.com');
    expect(text).toContain('for an hour');
    expect(text).toContain('at most one a day');
    expect(text).toContain('only says that there is a message');
    expect(text).toContain('never emailed');
    expect(emailHint('', { emailAfterMinutes: 90, emailDailyMax: 2 })).toContain('at the address you signed in with');
    expect(emailHint('a@b.co', { emailAfterMinutes: 90, emailDailyMax: 2 })).toMatch(/for 90 minutes, at most 2 a day/);
    expect(emailHint('a@b.co', { emailAfterMinutes: 120 })).toContain('for 2 hours');
    expect(emailHint('a@b.co', { emailAfterMinutes: 1 })).toContain('for a minute');
    expect(emailHint('a@b.co', undefined)).toContain('for an hour');
  });
});

describe('the keys and the name of a subscription', () => {
  it('reads unpadded base64url into bytes (the server\'s public key, 65 bytes starting with 4)', () => {
    const key = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
    const bytes = urlBase64ToBytes(key);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
    expect(Buffer.from(bytes).toString('base64url')).toBe(key);
    expect(Array.from(urlBase64ToBytes('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToBytes('AQI'))).toEqual([1, 2]);
  });

  it('compares keys as bytes, from an array or a buffer, and never calls nothing the same as nothing', () => {
    expect(sameKey(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]).buffer)).toBe(true);
    expect(sameKey(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(sameKey(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(sameKey(null, null)).toBe(false);
    expect(sameKey(new Uint8Array([1]), undefined)).toBe(false);
  });

  it('names a subscription the way the server does: the first 16 hex digits of the SHA-256 of its address', async () => {
    for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/gAAAA', 'https://web.push.apple.com/Qéø']) {
      expect(await endpointId(endpoint, crypto.webcrypto.subtle)).toBe(endpointHash(endpoint));
    }
  });
});

describe('which browsers can be sent notifications', () => {
  const full = { serviceWorker: {}, userAgent: DESKTOP, maxTouchPoints: 0 };
  const withPush = { PushManager: function PushManager() {}, Notification: function Notification() {} };

  it('knows an iPhone, an iPad (also when it says it is a Mac) and a page opened from the Home Screen', () => {
    expect(isIos({ userAgent: IPHONE })).toBe(true);
    expect(isIos({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X)' })).toBe(true);
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(isIos({ userAgent: DESKTOP })).toBe(false);
    expect(isIos(undefined)).toBe(false);
    expect(isStandalone({ standalone: true }, {})).toBe(true);
    expect(isStandalone({}, { matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' }) })).toBe(true);
    expect(isStandalone({}, { matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(isStandalone({}, {})).toBe(false);
    expect(isStandalone({}, { matchMedia: () => { throw new Error('no'); } })).toBe(false);
  });

  it('is yes for a browser with service workers, push and notifications', () => {
    expect(pushSupport({ nav: full, win: withPush, standalone: false })).toEqual({ ok: true });
  });

  it('is no, in plain words, for a browser without them', () => {
    const none = pushSupport({ nav: { userAgent: DESKTOP }, win: {}, standalone: false });
    expect(none).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(none.text).toBe('This browser cannot show notifications from a web page.');
    expect(pushSupport({ nav: full, win: { Notification: function Notification() {} }, standalone: false })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(pushSupport({ nav: { userAgent: DESKTOP }, win: withPush, standalone: false })).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('tells an iPhone in a Safari tab to add the page to the Home Screen first, and one that has it there but is too old, that it is too old', () => {
    const tab = pushSupport({ nav: { userAgent: IPHONE }, win: {}, standalone: false });
    expect(tab).toMatchObject({ ok: false, reason: 'ios-home-screen' });
    expect(tab.text).toContain('Home Screen');
    expect(tab.text).toContain('Share');
    expect(tab.text).toContain('Add to Home Screen');
    const old = pushSupport({ nav: { userAgent: IPHONE }, win: {}, standalone: true });
    expect(old).toMatchObject({ ok: false, reason: 'old-ios' });
    expect(old.text).toContain('iOS 16.4');
    expect(pushSupport({ nav: { userAgent: IPHONE, serviceWorker: {} }, win: withPush, standalone: true })).toEqual({ ok: true });
  });
});

describe('what the notifications switch says', () => {
  const ok = { ok: true };

  it('is off, and says so, for a browser that has not been turned on', () => {
    expect(notifyView({ support: ok, permission: 'default', subscribedHere: false })).toEqual({ checked: false, disabled: false, tone: 'plain', note: 'Off in this browser.' });
  });

  it('is on when this browser is one of the student\'s', () => {
    expect(notifyView({ support: ok, permission: 'granted', subscribedHere: true })).toEqual({ checked: true, disabled: false, tone: 'plain', note: 'On in this browser.' });
  });

  it('cannot be pressed, and says why, when the browser cannot or the permission was refused', () => {
    const unsupported = notifyView({ support: { ok: false, text: 'This browser cannot show notifications from a web page.' }, permission: 'default', subscribedHere: false });
    expect(unsupported).toEqual({ checked: false, disabled: true, tone: 'plain', note: 'This browser cannot show notifications from a web page.' });
    const denied = notifyView({ support: ok, permission: 'denied', subscribedHere: false });
    expect(denied).toMatchObject({ checked: false, disabled: true });
    expect(denied.note).toContain('blocked');
    expect(denied.note).toContain("browser's settings");
  });

  it('waits for the settings to load, and keeps a problem in view in the colour of one', () => {
    expect(notifyView({ support: ok, permission: 'default', subscribedHere: false, loaded: false })).toMatchObject({ disabled: true, note: 'Checking…' });
    expect(notifyView({ support: ok, permission: 'default', subscribedHere: false, loaded: false, problem: 'Not loaded.' })).toMatchObject({ disabled: true, tone: 'problem', note: 'Not loaded.' });
    expect(notifyView({ support: ok, permission: 'granted', subscribedHere: false, problem: 'Could not turn on.' })).toEqual({ checked: false, disabled: false, tone: 'problem', note: 'Could not turn on.' });
    expect(notifyView({ support: ok, permission: 'granted', subscribedHere: true, busy: true })).toMatchObject({ checked: true, disabled: true });
  });
});

describe('what the section says about when TAi notifies', () => {
  it('writes a clock as words', () => {
    expect([clockWords('22:00'), clockWords('08:00'), clockWords('08:30'), clockWords('00:00'), clockWords('12:00'), clockWords('13:05'), clockWords('x')]).toEqual(['10 pm', '8 am', '8:30 am', 'midnight', 'noon', '1:05 pm', '']);
  });

  it('says the limit and the quiet hours the server has, and what is not held', () => {
    const text = hintOf({ quietStart: '22:00', quietEnd: '08:00', dailyMax: 3, maxDevices: 5 });
    expect(text).toContain('only says that TAi has a new message');
    expect(text).toContain('at most 3 a day');
    expect(text).toContain('between 10 pm and 8 am wait for the morning');
    expect(text).toContain('A reply to something you wrote does too');
    expect(hintOf({ quietStart: '23:30', quietEnd: '07:00', dailyMax: 2 })).toContain('between 11:30 pm and 7 am');
  });

  it('leaves out what is not so: no quiet hours, or no notification of TAi\'s own messages', () => {
    expect(hintOf({ quietStart: '00:00', quietEnd: '00:00', dailyMax: 3 })).not.toContain('wait for the morning');
    const none = hintOf({ quietStart: '22:00', quietEnd: '08:00', dailyMax: 0 });
    expect(none).not.toContain('at most');
    expect(none).toContain('when a reply takes a while');
  });
});

describe('the time zone', () => {
  it('is the device\'s, when the browser names one the server could take', () => {
    const zone = (name) => ({ DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: name }) }) });
    expect(detectZone(zone('America/Vancouver'))).toBe('America/Vancouver');
    for (const odd of [undefined, '', '+05:00', 'x'.repeat(80), '../x', 5]) expect(detectZone(zone(odd)), String(odd)).toBe('');
    expect(detectZone({ DateTimeFormat: () => { throw new Error('no'); } })).toBe('');
    expect(detectZone()).not.toBe(undefined);
  });

  it('is sent to the server when it has one and the server has not got that one', () => {
    expect(needsZoneUpdate(null, 'America/Vancouver')).toBe(true);
    expect(needsZoneUpdate('America/Los_Angeles', 'America/Vancouver')).toBe(true);
    expect(needsZoneUpdate('America/Vancouver', 'America/Vancouver')).toBe(false);
    expect(needsZoneUpdate('America/Vancouver', '')).toBe(false);
  });
});

describe('the page\'s sign of life', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('makes an id in the form the server takes, with or without randomUUID', () => {
    expect(makePageId(crypto.webcrypto)).toMatch(UUID);
    expect(makePageId({ getRandomValues: (a) => crypto.webcrypto.getRandomValues(a) })).toMatch(UUID);
    expect(makePageId(undefined)).toMatch(UUID);
    expect(makePageId(crypto.webcrypto)).not.toBe(makePageId(crypto.webcrypto));
  });

  function fakeDocument() {
    const listeners = [];
    return { visibilityState: 'visible', addEventListener: (type, fn) => type === 'visibilitychange' && listeners.push(fn), change(state) { this.visibilityState = state; listeners.forEach((fn) => fn()); } };
  }

  it('adds the page\'s id and whether its tab is in front to every poll', () => {
    const doc = fakeDocument();
    const presence = createPresence({ doc, fetchImpl: vi.fn(), id: '11111111-1111-4111-8111-111111111111' });
    expect(presence.query()).toBe('&c=11111111-1111-4111-8111-111111111111&v=1');
    doc.visibilityState = 'hidden';
    expect(presence.query()).toBe('&c=11111111-1111-4111-8111-111111111111&v=0');
    expect(createPresence({ doc }).query()).toMatch(/^&c=[0-9a-f-]{36}&v=0$/);                // (without an id of its own the page makes one)
  });

  it('says so at once when the tab goes behind another or comes back, as a request that outlives the page, and only while signed in', () => {
    const doc = fakeDocument();
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true }));
    let signedIn = false;
    const presence = createPresence({ doc, fetchImpl, id: '22222222-2222-4222-8222-222222222222' });
    presence.watch(() => signedIn);
    doc.change('hidden');
    expect(fetchImpl).not.toHaveBeenCalled();
    signedIn = true;
    doc.change('hidden');
    doc.change('visible');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('api/poll?after=999999999999&wait=0&c=22222222-2222-4222-8222-222222222222&v=0');
    expect(options).toMatchObject({ keepalive: true, credentials: 'same-origin', cache: 'no-store' });
    expect(fetchImpl.mock.calls[1][0]).toContain('&v=1');
  });

  it('is not troubled by a request that fails', async () => {
    const doc = fakeDocument();
    createPresence({ doc, fetchImpl: () => Promise.reject(new Error('offline')) }).watch(() => true);
    expect(() => doc.change('hidden')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sync = createPresence({ doc, fetchImpl: () => { throw new Error('no fetch'); } });
    sync.watch(() => true);
    expect(() => doc.change('visible')).toThrow();                 // (a fetch that throws at once is a broken browser: nothing here pretends otherwise)
  });
});

describe('the files of a home-screen app', () => {
  const read = (name) => fs.readFileSync(path.join(here, name));
  const size = (name) => {
    const png = read(name);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };

  it('have a manifest that starts the page at its own address, as an app, with icons that are there and the size they say', () => {
    const manifest = JSON.parse(read('manifest.webmanifest').toString());
    expect(manifest).toMatchObject({ name: 'TAi', short_name: 'TAi', display: 'standalone', start_url: './', scope: './' });
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons) {
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(size(icon.src), icon.src).toEqual([w, h]);
      expect(icon.type).toBe('image/png');
    }
    expect(manifest.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(size('apple-touch-icon.png')).toEqual([180, 180]);
  });

  it('are linked from the page, and every element settings.js looks for is in it', () => {
    const html = read('index.html').toString();
    expect(html).toMatch(/<link rel="manifest" href="manifest\.webmanifest">/);
    expect(html).toMatch(/<link rel="apple-touch-icon" href="apple-touch-icon\.png">/);
    expect(html).toMatch(/<link rel="stylesheet" href="settings\.css">/);
    const code = read('settings.js').toString();
    const wanted = new Set([...code.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]));
    expect(wanted.size).toBeGreaterThan(8);
    for (const id of wanted) expect(html, id).toContain(`id="${id}"`);
    // the Settings entry sits between the theme entry and Sign out, and starts hidden
    expect(html).toMatch(/id="menu-theme"[\s\S]*?id="menu-settings"[^>]*\shidden[\s\S]*?id="signout"/);
    expect(code).toContain("serviceWorker.register('sw.js')");
  });
});
