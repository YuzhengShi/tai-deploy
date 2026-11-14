import { describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from '../db.js';
import { RATES_KEEP_MS, createMemoryRates, createSqliteRates } from './rates.js';

// This PC cannot load the native sqlite module; the host can (host_vitest.sh runs this file there). The memory store is tested everywhere.
const sqliteLoads = (() => {
  try {
    _initTestDatabase();
    return true;
  } catch {
    return false;
  }
})();

const HOUR = 3_600_000;

describe('the rates in memory', () => {
  it('counts a folder’s runs since a time, inclusively, and nobody else’s', () => {
    const r = createMemoryRates();
    r.record('ana', 1000);
    r.record('ana', 2000);
    r.record('bo', 2000);
    expect(r.count('ana', 0)).toBe(2);
    expect(r.count('ana', 2000)).toBe(1);
    expect(r.count('ana', 2001)).toBe(0);
    expect(r.count('bo', 0)).toBe(1);
    expect(r.count('nobody', 0)).toBe(0);
  });

  it('forgets what is older than two days when a run is recorded', () => {
    const r = createMemoryRates();
    r.record('ana', 0);
    r.record('ana', RATES_KEEP_MS - 1);
    expect(r.rows()).toHaveLength(2);
    r.record('ana', RATES_KEEP_MS + 1);
    expect(r.rows().map((x) => x.at)).toEqual([RATES_KEEP_MS - 1, RATES_KEEP_MS + 1]);
  });
});

describe.skipIf(!sqliteLoads)('the rates in the database', () => {
  it('has the table and its index in the schema', () => {
    _initTestDatabase();
    const db = getDb();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sandbox_runs'").all()).toHaveLength(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sandbox_runs'").all()).toHaveLength(1);
    expect((db.prepare('PRAGMA table_info(sandbox_runs)').all() as Array<{ name: string }>).map((c) => c.name)).toEqual(['student_folder', 'started_at']);
  });

  it('counts per student and per window, like the memory store', () => {
    _initTestDatabase();
    const r = createSqliteRates();
    const t = Date.now();
    r.record('ana', t - 2 * HOUR);
    r.record('ana', t - 10 * 60_000);
    r.record('ana', t);
    r.record('bo', t);
    expect(r.count('ana', t - HOUR)).toBe(2);
    expect(r.count('ana', t - 24 * HOUR)).toBe(3);
    expect(r.count('bo', t - HOUR)).toBe(1);
    expect(r.count('nobody', 0)).toBe(0);
  });

  it('removes rows older than two days whenever a run is recorded, and not before', () => {
    _initTestDatabase();
    const r = createSqliteRates();
    const t = Date.now();
    r.record('old', t - RATES_KEEP_MS - 5000);
    r.record('edge', t - RATES_KEEP_MS + 5000);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM sandbox_runs').get() as { n: number }).n).toBe(2); // pruned relative to the run being recorded: both are within two days of themselves
    r.record('now', t);
    const left = (getDb().prepare('SELECT student_folder AS f FROM sandbox_runs ORDER BY started_at').all() as Array<{ f: string }>).map((x) => x.f);
    expect(left).toEqual(['edge', 'now']);
  });

  it('follows a new database (a test, or a restart that opened another) and keeps the counts across the same one', () => {
    _initTestDatabase();
    const r = createSqliteRates();
    r.record('ana', Date.now());
    expect(r.count('ana', 0)).toBe(1);
    _initTestDatabase(); // a fresh in-memory database
    expect(r.count('ana', 0)).toBe(0);
    r.record('ana', Date.now());
    expect(r.count('ana', 0)).toBe(1);
  });

  it('records with a bound value, never in the text of the statement', () => {
    _initTestDatabase();
    const r = createSqliteRates();
    r.record("x'); DROP TABLE sandbox_runs; --", Date.now());
    expect(r.count("x'); DROP TABLE sandbox_runs; --", 0)).toBe(1);
    expect(getDb().prepare("SELECT name FROM sqlite_master WHERE name='sandbox_runs'").all()).toHaveLength(1);
  });
});
