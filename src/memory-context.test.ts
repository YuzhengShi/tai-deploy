/**
 * What the text agent is told of a student's work (docs/STUDENT_STATE.md): `buildMemoryContext` has a section of their own for the repository, the thread and the problems, always there, and the
 * three kinds are in no other list of it. Database code: run on the host (`bash host_vitest.sh src/memory-context.test.ts`), this PC has no native sqlite module.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDb, storeChatMetadata, storeMessage } from './db.js';
import { buildMemoryContext, listWorkFacts, storeMemory, upsertWorkFact } from './memory.js';
import { MEMORY_ID, StudentMemory, memoryItems, sqliteMemoryStore } from './portal/memory-view.js';
import type { MemoryDb } from './portal/memory-view.js';
import { WORK_NOTE, dayLabel, issueFact, repoFact, threadFact } from './work-facts.js';
import type { WorkFact } from './work-facts.js';

const ANA = 's_ana';
const BOB = 's_bob';
const JID = 'web:s_ana';
const DAY = 86_400_000;

beforeEach(() => {
  _initTestDatabase();
  storeChatMetadata(JID, '2026-11-05T10:00:00.000Z', 'Ana', 'web', false);
});

const say = (id: string, name: string, content: string, at: string, bot = false) =>
  storeMessage({ id, chat_jid: JID, sender: bot ? 'bot' : 's', sender_name: name, content, timestamp: at, is_from_me: bot, is_bot_message: bot });
const CHAT = ['## Recent conversation history', '[2026-11-05] Ana: hello', '[2026-11-05] TAi: hi there'];
/** The text of a fact written now, as the host writes it (the day is today's, in Pacific time). */
const now0 = Date.now();
const today = dayLabel(now0);
const repo2 = (name = 'cs6650-hw2'): WorkFact => repoFact('', 'Homework 2: MapReduce', name)!;
const repoLine = (name = 'cs6650-hw2') => `- Their code for Homework 2: MapReduce is in their repository ${name}.`;
const threadLine = `- Left open on ${today}: check the timeouts.`;
const issueLine = `- The cache deadlocks when two goroutines lock the map in opposite orders. (${today})`;
const keep = (folder: string, fact: WorkFact | null, at = now0) => expect(upsertWorkFact(folder, fact!, at)).toBe(true);
/** A memory of the agent's with a time of its own (storeMemory stamps the clock, and two in one millisecond have no order). */
const memorize = (folder: string, text: string, category: string, createdAt: number) => {
  storeMemory(folder, { text, category });
  getDb().prepare('UPDATE memories SET created_at = ? WHERE student_folder = ? AND text = ?').run(createdAt, folder, text);
};

describe('with nothing remembered of their work', () => {
  it('is exactly what it was: the stored memories, then the chat', () => {
    memorize(ANA, 'likes diagrams', 'student_preference', now0 - 10);
    say('m1', 'Ana', 'hello', '2026-11-05T10:00:01.000Z');
    say('m2', 'TAi', 'hi there', '2026-11-05T10:00:02.000Z', true);
    const expected = ['<memory_context>', '## Stored memories (from past sessions)', '- [student_preference] likes diagrams', ...CHAT, '</memory_context>'].join('\n');
    expect(buildMemoryContext(JID, ANA, 'diagrams')).toBe(expected);
    expect(buildMemoryContext(JID, ANA, 'what is a mutex')).toBe(expected); // (no word matches: the newest memories, as ever)
  });

  it('is empty for a student with no memories and no chat, and has the memories alone, or the chat alone', () => {
    expect(buildMemoryContext(JID, ANA, 'anything')).toBe('');
    memorize(ANA, 'likes diagrams', 'student_preference', now0);
    expect(buildMemoryContext(JID, ANA, 'anything')).toBe('<memory_context>\n## Stored memories (from past sessions)\n- [student_preference] likes diagrams\n</memory_context>');
    expect(buildMemoryContext(JID, BOB, 'anything')).toBe('');
    say('m1', 'Ana', 'hello', '2026-11-05T10:00:01.000Z');
    expect(buildMemoryContext(JID, BOB, 'anything')).toBe('<memory_context>\n## Recent conversation history\n[2026-11-05] Ana: hello\n</memory_context>');
  });
});

describe('with a repository, a thread and a problem remembered', () => {
  beforeEach(() => {
    memorize(ANA, 'likes diagrams', 'student_preference', now0 - 10);
    keep(ANA, repo2(), now0 - 3);
    keep(ANA, threadFact('Timeouts', 'check the timeouts.', now0), now0 - 2);
    keep(ANA, issueFact('The cache deadlocks when two goroutines lock the map in opposite orders.', now0), now0 - 1);
    say('m1', 'Ana', 'hello', '2026-11-05T10:00:01.000Z');
    say('m2', 'TAi', 'hi there', '2026-11-05T10:00:02.000Z', true);
  });

  it('has them in a section of their own, always, whatever the prompt says, after the stored memories and before the chat, ending in the words that make them questions', () => {
    const expected = ['<memory_context>', '## Stored memories (from past sessions)', '- [student_preference] likes diagrams', '## Their work, from earlier sessions', repoLine(), threadLine, issueLine, WORK_NOTE, ...CHAT, '</memory_context>'].join('\n');
    for (const prompt of ['what is a mutex', 'diagrams', '', 'repo issue thread', '!!!']) expect(buildMemoryContext(JID, ANA, prompt), prompt).toBe(expected);
  });

  it('says each of them once: they are in no list but their own', () => {
    const text = buildMemoryContext(JID, ANA, 'repository issue thread homework');
    for (const line of [repoLine(), threadLine, issueLine]) expect(text.split(line).length - 1, line).toBe(1);
    expect(text).not.toMatch(/\[(repo|thread|issue)\]/);
  });

  it('is a context of its own for a student who has nothing else', () => {
    expect(buildMemoryContext('web:s_nobody', BOB, 'hello')).toBe('');
    keep(BOB, repo2('bob-hw2'));
    expect(buildMemoryContext('web:s_nobody', BOB, 'hello')).toBe(['<memory_context>', '## Their work, from earlier sessions', repoLine('bob-hw2'), WORK_NOTE, '</memory_context>'].join('\n'));
  });

  it('shows at most six lines, the two newest repositories, the newest threads and problems, only this student\'s and none that has expired', () => {
    for (let i = 1; i <= 3; i++) keep(ANA, repoFact('', `Homework ${i + 2}: x`, `repo-${i + 2}`), now0 + i);
    keep(ANA, threadFact('Second topic', 'a second thing left open.', now0), now0 + 10);
    keep(ANA, threadFact('Third topic', 'a third thing left open.', now0), now0 + 11);
    for (let i = 1; i <= 4; i++) keep(ANA, issueFact(`Problem number ${i} in the lock table`, now0), now0 + 20 + i);
    keep(ANA, repoFact('', 'Homework 9: gone', 'expired-repo'), now0 - 100 * DAY); // written long ago: its 90 days are over
    keep(BOB, repoFact('', 'Homework 9: his', 'bobs-repo'), now0 + 100);
    const lines = buildMemoryContext(JID, ANA, 'hello').split('\n');
    const section = lines.slice(lines.indexOf('## Their work, from earlier sessions') + 1, lines.indexOf(WORK_NOTE));
    expect(section).toHaveLength(6);
    const starts = ['Their code for Homework 5: x is', 'Their code for Homework 4: x is', `Left open on ${today}: a third thing`, `Left open on ${today}: a second thing`, 'Problem number 4 in the lock table', 'Problem number 3 in the lock table'];
    starts.forEach((start, i) => expect(section[i].startsWith(`- ${start}`), `${i}: ${section[i]}`).toBe(true));
    expect(lines.join('\n')).not.toContain('bobs-repo');
    expect(lines.join('\n')).not.toContain('expired-repo');
  });

  it('keeps the newest ordinary memories in the stored list, six of them, however many rows about their work are newer and match the words of the prompt', () => {
    for (let i = 1; i <= 8; i++) memorize(ANA, `memory number ${i} about locks`, 'concept', now0 - 1000 + i);
    for (let i = 1; i <= 6; i++) keep(ANA, issueFact(`Problem number ${i} in the lock table`, now0), now0 + i);
    // "repo", "issue" and "thread" are words of the rows' own category column: the search matches nothing BUT their rows
    const text = buildMemoryContext(JID, ANA, 'repo issue thread');
    const listed = text.slice(text.indexOf('## Stored memories'), text.indexOf('## Their work'));
    // (the newest are "likes diagrams" of the set-up above, then the eighth, the seventh... of these)
    expect(listed.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- [student_preference] likes diagrams', ...[8, 7, 6, 5, 4].map((i) => `- [concept] memory number ${i} about locks`)]);
    expect(listed).not.toMatch(/\[(repo|thread|issue)\]/);
  });

  it('keeps what the search found among the ordinary memories when it found rows about their work too, and only those', () => {
    memorize(ANA, 'works with sqlite on nights', 'concept', now0 - 5000);
    for (let i = 1; i <= 8; i++) keep(ANA, issueFact(`Problem number ${i} in the lock table`, now0), now0 + i);
    const text = buildMemoryContext(JID, ANA, 'sqlite issue');
    const listed = text.slice(text.indexOf('## Stored memories'), text.indexOf('## Their work'));
    expect(listed.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- [concept] works with sqlite on nights']);
  });
});

describe('what the page\'s list does with them', () => {
  // the page's own spelling of a student's folder (src/portal/history.ts STUDENT_FOLDER): "s_" and twenty characters
  const P_ANA = 's_' + 'a'.repeat(20);
  const P_BOB = 's_' + 'b'.repeat(20);

  it('lists the three kinds with their own words, and takes one back by its id: only this student\'s, and it is gone from every reader', () => {
    keep(P_ANA, repo2());
    keep(P_ANA, threadFact('Timeouts', 'check the timeouts.', now0));
    keep(P_ANA, issueFact('The cache deadlocks when two goroutines lock the map in opposite orders.', now0));
    keep(P_BOB, repo2('bob-hw2'));
    memorize(P_ANA, 'likes diagrams', 'student_preference', now0 - 10);
    const store = sqliteMemoryStore(() => getDb() as unknown as MemoryDb);
    const rows = store.list(P_ANA, Date.now());
    expect(memoryItems(rows).map((i) => i.label).sort()).toEqual(['A problem you ran into', 'Preference', 'Where we stopped', 'Your code']);
    const mine = rows.find((r) => r.category === 'repo')!;
    const his = store.list(P_BOB, Date.now())[0];
    expect(MEMORY_ID.test(mine.id)).toBe(true); // the id the host wrote is one the endpoint takes
    const after: string[] = [];
    const memory = new StudentMemory(store, '/nonexistent-groups-dir', Date.now, (folder) => after.push(folder));
    expect(memory.forget(P_ANA, his.id)).toBe(false);
    expect(listWorkFacts(P_BOB).map((f) => f.key)).toEqual(['repo:hw2']);
    expect(memory.forget(P_ANA, mine.id)).toBe(true);
    expect(after).toEqual([P_ANA]);
    expect(listWorkFacts(P_ANA).map((f) => f.category)).toEqual(['issue', 'thread']);
    expect(buildMemoryContext(JID, P_ANA, 'hello')).not.toContain('their repository');
  });
});
