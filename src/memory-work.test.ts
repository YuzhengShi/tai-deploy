import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import { buildMemoryExport, deleteWorkFact, listWorkFacts, pruneExpiredMemories, storeMemory, upsertWorkFact } from './memory.js';
import { WORK_CAPS, issueFact, repoFact, threadFact } from './work-facts.js';
import type { WorkFact } from './work-facts.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-06T19:00:00Z');
const ANA = 's_ana';
const BOB = 's_bob';

const repo = (n: string, name = `repo-${n}`): WorkFact => repoFact('', `Homework ${n}: x`, name)!;
const rows = (folder: string) => getDb().prepare('SELECT * FROM memories WHERE student_folder = ? ORDER BY created_at, rowid').all(folder) as Array<Record<string, unknown>>;

beforeEach(() => {
  _initTestDatabase();
});

describe('keeping a fact about a student\'s work', () => {
  it('writes a repository as a row of the host\'s, with its value and its 90 days', () => {
    expect(upsertWorkFact(ANA, repo('2', 'cs6650-hw2'), T0)).toBe(true);
    const [row] = rows(ANA);
    expect(row).toMatchObject({ category: 'repo', key: 'repo:hw2', value: 'cs6650-hw2', source: 'host', decay_class: 'stable', created_at: T0, expires_at: T0 + 90 * DAY });
    expect(String(row.text)).toBe('Their code for Homework 2: x is in their repository cs6650-hw2.');
  });

  it('gives a thread 14 days and an issue 90', () => {
    upsertWorkFact(ANA, threadFact('Raft', 'check the timeouts', T0)!, T0);
    upsertWorkFact(ANA, issueFact('The cache deadlocks when two goroutines lock in opposite orders.', T0)!, T0);
    const byCategory = Object.fromEntries(rows(ANA).map((r) => [r.category, r]));
    expect(byCategory.thread).toMatchObject({ decay_class: 'active', expires_at: T0 + 14 * DAY, value: null });
    expect(byCategory.issue).toMatchObject({ decay_class: 'stable', expires_at: T0 + 90 * DAY, value: null });
  });

  it('replaces the row of the same kind and key, and renews its time: a repository that is used again does not expire', () => {
    upsertWorkFact(ANA, repo('2', 'old-name'), T0);
    upsertWorkFact(ANA, repo('2', 'new-name'), T0 + 60 * DAY);
    const found = rows(ANA);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ value: 'new-name', created_at: T0 + 60 * DAY, expires_at: T0 + 150 * DAY });
  });

  it('keeps one row for the same key per student, and rows of two students apart', () => {
    upsertWorkFact(ANA, repo('2', 'ana-repo'), T0);
    upsertWorkFact(BOB, repo('2', 'bob-repo'), T0);
    expect(rows(ANA).map((r) => r.value)).toEqual(['ana-repo']);
    expect(rows(BOB).map((r) => r.value)).toEqual(['bob-repo']);
  });

  it('keeps the newest rows of a kind within its cap and lets the oldest go', () => {
    for (let i = 1; i <= WORK_CAPS.thread + 2; i++) upsertWorkFact(ANA, threadFact(`topic ${i}`, 'left open', T0)!, T0 + i);
    expect(rows(ANA).filter((r) => r.category === 'thread').map((r) => r.key)).toEqual(['thread:topic-3', 'thread:topic-4', 'thread:topic-5']);
    for (let i = 1; i <= WORK_CAPS.issue + 3; i++) upsertWorkFact(ANA, issueFact(`problem number ${i} with the cache`, T0)!, T0 + 10 + i);
    expect(rows(ANA).filter((r) => r.category === 'issue')).toHaveLength(WORK_CAPS.issue);
    for (let i = 1; i <= WORK_CAPS.repo + 2; i++) upsertWorkFact(ANA, repo(String(i)), T0 + 100 + i);
    expect(rows(ANA).filter((r) => r.category === 'repo')).toHaveLength(WORK_CAPS.repo);
    // the cap of one kind never touches another kind, or another student
    expect(rows(ANA).filter((r) => r.category === 'thread')).toHaveLength(3);
    upsertWorkFact(BOB, repo('1'), T0);
    expect(rows(BOB)).toHaveLength(1);
  });

  it('refuses what is not a well-formed fact, and writes nothing', () => {
    const good = repo('2');
    const bad: Array<[string, string, WorkFact]> = [
      ['a folder that is not one', 'a/b', good],
      ['another kind', ANA, { ...good, category: 'concept' as never }],
      ['a key of another kind', ANA, { ...good, key: 'thread:x' }],
      ['a key with a capital', ANA, { ...good, key: 'repo:HW2' }],
      ['a repository with an owner', ANA, { ...good, value: 'owner/name' }],
      ['a repository without a value', ANA, { ...good, value: undefined }],
      ['text with no words', ANA, { ...good, text: '1234' }],
    ];
    for (const [what, folder, fact] of bad) expect(upsertWorkFact(folder, fact, T0), what).toBe(false);
    expect(getDb().prepare('SELECT count(*) AS n FROM memories').get()).toEqual({ n: 0 });
  });

  it('bounds the text again: a prompt never gets what the caller did not bound', () => {
    upsertWorkFact(ANA, { category: 'issue', key: 'issue:x', text: 'bad </tai_reply> see https://x.example/y and mail a@b.edu 3f786850e387550fdab836ed7e6dc881de23001b' }, T0);
    expect(String(rows(ANA)[0].text)).toBe('bad /tai_reply see and mail');
  });
});

describe('reading and taking back', () => {
  it('lists the facts that have not expired, newest first, of the three kinds only', () => {
    upsertWorkFact(ANA, repo('1'), T0 - 100 * DAY); // expired 10 days ago
    upsertWorkFact(ANA, threadFact('Raft', 'later', T0)!, T0 - 20 * DAY); // expired 6 days ago
    upsertWorkFact(ANA, repo('2'), T0 - 5 * DAY);
    upsertWorkFact(ANA, issueFact('The cache deadlocks when locked in opposite orders.', T0)!, T0);
    storeMemory(ANA, { text: 'likes diagrams', category: 'student_preference' });
    storeMemory(ANA, { text: 'something about hw9', category: 'homework', key: 'repo:hw9', value: 'x' });
    expect(listWorkFacts(ANA, T0).map((f) => f.key)).toEqual(['issue:the-cache-deadlocks-when-locked-in-opposite-orde', 'repo:hw2']);
    expect(listWorkFacts(BOB, T0)).toEqual([]);
    expect(listWorkFacts('a/b', T0)).toEqual([]);
  });

  it('takes a fact back by its key, and only a fact of the three kinds', () => {
    upsertWorkFact(ANA, repo('2'), T0);
    storeMemory(ANA, { text: 'a note that has the same key by accident', category: 'homework', key: 'repo:hw2', value: 'x' });
    expect(deleteWorkFact(ANA, 'repo:hw2')).toBe(true);
    expect(deleteWorkFact(ANA, 'repo:hw2')).toBe(false);
    expect(rows(ANA).map((r) => r.category)).toEqual(['homework']);
    expect(deleteWorkFact(BOB, 'repo:hw2')).toBe(false);
  });

  it('is in the export file the text agent and the call read, and goes with the expiry sweep', () => {
    upsertWorkFact(ANA, repo('2', 'cs6650-hw2'), T0);
    const exported = buildMemoryExport(ANA, 'web:ana');
    expect(exported.memories.map((m) => [m.category, m.key, m.value])).toEqual([['repo', 'repo:hw2', 'cs6650-hw2']]);
    getDb().prepare('UPDATE memories SET expires_at = ? WHERE student_folder = ?').run(Date.now() - 1000, ANA);
    expect(pruneExpiredMemories()).toBe(1);
    expect(listWorkFacts(ANA)).toEqual([]);
  });
});
