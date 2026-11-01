import { describe, expect, it } from 'vitest';

import { checkGithubParams, type GithubPolicy } from '../src/github-access.js';

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
