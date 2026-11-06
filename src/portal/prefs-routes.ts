/**
 * The calls of the Settings dialog, as routes a feature module adds to the page's server (PortalRoute in server.ts, which does the checks of
 * the built-in routes first: JSON, the page's header and origin, the session, the per-student read limit). Everything is about the signed-in
 * student's own file; the folder is the session's and never anything a request says.
 *
 *   GET  api/prefs              { tz, voiceSpeed (null: none chosen), defaults: { voiceSpeed }, notify: { push: [{ id, added }], email: { enabled } }, limits }
 *   POST api/prefs              a partial update: { tz?, voiceSpeed?, notify?: { email?: { enabled } } }, validated, unknown keys refused
 *   GET  api/push/key           { key }: the VAPID public key, for pushManager.subscribe (404 when push is off)
 *   POST api/push/subscribe     { endpoint, keys: { p256dh, auth }, expirationTime? }: a browser's subscription, checked (webpush.ts)
 *   POST api/push/unsubscribe   { endpoint } or { id }: takes a browser off the list (works even when push is off)
 *
 * A subscription is never sent back: the page is given a short hash for each (`id`) and works out the hash of its own to know whether this
 * browser is on the list. The push subscriptions cannot be changed through api/prefs, only through the two calls that check them.
 */
import { RateLimiter } from './auth.js';
import { checkSubscription, endpointHash } from '../notify/webpush.js';
import { MAX_PUSH_DEVICES, PrefsStore, validTimeZone, validVoiceSpeed, type Prefs } from './prefs.js';
import type { PortalRoute } from './server.js';

export interface PrefsRoutesDeps {
  prefs: PrefsStore;
  /** The VAPID public key; null: push is off (no key, or TAI_NOTIFY is not on): the page is told so by `features.push`. */
  push: { publicKey: string } | null;
  /** Whether e-mail notifications exist yet (a later piece sets it); until then the student cannot switch them on. */
  emailAvailable?: () => boolean;
  /** What the dialog says about the rules, read only (the e-mail ones only when e-mail is on). */
  limits: { quietStart: string; quietEnd: string; dailyMax: number; emailAfterMinutes?: number; emailDailyMax?: number };
  /** What a call uses for a student who has chosen no voice speed: the deployment's TAI_VOICE_SPEED, read the way src/voice reads it. Default 1. */
  defaults?: { voiceSpeed: number };
  now?: () => number;
  log?: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
}

const TOP_KEYS = new Set(['tz', 'voiceSpeed', 'notify']);
const SUBSCRIPTION_KEYS = new Set(['endpoint', 'keys', 'expirationTime']);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const shown = (key: string): string => key.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);

export function prefsView(prefs: Prefs, deps: Pick<PrefsRoutesDeps, 'limits' | 'defaults'>) {
  const { limits } = deps;
  return {
    tz: prefs.tz ?? null,
    // what the student chose, or null when they have not: a call then runs at `defaults.voiceSpeed`, the deployment's own pace (src/voice/speed.ts)
    voiceSpeed: prefs.voiceSpeed ?? null,
    defaults: { voiceSpeed: deps.defaults?.voiceSpeed ?? 1 },
    notify: {
      push: prefs.notify.push.map((s) => ({ id: endpointHash(s.endpoint), added: s.added || null })),
      email: { enabled: prefs.notify.email.enabled },
    },
    limits: {
      quietStart: limits.quietStart,
      quietEnd: limits.quietEnd,
      dailyMax: limits.dailyMax,
      maxDevices: MAX_PUSH_DEVICES,
      ...(limits.emailAfterMinutes !== undefined ? { emailAfterMinutes: limits.emailAfterMinutes, emailDailyMax: limits.emailDailyMax } : {}),
    },
  };
}

export function prefsRoutes(deps: PrefsRoutesDeps): PortalRoute[] {
  const now = deps.now ?? Date.now;
  // each subscribe looks through the other students' files (a browser belongs to one student at a time) and checks a point on a curve: a
  // generous allowance for a person, none for a script
  const subscribeLimit = new RateLimiter(20, 10 * 60_000, now);
  const unsubscribeLimit = new RateLimiter(30, 10 * 60_000, now);

  return [
    {
      path: '/api/prefs',
      method: 'GET',
      handler: ({ user, json }) => json(200, prefsView(deps.prefs.read(user.folder), deps)),
    },
    {
      path: '/api/prefs',
      method: 'POST',
      handler: async ({ user, readJson, json }) => {
        const body = await readJson();
        const keys = Object.keys(body);
        if (keys.length === 0) return json(400, { error: 'empty' });
        for (const key of keys) if (!TOP_KEYS.has(key)) return json(400, { error: 'unknown-key', key: shown(key) });
        const changes: { tz?: string; voiceSpeed?: number; emailEnabled?: boolean } = {};
        if ('tz' in body) {
          const tz = validTimeZone(body.tz);
          if (!tz) return json(400, { error: 'bad-tz' });
          changes.tz = tz;
        }
        if ('voiceSpeed' in body) {
          const speed = validVoiceSpeed(body.voiceSpeed);
          if (speed === null) return json(400, { error: 'bad-voice-speed' });
          changes.voiceSpeed = speed;
        }
        if ('notify' in body) {
          if (!isObject(body.notify)) return json(400, { error: 'bad-notify' });
          for (const key of Object.keys(body.notify)) if (key !== 'email') return json(400, { error: 'unknown-key', key: shown(`notify.${key}`) });
          if ('email' in body.notify) {
            const email = body.notify.email;
            if (!isObject(email)) return json(400, { error: 'bad-email' });
            for (const key of Object.keys(email)) if (key !== 'enabled') return json(400, { error: 'unknown-key', key: shown(`notify.email.${key}`) });
            if (typeof email.enabled !== 'boolean') return json(400, { error: 'bad-email' });
            if (!(deps.emailAvailable?.() ?? false)) return json(400, { error: 'email-off' });
            changes.emailEnabled = email.enabled;
          } else {
            return json(400, { error: 'empty' });
          }
        }
        json(200, prefsView(deps.prefs.update(user.folder, changes), deps));
      },
    },
    {
      path: '/api/push/key',
      method: 'GET',
      handler: ({ json }) => (deps.push ? json(200, { key: deps.push.publicKey }) : json(404, { error: 'push-off' })),
    },
    {
      path: '/api/push/subscribe',
      method: 'POST',
      handler: async ({ user, readJson, json }) => {
        if (!deps.push) return json(404, { error: 'push-off' });
        const body = await readJson();
        for (const key of Object.keys(body)) if (!SUBSCRIPTION_KEYS.has(key)) return json(400, { error: 'unknown-key', key: shown(key) });
        if (typeof body.expirationTime === 'number' && body.expirationTime <= now()) return json(400, { error: 'expired' });
        if (body.expirationTime !== undefined && body.expirationTime !== null && typeof body.expirationTime !== 'number') return json(400, { error: 'bad-request' });
        const checked = checkSubscription(body);
        if (!checked.ok) return json(400, { error: checked.error });
        if (!subscribeLimit.allow(user.folder)) return json(429, { error: 'rate-limited' });
        const added = deps.prefs.addPush(user.folder, checked.sub);
        deps.log?.info({ folder: user.folder, endpoint: endpointHash(checked.sub.endpoint), evicted: added.evicted, movedFromOthers: added.movedFromOthers }, 'portal: a browser turned notifications on');
        json(200, { ok: true, id: endpointHash(checked.sub.endpoint), devices: added.prefs.notify.push.length });
      },
    },
    {
      path: '/api/push/unsubscribe',
      method: 'POST',
      handler: async ({ user, readJson, json }) => {
        const body = await readJson();
        for (const key of Object.keys(body)) if (key !== 'endpoint' && key !== 'id') return json(400, { error: 'unknown-key', key: shown(key) });
        let id = '';
        if (typeof body.id === 'string' && /^[0-9a-f]{16}$/.test(body.id)) id = body.id;
        else if (typeof body.endpoint === 'string' && body.endpoint.length > 0 && body.endpoint.length <= 2048) id = endpointHash(body.endpoint);
        if (!id) return json(400, { error: 'bad-request' });
        if (!unsubscribeLimit.allow(user.folder)) return json(429, { error: 'rate-limited' });
        const done = deps.prefs.removePush(user.folder, id);
        if (done.removed) deps.log?.info({ folder: user.folder, endpoint: id }, 'portal: a browser turned notifications off');
        json(200, { ok: true, removed: done.removed, devices: done.prefs.notify.push.length });
      },
    },
  ];
}
