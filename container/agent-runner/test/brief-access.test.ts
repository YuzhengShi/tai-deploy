import { describe, expect, it, vi } from 'vitest';

import {
  CANVAS_NOT_LINKED,
  PIAZZA_NOT_IDENTIFIED,
  competencyIdentity,
  resolveBriefIdentity,
  scopeCanvasParams,
  scopePiazzaParams,
  withWindowDefaults,
  type IdentityInputs,
} from '../src/brief-access.js';
import type { RunPy } from '../src/weekly-brief.js';

// Rule 1 of the contract (docs/WEEKLY_BRIEF.md): in a student's container the student is who the host bound it to, whatever the model passes. Every
// test here is that rule from one side. The people are synthetic (Ada is the student; Bob is the classmate whose data must never come out).

const NOW = new Date('2026-11-04T20:00:00.000Z');

describe('competencyIdentity', () => {
  it('reads the lines start_mock_interview has always read', () => {
    const text = '# Competency\n- **Student name**: Ada Lovelace\nCanvas User ID: 7\nGitHub: ada-l\nother lines\n';
    expect(competencyIdentity(text)).toEqual({ name: 'Ada Lovelace', canvasUserId: '7', githubUsername: 'ada-l' });
    expect(competencyIdentity('Name: Bob Keller')).toEqual({ name: 'Bob Keller' });
    expect(competencyIdentity('nothing here')).toEqual({});
  });
});

describe('whose brief it is', () => {
  const base = (over: Partial<IdentityInputs> = {}): IdentityInputs => ({
    isMain: false,
    groupFolder: 'ada',
    bound: { canvasUserId: '7', githubUsername: 'ada-l' },
    args: {},
    readCompetency: () => null,
    ...over,
  });
  const forBob = { name: 'Bob Keller', canvasUserId: '8', githubUsername: 'bob-k' };

  it('is, in a student\'s container, the host\'s binding and nothing else', () => {
    const readCompetency = vi.fn(() => forBob);
    const r = resolveBriefIdentity(base({ readCompetency, studentFolder: 'bob', args: { canvasUserId: '8', githubUsername: 'bob-k' } }));
    expect(r).toEqual({ ok: true, folder: 'ada', identity: { canvasUserId: '7', githubUsername: 'ada-l', studentName: '' } });
    expect(readCompetency).not.toHaveBeenCalled();                     // a student's own COMPETENCY.md is no identity: the student's agent can write it
  });

  it('has no name and no address for Piazza in a student\'s container: they come from Canvas\'s record of the bound id', () => {
    const r = resolveBriefIdentity(base());
    expect(r.ok && r.identity.studentName).toBe('');
    expect(r.ok && 'email' in r.identity).toBe(false);
  });

  it('is nobody for a student who is not linked, rather than whoever the model or the files name', () => {
    const r = resolveBriefIdentity(base({ bound: { canvasUserId: '', githubUsername: '' }, args: { canvasUserId: '8', githubUsername: 'bob-k' }, readCompetency: () => forBob }));
    expect(r).toMatchObject({ ok: true, identity: { canvasUserId: '', githubUsername: '' } });
  });

  it('refuses to put into a path or a query what is no id and no login, even from the binding', () => {
    const r = resolveBriefIdentity(base({ bound: { canvasUserId: '7/../8', githubUsername: '../etc' } }));
    expect(r).toMatchObject({ ok: true, identity: { canvasUserId: '', githubUsername: '' } });
  });

  it('is the admin\'s explicit values first, then the admin chat\'s own binding, then its folder, in the admin\'s own folder', () => {
    const own = (over: Partial<IdentityInputs>) => resolveBriefIdentity(base({ isMain: true, groupFolder: 'main', readCompetency: () => ({ name: 'Owner', canvasUserId: '9', githubUsername: 'owner-9' }), ...over }));
    expect(own({})).toMatchObject({ identity: { canvasUserId: '7', githubUsername: 'ada-l', studentName: 'Owner' } });
    expect(own({ args: { canvasUserId: '5', githubUsername: 'x-5' } })).toMatchObject({ identity: { canvasUserId: '5', githubUsername: 'x-5' } });
    expect(own({ bound: { canvasUserId: '', githubUsername: '' } })).toMatchObject({ identity: { canvasUserId: '9', githubUsername: 'owner-9' } });
    expect(own({ args: { canvasUserId: 'abc' } })).toMatchObject({ identity: { canvasUserId: '7' } });      // an explicit value that is no id is passed over, not used
  });

  it('is, for another student\'s folder, what THAT folder says, never the admin chat\'s own binding', () => {
    const readCompetency = vi.fn((folder: string) => (folder === 'bob' ? forBob : null));
    const r = resolveBriefIdentity(base({ isMain: true, groupFolder: 'main', studentFolder: 'bob', readCompetency }));
    expect(r).toEqual({ ok: true, folder: 'bob', identity: { canvasUserId: '8', githubUsername: 'bob-k', studentName: 'Bob Keller' } });
    expect(readCompetency).toHaveBeenCalledWith('bob');
    const none = resolveBriefIdentity(base({ isMain: true, groupFolder: 'main', studentFolder: 'carol', readCompetency }));
    expect(none).toMatchObject({ ok: true, identity: { canvasUserId: '', githubUsername: '' } });         // not the admin's own 7 and ada-l
  });

  it('lets the admin name an account explicitly for another folder', () => {
    const r = resolveBriefIdentity(base({ isMain: true, groupFolder: 'main', studentFolder: 'bob', args: { canvasUserId: '12' }, readCompetency: () => forBob }));
    expect(r).toMatchObject({ identity: { canvasUserId: '12', githubUsername: 'bob-k' } });
  });

  it('refuses a folder name that is a path', () => {
    for (const bad of ['../bob', 'a/b', '.', '..', 'bob bob', 'x'.repeat(80)]) {
      expect(resolveBriefIdentity(base({ isMain: true, groupFolder: 'main', studentFolder: bad })), bad).toMatchObject({ ok: false });
    }
  });
});

describe('canvas_query: week_status and user_contact are about the bound student', () => {
  const student = { isMain: false, boundCanvasUserId: '7' };

  it('replaces a user_id the model passed with the bound one, for both actions', () => {
    for (const action of ['week_status', 'user_contact']) {
      expect(scopeCanvasParams(action, { user_id: '8' }, student), action).toEqual({ ok: true, params: expect.objectContaining({ user_id: '7' }) });
      const r = scopeCanvasParams(action, { user_id: '8', userId: '8', uid: '8', USER_ID: '8', 'user_id ': '8' }, student);
      expect(r.ok && r.params).toEqual({ user_id: '7' });                // whatever else was passed is gone: only what the helper reads, set by us
    }
  });

  it('drops the test-only parameters and keeps only a numeric assignment_id of week_status', () => {
    const r = scopeCanvasParams('week_status', { user_id: '8', now: '2020-01-01T00:00:00Z', budget_seconds: '999', assignment_id: '202', extra: 'x' }, student);
    expect(r).toEqual({ ok: true, params: { user_id: '7', assignment_id: '202' } });
    expect(scopeCanvasParams('week_status', { assignment_id: '../x' }, student)).toEqual({ ok: true, params: { user_id: '7' } });
    expect(scopeCanvasParams('user_contact', { assignment_id: '202' }, student)).toEqual({ ok: true, params: { user_id: '7' } });
  });

  it('refuses a student who is not linked instead of passing what the model named', () => {
    for (const bound of ['', 'abc', '7/../8']) {
      const r = scopeCanvasParams('user_contact', { user_id: '8' }, { isMain: false, boundCanvasUserId: bound });
      expect(r, bound).toEqual({ ok: false, message: CANVAS_NOT_LINKED });
    }
  });

  it('is the student\'s own e-mail address the model gets from user_contact: never a classmate\'s', () => {
    const r = scopeCanvasParams('user_contact', { user_id: '8' }, student);
    expect(r.ok && r.params?.user_id).toBe('7');
  });

  it('passes the admin chat and every other action through as they are', () => {
    const params = { user_id: '8', now: '2020-01-01T00:00:00Z' };
    const admin = scopeCanvasParams('week_status', params, { isMain: true, boundCanvasUserId: '7' });
    expect(admin.ok && admin.params).toBe(params);                     // the same object: nothing touched
    const other = { assignment_id: '202' };
    const r = scopeCanvasParams('assignment_detail', other, student);
    expect(r.ok && r.params).toBe(other);
    expect(scopeCanvasParams('assignments', undefined, student)).toEqual({ ok: true, params: undefined });
  });
});

describe('piazza_query: student_activity is about the bound student\'s own account', () => {
  const contact = { name: 'Ada Lovelace', email: 'ada@example.com', login_id: 'lovelace.a' };
  const ctx = (answer: unknown, over: Record<string, unknown> = {}) => {
    const runPy = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }) as unknown as RunPy & ReturnType<typeof vi.fn>;
    return { isMain: false, boundCanvasUserId: '7', now: NOW, runPy, ...over };
  };

  it('searches by what Canvas says of the bound id and drops every identity the model passed', async () => {
    const c = ctx(contact);
    const r = await scopePiazzaParams('student_activity', { email: 'bob@example.com', emails: 'bob2@example.com,bob3@example.com', name: 'Bob Keller', uid: 'uBob', user_id: '8' }, c);
    expect(r).toEqual({
      ok: true,
      params: { since: '2026-10-28T20:00:00.000Z', until: '2026-11-04T20:00:00.000Z', email: 'ada@example.com', name: 'Ada Lovelace' },      // the login 'lovelace.a' is no address
    });
    expect(c.runPy).toHaveBeenCalledTimes(1);
    expect((c.runPy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0].slice(0, 2)).toEqual(['canvas_api.py', { action: 'user_contact', params: { user_id: '7' } }]);
    expect(JSON.stringify(r)).not.toMatch(/bob|uBob|"8"/i);
  });

  it('gives a second address when the login is one, as a list in a string, and name alone when there is no address', async () => {
    const two = await scopePiazzaParams('student_activity', undefined, ctx({ name: 'Ada Lovelace', email: 'ada@example.com', login_id: 'Ada.L@example.org' }));
    expect(two).toMatchObject({ ok: true, params: { email: 'ada@example.com', emails: 'Ada.L@example.org', name: 'Ada Lovelace' } });
    const nameOnly = await scopePiazzaParams('student_activity', { email: 'bob@example.com' }, ctx({ name: 'Ada Lovelace', email: null, login_id: null }));
    expect(nameOnly.ok && nameOnly.params).toEqual({ since: '2026-10-28T20:00:00.000Z', until: '2026-11-04T20:00:00.000Z', name: 'Ada Lovelace' });
    const addressOnly = await scopePiazzaParams('student_activity', { name: 'Bob Keller' }, ctx({ name: null, email: 'ada@example.com' }));
    expect(addressOnly.ok && addressOnly.params).toEqual({ since: '2026-10-28T20:00:00.000Z', until: '2026-11-04T20:00:00.000Z', email: 'ada@example.com' });
  });

  it('keeps the window and the limit the student asked for and defaults the window to the last seven days', async () => {
    const r = await scopePiazzaParams('student_activity', { since: '2026-10-01T00:00:00Z', limit: '3' }, ctx(contact));
    expect(r.ok && r.params).toMatchObject({ since: '2026-10-01T00:00:00Z', until: '2026-11-04T20:00:00.000Z', limit: '3' });
  });

  it('refuses a student who is not linked without asking Canvas about anybody', async () => {
    const c = ctx(contact, { boundCanvasUserId: '' });
    expect(await scopePiazzaParams('student_activity', { email: 'bob@example.com' }, c)).toEqual({ ok: false, message: CANVAS_NOT_LINKED });
    expect(c.runPy).not.toHaveBeenCalled();
  });

  it('refuses when Canvas gives neither an address nor a name, or fails: the model\'s name is not used instead', async () => {
    for (const answer of [{ name: null, email: null, login_id: 'plain-login' }, { error: 'x' }, new Error('timed out'), null, 'text']) {
      const r = await scopePiazzaParams('student_activity', { email: 'bob@example.com', name: 'Bob Keller' }, ctx(answer));
      expect(r, String(answer)).toEqual({ ok: false, message: PIAZZA_NOT_IDENTIFIED });
    }
  });

  it('lets the admin chat name the person itself, and asks Canvas about nobody', async () => {
    const c = ctx(contact, { isMain: true });
    const r = await scopePiazzaParams('student_activity', { email: 'bob@example.com', name: 'Bob Keller' }, c);
    expect(r).toEqual({ ok: true, params: { email: 'bob@example.com', name: 'Bob Keller', since: '2026-10-28T20:00:00.000Z', until: '2026-11-04T20:00:00.000Z' } });
    expect(c.runPy).not.toHaveBeenCalled();
  });

  it('passes every other action through untouched', async () => {
    const c = ctx(contact);
    const params = { query: 'raft' };
    const r = await scopePiazzaParams('search', params, c);
    expect(r.ok && r.params).toBe(params);
    expect(c.runPy).not.toHaveBeenCalled();
    expect((await scopePiazzaParams('get_post', { post_id: '5' }, c)).ok).toBe(true);
  });
});

describe('withWindowDefaults', () => {
  it('gives the last seven days where no window was given and keeps one that was', () => {
    expect(withWindowDefaults(undefined, NOW)).toEqual({ since: '2026-10-28T20:00:00.000Z', until: '2026-11-04T20:00:00.000Z' });
    expect(withWindowDefaults({ repo: 'hw3', since: 'S' }, NOW)).toEqual({ repo: 'hw3', since: 'S', until: '2026-11-04T20:00:00.000Z' });
    expect(withWindowDefaults({ since: '', until: '' }, NOW)).toEqual({ since: '2026-10-28T20:00:00.000Z', until: '2026-11-04T20:00:00.000Z' });
  });
});
