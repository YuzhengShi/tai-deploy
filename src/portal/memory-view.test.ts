/** What TAi remembers, as the page shows it: the notes (and what may be done to one), and COMPETENCY.md in plain words. (The endpoints are in features.test.ts.) */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { MEMORY_ID, MemoryDb, MemoryRow, MemoryStore, StudentMemory, memoryItems, memoryLabel, progressView, sqliteMemoryStore } from './memory-view.js';

const FOLDER = 's_' + 'a'.repeat(20);
const OTHER = 's_' + 'b'.repeat(20);
const NOW = Date.parse('2026-11-02T12:00:00Z');

const COMPETENCY = `# Student Competency Model

## Student Profile

- Name: Ada Lovelace
- GitHub: ada-eval
- Learning style: problem first, then the diagram
- Canvas record: [brief summary]

## Effective Approaches (Self-Improving)

### Approaches That Work
<!-- Format: approach | evidence (N observations) | context -->
<!-- Example: Code-first then theory → faster understanding (4 observations) | implementation topics -->

Problem-first framing | 4 observations | new abstract concepts
- Analogies to real systems | 3 observations | new topics
Short quizzes at the end | 2 observations | any

### Approaches That Don't Work
None yet — will be populated as TAi discovers what to avoid.

## Mastery Scores

Format: concept: confidence | stability | scope | via | last_evidence

### Week 1
Go programming basics: 0.9 | 0.8 | [implementation, verbal] | [homework] | 2026-10-20
Tail latency and percentiles: 0.75 | 0.5 | [theoretical] | [socratic] | 2026-10-25
Docker concepts: 0.55 | 0.3 | [theoretical] | [socratic] | 2026-10-30
Terraform / Infrastructure as Code: 0.2 | 0.1 | [theoretical] | [socratic] | 2026-10-31
Raft (leader election, log replication): 0.0 | 0.0 | [verbal] | [mock_interview] | 2026-11-01
Paxos: 0.0 | 0.0 | [] | [] | never
Little's Law and queue theory: 0.0 | 0.0 | [] | [] | never

## Active Misconceptions

"A follower can vote twice in one term" | contradicts: Raft (leader election, log replication) | status: confirmed | freq: 3 | first: 2026-10-30 | last: 2026-11-01 | holding
"[incorrect belief]" | contradicts: [concept] | status: candidate

## Mock Interview Summary

- Most recent interview: [date, assignment, scores]
`;

describe('a saved note, as the page shows it', () => {
  it('has its words, its category in words, and when it was kept', () => {
    const rows: MemoryRow[] = [
      { id: 'mem-1', text: 'Prefers problem-first explanations', category: 'student_preference', created_at: NOW - 3600_000 },
      { id: 'mem-2', text: 'Works nights', category: 'something_the_agent_made_up', created_at: NOW },
    ];
    expect(memoryItems(rows)).toEqual([
      { id: 'mem-1', text: 'Prefers problem-first explanations', label: 'Preference', at: new Date(NOW - 3600_000).toISOString() },
      { id: 'mem-2', text: 'Works nights', label: 'Note', at: new Date(NOW).toISOString() },
    ]);
  });

  it('names every category the memory store knows, and anything else is a plain note', () => {
    const known = ['student_preference', 'identity', 'decision', 'misconception', 'breakthrough', 'concept', 'homework', 'session', 'checkpoint', 'other'];
    expect(known.map(memoryLabel)).toEqual(['Preference', 'About you', 'Decision', 'Mix-up', 'Breakthrough', 'Topic', 'Homework', 'Recent', 'Working note', 'Note']);
    for (const odd of ['', 'constructor', '__proto__', 'toString', 'Preference']) expect(memoryLabel(odd), odd).toBe('Note');
  });

  it('leaves out a note with no words, trims a very long one, and tolerates a time it cannot read', () => {
    const rows = [
      { id: 'mem-1', text: '   ', category: 'other', created_at: NOW },
      { id: 'mem-2', text: 'x'.repeat(2000), category: 'other', created_at: Number.NaN },
      { id: 'mem-3', text: 'line one\r\nline two', category: 'other', created_at: NOW },
    ] as MemoryRow[];
    const items = memoryItems(rows);
    expect(items.map((i) => i.id)).toEqual(['mem-2', 'mem-3']);
    expect(items[0].text).toHaveLength(600);
    expect(items[0].at).toBe('');
    expect(items[1].text).toBe('line one\nline two');
  });
});

describe('COMPETENCY.md in plain words', () => {
  it('sorts the topics that have been worked on into solid, getting there and just started, and counts the rest', () => {
    const view = progressView(COMPETENCY)!;
    expect(view.solid.map((t) => t.name)).toEqual(['Tail latency and percentiles', 'Go programming basics']);                  // (the newer evidence first)
    expect(view.gettingThere.map((t) => t.name)).toEqual(['Docker concepts']);
    expect(view.justStarted.map((t) => t.name)).toEqual(['Raft (leader election, log replication)', 'Terraform / Infrastructure as Code']);
    expect(view.untouched).toBe(2);                      // Paxos and Little's Law: nothing recorded
  });

  it('marks what the student has said out loud (the file\'s "verbal" scope), even before the score moves', () => {
    const view = progressView(COMPETENCY)!;
    const aloud = [...view.solid, ...view.gettingThere, ...view.justStarted].filter((t) => t.aloud).map((t) => t.name);
    expect(aloud).toEqual(['Go programming basics', 'Raft (leader election, log replication)']);
  });

  it('puts the newest evidence first inside a group', () => {
    const text = '## Mastery Scores\nOld one: 0.8 | 0.5 | [] | [] | 2026-09-01\nNew one: 0.75 | 0.5 | [] | [] | 2026-10-30\nMiddle: 0.9 | 0.5 | [] | [] | 2026-10-01\n';
    expect(progressView(text)!.solid.map((t) => t.name)).toEqual(['New one', 'Middle', 'Old one']);
  });

  it('keeps no number of the file in what it gives: no scores, no stability, no dates', () => {
    const json = JSON.stringify(progressView(COMPETENCY));
    expect(json).not.toMatch(/0\.\d/);
    expect(json).not.toMatch(/2026-\d\d-\d\d/);
    expect(json).not.toMatch(/stability|confidence|mock_interview|socratic|homework/);
    expect(json).not.toContain('Canvas record');
  });

  it('says the mix-ups in a sentence and what they contradict, and drops the template\'s placeholder', () => {
    const view = progressView(COMPETENCY)!;
    expect(view.mixups).toEqual([{ belief: 'A follower can vote twice in one term', about: 'Raft (leader election, log replication)' }]);
  });

  it('reads what works for this student, without the template\'s examples or its "None yet"', () => {
    expect(progressView(COMPETENCY)!.works).toEqual(['Problem-first framing', 'Analogies to real systems', 'Short quizzes at the end']);
    expect(progressView('## Mastery Scores\nPaxos: 0.1 | 0 | [] | [] | never\n\n### Approaches That Work\nNone yet — will be populated.\n')!.works).toEqual([]);
  });

  it('gives the way the student likes to learn, and nothing for the template\'s placeholder', () => {
    expect(progressView(COMPETENCY)!.style).toBe('problem first, then the diagram');
    expect(progressView('## Student Profile\n- Learning style: [discovered over time: analogies / code examples]\n## Mastery Scores\nPaxos: 0.1 | 0 | [] | [] | never\n')!.style).toBe('');
  });

  it('is nothing at all for a student with no file or an empty one, and empty lists for a file with nothing yet', () => {
    expect(progressView(null)).toBeNull();
    expect(progressView('   \n')).toBeNull();
    expect(progressView('# Student Competency Model\n\nNone yet.\n')).toEqual({ solid: [], gettingThere: [], justStarted: [], untouched: 0, mixups: [], works: [], style: '' });
  });

  it('reads the older spellings of a mastery line too', () => {
    const labelled = '## Mastery Scores\nDocker: confidence: 0.8 | stability: 0.4 | scope: [verbal] | via: [x] | last: 2026-10-01\nRaft:\n  confidence: 0.5 | stability: 0.2 | scope: [] | via: [] | last: 2026-10-02\n';
    const view = progressView(labelled)!;
    expect(view.solid).toEqual([{ name: 'Docker', aloud: true }]);
    expect(view.gettingThere).toEqual([{ name: 'Raft', aloud: false }]);
  });

  it('shows no more than a screenful of one group', () => {
    const lines = Array.from({ length: 70 }, (_, i) => `Topic ${i}: 0.8 | 0.5 | [] | [] | 2026-10-01`).join('\n');
    expect(progressView(`## Mastery Scores\n${lines}\n`)!.solid).toHaveLength(40);
  });
});

describe('the notes of a student, and what may be done to them', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function groups(files: Record<string, string> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-memory-'));
    dirs.push(dir);
    for (const [folder, text] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, folder), { recursive: true });
      fs.writeFileSync(path.join(dir, folder, 'COMPETENCY.md'), text);
    }
    return dir;
  }

  /** A store with a note or two for each of two students, and a record of what was asked. */
  function fakeStore(): MemoryStore & { rows: Map<string, MemoryRow[]>; asked: string[] } {
    const rows = new Map<string, MemoryRow[]>([
      [FOLDER, [{ id: 'mem-100-aaaaaa', text: 'Prefers diagrams', category: 'student_preference', created_at: NOW - 86_400_000 }]],
      [OTHER, [{ id: 'mem-200-bbbbbb', text: "Someone else's note", category: 'identity', created_at: NOW }]],
    ]);
    const asked: string[] = [];
    return {
      rows,
      asked,
      list: (folder) => {
        asked.push(`list ${folder}`);
        return rows.get(folder) ?? [];
      },
      remove: (folder, id) => {
        asked.push(`remove ${folder} ${id}`);
        const mine = rows.get(folder) ?? [];
        const at = mine.findIndex((r) => r.id === id);
        if (at !== -1) mine.splice(at, 1);
        return at !== -1;
      },
    };
  }

  it('gives a student their own notes and their own file, and nobody else\'s', () => {
    const store = fakeStore();
    const memory = new StudentMemory(store, groups({ [FOLDER]: COMPETENCY, [OTHER]: '## Mastery Scores\nPaxos: 0.9 | 0.9 | [] | [] | 2026-10-01\n' }), () => NOW);
    const view = memory.view(FOLDER);
    expect(view.memories.map((m) => m.text)).toEqual(['Prefers diagrams']);
    expect(view.progress!.solid.map((t) => t.name)).toContain('Go programming basics');
    expect(JSON.stringify(view)).not.toContain('Someone else');
    expect(JSON.stringify(view)).not.toContain('Paxos');
    expect(store.asked).toEqual([`list ${FOLDER}`]);
  });

  it('has no progress for a student with no file yet', () => {
    expect(new StudentMemory(fakeStore(), groups(), () => NOW).view(FOLDER).progress).toBeNull();
  });

  it('is empty for anything that is not a student\'s folder, and asks the store nothing', () => {
    const store = fakeStore();
    const memory = new StudentMemory(store, groups(), () => NOW);
    for (const folder of ['main', '../s_' + 'a'.repeat(20), 's_short', '', FOLDER + '/..']) expect(memory.view(folder), folder).toEqual({ memories: [], progress: null });
    expect(store.asked).toEqual([]);
  });

  it('forgets a note of this student, and tells what became of the copies made from the notes', () => {
    const store = fakeStore();
    const after: string[] = [];
    const memory = new StudentMemory(store, groups(), () => NOW, (folder) => after.push(folder));
    expect(memory.forget(FOLDER, 'mem-100-aaaaaa')).toBe(true);
    expect(store.rows.get(FOLDER)).toEqual([]);
    expect(after).toEqual([FOLDER]);
    expect(memory.forget(FOLDER, 'mem-100-aaaaaa')).toBe(false);          // already gone
    expect(after).toEqual([FOLDER]);                                      // (nothing changed: nothing to rebuild)
  });

  it('cannot forget a note of another student, and does not even ask the store when the id is not one', () => {
    const store = fakeStore();
    const memory = new StudentMemory(store, groups(), () => NOW);
    expect(memory.forget(FOLDER, 'mem-200-bbbbbb')).toBe(false);
    expect(store.rows.get(OTHER)).toHaveLength(1);
    store.asked.length = 0;
    for (const id of ['', 'x', "mem-1'; DROP TABLE memories;--", 'a b', 'mem/../1', '\n', 'x'.repeat(200)]) expect(memory.forget(FOLDER, id), id).toBe(false);
    expect(memory.forget('main', 'mem-100-aaaaaa')).toBe(false);
    expect(store.asked).toEqual([]);
    expect(MEMORY_ID.test('mem-1762000000000-k3j9x2')).toBe(true);
  });
});

describe('the notes in the database', () => {
  /** What a better-sqlite3 database is asked, and the rows it would answer. */
  function fakeDb(rows: unknown[] = [], changes = 1) {
    const calls: Array<{ sql: string; params: unknown[]; how: string }> = [];
    const db: MemoryDb = {
      prepare: (sql) => ({
        all: (...params) => {
          calls.push({ sql, params, how: 'all' });
          return rows;
        },
        run: (...params) => {
          calls.push({ sql, params, how: 'run' });
          return { changes };
        },
      }),
    };
    return { db, calls };
  }

  it('lists a student\'s notes that have not expired, newest first, by the folder and the time given', () => {
    const rows = [{ id: 'mem-1', text: 'a note', category: 'other', created_at: 5 }];
    const { db, calls } = fakeDb(rows);
    expect(sqliteMemoryStore(() => db).list(FOLDER, NOW)).toBe(rows);
    expect(calls).toHaveLength(1);
    expect(calls[0].how).toBe('all');
    expect(calls[0].sql).toMatch(/FROM memories WHERE student_folder = \? AND \(expires_at IS NULL OR expires_at > \?\) ORDER BY created_at DESC LIMIT \d+/);
    expect(calls[0].params).toEqual([FOLDER, NOW]);
  });

  it('deletes one note by its id AND the student\'s folder, never by the id alone', () => {
    const { db, calls } = fakeDb([], 1);
    expect(sqliteMemoryStore(() => db).remove(FOLDER, 'mem-1')).toBe(true);
    expect(calls[0].how).toBe('run');
    expect(calls[0].sql).toBe('DELETE FROM memories WHERE id = ? AND student_folder = ?');
    expect(calls[0].params).toEqual(['mem-1', FOLDER]);
    expect(sqliteMemoryStore(() => fakeDb([], 0).db).remove(FOLDER, 'mem-1')).toBe(false);
  });

  it('asks for the database only when it is used (the page may start before it is open)', () => {
    let opened = 0;
    const store = sqliteMemoryStore(() => {
      opened++;
      return fakeDb().db;
    });
    expect(opened).toBe(0);
    store.list(FOLDER, NOW);
    store.remove(FOLDER, 'mem-1');
    expect(opened).toBe(2);
  });
});
