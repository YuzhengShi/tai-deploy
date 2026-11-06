/**
 * Access rule of the github_query tool in a student's container: their own repositories and the course organisations, nothing else.
 * Kept apart from ipc-mcp-stdio.ts (which starts a server when imported) so it can be unit tested.
 *
 * Upstream checked only the first of `owner`, `org` and `user`, but github_api.py's list_repos reads `org` and then `user`:
 * {owner: <self>, user: <classmate>} passed the check and listed the classmate's repositories. Every one of them is checked here.
 */

export interface GithubPolicy {
  /** The GitHub username bound to this student by the host ('' until linked). */
  username: string;
  /** Organisations every student may read (GITHUB_ALLOWED_ORGS). */
  allowedOrgs: string[];
}

export type GithubVerdict = { ok: true } | { ok: false; message: string };

// Parameters that name an account; all of them must be the student's own or a course organisation.
const ACCOUNT_KEYS = new Set(['owner', 'org', 'user', 'username', 'login']);
// A login or repository name: no slash, no dot segment, nothing that could change the API path github_api.py builds from it.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// Parameters that become part of an API path or query.
const PATH_KEYS = new Set(['path', 'ref', 'sha', 'author', 'branch']);

export function checkGithubParams(params: Record<string, string> | undefined, policy: GithubPolicy): GithubVerdict {
  if (!params) return { ok: true };
  const refuse = (message: string): GithubVerdict => ({ ok: false, message });
  const own = policy.username.toLowerCase();
  const orgs = policy.allowedOrgs.map((o) => o.toLowerCase());

  for (const [rawKey, value] of Object.entries(params)) {
    const key = rawKey.toLowerCase();
    if (typeof value !== 'string') return refuse(`GitHub query refused: ${rawKey} must be text.`);
    if (/[\u0000-\u001f\\]/.test(value)) return refuse(`GitHub query refused: ${rawKey} holds a character that is not allowed.`);

    if (ACCOUNT_KEYS.has(key) && value !== '') {
      if (!NAME.test(value)) return refuse(`GitHub query refused: ${rawKey} is not a valid GitHub account name.`);
      const v = value.toLowerCase();
      if (!(own && v === own) && !orgs.includes(v)) {
        if (!own) {
          return refuse('Your GitHub identity has not been linked yet. Please share your GitHub username so I can look up your repositories.');
        }
        return refuse(`You can only access your own repositories (${policy.username}). I cannot browse other students' code.`);
      }
    } else if (key === 'repo' && value !== '') {
      if (!NAME.test(value)) return refuse('GitHub query refused: repo is the repository name only (no owner, no slash).');
    } else if (PATH_KEYS.has(key) && value !== '') {
      if (/(^|\/)\.\.(\/|$)|[?#%]/.test(value)) return refuse(`GitHub query refused: ${rawKey} may not contain "..", "?", "#" or "%".`);
    }
  }
  return { ok: true };
}

export interface GithubQueryPolicy extends GithubPolicy {
  /**
   * The admin chat (`isMain`) alone may read any account: nothing is filled in or checked for it. Every other container is held to the student's own account and the
   * course organisations, the host's own tasks (patrol, bootstrap) included: ipc-mcp-stdio.ts passes `isMain` here, never the task's origin.
   */
  fullAccess: boolean;
}

export type GithubQueryResolution = { ok: true; params: Record<string, string> | undefined } | { ok: false; message: string };

// github_api.py reads these exact keys, and an empty value is as good as none (`if org:`, `if not owner`).
const named = (params: Record<string, string> | undefined, key: string): boolean => !!params && typeof params[key] === 'string' && params[key] !== '';

/**
 * The student's own account where the call names none. The model cannot know which account the host has bound to the student, so it
 * used to ask the student for it: `user` is filled in for list_repos when neither `org` nor `user` is given, `owner` for every other
 * action when it is absent. Returns a new object; the caller's is left alone.
 */
export function withOwnAccount(action: string, params: Record<string, string> | undefined, username: string): Record<string, string> | undefined {
  if (!username) return params;
  if (action === 'list_repos') return named(params, 'org') || named(params, 'user') ? params : { ...params, user: username };
  return named(params, 'owner') ? params : { ...params, owner: username };
}

/**
 * What github_api.py is run with for a github_query call, or why the call is refused: the student's own account where none is named,
 * then the access check on the FINAL params, so that naming anybody else (or any key spelled another way) fails exactly as it did before
 * the defaults existed. Full access and a student with no linked account are passed through as they are.
 */
export function resolveGithubParams(action: string, params: Record<string, string> | undefined, policy: GithubQueryPolicy): GithubQueryResolution {
  if (policy.fullAccess) return { ok: true, params };
  const final = withOwnAccount(action, params, policy.username);
  const verdict = checkGithubParams(final, policy);
  if (!verdict.ok) return verdict;
  if (action === 'activity') {
    // `activity` lists every repository of the account it is given, with the commits in them. For a course organisation (which the check above lets
    // through for the other actions, a repository at a time) that is the whole class's code: this action is for the student's own account only.
    const owner = (final?.owner ?? '').toLowerCase();
    if (!policy.username) return { ok: false, message: 'Your GitHub identity has not been linked yet. Please share your GitHub username so I can look up your repositories.' };
    if (owner !== policy.username.toLowerCase()) return { ok: false, message: `The activity action covers your own GitHub account (${policy.username}) only.` };
  }
  return { ok: true, params: final };
}
