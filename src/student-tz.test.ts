import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PrefsStore } from './portal/prefs.js';
import { studentTimeZone } from './student-tz.js';

// The zone the container is told is the one the page stored in <store>/portal/<folder>.prefs.json (src/portal/prefs.ts), read by that module.
describe('studentTimeZone', () => {
  let store: string;
  const prefsFile = (folder: string) => path.join(store, 'portal', `${folder}.prefs.json`);
  const write = (folder: string, content: string) => {
    fs.mkdirSync(path.join(store, 'portal'), { recursive: true });
    fs.writeFileSync(prefsFile(folder), content);
  };

  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-student-tz-'));
  });
  afterEach(() => {
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('is the zone the student\'s page stored, as the prefs store writes it', () => {
    new PrefsStore(path.join(store, 'portal')).setTz('ada', 'America/Vancouver');
    expect(studentTimeZone('ada', store)).toBe('America/Vancouver');
    expect(studentTimeZone('bob', store)).toBeUndefined(); // Bob has said nothing: his containers get no variable
  });

  it('is undefined with no store, no file, an empty file or a file with no zone', () => {
    expect(studentTimeZone('ada', path.join(store, 'nowhere'))).toBeUndefined();
    expect(studentTimeZone('ada', store)).toBeUndefined();
    write('ada', '');
    expect(studentTimeZone('ada', store)).toBeUndefined();
    write('ada', JSON.stringify({ voiceSpeed: 1.2 }));
    expect(studentTimeZone('ada', store)).toBeUndefined();
  });

  it('is undefined for a damaged file and for anything that is not an IANA zone (the validation is the prefs store\'s)', () => {
    write('ada', '{ not json');
    expect(studentTimeZone('ada', store)).toBeUndefined();
    for (const tz of ['Not/AZone', 'UTC+8', '+08:00', '', 'America/Vancouver; rm -rf /', '../../etc/passwd', 12, null, ['America/Vancouver'], { tz: 'UTC' }]) {
      write('ada', JSON.stringify({ tz }));
      expect(studentTimeZone('ada', store), JSON.stringify(tz)).toBeUndefined();
    }
  });

  it('gives the canonical spelling of a zone that is spelled in another case', () => {
    write('ada', JSON.stringify({ tz: 'america/vancouver' }));
    expect(studentTimeZone('ada', store)).toBe('America/Vancouver');
  });

  it('reads the file again at every call, so a zone changed a minute ago is in the next container', () => {
    const prefs = new PrefsStore(path.join(store, 'portal'));
    prefs.setTz('ada', 'America/Vancouver');
    expect(studentTimeZone('ada', store)).toBe('America/Vancouver');
    prefs.setTz('ada', 'Asia/Tokyo');
    expect(studentTimeZone('ada', store)).toBe('Asia/Tokyo');
  });

  it('is undefined, and does not throw, for a folder name that could be a path', () => {
    for (const folder of ['', '../ada', 'a/b', 'a\\b', 'x'.repeat(65), 'ada.prefs']) {
      expect(() => studentTimeZone(folder, store), folder).not.toThrow();
      expect(studentTimeZone(folder, store), folder).toBeUndefined();
    }
  });
});
