# The weekly interview brief

The owner's words: "the mock interview must be based on THIS WEEK'S assignment requirements, the student's Canvas submission status this week, the code the student committed to
GitHub this week, and what they posted on Piazza this week." A real TA interview asks about the homework code, the week's concepts and the student's Piazza post. The brief is the
material for that: one object, built from the four sources, that the interviewer (the voice call, `src/voice/`, and the text agent) asks PERSONAL questions from ("you committed X on
Tuesday: what problem did it solve?", "your Piazza post says Y: what is the tradeoff?", "it is not submitted yet: what is left?").

Built in the agent container (`container/agent-runner/src/weekly-brief.ts`), from four helper scripts (`container/scripts/`). Nothing here reads or writes the student model.

## Where it runs

| Entry | What it does |
| --- | --- |
| `start_mock_interview` | builds the brief **beside** its own lookups (below) and adds it to `groups/<folder>/interview_context.json` as `weekBrief`; the answer's `Context:` line gains `week ✓, status ✓, commits ✓ (7), piazza ✓ (2 posts)` (✗ with the reason for what did not arrive). The interview starts whatever the brief does: it never throws. |
| `weekly_brief({assignment_id?, student_folder?})` | the same brief as compact text for the text agent (`formatWeekBrief`); writes no file; 3 calls per conversation (`tool-limits.ts`). `student_folder`, `canvas_user_id` and `github_username` are the admin chat's only. |
| `canvas_query` `week_status` | the Canvas part alone: `{window, week, assignments}` (params: `assignment_id?`). Auto-scoped to the student. |
| `github_query` `activity` | the GitHub part alone (params: `since?`, `until?` default the last 7 days, `repo?`, `max_repos?`, `max_commits?`, `detail?`). The student's own account only. |
| `piazza_query` `student_activity` | the Piazza part alone (params: `since?`, `until?`, `limit?` up to 8). Found by the student's Canvas e-mail address or name. |
| `canvas_query` `user_contact` | `{name, email, login_id}` of the bound student; not advertised to the model, used by the other two. |

**Time.** The old `start_mock_interview` was a chain of about a dozen `execSync` calls (20 to 60 s, the host waits at most 115 s). Its lookups are now asynchronous (`execPy`, an async
`execFile`, 30 s a call as before, the same order and the same results) and the brief runs at the same time: the call takes about as long as the longer of the two (the brief takes at most 40 s,
usually 5 to 15), not the sum. The brief starts as soon as the assignment is settled (at once when `assignment_id` is given, otherwise after the first Canvas call), so its main assignment is the
interview's (see "The window and the week"). A side effect: the MCP server no longer holds every other call back for the length of `start_mock_interview` (an `execSync` blocks the whole Node process; the other tools' calls
still do, for their own length, and a blocked loop makes this brief's timers run late).

## What is fetched

Canvas first (it gives the window and the e-mail address), then GitHub and Piazza at once. Each helper run has 15 s (`execPy`), the whole brief 40 s; what has not arrived is `failed: timed out`. When no
assignment is named, Canvas's first call is the `assignments` list (it picks the main assignment, see below) beside `user_contact`, and `week_status` follows.

* **Canvas** `week_status`: the assignment list (1 request), the modules (1: the one that holds the main assignment names the week: "Week 8! ..." is week 8), the main assignment's detail (1: full
  description and rubric), and the student's submission of each of at most four assignments (with comments and rubric assessment). At most 7 requests, 6 s each, 11 s in all (the script stops itself
  and says "unknown" for what it could not read). **No attachment is downloaded** (the old half of `start_mock_interview` reads the main submission's files; a download here would double the time and
  the vision calls): a text entry gives its body, a URL its address, an upload its file names, never the download address (it carries Canvas's access key). `user_contact`: the profile
  (`primary_email`, `login_id`), then the course's user record, whichever this token may read.
* **GitHub** `activity`: the account's repositories (one page of 100, `type=all`, sorted by `pushed`), those pushed to since the window began (at most 4 with commits in it), the commits of each in the
  window (15 each; in a repository the account does not own, only `author=<account>`), and the files (name, status, lines; the script keeps a patch of 300 characters, the brief does not) of the
  newest 4 commits **of all the repositories**. At most 1 + 4 + 4 requests (more only for empty repositories, which answer 409 and use no place), 6 s each, 11 s in all.
* **Piazza** `student_activity`: ONE feed request (the TAi account is a TA's: every item has a `log` of `{n: event, t, u: uid}`), ONE `get_users` for every uid on the page, then `get_post` for at most
  8 of the posts the student acted on. Inside the existing throttle (`piazza_throttle.py`); the brief gives it `PIAZZA_BUDGET_SECONDS=10`, so that it stops itself with what it has before the 15 s that kill it.

## The window and the week

`now` is the call's time. The **main assignment** P is the one the caller named, else the published assignment with the earliest due date at or after now (the week's open one), else the published
one most recently due; an assignment with no due date or not published is never picked by the rule. On Thursday 2026-11-05 that is Homework 7 (due the next Monday), not Midterm Mastery Part 2 (due the
Monday before), "Final Project Details" (no due date) or last term's unpublished leftovers (a test fixture with exactly these names and dates).
`since = min(now - 7 days, P.unlock_at)`, never earlier than `now - 21 days`; `until = now`. (An assignment older than three weeks therefore gets a window that does not reach its work.) The week's
assignments are the published ones that have started (`unlock_at`, or `due_at - 7 days` when there is none) and are due no longer than a week ago, P always among them, at most four, the others being
those due closest to P, ordered by due date. The window and the week are `week_window` and `week_assignments` in `canvas_api.py`.

**One rule picks P everywhere**: `pickPrimaryAssignment` (`weekly-brief.ts`, pure). `start_mock_interview` runs it over its own assignment list (its old default was the assignment most recently *past* due, i.e.
last week's), so `interview_context.json`'s `assignmentId`, name, spec, lecture material, submission text and code excerpts and the brief's `primary` assignment are about one assignment whenever no
`assignment_id` is passed (a named one is found by id exactly as before, published or not). `buildWeekBrief` with no assignment named (the `weekly_brief` tool) reads the `assignments` list first (one more
Canvas request, 8 s at most, in step with `user_contact`) and runs the same function; a list it cannot read costs nothing, `week_status` then applies the rule itself. `pick_primary` in `canvas_api.py` is
the same rule for a direct `canvas_query week_status` (the unlock date plays no part in either: the `assignments` list has none), and a test runs both on the same cases.

## Status of a submission

`status` is `graded`, `submitted`, `late`, `missing`, `not_submitted` or `unknown`; `statusLine` is one sentence with every time in Pacific (`pacific_time.py`, the course's clock; the student's own
clock is added to `due` when `TAI_STUDENT_TZ` says it reads differently). The student's own extension counts (Canvas's `cached_due_date` over the assignment's date).

| Status | Sentence |
| --- | --- |
| graded | `Submitted Sun Nov 1, 12:30 PM PST, on time; graded 88 of 100` (`(attempt 2)` after the time when it is not the first; `late`; `graded complete`; `No submission is on record; graded 50 of 100`; `Excused: the instructor excused this assignment`) |
| submitted | `Submitted Sun Nov 1, 12:30 PM PST, on time; not graded yet` (`waiting for review`; no `on time` when there is no due date) |
| late | `Submitted Tue Nov 3, 12:30 PM PST (attempt 3), late (it was due Mon Nov 2, 9:00 AM PST); not graded yet` |
| missing | `Missing: it was due Mon Nov 2, 9:00 AM PST (2 days ago) and nothing was submitted` |
| not_submitted | `Not submitted yet; due Mon Nov 9, 9:00 AM PST (in 5 days)` or `Not submitted yet (no due date)` |
| unknown | `Status unknown: Canvas did not return this student's submission`, or `No online submission is expected for this assignment` |

## The Piazza match

By e-mail address (case and spacing ignored; the primary address and the login when it is one are both tried), else by exact normalised full name. Two accounts with the address or the name are **no
match** (a wrong student's posts are worse than none). `matched: false` is not "has not posted": the interviewer is told that it cannot see the account. A name-only match is said to be less certain
(a namesake who has posted would be taken for a student who has not: only the accounts on the forum's last 200 threads are compared).

Counts are from the feed alone, in the window, both ends included: `posted` = `create`, `followups` = `followup` and `feedback` (a reply inside a follow-up), `answers` = `i_answer` and `s_answer`. Edits
(`update`, `*_update`) are not counted. Posts anonymous to classmates carry the uid for a TA and are found; one anonymous to everyone has none and is not. The feed page is 200 threads; when it is full (or
Piazza says there are more) and its oldest thread is still inside the window, the answer says older activity may be missing.

## Sizes (`BRIEF_LIMITS`, all enforced again in TypeScript whatever the helper sent)

4 assignments; requirements 2500 characters for the main one, 600 for the others; submission text 1500 (the helper gives the others 600); 5 links; 5 comments of 300, newest last; 8 rubric lines of 200;
4 repositories of 15 commits, messages 200; files (8 each) only for the newest 4 commits of all; 8 posts of 600 characters (subject 150, 6 tags of 40); 5 reasons in `sources.errors`. A worst-case
brief is about 45 KB of JSON, a typical one 5 to 10 KB.

## Failure modes

Every source is isolated. `sources.<x>` is `ok`, `failed` or `skipped` and `errors` says why in a fixed phrase (`failureReason`): `timed out`, `not configured`, `access refused`, `not found`, `busy, asked to slow
down`, `service error`, `unreadable answer`, `failed`; skips: no Canvas account linked, no GitHub account linked, not configured, no e-mail address or name to find the Piazza account by. The script's own words
are never forwarded (they quote response bodies). Canvas failing does not stop GitHub (the window is then the last 7 days) or Piazza (the contact call is separate). GitHub is asked on the host of the main
submission's link when that is github.com or the configured Enterprise host, else the configured one; when it knows no repositories of the account (or errors) and the host did not come from a link,
github.com is tried too, if at least 10 of the 40 seconds are left. The Enterprise token is never sent to github.com, and a link to any other host is ignored: the old code sent the token to
`https://<any host that starts with "github">/api/v3` (checked in a throwaway container of the live image: a submission with `https://github.evil.example/x/y` made `start_mock_interview` send `GITHUB_TOKEN`
there). That fix (`acceptGithubHost`) covers the old half too.

## Privacy

1. **Identity comes from the binding, never from the model.** In a student's container (`NANOCLAW_IS_MAIN` 0, a scheduled task included) the Canvas id and the GitHub login are `NANOCLAW_CANVAS_USER_ID` and
   `NANOCLAW_GITHUB_USERNAME`; the Piazza e-mail address and name are Canvas's (`user_contact`) for that id. Whatever `user_id`, `owner`, `email`, `name`, `uid` or `student_folder` the model passes is
   dropped (`brief-access.ts`: `scopeCanvasParams`, `scopePiazzaParams`, `resolveBriefIdentity`; `github-access.ts`: `activity` is the own account only, the course organisation too is refused: its
   repositories are the whole class's code). `COMPETENCY.md` is not an identity (the student's agent can write it). The admin chat may name anybody; for another student's folder the identity is that folder's
   file, not the admin's own binding.
2. **Piazza says nothing about anybody else:** no other name, e-mail address, uid or text; the subject of a question somebody else asked is not quoted; each quoted word is checked against its own author's
   uid node by node (an answer other students edited is quoted from the newest version THIS student wrote); replies to their posts are not counted at all.
3. **What people wrote is data**: cleaned (control characters, bidi overrides), bounded, quoted by `formatWeekBrief`, and the host quotes it again.
4. **Logs** count what was fetched and never quote it.

## Tests

`python container/scripts/test_week_status.py` (65), `test_github_activity.py` (36), `test_piazza_student_activity.py` (45): in-process against a fake HTTP layer / fake Piazza network, plus one class each
that runs the script as the container does against a loopback stand-in. `npx vitest run container/agent-runner/test` (`weekly-brief.test.ts`, `brief-access.test.ts`, `github-access.test.ts`,
`tool-limits.test.ts`): fake `runPy`, fake timers, and the real `execPy` against this machine's Python. Mutation checks (one mutation at a time, the file restored byte for byte after each): 118 killed (Canvas 34, GitHub 22, Piazza 20, TypeScript 42), none survives; the
survivors found on the way (an untested rubric limit, C1 control characters, the author date against the commit date, a limit that a server could exceed, the budget check before a post, a stderr cut) each
got a test, and two guards that no test could ever fail were removed as dead code.

## What was NOT verified

* No real Canvas, GitHub or Piazza call was made (no credentials). Every endpoint and field name is from the documented APIs or the lead's measurements of the live Piazza account on 2026-11-05. In particular
  not seen live: that Piazza's `get_users` records carry `id` (the match refuses to guess without it: the answer would be `matched: false`), the key `u` of every log entry, that `children[].uid` and
  `history[].uid` are per node as assumed, Canvas's `cached_due_date`, the profile's `primary_email` for this token, GitHub's `type=all` on the Khoury Enterprise, that `committer.date` is what its `since` filters.
* The glue was run end to end only against stub helper scripts, in a throwaway container of the live image (the real MCP server and SDK client, compiled with `--noCheck`): the scoping, the rate limit, the
  `Context:` line and `interview_context.json`. The time of a real call (5 to 15 s per source) is an estimate.
* The image must be rebuilt before any of this is live (the scripts and `dist/` are baked into it).
