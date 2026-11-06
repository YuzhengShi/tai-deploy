# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| WhatsApp messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in Docker containers (isolated Linux environments), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ (within limits, below) |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Pause, resume or cancel a task | any | only the tasks that agents made in its own group (never the patrol's or the bootstrap's) |
| Manage other groups | ✓ | ✗ |

#### Scheduled tasks and access (closed 2026-11-05, widened the same day)

**The first flaw.** Every task's container was started as "a scheduled task", and the container's tools treated that as full access (`hasFullAccess = isMain || isScheduledTask`):
`canvas_query` `grades`, `users` and `submissions` (other students' data), `github_query` for any owner, `set_student_identity`, and no per-session tool limits. A student's agent may
schedule a task for its own group, through `schedule_task` or by writing the JSON file itself (the host trusts the directory a file is in and nothing else), **with a prompt the student
chose**. So a student could make TAi run "list every student's grades" with the admin's access at a time they picked; the only barrier was the model's behaviour. Nothing was exposed:
only the owner was on the allowlist.

**The second, found while closing it.** The host's own tasks had the same full access, and they run in the student's own session: the patrol and the bootstrap use `context_mode: group`, so
they resume the group's session and add their turns to it, and the student resumes it in their next chat turn (read from `pi-runner.ts`: `SessionManager.open` on the session file the scheduler names; not observed on the live host). The patrol's prompt told the model to call `canvas_query` `submissions` and
said it "only ever shows this student". It lists every student's row for the assignment (user id, name, score, grade: the first 50), so the class's names and grades could end up in the
conversation the student reads. A sentence in a prompt is not a gate.

**How it is closed.**

| | |
|---|---|
| What a container may read | `isMain` alone (`container/agent-runner/src/access.ts`). The admin chat may ask about the class. **Every other container is bound to its student, the host's own patrol and bootstrap included:** `canvas_query` `grades`, `users` and `submissions` are refused (nothing filters their rows: the class is not asked for at all), `student_submission`, `my_grades`, `week_status` and `user_contact` always use the bound Canvas user, `github_query` reads the bound account and the course organisations (the patrol used to read the account named in `COMPETENCY.md`, which a student's agent can write), and `set_student_identity` is refused. |
| Tool limits | Lifted for the admin chat and for a **system task**: `isScheduledTask` and `isSystemTask` together (the scheduler sends the second only for a task whose stored origin is `system`; `NANOCLAW_IS_SYSTEM_TASK` is `1` only when both are true, and only the text `1` is a yes). A task an agent scheduled is a scheduled task with the student's limits. This is all `isSystemTask` decides about a container now. |
| Origin | `scheduled_tasks.origin` is written when a row is created: `system` by the host's own seeds (the patrol, the grade bootstrap, the course sync) and `container` by `src/ipc.ts` for **every** task an agent schedules, whoever the agent was and whatever the file says (the admin chat's included). Anything that is not exactly `system`, a NULL included, is not system. |
| Old rows | At every start the rows without an origin are classified (`classifyTaskOrigins`, `src/task-origin.ts`): `system` only when the id is a host seed's (`patrol-`, `bootstrap-`, `course-sync-`: an IPC task's id is made by the host, `task-<time>-<random>`, and cannot be chosen) **and** its prompt holds that seed's marker; every other row is `container`. Running at every start also covers rows an older host writes after a rollback. |
| Markers decide nothing alone | A prompt's `[TEACHING_PATROL]` is evidence of nothing: a student's agent can schedule a task that carries it. The teaching-team page, `hasPatrolTask`, `hasBootstrapRun`, `hasSyncTask`, the patrol's gate and `tai_live.sh patrol` took such a task for the host's own (it was counted as a patrol, and its marker kept the real patrol from being seeded). They ask for origin `system` and the seed's id prefix now (`isSystemTaskOfKind`; `team.ts` in SQL; `tai_live.sh` by the id alone, because it may run before the host has added the column). |
| The prompts the host's tasks run | Fixed at the source: the patrol asks for `canvas_query` `week_status` (bound, one call, no downloads) and `github_query` `activity` and says the class-wide actions are refused; the bootstrap no longer asks for the roster or binds an identity (it stops, unlinked). **The scheduler runs the prompt stored in the row**, and the seed skips a group that already has a patrol, so `refreshPatrolPrompts` puts the current prompt into every host-made patrol row at every start; without it the live patrol would run the old text for ever. `groups/global/CLAUDE.md` and `COMPETENCY_PROTOCOL.md` no longer offer the class-wide actions or say that `COURSE_STATUS.md` holds a student's status (it is written by a script, class-wide, with nothing about one student). |
| A student's task | Runs as that student's own chat, with the student's limits. It still delivers its reminder: `send_message` has no gate and no limit, and `src/ipc.ts` lets a group message its own chat. |
| Limits on a student's tasks | `src/ipc.ts` decides, whatever wrote the file (`src/task-limits.ts`): a repeating schedule with a gap under 60 minutes between **any** two runs is refused (a cron schedule is looked at over its next 200 runs within a year: `0,5 * * * *` and "every 5 minutes on Mondays" are caught); at most 10 open tasks (active or paused: a paused one is one resume away) that agents made, per group; at most 20 made in a rolling 24 hours, counted in `task_creations` so that cancelling one does not give the count back; a one-time task at most 60 days ahead; instructions at most 4,000 characters; instructions that **begin** with a system marker refused. The admin chat has none of these. A refusal is a sentence and an audit line (`schedule_task_refused`: the length of the instructions, never the words). |
| The system's tasks are not a student's to stop | `pause_task`, `resume_task` and `cancel_task` from a group that is not the admin chat work only on tasks whose origin is `container` in that group: the patrol, the bootstrap and a task nobody classified are refused (audit: `task_change_refused`), another group's task is "no such task". `list_tasks` marks the system's. No IPC request edits a task. |
| The agent learns the outcome | The four task tools wrote a file and answered "scheduled" or "requested" at once, whatever the host did with it. A request now carries an id of its own, the host writes its answer to `ipc/<group>/results/<id>.json` (through `writeFileAtomicSafe`, which refuses a `results` that is a link leading out; the directory is made when the container starts; an id that is not 8 to 64 plain characters is ignored), and the tool waits up to 10 s and says what the host said. With nothing in time it says it could not confirm. Every exit of the four cases answers, the old silent ones included. The container tool also checks a student's request against the same limits first (`task-limits.ts` is the same text in both packages; `container/agent-runner/test/task-limits.test.ts` fails when the copies differ), before it asks the student to confirm a schedule the host would drop. |
| Identity writes | The host used to apply a `set_student_identity` file from **any** group for its own folder, so a student's agent could skip the tool and bind any Canvas user to itself (no guard covers `/workspace/ipc`). Only the admin chat binds now; a container's request is refused and written to `data/audit/admin-operations.jsonl` (`set_student_identity_refused`), and a request that changes nothing (the bootstrap's call for a student the allowlist bound) is ignored silently. |
| Mock interview: who | The old half of `start_mock_interview` took the student's Canvas id and GitHub login from the model's `canvas_user_id` and `github_username` when the chat was not linked, then from `COMPETENCY.md` (a file a student's agent can write), then from a search of the Canvas roster by the name in that file, and fetched the submission of whoever that gave, with the operator's token, outside `canvas_query`'s rules. It now takes the identity from the resolver the weekly brief uses (`resolveBriefIdentity`, `brief-access.ts`): in a student's container, scheduled tasks included, the host's binding and nothing else; only the admin chat may name a student or a folder. A student who is not linked gets an interview without a submission or code. The roster (`users`) is asked for only in the admin chat. |
| Mock interview: which repository | The interview read GitHub as the **owner a link in the student's own submission named** (`ghOwner = submissionRepoOwner \|\| githubUsername`), so a link to a classmate's repository, or to a private one of the instructor's that the operator's token can see, put that code into the student's own `interview_context.json`. It now reads a linked repository only when its owner is the student's own login (case-insensitive) or, for an organisation or a team, when that login has committed to that very repository (`mayReadLinkedRepo`, `access.ts`: one `commits` lookup with `author=<the login>`, no answer from GitHub reaches the student); otherwise the link is dropped and the interview reads the login's own repositories. With no login known, a link is trusted for nothing. The admin chat is held to the same rule for the student it names (the excerpts land in that student's folder): it used to take the link's owner for the student's login when it had none, and now needs the login named or in that folder's `COMPETENCY.md`. |

| Action | Admin chat | System task (patrol, bootstrap) | Student task | Student chat |
|--------|------------|---------------------------------|--------------|--------------|
| `canvas_query` `grades`, `users`, `submissions` | ✓ | ✗ | ✗ | ✗ |
| `student_submission`, `my_grades`, `week_status`, `user_contact` | as asked | the bound user only | the bound user only | the bound user only |
| `canvas_query`, course content (assignments, files, pages, announcements, discussions ...) | ✓ | ✓ | ✓ | ✓ |
| `github_query` | any account | the bound account and the course organisations | the same | the same |
| `set_student_identity` | ✓ | ✗ | ✗ | ✗ |
| Per-session tool limits (30 Canvas calls and so on) | none | none | yes | yes |
| Pause, resume or cancel the patrol or the bootstrap | ✓ | n/a | ✗ | ✗ |
| Schedule every 5 minutes, 30 tasks, 90 days ahead | ✓ | n/a | ✗ | ✗ |

Tested as this table: every Canvas action against every kind of container (`container/agent-runner/test/access.test.ts`, through `buildMcpServers`, with a check that the table covers every action
`canvas_api.py` answers); `schedule_task`'s origin, the identity refusal, each limit and each refusal, the answers and the protection of the system's tasks
(`src/ipc-task-origin.test.ts`, `src/ipc-task-limits.test.ts`); the migration on a database with the old schema and the real seeds (`src/task-origin-db.test.ts`); the markers
(`src/system-task-checks.test.ts`, `src/teaching-patrol.test.ts`, `src/portal/team-db.test.ts`, `deploy/cs6650/test_tai_live.py`); the limits, over both copies of the module
(`container/agent-runner/test/task-limits.test.ts`); the wait for the host's answer (`container/agent-runner/test/ipc-result.test.ts`); the flag in the scheduler's start of a container
(`src/task-scheduler.test.ts`) and on the container's stdin (`src/container-runner.test.ts`). The interview's two rules are `access-interview.test.ts`; `access-source.test.ts` reads the text
of `ipc-mcp-stdio.ts` (which starts a server when imported) for the lines that decide access, and for the task tools, and fails when one returns to the old shape: a guard on wiring, not a
proof of behaviour.

**Sessions written before this fix may hold class data.** Every patrol that followed its old prompt put a `submissions` listing into the student's session file. The live host has only the
owner's group. To check (read-only), on the host: `grep -rlE 'user_name|sortable_name|grade_matches_current_submission|entered_grade' ~/tai-live/tai/data/sessions --include='*.jsonl'`.
The first two are in the rows of `submissions` and `users` (names), the other two only in the raw objects `grades` returns (no name in them; `canvas_api.py` prints neither key in any answer a bound
action gives). A session it lists holds a class listing (a `discussion_entries` answer matches `user_name` too: read the hit before deciding). Deleting that group's session file, or the `sessions`
row for it in `store/messages.db`, makes the student's next chat start a new session; `COMPETENCY.md` and the competency files carry what matters. **Not run, and read from the code, not seen on the
live host:** that pi's session files are `*.jsonl` (`findSessionFile`), that they are under `data/sessions/<group>/.claude/pi-sessions/` (the `.claude` mount of `container-runner.ts`), and that
the live `DATA_DIR` is `~/tai-live/tai/data`. A run that finds nothing is only as good as those three points.

**Not covered.**
* **The image must be rebuilt, and deployed with the host.** The Canvas, GitHub and identity rules, the interview's rules and the tool's wait are in the image: an old image under the new host keeps
  `grades`, `users` and `submissions` open to the patrol, and its task tools answer "scheduled" at once (the host still enforces the limits and the protection of the system's tasks, and writes
  answers nobody reads). A new image under an old host gets no system flag (the patrol loses its lifted tool limits: fails closed) and never an answer (its task tools wait 10 s and say they could not confirm).
* **The restriction is policy inside the container, not isolation.** A student's agent runs as the same user as the MCP server that holds the Canvas token (the `/proc/<pid>/environ` gap of section 6), and
  the helper scripts are in the image. This closes the scheduled-task routes; it does not make a student chat's own tools a wall.
* **Private Piazza posts: closed (2026-11-06).** The operator's Piazza account is a TA, so Piazza shows it students' PRIVATE questions to the staff (5 of the 200 recent threads on the live forum, with their words;
  the marker is `status: 'private'` on the feed item and on the post, measured). Until now `piazza_query` `recent_posts`, `get_post`, `search`, `get_pinned` and `get_by_tag` returned them to any container, and
  `list_tags` counted their tags. `piazza_query.py` `is_private` now keeps a private post out of every action (`student_activity` included, a student's own private question as well) and `get_post` of one says it is
  private; `container/scripts/test_piazza_private.py` covers each action with a mutation check. Not covered: the lookups still carry no author, and a private post could only be recognised by that field.
* **Other tools that return what the class wrote or class-wide code**, found while checking and not changed: `canvas_query` `discussion_entries` carries the posters' names (the class forum, as every student sees it in Canvas); `github_query` lets every
  container but the admin chat read any repository of a course organisation and list them (`GITHUB_ALLOWED_ORGS`): if students' repositories live in the organisation, that is the class's code.
* **The course sync agent** (`TAI_SEED_COURSE_SYNC=1`, off) asks for a section per student (submissions, grades, GitHub activity) in the `COURSE_STATUS.md` that every student's agent reads. Keep it off; the
  live script writes that file with nothing about one student. Seeding it now says so in the log.
* **The voice call's `schedule_task`: closed (2026-11-06).** It wrote the IPC file itself and told the caller "scheduled" at once, so a task the host then refused was announced as set. It now puts a request id in
  the file and waits up to 6 s for the host's `results/<id>.json` (`src/voice/ipc-answer.ts`): a refusal is spoken as an error, no answer in time is "not sure it was set". The host's limits are the authority as
  before; `src/voice/functions.test.ts` covers each of the four outcomes.
* **Cost at the floors.** A student may keep 10 open tasks, each running once an hour: 240 containers a day from one student, and the owner's model budget with it. The numbers are constants in
  `task-limits.ts` (two copies). A flood of refused requests costs the host a few milliseconds each (a cron schedule is looked at over up to 200 runs) and is not rate limited. The admin chat's tasks for a
  student's group count toward that group's 10 (their origin is `container` too). The container's own check uses the task list as it was when the container started.
* **What a student can still do:** make and cancel their own tasks (within the limits above), and put a system marker in the middle of a prompt: it no longer fools anything and gives no access.
* **The interview's "belongs" check has not been run against real GitHub** (the tests use a spy): it is one `commits?author=<login>` lookup, so a repository the student has committed to
  (a team's, an organisation's, a classmate's they collaborate on) is read, and a commit under an e-mail GitHub does not tie to the login is not found, which leaves that link unread.
  The interview then reads at most four files of the repository, as before.

### 5. Credential Handling

**Mounted Credentials:**
- Claude auth tokens (filtered from `.env`, read-only)

**NOT Mounted:**
- WhatsApp session (`store/auth/`) - host only
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns

**Credential Filtering:**
Only these environment variables are exposed to containers:
```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
```

> **Note:** Anthropic credentials are mounted so that Claude Code can authenticate when the agent runs. However, this means the agent itself can discover these credentials via Bash or file operations. Ideally, Claude Code would authenticate without exposing credentials to the agent's execution environment, but I couldn't figure this out. **PRs welcome** if you have ideas for credential isolation.

**The live deployment's model providers** (`deploy/cs6650`): an agent container and the voice relay know only the gateway and its key; the provider keys are the gateway's. Cerebras'
comes from the world's `.env` at the gateway's creation. **DeepSeek's** (`DEEPSEEK_API_KEY`) is typed hidden by `tai_credentials.sh deepseek` and stored in
`~/tai-live/gateway.env` only (mode 600, unquoted), never in `credentials.env`, never in TAi's `.env` (which a container's secrets are read from) and never on a command line
(`--env-file`). Where students' words go is decided by which model is chosen: the `deepseek` alias sends them to DeepSeek's own API, in another jurisdiction, and **no fallback
chain leads to it**, so it is only ever a deliberate choice (`SETTINGS.md`, "DeepSeek"). **z.ai's** (`ZAI_API_KEY`) is typed hidden by `tai_credentials.sh zai` and kept the same way
(`gateway.env` only); the aliases `glm` and `glm-vision` (GLM-5.3-Flash at z.ai's own endpoint, in another jurisdiction) are in no fallback chain either, and `glm-vision` is what reads a
student's picture when `TAI_VISION=1` (`VISION.md`): that picture goes to z.ai and nowhere else. The key is a GLM Coding Plan key, and z.ai's own terms limit that plan to supported coding
tools; the owner decided on 2026-11-05 that this key may serve students. It rests on that decision, not on anything z.ai said: a pay-per-token key typed with `tai_credentials.sh zai` would replace it with no code change.
A key typed or pasted anywhere but that hidden prompt (a chat, a command line) is to be revoked and replaced.

### 6. Tool Guards (PreToolUse hooks)

`container/agent-runner/src/guards.ts` runs before the agent's tools. They are depth, not a wall: the container has network access by
design and the agent runs as the same user as the process that holds the API credentials. What they do for a non-main group:

| Tool | Guard |
|------|-------|
| Bash | Every credential the host handed over (and any credential-named variable) is unset for the command. No network tools, `eval`, base64-into-shell, `/dev/tcp`; quote-split spellings (`c''url`) are folded first. No mention of `/proc` except the plain system summaries. A shell may only read `COMPETENCY.md`. Files a command writes are capped (`ulimit -f`); a full workspace refuses every command but a deletion or a measurement. |
| Read, Grep | Paths are resolved and symlinks followed before the sensitive-file patterns (`.env*`, the database, every `/proc/<pid>/` entry) apply. |
| WebFetch | http(s) only; the host is resolved and refused when it is loopback, private, link-local (the cloud metadata address), a docker address or an internal name. 15 calls per answer. |
| Write, Edit | 5 MB per write; workspace size; `COMPETENCY.md` may not have three or more concepts newly raised to 0.8 or more in one write (both line formats). |
| github_query (MCP) | owner, org and user must each be the student's own account or a course organisation; repository and path parameters cannot change the API path. |

A blocking hook must return `hookSpecificOutput.permissionDecision: 'deny'`; the shape upstream used (`decision: 'block'`) is ignored by
the SDK, so no guard stopped anything before this fork (see `eval/RESULTS.md`). The guards have unit tests in
`container/agent-runner/test/` and are exercised end to end by `eval/harness/guards.py`.

Known gaps: a directory-wide search (`Grep` over a folder, `grep -r`) can still read a `.env` file inside it; the credentials stay in the
agent process's environment (Claude harness; see the pi section below), so a determined same-user process can read `/proc/<pid>/environ` by a
route the patterns do not name; a host name can change its address between the check and the fetch.

#### pi harness (`TAI_HARNESS=pi`, the default)

The same guards apply, through `container/agent-runner/src/pi-guards.ts`: a pi tool call (`bash`, `read`, `write`, `edit` with a list of
`{oldText, newText}`, `grep`, `web_fetch`) is turned into the Claude-style call the rules know and run through the same composed hooks, so a
rule added to `guards.ts` holds for both harnesses. pi resolves a path before it opens it (a leading `@` is dropped, `~` is expanded,
`file://` URLs are read), and so does the guard, which checks the path as written and as pi will open it; a guard that fails blocks the
call. The reason a guard gives is what the model reads (the Claude CLI dropped it when more than one hook matched).

What the pi runner closes that the Claude harness leaves open:

| | |
|---|---|
| Credentials | The host hands them over on stdin and the runner keeps them in memory: the model's key goes to pi's runtime, the others to the MCP server that needs them (the server's `env`; every `$` in a value is doubled and a leading `!` escaped, because pi would otherwise expand `$NAME` and run `!command` in a configuration value). The agent's shell gets the container's environment without anything named like a credential and without pi's `PI_*` session variables. |
| Discovery | `/workspace/group` is pi's working directory and the model writes there, so pi is started with nothing discovered from it or from the home directory: no extensions, skills, prompt templates, themes or `AGENTS.md`/`CLAUDE.md`/`SYSTEM.md` files, settings and MCP servers in memory, a temporary agent directory. A group's own `CLAUDE.md` is read for the admin chat only: the host never writes one for a student, so a file there is what the model wrote, and it would come back as instructions in every later session. Tested by planting all of them (`eval/harness/pi_isolation.py`). |
| Tool set | pi's `read`, `write`, `edit`, `bash`, `grep`, `find`, our `web_fetch` and the MCP tools. No `Task` (subagents), `Skill`, `WebSearch`, `TodoWrite` or `NotebookEdit`. `web_fetch` checks every hop of a redirect against the private-address rules, caps the page at 2 MB and the answer at 30,000 characters. |

Gaps that remain: the DNS-rebinding window of `web_fetch`; a directory-wide `grep` skips hidden files (ripgrep's default), a `bash` `grep -r` does not.

### 7. The student page (`src/portal`, see `PORTAL.md`)

The web channel's own HTTP API has no authentication and stays on loopback (`127.0.0.1:8199` live); it is never proxied. What faces the
network is the page's listener (a unix socket in the live deployment, so nothing is bound on any network interface), which works like this:

| | |
|---|---|
| Who | A Google ID token, verified in the server: RS256 only, Google's published keys (refetched once for an unknown key, then not again for a minute), issuer, audience, expiry, `email_verified`, and a single-use nonce the server issued to that page. Then the address must be on the allowlist; the session is an HMAC-signed cookie (`HttpOnly; Secure; SameSite=Lax`, path `/tai`, 12 h). Removing an address from `users.json` ends its session at the next request. |
| Which chat | From the allowlist entry of the signed-in address: the group folder (a hash of the address), the Canvas user id and the GitHub login that bind the agent's tools. Nothing a request says can change them, so one student cannot ask TAi to read as another. The name TAi is told is the allowlist's, not Google's display name. |
| Other students' data | Each student's page history is a file of their own; a reply is stored under the chat it was sent to; a request cannot name a chat. Covered by tests with two students. |
| Forged requests | A POST must be JSON, carry `X-TAi: 1`, and come from the page's own origin (checked against `TAI_PORTAL_ORIGIN` and `Sec-Fetch-Site`); cookies are `SameSite=Lax`. |
| The browser | Model output is rendered from DOM nodes (`createElement`/`createTextNode`), never as HTML; links are http, https or mailto only, open with `rel="noopener noreferrer nofollow"`. A content policy allows scripts from the page itself and Google's sign-in script only. Tested with hostile text in a real browser. |
| Abuse | Per-address and per-student limits (30 sign-in attempts and 30 messages per 10 minutes, 4 waiting polls, 6000-character messages, 16 KB bodies) and a bounded nonce store. |

What the page does not change: a student's agent container is the same container, with the same guards and the same Canvas/GitHub binding.
The Canvas, GitHub and Piazza credentials are the operator's own, in `.env` on the host: the guards are what keep one student's agent
from using them for another (`github-access.ts`, the Canvas tool's user binding), so the allowlist decides who may try, not what a
signed-in student may ask. Letting the whole class in is a decision about those credentials as much as about the page.

#### What came with pictures, files, voice and the admin chat

| | |
|---|---|
| Pictures TAi sends | Stored under `store/portal-media/<folder>/<random id>.<ext>` and served by `GET /api/media/<id>` to the student they belong to (the folder comes from the session, the id is checked against `^[0-9a-f]{32}$` before it is near a path). Only PNG, JPEG, GIF and WebP pass for a picture, decided by the bytes (SVG never), and the reply carries `Content-Security-Policy: default-src 'none'; sandbox`. The path a container names for the host to send (`ipcMediaPath`) must resolve inside that group's own IPC directory: `..` led out of it before. |
| Files students attach | `POST /api/upload` (octet-stream, `X-TAi: 1`, the page's origin): the name is reduced to `[A-Za-z0-9._-]`, the kind comes from the extension and the bytes (a "text" file with NUL bytes, an executable, SVG are refused), 5 MB each, 100 files / 50 MB per student, and the file goes only to that student's own `groups/<folder>/uploads/`. An id is good once, for that student, for 30 minutes. The text of a file is data in the student's own message, like anything else they type. |
| Voice notes | The page records them on the student's own click and sends them as audio (`POST /api/voicenote`: the type is one of five audio types and the bytes are sniffed, 5 MB each, 100 MB per student). The file is **kept** under `store/portal-media/<folder>/<id>.<ext>` and served by `GET /api/media/<id>` to that student only (with Range requests, for the player), and it is sent to Deepgram's pre-recorded endpoint with `mip_opt_out=true` for its words. There is no deletion path yet: a student's recordings stay on the host until someone removes them. A reaction (`POST /api/react`) is a line in the history, from the six emoji only, on a message of TAi's in the student's own history. |
| Voice calls | A WebSocket on the page's origin: the session cookie, an `Origin` equal to the page's own and an enrolled address are checked at the upgrade, one live call per student, per-student and per-host limits on minutes. Deepgram's thinking requests reach `/voice-llm/` with a bearer token that is an HMAC of one call's id and its expiry, rate and size limited, and the relay forwards a fixed model with a whitelist of fields: the gateway key and the Cerebras key never leave the host. The call's tools run in a throwaway container with the student's own identity binding (a "tool host"), never in the orchestrator, and `DEEPGRAM_API_KEY` is not given to any container. |
| What TAi remembers, and thumbs (no longer on the page) | **The page has neither any more** (the "What TAi remembers" sheet and the thumbs were taken off it); the server still answers these calls, which nothing on the page makes, so they are what they were until they are deleted. `GET /api/memory` answers the signed-in student with their own saved notes (the folder is the session's, never a request's) and a plain-words reading of their own COMPETENCY.md (levels as words: no scores, dates or ids; `src/portal/memory-view.ts`), only where the deployment has it and never in the admin chat. `POST /api/memory/forget` deletes one note by its id **and** the session's folder (`DELETE ... WHERE id = ? AND student_folder = ?`: another student's id is a 404), with the usual JSON, `X-TAi` and origin checks and 20 a minute, and rebuilds the derived `memory_store.json`. The notes are text a model wrote about the student: the page shows them as text, never as HTML. `POST /api/feedback` is a line in the student's history like an emoji (a thumb up or down and one of four reasons, on a message of TAi's in their own history), 60 a minute; it starts no agent run and reaches TAi only as a line ahead of the student's next message. |
| Options and quick checks | TAi writes options as a `<choices>` block (`src/choices.ts`); the web channel takes it out of TAi's words, so the page gets the question and the options and **never the answer TAi marked or its note on it**: they are kept in a `secret` field of the history line that `tail`, `since` and `activities` leave out of what the page is handed (`src/portal/history.ts`; tests read the page's history, poll and activity answers for it). A tap is `POST /api/choose` (students only; 404 under `/api/admin/`): the line and option are looked up in the signed-in student's own history, an option can be tapped once and only while it is the last thing said (409 otherwise), it is held to the same 30 messages in 10 minutes as typing, and the tap is the student's message with the option's own words (nothing the page sends is put in it). The host grades it and tells TAi with the tap which option was chosen and whether it was the one TAi marked. A model marks the wrong answer or lets two be right in about one question of four, and puts the answer second almost every time: so a quick check's options are shuffled and its answer is put to other models (`TAI_CHOICES_CHECK_MODELS`) that have not seen the key; a disagreement drops the key. The check sends the question and the options to the gateway (no student name, id or history). |
| The admin chat | The owner's second chat (`/api/admin/*`, `role: owner` only, 403 for anyone else) is the one group the orchestrator treats as the instructor's (`main`: class-wide Canvas, GitHub and Piazza queries, scheduling). Its container gets the groups, the database and the audit log **read-only** and its own folder to write in; not the project root, so not the `.env`, the source or other groups' sessions (`TAI_ADMIN_FULL_PROJECT=1` restores the original's whole-project mount: do not). It reads text students write, so it must not be one prompt away from the keys. |
| The class-wide course status | Written by a script from Canvas (`src/course-status.ts`, `container/scripts/course_status.py`), not by a model, with nothing about one student in it: every student's agent reads that file. What changed between two of its versions (a new announcement or file, a deadline that moved) is the same for everyone and goes to every student's activity list (`src/course-updates.ts`). |
| One student's standing in the course | `src/student-course.ts`, every 6 hours (`TAI_STUDENT_COURSE_HOURS`): **the orchestrator itself** calls Canvas once with the instructor's token (`students/submissions?student_ids[]=all`) and reads every student's submissions, which no container does. The token goes only to the host of `CANVAS_BASE_URL` (a next page on another host is not followed), never into a log or a file. What is kept between two looks is `store/student-course.json` (mode 600): Canvas user id, assignment id, a state word, a grading time, a posting time and two flags; no score, no name, no assignment title. What is told (a grade once Canvas has posted it, or changed after that: a grade Canvas holds back is not told; an assignment marked missing that is turned in on Canvas and has no submission at all; one due within 24 hours with no submission) is written to the history of the student whose Canvas user id it is on the allowlist, and to nobody else's (`Portal.recordForCanvasUser`; tests with two students); a student who has not opened the page is told nothing. The class never sees another's grade: nothing here is shared, and the call is the same data the `grades` action of `canvas_query` already reads for the admin group. |

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  WhatsApp Messages (potentially malicious)                        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential filtering                                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • Network access (unrestricted)                                  │
│  • Cannot modify security config                                  │
└──────────────────────────────────────────────────────────────────┘
```
