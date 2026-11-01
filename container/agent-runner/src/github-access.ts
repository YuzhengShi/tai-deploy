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
