"""GitHub API helper — reads JSON request from stdin, returns JSON to stdout."""
import json
import re
import sys
import os
import base64
import time
from datetime import datetime, timedelta

try:
    import requests
except ImportError:
    print(json.dumps({"error": "requests library not installed"}))
    sys.exit(1)

# Khoury GHE (default)
TOKEN = os.environ.get('GITHUB_TOKEN', '')
BASE_URL = os.environ.get('GITHUB_BASE_URL', 'https://github.khoury.northeastern.edu/api/v3')
# Public github.com (used when host="github.com" in request params)
TOKEN_PUBLIC = os.environ.get('GITHUB_TOKEN_PUBLIC', '')
BASE_URL_PUBLIC = os.environ.get('GITHUB_BASE_URL_PUBLIC', 'https://api.github.com')
MAX_PAGES = 3
TIMEOUT = 15


def api_get(endpoint, params=None, max_pages=None):
    """GET with pagination (at most `max_pages` pages, MAX_PAGES when not given), returns combined list or single object."""
    url = f"{BASE_URL}{endpoint}"
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    all_results = []
    pages = 0

    while url and pages < (max_pages or MAX_PAGES):
        resp = requests.get(url, headers=headers, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list):
            all_results.extend(data)
        else:
            return data  # Single object
        url = None
        params = None
        link = resp.headers.get('Link', '')
        for part in link.split(','):
            if 'rel="next"' in part:
                url = part.split('<')[1].split('>')[0]
        pages += 1

    return all_results


# ── The weekly interview brief: commits in a window, and `activity` (docs/WEEKLY_BRIEF.md) ───────────────────────────────────────────────────
#
# `activity` answers "what did this account commit in the window" in at most 1 + 4 + 4 requests: the account's repositories (one page, pushed most
# recently first), the commits of each of the first few that were pushed to in the window, and the files of the newest few commits overall. It stops
# itself after ACTIVITY_BUDGET_SECONDS (its caller kills it at 15) and answers with what it has, and a repository that cannot be read (an empty one
# answers 409) is left out and counted, never fails the whole answer.

ACTIVITY_BUDGET_SECONDS = 11.0
ACTIVITY_REQUEST_TIMEOUT = 6
NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')                           # a login or repository name: nothing that could change the API path built from it
FULL_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}$')
_ISO = re.compile(r'^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$')
_CONTROL = re.compile('[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ufeff]')


def parse_iso(value):
    """An ISO date-time as a naive UTC datetime, or None. Written by hand: datetime.fromisoformat reads a trailing 'Z' only from Python 3.11 on."""
    found = _ISO.match(str(value or '').strip())
    if not found:
        return None
    try:
        moment = datetime(int(found.group(1)), int(found.group(2)), int(found.group(3)), int(found.group(4)), int(found.group(5)), int(found.group(6) or 0))
    except ValueError:
        return None
    zone = found.group(7)
    if zone and zone != 'Z':
        digits = zone[1:].replace(':', '')
        moment -= (1 if zone[0] == '+' else -1) * timedelta(hours=int(digits[:2]), minutes=int(digits[2:]))
    return moment


def iso_z(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def clamp_int(value, default, low, high):
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def one_line(text, limit):
    """A commit message as one line (the lines joined by ' | '), no control character, at most `limit` characters."""
    lines = [re.sub(r'\s+', ' ', _CONTROL.sub('', line)).strip() for line in str(text or '').splitlines()]
    joined = ' | '.join(line for line in lines if line)
    return joined if len(joined) <= limit else joined[:max(limit - 1, 0)].rstrip() + '…'


class Budget:
    def __init__(self, seconds, clock=time.monotonic):
        self.clock = clock
        self.end = clock() + seconds

    def expired(self):
        return self.end - self.clock() <= 0


def commit_files(full_name, sha):
    """[{name, status, additions, deletions, patch}] of the first eight files of one commit (the patch cut at 300 characters), and how many files it has."""
    data = api_get(f"/repos/{full_name}/commits/{sha}")
    files = data.get("files") or [] if isinstance(data, dict) else []
    return [{"name": _CONTROL.sub('', str(f.get("filename") or '')), "status": str(f.get("status") or ''), "additions": f.get("additions") or 0,
             "deletions": f.get("deletions") or 0, "patch": _CONTROL.sub('', (f.get("patch") or '')[:300])} for f in files[:8]], len(files)


def activity(params):
    """The commits of one account in a window: {since, until, total, repos: [{name, full_name, url, updated_at, own, count, commits: [{sha, date, message, files}]}], note?}.
    Repositories the account owns give all their commits in the window; one it does not own (an organisation's, say) only the commits the account
    authored. `files` (and `files_total`) are there for the newest `detail` commits of all, an empty list for the others."""
    global TIMEOUT
    owner = str(params.get("owner") or "")
    if not NAME.match(owner):
        return {"error": "owner must be a GitHub login"}
    since, until = parse_iso(params.get("since")), parse_iso(params.get("until"))
    if since is None or until is None:
        return {"error": "since and until must be ISO date-times like 2026-11-02T17:00:00Z"}
    if since > until:
        return {"error": "since is after until"}
    repo = str(params.get("repo") or "")
    if repo and not NAME.match(repo):
        return {"error": "repo is the repository name only (no owner, no slash)"}
    max_repos = clamp_int(params.get("max_repos"), 4, 1, 8)
    max_commits = clamp_int(params.get("max_commits"), 15, 1, 50)
    detail = clamp_int(params.get("detail"), 4, 0, 8)
    try:
        seconds = float(params.get("budget_seconds") or ACTIVITY_BUDGET_SECONDS)       # only the tests ask for another
    except (TypeError, ValueError):
        seconds = ACTIVITY_BUDGET_SECONDS
    budget = Budget(max(0.2, min(seconds, ACTIVITY_BUDGET_SECONDS)))
    TIMEOUT = min(TIMEOUT, ACTIVITY_REQUEST_TIMEOUT)

    if repo:
        info = api_get(f"/repos/{owner}/{repo}")
        repos = [info] if isinstance(info, dict) else []
    else:
        listed = api_get(f"/users/{owner}/repos", {"type": "all", "sort": "pushed", "direction": "desc", "per_page": 100}, max_pages=1)
        repos = [r for r in listed if isinstance(r, dict)] if isinstance(listed, list) else []
    pushed = [(parse_iso(r.get("pushed_at")), r) for r in repos]
    pushed = [(when, r) for when, r in pushed if repo or (when is not None and when >= since)]      # a repository the caller named is always read
    pushed.sort(key=lambda pair: pair[0] or datetime.min, reverse=True)

    out, rows, problems = [], [], []
    for _, r in pushed[:max_repos * 3]:                              # a repository with nothing in the window (an empty one, say) does not use one of the places
        if len(out) >= max_repos:
            break
        if budget.expired():
            problems.append("the time ran out before every repository was read")
            break
        full = str(r.get("full_name") or "")
        if not FULL_NAME.match(full):
            continue
        own = str((r.get("owner") or {}).get("login") or "").lower() == owner.lower()
        query = {"per_page": max_commits + 1, "since": iso_z(since), "until": iso_z(until)}
        if not own:
            query["author"] = owner
        try:
            data = api_get(f"/repos/{full}/commits", query, max_pages=1)
        except requests.exceptions.HTTPError as e:
            if e.response.status_code != 409:                        # 409 is an empty repository (made this week, nothing pushed): no commits, and nothing to report
                problems.append("a repository could not be read")
            continue
        except Exception:
            problems.append("a repository could not be read")
            continue
        commits = []
        for c in (data if isinstance(data, list) else [])[:max_commits + 1]:
            info = c.get("commit") or {}
            who = info.get("committer") or info.get("author") or {}
            commits.append({"sha": str(c.get("sha") or ""), "date": str(who.get("date") or ""), "message": one_line(info.get("message"), 200), "files": []})
        if not commits:
            continue
        more = len(commits) > max_commits
        commits = commits[:max_commits]
        entry = {"name": str(r.get("name") or full.split('/')[-1]), "full_name": full, "url": r.get("html_url"), "updated_at": r.get("updated_at"), "own": own,
                 "count": len(commits), "commits": commits}
        if more:
            entry["more"] = True                                       # the repository has more commits in the window than are listed
            problems.append("a repository has more commits in the window than are listed")
        out.append(entry)
        rows.extend((c["date"], full, c) for c in commits)

    rows.sort(key=lambda row: parse_iso(row[0]) or datetime.min, reverse=True)
    for _, full, c in rows[:detail]:
        if budget.expired():
            problems.append("the time ran out before the files of every recent commit were read")
            break
        try:
            c["files"], c["files_total"] = commit_files(full, c["sha"])
        except Exception:
            problems.append("the files of a commit could not be read")
    for entry in out:
        for c in entry["commits"]:
            c["sha"] = c["sha"][:8]
    answer = {"since": iso_z(since), "until": iso_z(until), "total": sum(e["count"] for e in out), "repos": out}
    if problems:
        answer["note"] = "; ".join(dict.fromkeys(problems))
    return answer


def handle(req):
    global BASE_URL, TOKEN
    action = req.get("action", "")
    params = req.get("params", {})

    # Per-request host override: pass "host": "github.com" to use public GitHub
    host = params.pop("host", "")
    if host == "github.com":
        BASE_URL = BASE_URL_PUBLIC
        TOKEN = TOKEN_PUBLIC
    else:
        BASE_URL = os.environ.get('GITHUB_BASE_URL', 'https://github.khoury.northeastern.edu/api/v3')
        TOKEN = os.environ.get('GITHUB_TOKEN', '')

    if not TOKEN:
        return {"error": f"No token for {'github.com' if host == 'github.com' else 'GHE'}. Set {'GITHUB_TOKEN_PUBLIC' if host == 'github.com' else 'GITHUB_TOKEN'} in .env"}

    if action == "list_repos":
        org = params.get("org")
        user = params.get("user")
        if org:
            data = api_get(f"/orgs/{org}/repos", {"per_page": 30, "sort": "updated"})
        elif user:
            data = api_get(f"/users/{user}/repos", {"per_page": 30, "sort": "updated"})
        else:
            return {"error": "org or user required"}
        return [{"name": r["name"], "full_name": r["full_name"], "private": r["private"], "updated_at": r.get("updated_at"), "html_url": r["html_url"]} for r in data]

    elif action == "repo_tree":
        owner = params.get("owner", "")
        repo = params.get("repo", "")
        path = params.get("path", "")
        ref = params.get("ref")
        recursive = params.get("recursive", False)
        if not owner or not repo:
            return {"error": "owner and repo required"}
        if recursive:
            # Use Git Trees API for full recursive listing
            tree_ref = ref
            if not tree_ref:
                repo_info = api_get(f"/repos/{owner}/{repo}")
                tree_ref = repo_info.get("default_branch", "main") if isinstance(repo_info, dict) else "main"
            data = api_get(f"/repos/{owner}/{repo}/git/trees/{tree_ref}", {"recursive": "1"})
            if isinstance(data, dict) and "tree" in data:
                return [{"name": f["path"].split("/")[-1], "path": f["path"], "type": "file" if f["type"] == "blob" else "dir", "size": f.get("size", 0)} for f in data["tree"]]
            return data
        ep = f"/repos/{owner}/{repo}/contents/{path}"
        qp = {"ref": ref} if ref else None
        data = api_get(ep, qp)
        if isinstance(data, list):
            return [{"name": f["name"], "type": f["type"], "size": f.get("size")} for f in data]
        return data

    elif action == "commits":
        owner = params.get("owner", "")
        repo = params.get("repo", "")
        if not owner or not repo:
            return {"error": "owner and repo required"}
        limit = clamp_int(params.get("limit", 20), 20, 1, 100)          # one page: GitHub's own page size is the limit, so the limit is the answer's length
        qp = {"per_page": limit}
        if params.get("author"):
            qp["author"] = params["author"]
        if params.get("path"):
            qp["path"] = params["path"]
        if params.get("sha"):
            qp["sha"] = params["sha"]
        for key in ("since", "until"):                                  # ISO date-times: only the commits after / before them
            if params.get(key):
                moment = parse_iso(params[key])
                if moment is None:
                    return {"error": f"{key} must be an ISO date-time like 2026-11-02T17:00:00Z"}
                qp[key] = iso_z(moment)
        data = api_get(f"/repos/{owner}/{repo}/commits", qp, max_pages=1)
        return [{"sha": c["sha"][:8], "message": (c["commit"]["message"])[:200], "author": c["commit"]["author"]["name"], "date": c["commit"]["author"]["date"], "url": c["html_url"]} for c in data[:limit]]

    elif action == "activity":
        return activity(params)

    elif action == "commit_detail":
        owner = params.get("owner", "")
        repo = params.get("repo", "")
        sha = params.get("sha", "")
        if not owner or not repo or not sha:
            return {"error": "owner, repo, and sha required"}
        data = api_get(f"/repos/{owner}/{repo}/commits/{sha}")
        files = data.get("files", [])
        return {
            "sha": data["sha"],
            "message": data["commit"]["message"],
            "author": data["commit"]["author"]["name"],
            "date": data["commit"]["author"]["date"],
            "stats": data.get("stats"),
            "files": [{"filename": f["filename"], "status": f["status"], "additions": f["additions"], "deletions": f["deletions"], "patch": (f.get("patch") or "")[:500]} for f in files[:15]],
        }

    elif action == "pull_requests":
        owner = params.get("owner", "")
        repo = params.get("repo", "")
        if not owner or not repo:
            return {"error": "owner and repo required"}
        state = params.get("state", "open")
        data = api_get(f"/repos/{owner}/{repo}/pulls", {"state": state, "per_page": 20})
        return [{"number": pr["number"], "title": pr["title"], "state": pr["state"], "user": pr["user"]["login"], "created_at": pr["created_at"], "updated_at": pr["updated_at"], "html_url": pr["html_url"]} for pr in data]

    elif action == "pr_detail":
        owner = params.get("owner", "")
        repo = params.get("repo", "")
        number = params.get("number", "")
        if not owner or not repo or not number:
            return {"error": "owner, repo, and number required"}
        data = api_get(f"/repos/{owner}/{repo}/pulls/{number}")
        return {
            "number": data["number"],
            "title": data["title"],
            "state": data["state"],
            "body": (data.get("body") or "")[:1000],
            "user": data["user"]["login"],
            "created_at": data["created_at"],
            "merged_at": data.get("merged_at"),
            "additions": data.get("additions"),
            "deletions": data.get("deletions"),
            "changed_files": data.get("changed_files"),
            "html_url": data["html_url"],
        }

    elif action == "pr_reviews":
        owner = params.get("owner", "")
        repo = params.get("repo", "")
        number = params.get("number", "")
        if not owner or not repo or not number:
            return {"error": "owner, repo, and number required"}
        data = api_get(f"/repos/{owner}/{repo}/pulls/{number}/comments", {"per_page": 50})
        return [{"user": c["user"]["login"], "body": c["body"][:500], "path": c.get("path"), "created_at": c["created_at"]} for c in data]

    elif action == "check_runs":
        owner = params.get("owner", "")
        repo = params.get("repo", "")
        ref = params.get("ref", "main")
        if not owner or not repo:
            return {"error": "owner and repo required"}
        data = api_get(f"/repos/{owner}/{repo}/commits/{ref}/check-runs")
        runs = data.get("check_runs", []) if isinstance(data, dict) else []
        return [{"name": r["name"], "status": r["status"], "conclusion": r.get("conclusion"), "started_at": r.get("started_at"), "completed_at": r.get("completed_at")} for r in runs]

    elif action == "file_content":
        owner = params.get("owner", "")
        repo = params.get("repo", "")
        path = params.get("path", "")
        ref = params.get("ref")
        if not owner or not repo or not path:
            return {"error": "owner, repo, and path required"}
        qp = {"ref": ref} if ref else None
        data = api_get(f"/repos/{owner}/{repo}/contents/{path}", qp)
        if isinstance(data, dict) and data.get("encoding") == "base64" and data.get("content"):
            try:
                decoded = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
                return {"path": data["path"], "size": data["size"], "content": decoded[:6000]}
            except Exception:
                return {"path": data["path"], "size": data["size"], "content": "(binary file)"}
        return data

    else:
        return {"error": f"Unknown action: {action}", "available": ["list_repos", "repo_tree", "commits", "commit_detail", "pull_requests", "pr_detail", "pr_reviews", "check_runs", "file_content", "activity"]}


def main():
    # A function, so that the tests can import this file and call handle() against a fake HTTP layer; run as a script it does what it always did
    try:
        raw = sys.stdin.read().strip()
        if not raw:
            print(json.dumps({"error": "No input provided"}))
            sys.exit(1)
        req = json.loads(raw)
        result = handle(req)
        print(json.dumps(result, indent=2, default=str))
    except requests.exceptions.HTTPError as e:
        print(json.dumps({"error": f"GitHub API error: {e.response.status_code} {e.response.text[:500]}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)


if __name__ == '__main__':
    main()
