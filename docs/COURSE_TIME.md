# Deadlines: the Pacific time TAi says, and the student's own clock

Round J, 2026-11-05. What is built, what it rests on, what was run and what was not.

## The problem

TAi's "Pacific" is `America/Los_Angeles` (the orchestrator's `TZ`, `container/scripts/pacific_time.py`, `due_pacific`, "9:00 AM PST"). A student's wall
clock is not always that. The time zone data of 2026 (tzdata 2026e, which the agent image has: Debian 12 `tzdata 2026e-0+deb12u1`) keeps British Columbia
on UTC-7 all year from 2026-11-01, while Los Angeles is UTC-8 in winter. A deadline at 17:00 UTC is "9:00 AM PST" in TAi's words and **10:00 AM** on the
wall clock of a student in Vancouver. What Canvas itself shows that student depends on their Canvas profile or the course's zone, which **nobody has
checked**: so TAi does not claim that either time is "the" time. It keeps saying the Pacific time it has always said and, when the student's own clock
reads differently, says that as well, with the zone's name.

## What a student is told

* Text chat: "9:00 AM PST, which is 10:00 AM your time in Vancouver" (the persona's rule, `groups/global/CLAUDE.md`).
* Voice: the Pacific time first, then theirs with the city (`src/voice/prompts.ts`, rule 6).
* A student whose clock reads the same as Pacific (Los Angeles, Seattle, Tijuana), a student who has not told us their zone, and a zone the image cannot
  find are told exactly what they always were: the field is not there, nothing else changes.

## The pieces

| Piece | What it does |
| --- | --- |
| `src/portal/prefs.ts` (agent a2) | Keeps `tz` (an IANA name, validated) in `store/portal/<folder>.prefs.json`; the page sends the device's zone after sign-in. |
| `src/student-tz.ts` | `studentTimeZone(folder, storeDir)`: reads that file with `PrefsStore` (no second parser). Undefined for no file, a damaged file, a name that is no zone, a folder name that could be a path. |
| `src/container-runner.ts` | `buildContainerArgs(..., studentTz)` adds `-e TAI_STUDENT_TZ=<zone>` before the image, for the text agent's containers and the voice tool host (`spawnToolHost`). Read at every container start. The admin chat runs under the folder `main`, which has no preferences file (the owner's zone is kept under their own student folder), so it never gets the variable. |
| `container/agent-runner/src/mcp-servers.ts` | Names `TAI_STUDENT_TZ` in the environment of the nanoclaw MCP server (which runs `canvas_api.py` with its own environment). Needed: the file's own comment says pi hands an MCP server only what it is given, and the MCP SDK's stdio transport (read in the image) starts a server with a short whitelist of the parent's variables plus what it is passed; only the tool host passes the whole container environment (`McpToolServer.connect`). Without this line every test passes and `due_local` may never appear in a text agent's container. |
| `container/scripts/pacific_time.py` | `student_zone()` (the variable, checked against the same name rule as the page's validator, then `zoneinfo`: stdlib, the system's tzdata, no package) and `student_local(iso)`. |
| `container/scripts/canvas_api.py` | `due_fields()`: `due_pacific`, `due_local` (only when it applies), `due_relative`, in that order, for `assignments`, `upcoming`, both rows of `my_grades` and `assignment_detail`. |
| `src/voice/canvas-text.ts` | `find` (the assignments) and `assignment_detail` say "on the student's own clock ..." when `due_local` is there. |

## Contract

* **`TAI_STUDENT_TZ`**: an IANA name (`America/Vancouver`), set by the orchestrator in the `docker run` of a student's containers; never by hand, never a secret.
  Absent when the student has not told us or the stored value is not a zone. A container that is already running keeps the zone it started with
  (a warm text container lives `IDLE_TIMEOUT`, 2 minutes; a kept voice tool host up to `TAI_VOICE_TOOLHOST_KEEP_SEC`, 10 minutes).
* **`due_local`**, a string such as `Fri Nov 6, 10:00 AM (America/Vancouver, UTC-7)`: the student's wall-clock date and time of the deadline, the IANA name the
  page sent (not an abbreviation: `PST` is the Pacific zone's, and many zones only have `+13`) and the offset (`UTC-7`, `UTC+5:30`, `UTC+0`). Present only
  when the variable names a zone this Python finds **and** the date or time differs from the Pacific one; otherwise the key is **absent, not null**. It never
  makes a call fail: any error in it is "no field". 65 characters at most (with the longest zone name of tzdata, America/Argentina/ComodRivadavia, 32 characters).
* **`assignment_detail` now has `due_pacific` and `due_relative`** (it had only the raw UTC `due_at`, the one a model reads as "5 pm"), and `due_local`
  when it applies. Every field it had is unchanged.
* The comparison is made against the same hand-written US rule `pacific()` uses, so "same wall clock" means what the Pacific text says.

## Run and checked

* `python container/scripts/test_pacific_time.py` and `test_canvas_api_due_local.py` (the real script against a stand-in Canvas served from the test),
  `npx vitest run src/student-tz.test.ts src/student-tz-env.test.ts src/voice/canvas-text.test.ts container/agent-runner/test/student-tz.test.ts`.
* In a throwaway container of the live image (`/opt/leanrag/bin/python3` 3.11.2, tzdata 2026e): both Python files pass with the real `America/Vancouver`
  (the checks at 2026-11-01 09:00 UTC, 2027-03-14 09:59 and 10:00 UTC included), and the script printed the same for no variable, an invalid zone and `America/Los_Angeles`.
* On the development PC, against the stand-in Canvas, a copy of the script as it was before this change (with the old `pacific_time.py`) and the new one were run side
  by side: `assignments`, `upcoming` and `my_grades` are byte for byte the same for no variable, an empty one, an invalid zone, an offset (`UTC+8`) and `America/Los_Angeles`.
  The only answer that changed is `assignment_detail` (the two new fields; every old key is unchanged).
* On a PC whose Python reads the pip package `tzdata` 2025.3, Vancouver is UTC-8 in winter like Los Angeles: the tests that need the 2026e data are
  skipped there (with the reason printed) and run in the image. The Vancouver cases are also run on a fixed UTC-7 zone, so the logic is tested everywhere.

## NOT verified, and known gaps

* What Canvas itself shows a student in Vancouver. The zone used is the one the student's browser reports, not Canvas's.
* The whole way from a real student's page to a spoken sentence: the pieces are tested one by one, and the MCP hop (`docker run -e` to the server's environment)
  by a unit test of `buildMcpServers`, not by a call. After a deploy, ask TAi from a page whose device is in Vancouver "what is due this week" and look for
  both times.
* `COURSE_STATUS.md` is the same file for every student and the voice call's "Upcoming deadlines" block is made from it: both carry the Pacific time only.
  The persona and rule 6 say to look a deadline up (`canvas_query` `upcoming`) when the student asks what it is for them. Putting the zone into the
  voice block (`freshDeadline` in `src/voice/context-builder.ts`, where the hub knows the student's folder) would be the next step.
* **Size in a voice call.** A function result is cut at `RESULT_CAP`, 6000 characters (`src/voice/functions.ts`, `capResult`), and `assignments`, `upcoming` and `my_grades`
  reach the model as the script's indented JSON. Measured on lists made by the real script: 382, 366 and 340 characters per item, and `due_local` adds 67 (+17 to 20 %): the
  items that fit go from 15.7 to 13.4 (`assignments`) and from 17.6 to 14.7 (`my_grades`). A longer list is cut at its end, where the upcoming deadlines are; that was already so
  for a course with more than 15 assignments (20 of them were 7,649 characters before). `upcoming` (the nearest deadlines) fits. Not done, because it needs a hook in
  `functions.ts`: a one-line-per-item form of these three answers for voice, built in `canvas-text.ts` (no such cap was found on the text agent's path: `canvas_query` returns the whole answer; pi's own limit on a tool result was not checked).
* A student who has not told us a zone gets no `due_local` (`TAI_PUSH_DEFAULT_TZ` is for notifications only).
* The teaching patrol's prompt has no deadline wording of its own ("due Monday 9am" is a condition); its container gets the variable like any other, and the
  persona's rule applies to what the patrol writes.
