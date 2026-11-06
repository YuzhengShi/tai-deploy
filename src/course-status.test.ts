import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }));

import { acceptable, refreshCourseStatus, startCourseStatusJob } from './course-status.js';

const PAGE = '# Course Status\nLast synced: 2026-11-02 18:00 UTC\n' + '| row | data |\n'.repeat(30);
const SECRETS = { CANVAS_API_TOKEN: 'TOKEN-123456789', CANVAS_BASE_URL: 'https://canvas.example/api/v1', CANVAS_COURSE_ID: '1' };

describe('the class-wide course status', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-status-'));
    file = path.join(dir, 'global', 'COURSE_STATUS.md');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('puts a good page in place, keeps it when only the time moved, and replaces it when something changed', async () => {
    const seen: string[] = [];
    const run = async (config: string) => (seen.push(config), { code: 0, stdout: PAGE, stderr: '' });
    expect(await refreshCourseStatus({ run, file, readSecrets: () => SECRETS })).toBe('written');
    expect(fs.readFileSync(file, 'utf-8')).toBe(PAGE);
    const sent = JSON.parse(seen[0]);
    expect(sent.env).toEqual(SECRETS);
    expect(sent.previous).toBe('');
    expect(Date.parse(sent.now)).not.toBeNaN();

    const later = PAGE.replace('2026-11-02 18:00', '2026-11-02 24:00');
    expect(await refreshCourseStatus({ run: async () => ({ code: 0, stdout: later, stderr: '' }), file, readSecrets: () => SECRETS })).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf-8')).toBe(PAGE);

    const changed = PAGE + '| new announcement | x |\n';
    expect(await refreshCourseStatus({ run: async () => ({ code: 0, stdout: changed, stderr: '' }), file, readSecrets: () => SECRETS })).toBe('written');
    expect(fs.readFileSync(file, 'utf-8')).toBe(changed);
    expect(JSON.parse(seen.length ? seen[0] : '{}').previous).toBe('');
    expect(fs.readdirSync(path.join(dir, 'global'))).toEqual(['COURSE_STATUS.md']);        // no temporary file left behind
  });

  it('tells whoever asked of what changed: the page as it was and as it is, when it was written and not when it was not', async () => {
    const told: Array<[string, string]> = [];
    const deps = (stdout: string) => ({ run: async () => ({ code: 0, stdout, stderr: '' }), file, readSecrets: () => SECRETS, onChange: (a: string, b: string) => void told.push([a, b]) });
    await refreshCourseStatus(deps(PAGE));
    expect(told).toEqual([['', PAGE]]);
    await refreshCourseStatus(deps(PAGE.replace('2026-11-02 18:00', '2026-11-02 24:00')));      // only the time moved
    expect(told).toHaveLength(1);
    const changed = PAGE + '| new announcement | x |\n';
    await refreshCourseStatus(deps(changed));
    expect(told[1]).toEqual([PAGE, changed]);
  });

  it('is not stopped by a listener that fails: the page is in place', async () => {
    const result = await refreshCourseStatus({
      run: async () => ({ code: 0, stdout: PAGE, stderr: '' }),
      file,
      readSecrets: () => SECRETS,
      onChange: () => {
        throw new Error('no page');
      },
    });
    expect(result).toBe('written');
    expect(fs.readFileSync(file, 'utf-8')).toBe(PAGE);
  });

  it('hands the script the page as it was, for the alerts', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PAGE);
    let config = '';
    await refreshCourseStatus({ run: async (c) => ((config = c), { code: 1, stdout: '', stderr: 'x' }), file, readSecrets: () => SECRETS });
    expect(JSON.parse(config).previous).toBe(PAGE);
  });

  it('never replaces a good page with a bad answer', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PAGE);
    for (const answer of [
      { code: 1, stdout: PAGE, stderr: 'Canvas could not be read: 401' },
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: 'I am sorry, I cannot do that', stderr: '' },
      { code: 0, stdout: '# Course Status\nshort', stderr: '' },
      { code: 0, stdout: PAGE + 'x'.repeat(130_000), stderr: '' },
      { code: null, stdout: '', stderr: 'docker: not found' },
    ]) {
      expect(await refreshCourseStatus({ run: async () => answer, file, readSecrets: () => SECRETS })).toBe('failed');
      expect(fs.readFileSync(file, 'utf-8')).toBe(PAGE);
    }
    expect(await refreshCourseStatus({ run: async () => { throw new Error('boom'); }, file, readSecrets: () => SECRETS })).toBe('failed');
  });

  it('does nothing without Canvas', async () => {
    const run = vi.fn();
    for (const secrets of [{}, { CANVAS_API_TOKEN: 'x' }, { ...SECRETS, CANVAS_COURSE_ID: '' }]) {
      expect(await refreshCourseStatus({ run, file, readSecrets: () => secrets })).toBe('skipped');
    }
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('knows a course status page when it sees one', () => {
    expect(acceptable(PAGE)).toBe(true);
    expect(acceptable(PAGE.replace('# Course Status', '# Something else'))).toBe(false);
    expect(acceptable(PAGE + '\u0000')).toBe(false);
  });

  it('can be switched off, and stops when told to', () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => ({ code: 0, stdout: PAGE, stderr: '' }));
      startCourseStatusJob({ TAI_COURSE_STATUS_HOURS: '0' }, { run, file, readSecrets: () => SECRETS })();
      vi.advanceTimersByTime(10 * 3_600_000);
      expect(run).not.toHaveBeenCalled();
      const stop = startCourseStatusJob({}, { run, file, readSecrets: () => SECRETS });
      vi.advanceTimersByTime(61_000);
      expect(run).toHaveBeenCalledTimes(1);
      stop();
      vi.advanceTimersByTime(24 * 3_600_000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
