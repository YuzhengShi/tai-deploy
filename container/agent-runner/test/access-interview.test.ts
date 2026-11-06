import { describe, expect, it, vi } from 'vitest';

import { mayReadLinkedRepo } from '../src/access.js';
import { resolveBriefIdentity } from '../src/brief-access.js';
import { buildMcpServers } from '../src/mcp-servers.js';
import type { ContainerInput } from '../src/protocol.js';
import { acceptGithubHost } from '../src/weekly-brief.js';

// buildMcpServers says on stderr whether LeanRAG is mounted, for every call
vi.mock('../src/protocol.js', async (original) => ({ ...(await original<typeof import('../src/protocol.js')>()), log: () => undefined }));

// start_mock_interview reads with the operator's token what the student's own submission links to. These are the two rules that decide whose it is: who the student is
// (the host's binding, whatever the model passes or a file says) and whose repository a link may be (the student's own, else one they have committed to).
// Synthetic people only: Ada is the student, Bob a classmate, "instructor" owns a private repository the token can see.

describe('mayReadLinkedRepo: whose repository a submission\'s link may be', () => {
  const ask = async (login: string, owner: string, repo: string, belongs: (login: string) => Promise<boolean> = async () => false) => {
    const spy = vi.fn(belongs);
    const allowed = await mayReadLinkedRepo({ login, link: { owner, repo }, belongs: spy });
    return { allowed, calls: spy.mock.calls };
  };

  it('reads the student\'s own repository, in whatever case the link spells the login, without asking GitHub anything', async () => {
    expect(await ask('ada-gh', 'ada-gh', 'hw3')).toEqual({ allowed: true, calls: [] });
    expect(await ask('ada-gh', 'Ada-GH', 'hw3')).toEqual({ allowed: true, calls: [] });
    expect(await ask('Ada-GH', 'ada-gh', 'hw3')).toEqual({ allowed: true, calls: [] });
  });

  it('refuses a classmate\'s repository, and the instructor\'s private one, after asking whether the student has committed to it, and says so with the student\'s login', async () => {
    expect(await ask('ada-gh', 'bob-gh', 'hw3')).toEqual({ allowed: false, calls: [['ada-gh']] });
    expect(await ask('ada-gh', 'instructor', 'solutions')).toEqual({ allowed: false, calls: [['ada-gh']] });
  });

  it('reads an organisation\'s or a team\'s repository when the student is shown to belong to it (a commit of theirs), and asks with their login, never with the link\'s owner', async () => {
    const { allowed, calls } = await ask('ada-gh', 'course-org', 'hw3-ada', async () => true);
    expect(allowed).toBe(true);
    expect(calls).toEqual([['ada-gh']]);
    expect(calls.flat()).not.toContain('course-org');
  });

  it('refuses when the check fails, throws, rejects or says anything but true', async () => {
    expect((await ask('ada-gh', 'team-x', 'project', async () => { throw new Error('GitHub API error: 404'); })).allowed).toBe(false);
    expect((await ask('ada-gh', 'team-x', 'project', () => Promise.reject(new Error('timed out')))).allowed).toBe(false);
    expect((await ask('ada-gh', 'team-x', 'project', async () => 'yes' as unknown as boolean)).allowed).toBe(false);
    expect((await ask('ada-gh', 'team-x', 'project', async () => 1 as unknown as boolean)).allowed).toBe(false);
    expect((await ask('ada-gh', 'team-x', 'project', async () => undefined as unknown as boolean)).allowed).toBe(false);
  });

  it('trusts the link for nothing when no login is known, and asks nobody anything', async () => {
    expect(await ask('', 'bob-gh', 'hw3', async () => true)).toEqual({ allowed: false, calls: [] });
    expect(await ask('', '', '', async () => true)).toEqual({ allowed: false, calls: [] });
  });

  it('refuses a name that could change an API path before it asks anything, even for the student\'s own login', async () => {
    const BAD = ['..', '../x', '%2e%2e', 'a/b', 'a b', '', '.hidden', '-x', 'a%2fb', 'x\u0000y', 'x\\y', 'a'.repeat(101)];
    for (const bad of BAD) {
      expect(await ask('ada-gh', bad, 'hw3', async () => true), `owner ${JSON.stringify(bad)}`).toEqual({ allowed: false, calls: [] });
      expect(await ask('ada-gh', 'ada-gh', bad, async () => true), `repo ${JSON.stringify(bad)}`).toEqual({ allowed: false, calls: [] });
      expect(await ask('ada-gh', 'course-org', bad, async () => true), `org repo ${JSON.stringify(bad)}`).toEqual({ allowed: false, calls: [] });
    }
  });

  it('accepts the plain names a repository has (dots, dashes and underscores inside)', async () => {
    expect((await ask('ada-gh', 'ada-gh', 'cs6650_hw3.v2')).allowed).toBe(true);
    expect((await ask('ada-gh', 'ada-gh', 'My-Repo')).allowed).toBe(true);
  });
});

describe('the host a submission\'s link names', () => {
  it('is the canonical one, whatever the link\'s spelling: https://GitHub.com/x/y is github.com, not an Enterprise host that would be sent the Enterprise token', () => {
    expect(acceptGithubHost('GitHub.com', {})).toBe('github.com');
    expect(acceptGithubHost('github.com', {})).toBe('github.com');
    expect(acceptGithubHost('github.evil.example', {})).toBe('');
    const enterprise = { GITHUB_BASE_URL: 'https://github.khoury.example/api/v3' };
    expect(acceptGithubHost('GITHUB.khoury.example', enterprise)).toBe('github.khoury.example');
    expect(acceptGithubHost('github.evil.example', enterprise)).toBe('');
  });
});

describe('start_mock_interview\'s identity: the one the weekly brief uses, for each kind of container', () => {
  const ADA = { canvasUserId: '1001', githubUsername: 'ada-gh' };
  const BOB = { canvasUserId: '1002', githubUsername: 'bob-gh' };
  const CONTEXTS: Record<string, ContainerInput> = {
    'student chat': { prompt: 'x', groupFolder: 'ada', chatJid: 'web:ada', isMain: false, ...ADA },
    // the host made the task, and an agent scheduled it: both are scheduled tasks in a student's container, bound to the student
    'system task': { prompt: 'x', groupFolder: 'ada', chatJid: 'web:ada', isMain: false, isScheduledTask: true, isSystemTask: true, ...ADA },
    'student task': { prompt: 'x', groupFolder: 'ada', chatJid: 'web:ada', isMain: false, isScheduledTask: true, isSystemTask: false, ...ADA },
  };
  // what the model passes and what a file the student's agent can write says: both name Bob
  const asBob = { canvas_user_id: BOB.canvasUserId, github_username: BOB.githubUsername, student_folder: 'bob' };
  const competencyOfBob = { name: 'Bob Barker', ...BOB };

  /** The call start_mock_interview makes, from the environment the container's nanoclaw server has. */
  const identityOf = (input: ContainerInput, args: Partial<typeof asBob>, competency: typeof competencyOfBob | null) => {
    const env = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, {}).nanoclaw.env;
    return resolveBriefIdentity({
      isMain: env['NANOCLAW_IS_MAIN'] === '1',
      groupFolder: input.groupFolder,
      studentFolder: args.student_folder,
      bound: { canvasUserId: env['NANOCLAW_CANVAS_USER_ID'] ?? '', githubUsername: env['NANOCLAW_GITHUB_USERNAME'] ?? '' },
      args: { canvasUserId: args.canvas_user_id, githubUsername: args.github_username },
      readCompetency: () => competency,
    });
  };

  it.each(Object.keys(CONTEXTS))('%s: the host\'s binding, whatever the model passes and whatever COMPETENCY.md says', (name) => {
    const who = identityOf(CONTEXTS[name], asBob, competencyOfBob);
    expect(who).toMatchObject({ ok: true, folder: 'ada', identity: { canvasUserId: ADA.canvasUserId, githubUsername: ADA.githubUsername } });
  });

  it.each(Object.keys(CONTEXTS))('%s that is not linked: nobody, not whoever the model or the files name', (name) => {
    const unlinked = { ...CONTEXTS[name], canvasUserId: undefined, githubUsername: undefined };
    const who = identityOf(unlinked, asBob, competencyOfBob);
    expect(who).toMatchObject({ ok: true, folder: 'ada', identity: { canvasUserId: '', githubUsername: '' } });
  });

  it('the admin chat names the student: the folder, the ids it passes, and else what that folder\'s COMPETENCY.md says', () => {
    const admin: ContainerInput = { prompt: 'x', groupFolder: 'main', chatJid: 'web:main', isMain: true };
    expect(identityOf(admin, { student_folder: 'bob', canvas_user_id: '2002' }, competencyOfBob)).toMatchObject({ ok: true, folder: 'bob', identity: { canvasUserId: '2002', githubUsername: 'bob-gh' } });
    expect(identityOf(admin, { student_folder: 'bob' }, competencyOfBob)).toMatchObject({ ok: true, folder: 'bob', identity: { canvasUserId: '1002', githubUsername: 'bob-gh', studentName: 'Bob Barker' } });
    expect(identityOf(admin, { student_folder: 'bob' }, null)).toMatchObject({ ok: true, folder: 'bob', identity: { canvasUserId: '', githubUsername: '' } });
  });

  it('the admin chat\'s own binding is the admin\'s, never another student\'s', () => {
    const admin: ContainerInput = { prompt: 'x', groupFolder: 'main', chatJid: 'web:main', isMain: true, canvasUserId: '9', githubUsername: 'admin-gh' };
    expect(identityOf(admin, { student_folder: 'bob' }, competencyOfBob)).toMatchObject({ identity: { canvasUserId: '1002', githubUsername: 'bob-gh' } });
    expect(identityOf(admin, {}, null)).toMatchObject({ folder: 'main', identity: { canvasUserId: '9', githubUsername: 'admin-gh' } });
  });

  it('refuses a folder name that is a path, so a student folder can never lead out of the groups', () => {
    const admin: ContainerInput = { prompt: 'x', groupFolder: 'main', chatJid: 'web:main', isMain: true };
    for (const folder of ['../etc', '..', 'a/b', '/workspace/group', 'x\\y']) {
      expect(identityOf(admin, { student_folder: folder }, null), folder).toMatchObject({ ok: false });
    }
  });

  it('a student container ignores a folder name altogether: it is its own', () => {
    expect(identityOf(CONTEXTS['student task'], { student_folder: '../etc' }, null)).toMatchObject({ ok: true, folder: 'ada' });
  });
});
