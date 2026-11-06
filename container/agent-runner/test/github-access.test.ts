import { describe, expect, it } from 'vitest';

import { checkGithubParams, resolveGithubParams, withOwnAccount, type GithubPolicy, type GithubQueryPolicy } from '../src/github-access.js';

const policy: GithubPolicy = { username: 'ann-eval', allowedOrgs: ['cs6650-course'] };
const message = (params: Record<string, string> | undefined, p: GithubPolicy = policy) => {
  const v = checkGithubParams(params, p);
  return v.ok ? null : v.message;
};

describe('github_query access', () => {
  it('lets a student read their own repositories and the course organisation', () => {
    expect(message({ owner: 'ann-eval', repo: 'hw3-ann' })).toBeNull();
    expect(message({ user: 'Ann-Eval' })).toBeNull(); // GitHub names are case-insensitive
    expect(message({ org: 'cs6650-course' })).toBeNull();
    expect(message({ owner: 'cs6650-course', repo: 'handouts', path: 'hw3/README.md', ref: 'main' })).toBeNull();
    expect(message({ owner: 'ann-eval', repo: 'hw3', author: 'bob-eval' })).toBeNull(); // a commit filter, not an account to read
    expect(message({})).toBeNull();
    expect(message(undefined)).toBeNull();
  });

  it('refuses a classmate named in ANY of owner, org, user', () => {
    for (const key of ['owner', 'org', 'user']) {
      expect(message({ [key]: 'bob-eval' })).toMatch(/only access your own/);
    }
    // the bypass found by the guard tests: the first key is the student's own, the one github_api.py reads is the classmate's
    expect(message({ owner: 'ann-eval', user: 'bob-eval' })).toMatch(/only access your own/);
    expect(message({ user: 'bob-eval', owner: 'ann-eval' })).toMatch(/only access your own/);
    expect(message({ owner: 'ann-eval', org: 'cs6650-course', user: 'bob-eval' })).toMatch(/only access your own/);
    expect(message({ Owner: 'ann-eval', USER: 'bob-eval' })).toMatch(/only access your own/);
    expect(message({ owner: 'ann-eval', username: 'bob-eval' })).toMatch(/only access your own/);
  });

  it('asks for the GitHub username while none is linked', () => {
    const unlinked: GithubPolicy = { username: '', allowedOrgs: ['cs6650-course'] };
    expect(message({ owner: 'ann-eval' }, unlinked)).toMatch(/not been linked/);
    expect(message({ org: 'cs6650-course' }, unlinked)).toBeNull();
  });

  it('keeps names from changing the API path', () => {
    for (const repo of ['../../users/bob-eval', 'bob-eval/hw3', '..', '.', 'a/b', 'a b', 'hw3?x=1', '']) {
      if (repo === '') continue; // empty means "not given"
      expect(message({ owner: 'ann-eval', repo })).toMatch(/repo is the repository name only/);
    }
    expect(message({ owner: 'ann-eval/../bob-eval' })).toMatch(/not a valid GitHub account name/);
    expect(message({ owner: 'ann-eval', repo: 'hw3', path: '../../../bob-eval/hw3/main.go' })).toMatch(/may not contain/);
    expect(message({ owner: 'ann-eval', repo: 'hw3', path: 'a/%2e%2e/b' })).toMatch(/may not contain/);
    expect(message({ owner: 'ann-eval', repo: 'hw3', ref: 'main?per_page=100' })).toMatch(/may not contain/);
    expect(message({ owner: 'ann-eval', repo: 'hw3', sha: 'abc#frag' })).toMatch(/may not contain/);
    expect(message({ owner: 'ann-eval', repo: 'hw3', path: 'dir\\..\\x' })).toMatch(/not allowed/);
    expect(message({ owner: 'ann-eval', repo: 'hw3', path: 'a\nb' })).toMatch(/not allowed/);
  });

  it('accepts ordinary paths and names with dots, dashes and underscores', () => {
    expect(message({ owner: 'ann-eval', repo: 'hw3.go_worker-pool', path: 'cmd/server/main.go', ref: 'feature/x-1.2' })).toBeNull();
    expect(message({ owner: 'ann-eval', repo: 'hw3', path: 'a..b/c.go' })).toBeNull(); // ".." inside a name is not a dot segment
  });
});

// github_query in a student's container: a call that names no account is for the student's own, and the access check runs on the result.
describe('github_query defaults to the student\'s own account', () => {
  const student: GithubQueryPolicy = { username: 'ann-eval', allowedOrgs: ['cs6650-course'], fullAccess: false };
  const resolve = (action: string, params: Record<string, string> | undefined, p: GithubQueryPolicy = student) => resolveGithubParams(action, params, p);
  /** The params the call is made with, or the refusal. */
  const outcome = (action: string, params: Record<string, string> | undefined, p: GithubQueryPolicy = student) => {
    const r = resolve(action, params, p);
    return r.ok ? r.params : r.message;
  };

  it('fills in `user` for list_repos when neither org nor user is given', () => {
    expect(outcome('list_repos', undefined)).toEqual({ user: 'ann-eval' });
    expect(outcome('list_repos', {})).toEqual({ user: 'ann-eval' });
    expect(outcome('list_repos', { org: '', user: '' })).toEqual({ org: '', user: 'ann-eval' }); // an empty value is as good as none
  });

  it('leaves list_repos alone when an org or a user is named', () => {
    expect(outcome('list_repos', { org: 'cs6650-course' })).toEqual({ org: 'cs6650-course' }); // no `user` added next to the org
    expect(outcome('list_repos', { user: 'Ann-Eval' })).toEqual({ user: 'Ann-Eval' }); // as typed
    expect(outcome('list_repos', { org: 'cs6650-course', user: '' })).toEqual({ org: 'cs6650-course', user: '' });
  });

  it('fills in `owner` for the other actions when it is absent', () => {
    expect(outcome('repo_tree', { repo: 'hw3' })).toEqual({ repo: 'hw3', owner: 'ann-eval' });
    expect(outcome('commits', undefined)).toEqual({ owner: 'ann-eval' });
    expect(outcome('file_content', { owner: '', repo: 'hw3', path: 'main.go' })).toEqual({ owner: 'ann-eval', repo: 'hw3', path: 'main.go' });
    for (const action of ['commit_detail', 'pull_requests', 'pr_detail', 'pr_reviews', 'check_runs', 'something_else']) {
      expect(outcome(action, { repo: 'hw3' }), action).toEqual({ repo: 'hw3', owner: 'ann-eval' });
    }
  });

  it('does not override an owner that is given, and does not touch the caller\'s object', () => {
    expect(outcome('repo_tree', { owner: 'cs6650-course', repo: 'handouts' })).toEqual({ owner: 'cs6650-course', repo: 'handouts' });
    expect(outcome('repo_tree', { owner: 'Ann-Eval', repo: 'hw3' })).toEqual({ owner: 'Ann-Eval', repo: 'hw3' });
    const given = Object.freeze({ repo: 'hw3' });
    expect(withOwnAccount('commits', given, 'ann-eval')).toEqual({ repo: 'hw3', owner: 'ann-eval' });
    expect(given).toEqual({ repo: 'hw3' });
  });

  it('still refuses anybody else, whatever the spelling and whatever is defaulted', () => {
    for (const [action, params] of [
      ['repo_tree', { owner: 'bob-eval', repo: 'hw3' }],
      ['list_repos', { user: 'bob-eval' }],
      ['list_repos', { org: 'bob-eval' }],
      ['list_repos', { owner: 'bob-eval' }], // list_repos ignores owner, but the check does not
      ['list_repos', { user: 'bob-eval', owner: 'ann-eval' }],
      ['commits', { Owner: 'bob-eval', repo: 'hw3' }], // another spelling: `owner` is defaulted, the check still sees this one
      ['commits', { USER: 'bob-eval', repo: 'hw3' }],
      ['commits', { owner: 'ann-eval', user: 'bob-eval', repo: 'hw3' }],
    ] as const) {
      expect(outcome(action, params), `${action} ${JSON.stringify(params)}`).toMatch(/only access your own/);
    }
  });

  it('keeps the other checks on the final params', () => {
    expect(outcome('file_content', { repo: '../../users/bob-eval', path: 'x' })).toMatch(/repo is the repository name only/);
    expect(outcome('file_content', { repo: 'hw3', path: '../../../x' })).toMatch(/may not contain/);
    expect(outcome('repo_tree', { repo: 'hw3' }, { ...student, username: 'ann/../bob' })).toMatch(/not a valid GitHub account name/); // a bad bound name is refused, not passed on
  });

  it('leaves full access exactly as it is', () => {
    const admin: GithubQueryPolicy = { ...student, fullAccess: true };
    const params = { repo: 'hw3' };
    const r = resolve('repo_tree', params, admin);
    expect(r).toEqual({ ok: true, params: { repo: 'hw3' } });
    expect(r.ok && r.params).toBe(params); // the same object: nothing filled in
    expect(outcome('repo_tree', { owner: 'bob-eval', repo: 'hw3' }, admin)).toEqual({ owner: 'bob-eval', repo: 'hw3' });
    expect(outcome('list_repos', undefined, admin)).toBeUndefined();
  });

  it('leaves a student without a linked account as it was', () => {
    const unlinked: GithubQueryPolicy = { ...student, username: '' };
    expect(outcome('list_repos', undefined, unlinked)).toBeUndefined(); // nothing to default to
    expect(outcome('repo_tree', { repo: 'hw3' }, unlinked)).toEqual({ repo: 'hw3' });
    expect(outcome('repo_tree', { owner: 'ann-eval', repo: 'hw3' }, unlinked)).toMatch(/not been linked/);
    expect(outcome('list_repos', { org: 'cs6650-course' }, unlinked)).toEqual({ org: 'cs6650-course' });
  });
});

describe('github_query activity is the student\'s own account only', () => {
  const student: GithubQueryPolicy = { username: 'ann-eval', allowedOrgs: ['cs6650-course'], fullAccess: false };
  const outcome = (params: Record<string, string> | undefined, p: GithubQueryPolicy = student) => {
    const r = resolveGithubParams('activity', params, p);
    return r.ok ? r.params : r.message;
  };

  it('fills in the student\'s own account, and keeps the window and the other parameters', () => {
    expect(outcome({ since: '2026-10-28T20:00:00Z', until: '2026-11-04T20:00:00Z', repo: 'hw3', detail: '2' })).toEqual({ since: '2026-10-28T20:00:00Z', until: '2026-11-04T20:00:00Z', repo: 'hw3', detail: '2', owner: 'ann-eval' });
    expect(outcome(undefined)).toEqual({ owner: 'ann-eval' });
    expect(outcome({ owner: 'Ann-Eval' })).toEqual({ owner: 'Ann-Eval' });                     // GitHub names are case-insensitive
  });

  it('refuses a classmate, as every other action does', () => {
    expect(outcome({ owner: 'bob-eval' })).toMatch(/only access your own/);
    expect(outcome({ owner: 'ann-eval', user: 'bob-eval' })).toMatch(/only access your own/);
    expect(outcome({ owner: 'ann-eval', org: 'bob-eval' })).toMatch(/only access your own/);
  });

  it('refuses the course organisation, which the other actions let through: its repositories are the whole class\'s code', () => {
    expect(outcome({ owner: 'cs6650-course' })).toMatch(/covers your own GitHub account \(ann-eval\) only/);
    expect(resolveGithubParams('repo_tree', { owner: 'cs6650-course', repo: 'handouts' }, student).ok).toBe(true);     // still allowed for a repository at a time
    expect(resolveGithubParams('commits', { owner: 'cs6650-course', repo: 'handouts' }, student).ok).toBe(true);
  });

  it('refuses a name that is no account name or has a path in it', () => {
    expect(outcome({ owner: '../bob-eval' })).toMatch(/not a valid GitHub account name/);
    expect(outcome({ owner: 'ann-eval', repo: '../../x' })).toMatch(/repo is the repository name only/);
    expect(outcome({ owner: 'ann-eval/x' })).toMatch(/not a valid GitHub account name/);
  });

  it('asks for the username while none is linked, even when no account is named', () => {
    const unlinked: GithubQueryPolicy = { ...student, username: '' };
    expect(outcome(undefined, unlinked)).toMatch(/not been linked/);
    expect(outcome({ owner: 'cs6650-course' }, unlinked)).toMatch(/not been linked/);
    expect(outcome({ owner: 'ann-eval' }, unlinked)).toMatch(/not been linked/);
  });

  it('leaves full access as it is: the admin chat names whoever it wants', () => {
    const admin: GithubQueryPolicy = { ...student, fullAccess: true };
    expect(outcome({ owner: 'bob-eval' }, admin)).toEqual({ owner: 'bob-eval' });
    expect(outcome({ owner: 'cs6650-course' }, admin)).toEqual({ owner: 'cs6650-course' });
  });
});
