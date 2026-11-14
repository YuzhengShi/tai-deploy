/**
 * How many runs a student has started lately (docs/GO_SANDBOX.md: 10 an hour, 40 a day). In production a table of the host's own database, so that a restart does not give
 * the counts back; in tests a list in memory. A row is a run that began to stage; rows older than two days are removed whenever a run is recorded.
 */
import type Database from 'better-sqlite3';

import { getDb } from '../db.js';
import type { SandboxRates } from './types.js';

export const RATES_KEEP_MS = 2 * 24 * 60 * 60 * 1000;

export function createSqliteRates(): SandboxRates {
  let db: Database.Database | null = null;
  let stmts: { count: Database.Statement; insert: Database.Statement; prune: Database.Statement } | null = null;
  // (the statements belong to the database they were made on: a test that starts a new in-memory database gets new ones)
  const prepared = () => {
    const current = getDb();
    if (current !== db || !stmts) {
      db = current;
      stmts = {
        count: current.prepare('SELECT COUNT(*) AS n FROM sandbox_runs WHERE student_folder = ? AND started_at >= ?'),
        insert: current.prepare('INSERT INTO sandbox_runs (student_folder, started_at) VALUES (?, ?)'),
        prune: current.prepare('DELETE FROM sandbox_runs WHERE started_at < ?'),
      };
    }
    return stmts;
  };
  return {
    count(folder, sinceMs) {
      const row = prepared().count.get(folder, Math.floor(sinceMs)) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    record(folder, atMs) {
      const s = prepared();
      s.insert.run(folder, Math.floor(atMs));
      s.prune.run(Math.floor(atMs) - RATES_KEEP_MS);
    },
  };
}

export function createMemoryRates(): SandboxRates & { rows(): Array<{ folder: string; at: number }> } {
  let rows: Array<{ folder: string; at: number }> = [];
  return {
    count: (folder, sinceMs) => rows.filter((r) => r.folder === folder && r.at >= sinceMs).length,
    record(folder, atMs) {
      rows.push({ folder, at: atMs });
      rows = rows.filter((r) => r.at >= atMs - RATES_KEEP_MS);
    },
    rows: () => rows.slice(),
  };
}
