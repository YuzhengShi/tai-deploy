/**
 * What a student chose, kept by the server, one small JSON file each: `<dir>/<folder>.prefs.json` (the dir is store/portal, next to the history).
 *
 *   {
 *     "tz": "America/Vancouver",                  the student's IANA time zone, as their browser says it (absent: not told yet)
 *     "voiceSpeed": 1.05,                         how fast TAi speaks in a call: 0.8 to 1.4 in steps of 0.05 (absent: the deployment's pace)
 *     "notify": { "push": [ { "endpoint", "keys": { "p256dh", "auth" }, "added" } ],     browsers to push to, at most five
 *                 "email": { "enabled": false } }
 *   }
 *
 * OTHER PIECES READ THIS FILE BY THAT PATH AND THESE KEYS (the voice side reads `voiceSpeed`, the course-time rules read `tz`): the names stay,
 * a reader ignores the keys it does not know, and so does this module's writer: it changes the keys it is asked to change and leaves the rest of
 * the file as it found it. A missing or broken file means the defaults. The write is atomic (a temporary file, then a rename) and every
 * change is read-modify-write in one synchronous run, so two requests, or a request and the sender removing a dead subscription, cannot
 * interleave. A push subscription is a capability to wake a student's device: it is never returned by any call (the page is given a short
 * hash to recognise its own), and one browser's subscription belongs to one student at a time.
 */
import fs from 'node:fs';
import path from 'node:path';

import { endpointHash } from '../notify/webpush.js';

export const MAX_PUSH_DEVICES = 5;
export const MIN_VOICE_SPEED = 0.8;
export const MAX_VOICE_SPEED = 1.4;
const FOLDER = /^[A-Za-z0-9_-]{1,64}$/;
const PREFS_FILE = /^([A-Za-z0-9_-]{1,64})\.prefs\.json$/;

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** When it was subscribed (ISO). */
  added: string;
}

export interface Prefs {
  tz?: string;
  /** What the student chose; absent when they have not: a call then runs at the deployment's own pace (TAI_VOICE_SPEED, src/voice/speed.ts). */
  voiceSpeed?: number;
  notify: { push: StoredSubscription[]; email: { enabled: boolean } };
}

/** The canonical name of an IANA time zone ("America/Vancouver"), or null for anything else (an offset, a typo, text that is not a zone). */
export function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** A speed in range, rounded to the step of 0.05; null when it is not a number or lies outside 0.8 to 1.4. */
export function validVoiceSpeed(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_VOICE_SPEED - 1e-9 || value > MAX_VOICE_SPEED + 1e-9) return null;
  return Math.round(value * 20) / 20;
}

/**
 * The speed a file holds, read the way src/voice/speed.ts reads it (a call uses it): a number, or a numeric string, from 0.8 to 1.4, in steps of
 * 0.05; anything else is "none chosen", which a call takes as the deployment's pace.
 */
export function storedSpeed(raw: unknown): number | undefined {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d(?:\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN;
  return validVoiceSpeed(value) ?? undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function storedSubscription(raw: unknown): StoredSubscription | null {
  if (!isObject(raw) || typeof raw.endpoint !== 'string' || raw.endpoint.length === 0 || raw.endpoint.length > 2048 || !isObject(raw.keys)) return null;
  const { p256dh, auth } = raw.keys;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  return { endpoint: raw.endpoint, keys: { p256dh, auth }, added: typeof raw.added === 'string' ? raw.added : '' };
}

/** What a file's contents mean: the defaults for what is missing or not the right kind. */
export function normalizePrefs(doc: Record<string, unknown>): Prefs {
  const notify = isObject(doc.notify) ? doc.notify : {};
  const push = (Array.isArray(notify.push) ? notify.push : []).map(storedSubscription).filter((s): s is StoredSubscription => s !== null);
  const tz = validTimeZone(doc.tz);
  const speed = storedSpeed(doc.voiceSpeed);
  return {
    ...(tz ? { tz } : {}),
    ...(speed !== undefined ? { voiceSpeed: speed } : {}),
    notify: { push: push.slice(-MAX_PUSH_DEVICES), email: { enabled: isObject(notify.email) && notify.email.enabled === true } },
  };
}

function readDoc(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

let counter = 0;

function writeAtomic(file: string, doc: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${++counter}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (err) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* it was never written */
    }
    throw err;
  }
}

/** The `notify` object of a document, made one if it was missing or not an object (its other keys are kept). */
function notifyOf(doc: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(doc.notify)) doc.notify = {};
  return doc.notify as Record<string, unknown>;
}

export class PrefsStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The file of a chat folder; a name that could be a path is refused. */
  file(folder: string): string {
    if (!FOLDER.test(folder)) throw new Error('not a chat folder');
    return path.join(this.dir, `${folder}.prefs.json`);
  }

  read(folder: string): Prefs {
    return normalizePrefs(readDoc(this.file(folder)));
  }

  private change(folder: string, apply: (doc: Record<string, unknown>) => void): Prefs {
    const file = this.file(folder);
    const doc = readDoc(file);
    apply(doc);
    writeAtomic(file, doc);
    return normalizePrefs(doc);
  }

  /** Several settings in one write (the values must already be validated: validTimeZone, validVoiceSpeed). */
  update(folder: string, changes: { tz?: string; voiceSpeed?: number; emailEnabled?: boolean }): Prefs {
    return this.change(folder, (doc) => {
      if (changes.tz !== undefined) doc.tz = changes.tz;
      if (changes.voiceSpeed !== undefined) doc.voiceSpeed = changes.voiceSpeed;
      if (changes.emailEnabled !== undefined) {
        const notify = notifyOf(doc);
        notify.email = { ...(isObject(notify.email) ? notify.email : {}), enabled: changes.emailEnabled };
      }
    });
  }

  setTz(folder: string, tz: string): Prefs {
    return this.update(folder, { tz });
  }

  setVoiceSpeed(folder: string, speed: number): Prefs {
    return this.update(folder, { voiceSpeed: speed });
  }

  setEmailEnabled(folder: string, enabled: boolean): Prefs {
    return this.update(folder, { emailEnabled: enabled });
  }

  /**
   * Adds a browser's subscription (the same endpoint again replaces its entry). Over five, the oldest is dropped: a student who clears their
   * browser data gets a new endpoint each time and the old ones only go when a push finds them dead, so refusing the sixth would lock them
   * out. The same endpoint is taken off every other student's file first: a browser belongs to whoever signed in and turned it on last.
   */
  addPush(folder: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }): { prefs: Prefs; evicted: number; movedFromOthers: number } {
    const id = endpointHash(sub.endpoint);
    const movedFromOthers = this.removePushFromOthers(id, folder);
    let evicted = 0;
    const prefs = this.change(folder, (doc) => {
      const notify = notifyOf(doc);
      const kept = normalizePrefs(doc).notify.push.filter((s) => endpointHash(s.endpoint) !== id);
      kept.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: new Date(this.now()).toISOString() });
      evicted = Math.max(0, kept.length - MAX_PUSH_DEVICES);
      notify.push = kept.slice(-MAX_PUSH_DEVICES);
    });
    return { prefs, evicted, movedFromOthers };
  }

  /** Takes one browser off a student's list, by the hash of its endpoint. Quiet about one that is not there. */
  removePush(folder: string, id: string): { removed: boolean; prefs: Prefs } {
    let removed = false;
    const file = this.file(folder);
    if (!fs.existsSync(file)) return { removed, prefs: this.read(folder) };
    const prefs = this.change(folder, (doc) => {
      const notify = notifyOf(doc);
      const all = normalizePrefs(doc).notify.push;
      const kept = all.filter((s) => endpointHash(s.endpoint) !== id);
      removed = kept.length !== all.length;
      notify.push = kept;
    });
    return { removed, prefs };
  }

  /** Every other student's entry for this endpoint goes: returns how many there were. */
  private removePushFromOthers(id: string, except: string): number {
    let removed = 0;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const match = PREFS_FILE.exec(name);
      if (!match || match[1] === except) continue;
      const other = normalizePrefs(readDoc(path.join(this.dir, name)));
      if (other.notify.push.some((s) => endpointHash(s.endpoint) === id)) {
        if (this.removePush(match[1], id).removed) removed++;
      }
    }
    return removed;
  }
}
