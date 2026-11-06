import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it, vi } from 'vitest';

import {
  CANVAS_IDENTITY_ACTIONS,
  CANVAS_IDENTITY_NOT_LINKED,
  CANVAS_RESTRICTED_ACTIONS,
  accessFlagsFromEnv,
  accessFlagsFromInput,
  checkCanvasAccess,
  liftsToolLimits,
} from '../src/access.js';
import { scopeCanvasParams } from '../src/brief-access.js';
import { resolveGithubParams } from '../src/github-access.js';
import { buildMcpServers } from '../src/mcp-servers.js';
import type { ContainerInput } from '../src/protocol.js';
import { TOOL_LIMITS, ToolLimiter } from '../src/tool-limits.js';

// buildMcpServers says on stderr whether LeanRAG is mounted, for every call; the table below makes hundreds
vi.mock('../src/protocol.js', async (original) => ({ ...(await original<typeof import('../src/protocol.js')>()), log: () => undefined }));

// Who gets what, for the four kinds of container there are. Every row goes the whole way the host's decision goes: the ContainerInput the host writes (the shape
// src/task-scheduler.ts and src/index.ts give it), through buildMcpServers (what the nanoclaw server's environment says), through the decisions the tools make.
// Synthetic people only: Ada is the student the container is bound to, Bob is a classmate.
//
// Two decisions, and they differ: WHAT A CONTAINER MAY READ is the admin chat's alone (`isMain`): a student's chat, a task an agent scheduled and the host's own tasks
// (the patrol and the bootstrap, which run in the student's session, where the student reads what they read) are all bound to their student. WHICH TOOL LIMITS apply is
// what the host's own tasks differ in.

const ADA = { canvasUserId: '1001', githubUsername: 'ada-gh' };
const BOB = { canvasUserId: '1002', githubUsername: 'bob-gh' };
const ORGS = ['course-org'];

const base = { prompt: 'x', groupFolder: 'ada', chatJid: 'web:ada', ...ADA };
const CONTEXTS: Record<string, ContainerInput> = {
  'admin chat': { ...base, groupFolder: 'main', chatJid: 'web:main', isMain: true },
  // what the scheduler passes for a task the host made itself (the patrol, the grade bootstrap) ...
  'system task': { ...base, isMain: false, isScheduledTask: true, isSystemTask: true },
  // ... and for one an agent scheduled (schedule_task, or a file in its own IPC directory), with a prompt the student chose
  'student task': { ...base, isMain: false, isScheduledTask: true, isSystemTask: false },
  'student chat': { ...base, isMain: false },
};
const NAMES = Object.keys(CONTEXTS);

/** What the nanoclaw server of this container knows, as ipc-mcp-stdio.ts reads it. */
function serverOf(input: ContainerInput) {
  const env = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, {}).nanoclaw.env;
  const flags = accessFlagsFromEnv(env);
  return {
    env,
    isMain: flags.isMain,
    toolLimitsLifted: liftsToolLimits(flags),
    boundCanvasUserId: env['NANOCLAW_CANVAS_USER_ID'] ?? '',
    githubUsername: env['NANOCLAW_GITHUB_USERNAME'] ?? '',
  };
}

describe('whose tool limits are lifted', () => {
  const lifted: Record<string, boolean> = { 'admin chat': true, 'system task': true, 'student task': false, 'student chat': false };

  it.each(NAMES)('%s', (name) => {
    expect(serverOf(CONTEXTS[name]).toolLimitsLifted).toBe(lifted[name]);
  });

  it('is the same answer on both sides: the nanoclaw server\'s environment and the ContainerInput the voice tool host reads, for every combination of the flags', () => {
    const values = [true, false, undefined];
    for (const isMain of values) {
      for (const isScheduledTask of values) {
        for (const isSystemTask of values) {
          const input = { ...base, isMain: isMain === true, isScheduledTask, isSystemTask } as ContainerInput;
          expect(liftsToolLimits(accessFlagsFromEnv(serverOf(input).env)), JSON.stringify({ isMain, isScheduledTask, isSystemTask })).toBe(liftsToolLimits(accessFlagsFromInput(input)));
        }
      }
    }
  });
});

describe('fails closed', () => {
  it('a scheduled task alone lifts nothing: what an older host sends, and what every task sent before this', () => {
    expect(liftsToolLimits(accessFlagsFromEnv({ NANOCLAW_IS_MAIN: '0', NANOCLAW_IS_SCHEDULED_TASK: '1' }))).toBe(false);
    expect(serverOf({ ...base, isMain: false, isScheduledTask: true }).toolLimitsLifted).toBe(false);
  });

  it('the system flag means nothing without the task flag: it is not even sent, and read on its own it lifts nothing', () => {
    expect(serverOf({ ...base, isMain: false, isSystemTask: true }).env['NANOCLAW_IS_SYSTEM_TASK']).toBe('0');
    expect(liftsToolLimits(accessFlagsFromEnv({ NANOCLAW_IS_MAIN: '0', NANOCLAW_IS_SCHEDULED_TASK: '0', NANOCLAW_IS_SYSTEM_TASK: '1' }))).toBe(false);
    expect(liftsToolLimits(accessFlagsFromInput({ isMain: false, isSystemTask: true }))).toBe(false);
  });

  it('only the text "1" is a yes', () => {
    for (const not of ['', '0', 'true', 'yes', ' 1', '1 ', '01', 'TRUE', undefined]) {
      expect(liftsToolLimits(accessFlagsFromEnv({ NANOCLAW_IS_SCHEDULED_TASK: '1', NANOCLAW_IS_SYSTEM_TASK: not })), String(not)).toBe(false);
      expect(accessFlagsFromEnv({ NANOCLAW_IS_MAIN: not }).isMain, String(not)).toBe(false);
    }
    expect(accessFlagsFromEnv({ NANOCLAW_IS_MAIN: '1' }).isMain).toBe(true);
    expect(liftsToolLimits(accessFlagsFromEnv({ NANOCLAW_IS_SCHEDULED_TASK: '1', NANOCLAW_IS_SYSTEM_TASK: '1' }))).toBe(true);
  });

  it('nothing the input says in another type counts either (a string "true" from a hand-written input is not true)', () => {
    expect(accessFlagsFromInput({ isMain: 'true' as unknown as boolean }).isMain).toBe(false);
    expect(liftsToolLimits(accessFlagsFromInput({ isScheduledTask: 1 as unknown as boolean, isSystemTask: 1 as unknown as boolean }))).toBe(false);
  });
});

describe('canvas_query: what comes back, for each kind of container and each action', () => {
  // The decisions of the handler in ipc-mcp-stdio.ts, in its order: checkCanvasAccess, then scopeCanvasParams (access-source.test.ts holds the order and the keys).
  type Outcome = 'as given' | 'refused' | 'bound to 1001';
  function outcome(context: string, action: string, params?: Record<string, string>): Outcome {
    const server = serverOf(CONTEXTS[context]);
    const verdict = checkCanvasAccess(action, params, { isMain: server.isMain, boundCanvasUserId: server.boundCanvasUserId });
    if (!verdict.ok) return 'refused';
    const scoped = scopeCanvasParams(action, verdict.params, { isMain: server.isMain, boundCanvasUserId: server.boundCanvasUserId });
    if (!scoped.ok) return 'refused';
    return JSON.stringify(scoped.params) === JSON.stringify(params) ? 'as given' : (`bound to ${scoped.params?.user_id}` as Outcome);
  }

  // Every action canvas_api.py answers. The model names Bob wherever an action takes a user.
  const asBob = { user_id: BOB.canvasUserId };
  const ROWS: Array<{ action: string; params?: Record<string, string>; why: string; admin: Outcome; system: Outcome; studentTask: Outcome; studentChat: Outcome }> = [
    // the actions that list the class: the admin chat's alone, the host's own tasks refused too (they read in the student's session)
    { action: 'grades', why: 'every student\'s submissions', admin: 'as given', system: 'refused', studentTask: 'refused', studentChat: 'refused' },
    { action: 'users', why: 'the roster, with e-mail addresses', admin: 'as given', system: 'refused', studentTask: 'refused', studentChat: 'refused' },
    { action: 'submissions', params: { assignment_id: '77' }, why: 'one assignment\'s rows for every student: id, name, score, grade', admin: 'as given', system: 'refused', studentTask: 'refused', studentChat: 'refused' },
    // about one student: the bound one, whatever the model passes, in every container but the admin chat
    { action: 'student_submission', params: { assignment_id: '77', ...asBob }, why: 'a submission with its text and files', admin: 'as given', system: 'bound to 1001', studentTask: 'bound to 1001', studentChat: 'bound to 1001' },
    { action: 'my_grades', params: asBob, why: 'a student\'s scores', admin: 'as given', system: 'bound to 1001', studentTask: 'bound to 1001', studentChat: 'bound to 1001' },
    { action: 'my_grades', why: 'no user named at all', admin: 'as given', system: 'bound to 1001', studentTask: 'bound to 1001', studentChat: 'bound to 1001' },
    { action: 'week_status', params: { assignment_id: '77', ...asBob }, why: 'this week\'s standing (scoped by brief-access.ts)', admin: 'as given', system: 'bound to 1001', studentTask: 'bound to 1001', studentChat: 'bound to 1001' },
    { action: 'user_contact', params: asBob, why: 'a student\'s name and e-mail (scoped by brief-access.ts)', admin: 'as given', system: 'bound to 1001', studentTask: 'bound to 1001', studentChat: 'bound to 1001' },
    // course content, the same for everybody: nothing about a student, or what every student of the course sees in Canvas itself
    ...['assignments', 'upcoming', 'announcements', 'discussions', 'modules', 'pages', 'syllabus', 'files'].map((action) => ({ action, why: 'course content', admin: 'as given' as Outcome, system: 'as given' as Outcome, studentTask: 'as given' as Outcome, studentChat: 'as given' as Outcome })),
    ...[
      ['assignment_detail', { assignment_id: '77' }],
      ['discussion_detail', { topic_id: '5' }],
      ['discussion_entries', { topic_id: '5' }],
      ['module_items', { module_id: '3' }],
      ['page_detail', { page_url: 'syllabus' }],
      ['file_content', { file_id: '9' }],
    ].map(([action, params]) => ({ action: action as string, params: params as Record<string, string>, why: 'course content (a discussion\'s entries carry their authors\' names: the class forum, as every student sees it in Canvas)', admin: 'as given' as Outcome, system: 'as given' as Outcome, studentTask: 'as given' as Outcome, studentChat: 'as given' as Outcome })),
  ];

  for (const row of ROWS) {
    const expected: Record<string, Outcome> = { 'admin chat': row.admin, 'system task': row.system, 'student task': row.studentTask, 'student chat': row.studentChat };
    it(`${row.action}${row.params ? ' ' + JSON.stringify(row.params) : ''} (${row.why})`, () => {
      for (const name of NAMES) expect(outcome(name, row.action, row.params), `${name}: ${row.action}`).toBe(expected[name]);
    });
  }

  it('covers every action canvas_api.py answers, so that a new one cannot arrive without a decision here', () => {
    const script = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'canvas_api.py'), 'utf-8');
    const available = /"available": \[([^\]]+)\]/.exec(script);
    expect(available, 'the "available" list of canvas_api.py').not.toBeNull();
    const offered = [...available![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect([...new Set(ROWS.map((r) => r.action))].sort()).toEqual(offered);
  });

  it('lists exactly the actions that list the class and the ones that are about one student', () => {
    expect([...CANVAS_RESTRICTED_ACTIONS].sort()).toEqual(['grades', 'submissions', 'users']);
    expect([...CANVAS_IDENTITY_ACTIONS].sort()).toEqual(['my_grades', 'student_submission']);
  });

  it('refuses a student whose container is not linked, in the words the model repeats to the student, and never lets the model\'s user id through (the host\'s own tasks included)', () => {
    for (const name of ['system task', 'student task', 'student chat']) {
      const verdict = checkCanvasAccess('my_grades', { user_id: BOB.canvasUserId }, { isMain: serverOf(CONTEXTS[name]).isMain, boundCanvasUserId: '' });
      expect(verdict, name).toEqual({ ok: false, message: CANVAS_IDENTITY_NOT_LINKED });
    }
  });

  it('names the action it refused, says that only the admin chat may list the class, and says what to use instead', () => {
    const verdict = checkCanvasAccess('submissions', { assignment_id: '77' }, { isMain: false, boundCanvasUserId: ADA.canvasUserId });
    expect(verdict.ok).toBe(false);
    const message = verdict.ok === false ? verdict.message : '';
    expect(message).toContain('The "submissions" action is restricted to protect student privacy.');
    expect(message).toContain('only the admin chat');
    for (const instead of ['week_status', 'my_grades', 'student_submission']) expect(message).toContain(instead);
  });

  it('does not touch the caller\'s params', () => {
    const params = { assignment_id: '77', user_id: BOB.canvasUserId };
    checkCanvasAccess('student_submission', params, { isMain: false, boundCanvasUserId: ADA.canvasUserId });
    expect(params).toEqual({ assignment_id: '77', user_id: BOB.canvasUserId });
  });
});

describe('set_student_identity, by container', () => {
  // the tool refuses unless the container is the admin chat, and the host refuses a container's own file (src/ipc-task-origin.test.ts): the host's tasks are no exception,
  // the bootstrap's account comes from the allowlist
  const allowed: Record<string, boolean> = { 'admin chat': true, 'system task': false, 'student task': false, 'student chat': false };
  it.each(NAMES)('%s', (name) => {
    expect(serverOf(CONTEXTS[name]).isMain).toBe(allowed[name]);
  });
});

describe('github_query, by container', () => {
  const call = (name: string, params: Record<string, string>, action = 'repo_tree') => {
    const server = serverOf(CONTEXTS[name]);
    return resolveGithubParams(action, params, { username: server.githubUsername, allowedOrgs: ORGS, fullAccess: server.isMain });
  };

  it.each(NAMES)('a classmate\'s repository, or any account the model names: %s', (name) => {
    const verdict = call(name, { owner: BOB.githubUsername, repo: 'hw3' });
    expect(verdict.ok).toBe(name === 'admin chat');
    if (!verdict.ok) expect(verdict.message).toContain('You can only access your own repositories');
  });

  it.each(NAMES)('their own and the course organisation\'s: %s', (name) => {
    expect(call(name, { owner: ADA.githubUsername, repo: 'hw3' }).ok).toBe(true);
    expect(call(name, { owner: 'course-org', repo: 'handouts' }).ok).toBe(true);
  });

  it('a system task is held to the bound account even when COMPETENCY.md, which a student\'s agent can write, names another one', () => {
    // the patrol read the GitHub name from that file: whatever it says, it is passed as an account and refused unless it is the bound one
    const verdict = call('system task', { owner: 'someone-the-file-says', repo: 'x' });
    expect(verdict.ok).toBe(false);
    expect(call('system task', {}, 'list_repos')).toMatchObject({ ok: true, params: { user: ADA.githubUsername } });         // no account named: the bound one
  });

  it('a student container is held to the allowlist even when it names a classmate under another key', () => {
    for (const name of ['system task', 'student task', 'student chat']) {
      for (const key of ['user', 'org', 'username', 'login']) {
        const verdict = call(name, { owner: ADA.githubUsername, [key]: BOB.githubUsername }, 'list_repos');
        expect(verdict.ok, `${name} ${key}`).toBe(false);
      }
    }
  });

  it('the activity action is the bound account\'s alone, in every container but the admin chat', () => {
    for (const name of ['system task', 'student task', 'student chat']) {
      expect(call(name, { owner: 'course-org' }, 'activity').ok, name).toBe(false);
      expect(call(name, { owner: BOB.githubUsername }, 'activity').ok, name).toBe(false);
      expect(call(name, {}, 'activity'), name).toMatchObject({ ok: true, params: { owner: ADA.githubUsername } });
    }
    expect(call('admin chat', { owner: BOB.githubUsername }, 'activity').ok).toBe(true);
  });
});

describe('the tool limits, by container', () => {
  const callsUntilRefused = (name: string, tool: string, tries: number): number => {
    const limiter = new ToolLimiter(TOOL_LIMITS, serverOf(CONTEXTS[name]).toolLimitsLifted);
    for (let i = 1; i <= tries; i++) if (limiter.check(tool)) return i - 1;
    return tries;
  };

  it('stop a student task and a student chat after the same number of calls, and never stop the admin chat or a system task', () => {
    expect(callsUntilRefused('student task', 'canvas_query', 100)).toBe(TOOL_LIMITS.canvas_query);
    expect(callsUntilRefused('student chat', 'canvas_query', 100)).toBe(TOOL_LIMITS.canvas_query);
    expect(callsUntilRefused('admin chat', 'canvas_query', 100)).toBe(100);
    expect(callsUntilRefused('system task', 'canvas_query', 100)).toBe(100);
  });

  it('never stop send_message, which is how a student\'s own scheduled reminder reaches them', () => {
    expect(Object.prototype.hasOwnProperty.call(TOOL_LIMITS, 'send_message')).toBe(false);
    expect(callsUntilRefused('student task', 'send_message', 500)).toBe(500);
  });
});

describe('what the host\'s input becomes in the nanoclaw server\'s environment', () => {
  it('says a task is a task, and that it is the host\'s own only when the host said so', () => {
    const flags = (name: string) => {
      const { env } = serverOf(CONTEXTS[name]);
      return [env['NANOCLAW_IS_MAIN'], env['NANOCLAW_IS_SCHEDULED_TASK'], env['NANOCLAW_IS_SYSTEM_TASK']];
    };
    expect(flags('admin chat')).toEqual(['1', '0', '0']);
    expect(flags('system task')).toEqual(['0', '1', '1']);
    expect(flags('student task')).toEqual(['0', '1', '0']);     // still a scheduled task: its answer is not sent to the student, only what it says through send_message
    expect(flags('student chat')).toEqual(['0', '0', '0']);
  });

  it('keeps the identity binding in every one of them, so that every task is bound to its student', () => {
    for (const name of ['system task', 'student task', 'student chat']) {
      const { env } = serverOf(CONTEXTS[name]);
      expect(env['NANOCLAW_CANVAS_USER_ID'], name).toBe(ADA.canvasUserId);
      expect(env['NANOCLAW_GITHUB_USERNAME'], name).toBe(ADA.githubUsername);
    }
  });
});
