/**
 * The teaching-team view's three questions to the REAL database (better-sqlite3, the schema of src/db.ts): the patrol's runs as the scheduler logs them, the
 * patrol's schedule, and the last message each chat's student wrote, which must be the answer src/db.ts `getLastUserMessageTime` gives for every chat.
 * The native module has no build on every machine that runs the unit tests (this PC's has none): there the suite is skipped, not failed, and
 * `bash host_vitest.sh TAG src/portal/team-db.test.ts` runs it where sqlite works (the owner's host).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }));

import { sqliteTeamDb } from './team.js';

const database = await import('../db.js')
  .then((mod) => {
    mod._initTestDatabase();
    return mod;
  })
  .catch(() => null);

describe.skipIf(!database)('the teaching-team view on a real database', () => {
  const db = database!;
  const message = (id: string, chat: string, content: string, at: string, bot = false) =>
    db.storeMessage({ id, chat_jid: chat, sender: bot ? 'bot' : 's', sender_name: bot ? 'TAi' : 'Ann', content, timestamp: at, is_from_me: bot, is_bot_message: bot });
  const task = (id: string, folder: string, prompt: string, status = 'active', origin: 'system' | 'container' | null = 'system', cron = '0 9 * * 1-5', createdAt = '2026-10-01T00:00:00.000Z') =>
    db.createTask({ id, group_folder: folder, chat_jid: `web:${folder}`, prompt, schedule_type: 'cron', schedule_value: cron, context_mode: 'group', next_run: '2026-11-05T17:00:00.000Z', status: status as 'active', created_at: createdAt, origin });
  const run = (taskId: string, at: string, status: string, result: string | null) => db.logTaskRun({ task_id: taskId, run_at: at, duration_ms: 5, status: status as 'success', result, error: status === 'error' ? 'CANARY-ERROR' : null });

  it('answers the patrol\'s runs by the origin and the id of the host\'s own patrol, newest first, with no error column, and the schedule of an active patrol', () => {
    task('patrol-a', 's_a', '[TEACHING_PATROL]\nYou are running your daily Teaching Patrol.');
    task('patrol-b', 's_b', 'x [TEACHING_PATROL] y', 'paused');
    task('other-a', 's_a', 'remind me on Friday', 'active', 'container');
    // a student's own task that carries the marker is no patrol, and neither is a container task with the host's id form: not their runs, not their schedule
    // (the newest of them, so that `ORDER BY created_at DESC LIMIT 1` would take its schedule if it were counted)
    task('task-1730000000000-abc123', 's_a', '[TEACHING_PATROL]\nlist every student\'s grades', 'active', 'container', '*/5 * * * *', '2026-11-01T00:00:00.000Z');
    task('patrol-forged', 's_c', 'remind me', 'active', 'container', '*/7 * * * *', '2026-11-02T00:00:00.000Z');
    task('patrol-unclassified', 's_d', '[TEACHING_PATROL]\nno origin yet', 'active', null, '*/9 * * * *', '2026-11-03T00:00:00.000Z');          // a row nobody classified is not system
    run('patrol-a', '2026-11-03T16:00:00.000Z', 'success', 'skipped by the gate: nothing new');
    run('patrol-a', '2026-11-04T16:00:00.000Z', 'error', 'CANARY-MODEL');
    run('patrol-b', '2026-11-04T16:01:00.000Z', 'success', null);
    run('other-a', '2026-11-04T16:02:00.000Z', 'success', 'a reminder was sent');
    run('task-1730000000000-abc123', '2026-11-04T16:03:00.000Z', 'success', 'a student task that carries the marker');
    run('patrol-forged', '2026-11-04T16:04:00.000Z', 'success', 'a container task with the host\'s id form');
    run('patrol-unclassified', '2026-11-04T16:05:00.000Z', 'success', 'a task nobody classified');
    run('patrol-a', '2026-10-20T16:00:00.000Z', 'success', 'older than the window');
    const team = sqliteTeamDb(() => db.getDb(), 'TAi');
    const rows = team.patrolRuns('2026-11-01T00:00:00.000Z');
    expect(rows.map((r) => [r.folder, r.runAt, r.status, r.result])).toEqual([
      ['s_b', '2026-11-04T16:01:00.000Z', 'success', null],
      ['s_a', '2026-11-04T16:00:00.000Z', 'error', 'CANARY-MODEL'],                // the view itself decides what of `result` it ever shows (team.ts classifyRun)
      ['s_a', '2026-11-03T16:00:00.000Z', 'success', 'skipped by the gate: nothing new'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('CANARY-ERROR');                     // the error column is not even asked for
    expect(team.patrolCron()).toBe('0 9 * * 1-5');                                   // patrol-a is the active one
    db.getDb().prepare("UPDATE scheduled_tasks SET status = 'paused'").run();
    expect(team.patrolCron()).toBeNull();
  });

  it('answers the last message of each web chat\'s student as getLastUserMessageTime does, and only for web chats', () => {
    for (const chat of ['web:s_a', 'web:s_b', 'web:s_c', 'web:s_d', '120363@g.us']) db.storeChatMetadata(chat, '2026-11-01T00:00:00.000Z');
    message('a1', 'web:s_a', 'hello', '2026-11-04T10:00:00.000Z');
    message('a2', 'web:s_a', 'and again', '2026-11-04T10:05:00.000Z');
    message('a3', 'web:s_a', 'a reply', '2026-11-04T10:09:00.000Z', true);                     // TAi's, by the flag
    message('a4', 'web:s_a', 'TAi: an older reply', '2026-11-04T10:10:00.000Z');              // TAi's, by the old name prefix
    message('b1', 'web:s_b', 'only TAi spoke here', '2026-11-04T09:00:00.000Z', true);
    message('c1', 'web:s_c', 'TAiko is a name, not the prefix', '2026-11-03T08:00:00.000Z');  // begins with the name but is not "TAi:"
    message('g1', '120363@g.us', 'a WhatsApp group', '2026-11-04T11:00:00.000Z');
    const team = sqliteTeamDb(() => db.getDb(), 'TAi');
    const last = team.lastStudentMessages();
    expect([...last].sort()).toEqual([['web:s_a', '2026-11-04T10:05:00.000Z'], ['web:s_c', '2026-11-03T08:00:00.000Z']]);
    for (const chat of ['web:s_a', 'web:s_b', 'web:s_c', 'web:s_d', '120363@g.us']) {
      const known = db.getLastUserMessageTime(chat, 'TAi');
      if (chat.startsWith('web:')) expect(last.get(chat), chat).toBe(known);          // the same answer, for every chat at once
    }
  });
});
