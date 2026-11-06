/** The per-student preferences file: tolerant reads, atomic and key-preserving writes, validation, and the rules for push subscriptions. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { endpointHash } from '../notify/webpush.js';
import { MAX_PUSH_DEVICES, PrefsStore, normalizePrefs, storedSpeed, validTimeZone, validVoiceSpeed } from './prefs.js';

const ADA = 's_' + 'a1'.repeat(10);
const BOB = 's_' + 'b2'.repeat(10);
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } });

describe('the preferences of a student', () => {
  let dir: string;
  let store: PrefsStore;
  let clock = Date.parse('2026-11-05T12:00:00Z');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-prefs-'));
    clock = Date.parse('2026-11-05T12:00:00Z');
    store = new PrefsStore(dir, () => (clock += 1000));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fileOf = (folder: string) => path.join(dir, `${folder}.prefs.json`);
  const rawOf = (folder: string) => JSON.parse(fs.readFileSync(fileOf(folder), 'utf-8'));

  describe('reading', () => {
    it('is the defaults for a student with no file', () => {
      expect(store.read(ADA)).toEqual({ notify: { push: [], email: { enabled: false } } });                // no voiceSpeed: none chosen, a call runs at the deployment's pace
    });

    it('is the defaults for a file that is broken, empty, an array or not an object, and reads nothing it should not trust', () => {
      for (const content of ['', '{"tz": ', '[1,2,3]', 'null', '"text"', '42', '\u0000\u0001garbage']) {
        fs.writeFileSync(fileOf(ADA), content);
        expect(store.read(ADA), JSON.stringify(content)).toEqual({ notify: { push: [], email: { enabled: false } } });
      }
    });

    it('takes the good keys of a file and the defaults for the bad ones', () => {
      fs.writeFileSync(
        fileOf(ADA),
        JSON.stringify({
          tz: 'Mars/Base',
          voiceSpeed: 7,
          theme: 'future key',
          notify: { push: [sub(1), { endpoint: 'x' }, 'text', null, { endpoint: 5, keys: {} }], email: { enabled: 'yes' } },
        }),
      );
      const prefs = store.read(ADA);
      expect(prefs.tz).toBeUndefined();
      expect(prefs.voiceSpeed).toBeUndefined();
      expect(prefs.notify.push).toHaveLength(1);
      expect(prefs.notify.push[0].endpoint).toBe(sub(1).endpoint);
      expect(prefs.notify.email.enabled).toBe(false);
      fs.writeFileSync(fileOf(ADA), JSON.stringify({ tz: 'America/Vancouver', voiceSpeed: 1.15, notify: { email: { enabled: true } } }));
      expect(store.read(ADA)).toMatchObject({ tz: 'America/Vancouver', voiceSpeed: 1.15, notify: { email: { enabled: true }, push: [] } });
    });

    it('reads a stored speed as src/voice/speed.ts does (a number or a numeric string from 0.8 to 1.4, in steps of 0.05) and calls anything else none chosen', () => {
      expect([storedSpeed(1), storedSpeed(1.2), storedSpeed('1.15'), storedSpeed(' 0.9 '), storedSpeed(1.03), storedSpeed(0.8), storedSpeed(1.4)]).toEqual([1, 1.2, 1.15, 0.9, 1.05, 0.8, 1.4]);
      for (const none of [undefined, null, 0, 0.5, 1.5, 7, NaN, 'fast', '1.2x', '', {}, [1], true]) expect(storedSpeed(none), String(none)).toBeUndefined();
      expect(normalizePrefs({ voiceSpeed: '1.1' }).voiceSpeed).toBe(1.1);
      expect('voiceSpeed' in normalizePrefs({})).toBe(false);
    });

    it('keeps at most five subscriptions of a file that holds more (the newest)', () => {
      const many = Array.from({ length: 9 }, (_, i) => ({ ...sub(i), added: '' }));
      expect(normalizePrefs({ notify: { push: many } }).notify.push.map((s) => s.endpoint)).toEqual(many.slice(-5).map((s) => s.endpoint));
    });

    it('refuses a folder name that could be a path', () => {
      for (const folder of ['../x', 'a/b', 'a\\b', '', 'x'.repeat(65), 'a b', '..']) {
        expect(() => store.read(folder), folder).toThrow(/not a chat folder/);
        expect(() => store.setTz(folder, 'UTC'), folder).toThrow(/not a chat folder/);
      }
    });
  });

  describe('validation', () => {
    it('knows IANA time zones, names them canonically, and refuses what is not one', () => {
      expect(validTimeZone('America/Vancouver')).toBe('America/Vancouver');
      expect(validTimeZone('america/los_angeles')).toBe('America/Los_Angeles');
      expect(validTimeZone('US/Pacific')).toBe('America/Los_Angeles');
      expect(validTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
      expect(validTimeZone('UTC')).toBe('UTC');
      for (const bad of ['Mars/Base', '', '+05:00', '-08:00', 'UTC+8', '../../etc/passwd', 'America/Los_Angeles; DROP', 'a'.repeat(65), ' America/Vancouver', 'America/Vancouver\n', 12, null, undefined, {}, ['UTC']]) {
        expect(validTimeZone(bad), JSON.stringify(bad)).toBeNull();
      }
    });

    it('takes a voice speed from 0.8 to 1.4, rounds it to a step of 0.05, and refuses anything else', () => {
      expect(validVoiceSpeed(1)).toBe(1);
      expect(validVoiceSpeed(0.8)).toBe(0.8);
      expect(validVoiceSpeed(1.4)).toBe(1.4);
      expect(validVoiceSpeed(1.03)).toBe(1.05);
      expect(validVoiceSpeed(1.02)).toBe(1);
      expect(validVoiceSpeed(0.85)).toBe(0.85);
      expect(validVoiceSpeed(1.2)).toBe(1.2);
      for (const bad of [0.79, 0.5, 0, -1, 1.41, 2, NaN, Infinity, -Infinity, '1', '1.1', null, undefined, true, {}, [1]]) expect(validVoiceSpeed(bad), String(bad)).toBeNull();
    });
  });

  describe('writing', () => {
    it('stores a time zone and a speed and gives them back', () => {
      store.setTz(ADA, 'America/Vancouver');
      store.setVoiceSpeed(ADA, 1.15);
      expect(store.read(ADA)).toMatchObject({ tz: 'America/Vancouver', voiceSpeed: 1.15 });
      expect(rawOf(ADA)).toMatchObject({ tz: 'America/Vancouver', voiceSpeed: 1.15 });
      expect(store.read(BOB).tz).toBeUndefined();
    });

    it('leaves the keys it does not know exactly as they were, at the top and inside notify', () => {
      fs.writeFileSync(
        fileOf(ADA),
        JSON.stringify({ theme: 'night', beta: { a: [1, 2] }, notify: { digest: 'weekly', email: { enabled: false, address: 'ada@example.com' }, push: [] } }),
      );
      store.setTz(ADA, 'Asia/Tokyo');
      store.setVoiceSpeed(ADA, 0.9);
      store.setEmailEnabled(ADA, true);
      store.addPush(ADA, sub(1));
      const raw = rawOf(ADA);
      expect(raw.theme).toBe('night');
      expect(raw.beta).toEqual({ a: [1, 2] });
      expect(raw.notify.digest).toBe('weekly');
      expect(raw.notify.email).toEqual({ enabled: true, address: 'ada@example.com' });
      expect(raw.notify.push).toHaveLength(1);
      expect(raw.tz).toBe('Asia/Tokyo');
    });

    it('writes a whole file or nothing: no temporary file stays, the file is JSON, and a failed write keeps the old one', () => {
      store.setTz(ADA, 'UTC');
      for (let i = 0; i < 20; i++) store.setVoiceSpeed(ADA, 0.8 + (i % 13) * 0.05);
      expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(() => rawOf(ADA)).not.toThrow();
      const before = fs.readFileSync(fileOf(ADA), 'utf-8');
      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('the disk is full');
      });
      expect(() => store.setTz(ADA, 'Asia/Tokyo')).toThrow(/disk is full/);
      expect(fs.readFileSync(fileOf(ADA), 'utf-8')).toBe(before);
      expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('replaces a file that was broken, rather than failing on it', () => {
      fs.writeFileSync(fileOf(ADA), '{"tz": ');
      store.setTz(ADA, 'UTC');
      expect(rawOf(ADA)).toEqual({ tz: 'UTC' });
    });

    it.skipIf(process.platform === 'win32')('keeps the file readable by its owner only', () => {
      store.setTz(ADA, 'UTC');
      expect(fs.statSync(fileOf(ADA)).mode & 0o777).toBe(0o600);
    });

    it('creates the directory when it is not there yet', () => {
      const nested = new PrefsStore(path.join(dir, 'a', 'b'));
      nested.setTz(ADA, 'UTC');
      expect(nested.read(ADA).tz).toBe('UTC');
    });
  });

  describe('push subscriptions', () => {
    it('adds a browser with the time it was added, and the same endpoint again is one entry, not two', () => {
      store.addPush(ADA, sub(1));
      const first = store.read(ADA).notify.push[0];
      expect(first.added).toBe('2026-11-05T12:00:01.000Z');
      store.addPush(ADA, { ...sub(1), keys: { p256dh: 'new-p256dh', auth: 'new-auth' } });
      const list = store.read(ADA).notify.push;
      expect(list).toHaveLength(1);
      expect(list[0].keys).toEqual({ p256dh: 'new-p256dh', auth: 'new-auth' });
    });

    it('keeps five, and a sixth takes the oldest one\'s place', () => {
      for (let i = 1; i <= MAX_PUSH_DEVICES; i++) expect(store.addPush(ADA, sub(i)).evicted).toBe(0);
      const sixth = store.addPush(ADA, sub(6));
      expect(sixth.evicted).toBe(1);
      expect(sixth.prefs.notify.push.map((s) => s.endpoint)).toEqual([2, 3, 4, 5, 6].map((n) => sub(n).endpoint));
      expect(store.read(ADA).notify.push).toHaveLength(5);
    });

    it('takes a browser off whichever student had it: it belongs to the one who turned it on last (a shared computer)', () => {
      store.addPush(ADA, sub(1));
      store.addPush(ADA, sub(2));
      const moved = store.addPush(BOB, sub(1));
      expect(moved.movedFromOthers).toBe(1);
      expect(store.read(BOB).notify.push.map((s) => s.endpoint)).toEqual([sub(1).endpoint]);
      expect(store.read(ADA).notify.push.map((s) => s.endpoint)).toEqual([sub(2).endpoint]);
      expect(store.addPush(BOB, sub(3)).movedFromOthers).toBe(0);
    });

    it('removes one browser by the hash of its endpoint, quietly when it is not there, and touches nobody else', () => {
      store.addPush(ADA, sub(1));
      store.addPush(ADA, sub(2));
      store.addPush(BOB, sub(3));
      const done = store.removePush(ADA, endpointHash(sub(1).endpoint));
      expect(done.removed).toBe(true);
      expect(done.prefs.notify.push.map((s) => s.endpoint)).toEqual([sub(2).endpoint]);
      expect(store.removePush(ADA, endpointHash(sub(1).endpoint)).removed).toBe(false);
      expect(store.removePush(ADA, endpointHash(sub(3).endpoint)).removed).toBe(false);          // Bob's is not Ada's to remove
      expect(store.read(BOB).notify.push).toHaveLength(1);
      expect(store.removePush('s_' + 'c3'.repeat(10), 'deadbeefdeadbeef').removed).toBe(false);
      expect(fs.existsSync(fileOf('s_' + 'c3'.repeat(10)))).toBe(false);                          // no file made to remove nothing
    });

    it('holds its other keys while it does all that', () => {
      fs.writeFileSync(fileOf(ADA), JSON.stringify({ tz: 'UTC', voiceSpeed: 1.2, extra: true }));
      store.addPush(ADA, sub(1));
      store.removePush(ADA, endpointHash(sub(1).endpoint));
      expect(rawOf(ADA)).toMatchObject({ tz: 'UTC', voiceSpeed: 1.2, extra: true, notify: { push: [] } });
    });
  });
});
