# The teaching patrol and its gate

Every weekday at 9:00 (the orchestrator's `TZ`, Pacific live) each student has a patrol task (`src/teaching-patrol.ts`): a container and a model read the student's
`COMPETENCY.md`, the class's `COURSE_STATUS.md`, Canvas and GitHub through the tools, check nine triggers and, if one holds, send ONE message. On 2026-11-03 two runs on the
owner's own group took 5 to 7 model requests and 165,000 to 202,000 input tokens each, and both ended in "no action": about nine patrols in ten do. The gate
(`src/patrol-gate.ts`, called by `src/task-scheduler.ts`) decides **with code, before any container**, whether a student's patrol needs the model today.

## The rule

The model runs when something **new** has appeared since the last run it finished, or when the **weekly full check** is due (a week since it last looked; the first one counts
from the student's registration, so a student who joined yesterday waits). Otherwise the day's run is skipped: no container, no model, a row in `task_run_logs` saying why,
and the next run scheduled as usual.

| Signal | Fires when | Key |
| --- | --- | --- |
| a deadline's last chance | an assignment of the student's that is turned in on Canvas, not excused, with no submission, is due before the *next patrol* (so for a Monday 9:00 deadline: Friday, the last patrol before it, since none runs on a weekend) | `due-last:<id>` |
| a deadline that has passed | the same, 12 to 72 hours after it (a student submits at 8:59: not in the minutes after it) | `due-late:<id>` |
| Canvas cannot be seen | the student has a Canvas id and there is no snapshot, or one older than 48 hours (`store/student-course.json`, made every 6 hours) | `canvas-unknown` |
| gone quiet | no message and no call (`competency/voice-sessions.md` is written when one ends) for 5 days, until 3 weeks; a student who never wrote counts from registration | `inactive` |
| a confirmed misconception | an Active Misconceptions line with `status: confirmed` or three sightings, not closed (`remediated`, `resolved`, `effective: true`) and not `identifying` | `misconception:<hash>` |
| knowledge going stale | mastery lines with confidence above 0.7 and stability below 0.3 and no evidence for 14 days (the patrol's own spaced-review trigger) | `spaced:<hash>` |
| a record code cannot read | a `COMPETENCY.md` of 400+ characters with no mastery line it understands | `competency-unknown` |

**New** is measured against the keys of the last run the model *finished* (`store/patrol-gate.json`: when, and the keys; no text). A state that lasts, a student who stays quiet, a
misconception that waits for them, costs one run and then the weekly check, not one run a day. A run that failed (a provider that answers 402) is not kept, so the next day looks
again. A skipped day keeps nothing. The weekly check is also what covers the triggers code cannot see: their GitHub, Piazza, this week's topic, the mock interview.

**Fail-open.** What code cannot read is itself a signal (`canvas-unknown`, `competency-unknown`), an error anywhere in the gate means "run", and `off` is the old behaviour. A
student with no Canvas id has no Canvas signal (there is nothing for the model to query either); one the snapshot has nothing for (the owner, who is not an enrolled student) has
none.

**What the model is told.** A patrol that runs gets a note after its prompt: which signals are on and why it runs (ids, counts, hours). Never a word a student wrote: the
note is built from numbers, and so is the log. Whether to reach out stays the model's judgment, and the nine triggers still apply.

## Reading it

`bash deploy/cs6650/tai_live.sh patrol [DAYS]` prints the last week's patrol runs: how many the model made (and how many failed), how many the gate skipped, and the gate's
reasons for the latest skips. Each decision is also a journal line (`Patrol gate: ...`). **Before trusting it**, `TAI_PATROL_GATE=shadow` (`tai_live.sh set`, then `restart`)
makes the gate decide and log while the model runs as before: after a week `patrol` says how many of the model's runs it would have skipped, and the owner can compare with the
runs that sent a message.

Settings: `TAI_PATROL_GATE` (`on`, `shadow`, `off`), `TAI_PATROL_INACTIVE_DAYS` (5), `TAI_PATROL_FLOOR_DAYS` (7; `0` = only new signals). `SETTINGS.md`.

**The decision log.** The persona and the protocol tell the model to log every patrol decision, "including when you decide NOT to intervene", and none did, so the scheduler writes one line per
patrol run in the student's `competency/intervention-log.md` (newest first, `src/intervention-log.ts`): `no-action` for a gate skip (with the signals still open and whether the weekly check was due), `no-action`
for a run that finished and sent no message, `intervene` for one that sent one, `failed` for a run whose model could not be reached, that never finished, or broke. The lines are made of signal keys, numbers
and fixed words, never a word a student wrote. "Sent a message" is the marker the send tool leaves in `data/ipc/<folder>/messages/.send_message_used`: the scheduler removes an old one before the run and takes this
run's after it. Nothing took it after a patrol before, and the chat's next reply is held back whenever it finds one (`src/index.ts`), so a patrol that had sent a message could swallow the student's next answer
(read from the code, not seen live). Tests: `src/task-scheduler.test.ts`, `src/intervention-log.test.ts`.

## What the patrol may and may not read

The patrol runs in the student's own group, with `context_mode: group`: it resumes the student's session file and adds its turns to it (read from `pi-runner.ts`, `SessionManager.open`; not observed on
the live host), so **whatever it reads is in the conversation the student replies in** (that is also why its reasoning stays in it, and why the proactive message arrives where the student answers). The rule that follows is code, not a sentence in the prompt
(`container/agent-runner/src/access.ts`; `docs/SECURITY.md`, "Scheduled tasks and access"):

| The patrol may read | The patrol may not read (refused by the tool, whatever it is told) |
| --- | --- |
| this student's `COMPETENCY.md` and `competency/` files | another student's folder (it has none mounted) |
| `COURSE_STATUS.md`: the class's syllabus, modules, announcements, assignments and deadlines, class-wide by script, **nothing about any one student** | a per-student status of the class: there is none in that file, and the course sync agent that wrote one is off |
| `canvas_query` `week_status` (this student's week: what is due, submitted, on time, graded), `my_grades`, `student_submission` with an `assignment_id`: always the Canvas account the host linked to the chat, whatever `user_id` it passes | `canvas_query` `submissions`, `grades` and `users`: they list the class (names, scores, grades, e-mail addresses), so they are for the admin chat only; the patrol's old prompt asked for `submissions` and said it "only ever shows this student", which was false |
| `github_query` `activity` (no params: this student's linked account), and `commits` and the like on that account or on a course organisation | any other GitHub account, and the account a student writes in `COMPETENCY.md`, a file their agent can edit |
| the course's own pages, files and announcements; `piazza_query` | `set_student_identity` (the account link comes from the allowlist); stopping or changing any task |

The prompt asks for `week_status` and not `student_submission` per assignment on purpose: `student_submission` downloads the attachments and makes vision calls (capped per submission), which
would run for every student every weekday; `week_status` is one call that makes at most seven requests and downloads nothing. The prompt is stored in the patrol's row and run from it, so
`seedTeachingPatrol` puts the current text into every host-made patrol row at every start (`refreshPatrolPrompts`): a row seeded before a change of the prompt would otherwise keep the old text for good.
A patrol is **the host's own task**: the row's origin is `system` and its id starts `patrol-`; a student's task that carries `[TEACHING_PATROL]` in its prompt is not one (it is not gated, not counted by the
teaching-team page, and does not stop the real patrol from being seeded), and a student's agent cannot pause, resume or cancel the patrol (`docs/SECURITY.md`). What is not changed: its tool limits are
lifted (no 30-call cap); and sessions written before this fix may hold a class listing (the one-line check is in `SECURITY.md`).

## When the model could not be reached, and how long a patrol holds a container

**A run whose model request failed is a failed run.** On 2026-11-04 at 17:03 UTC the patrol met Cerebras' "payment required"; the runner answered with its apology
("sorry, something went wrong on my end ...") under status `success` (a chat has to show it), the scheduler logged a success, `tai_live.sh patrol` said "0 failed", and the gate
would have kept the day's signals as seen by a model that had looked at nothing. The runner now marks such an answer (`apiFailure`, `container/agent-runner/src/protocol.ts`
`failureOutput`); the scheduler logs the run as `error` ("the model could not be reached (other), so the task did nothing"), keeps nothing of it (the signals stay new, so the next
patrol looks again), and `patrol` counts it as failed. There is no retry the same day: the next patrol is the retry. Runs logged before this keep their old `success`.

**A task's container is closed when its runner says it is idle.** The runner reports `idle` after every turn (also when the turn retired the session: the session cap, an
overflow; and when the host had already closed its stdin); the scheduler closes the container's stdin `TAI_TASK_CLOSE_DELAY_MS` (5 s) later, whatever the answer was. Before, only a result *with text* started a timer (`IDLE_TIMEOUT`, 2 min), so a patrol that decided "nothing to do"
and wrote nothing kept its container until `CONTAINER_TIMEOUT` (937 s on 2026-11-03, exit 137, logged as a success), and one that wrote a line kept it 140 s for 20 s of work. The
patrols' own cap is `TAI_MAX_CONCURRENT_TASKS` (2 of the 5 containers; a student's message goes before a waiting task), so these hold-ups never queued a chat; they stretched the
patrols: 105 runs at 140 s on two slots is about two hours, at 937 s about thirteen. At about 30 s a run it is under half an hour (an estimate: the real figure is in the journal
after the first morning).

**A task that never finished is a failed run.** The container runner reports a container that was stopped after it had streamed something (the 15-minute timeout, a shutdown) as a
success with nothing in it. A runner that finishes says `idle`, or has written its answer; a task with neither is logged as `error` ("the task did not finish: its runner never said
it was done") and keeps nothing, like one whose model failed. The one harmless false alarm is a task closed early because a student wrote in: the runner says `idle` on that path too,
so it does not happen with the current image. The same rule for **chats** is now made (round J, `docs/PROGRESS.md`): `src/index.ts` armed its 2-minute timer on a text result only, so a chat turn that ended with no text (the answer
went out through `send_message`: its result is `result: null`) kept its container until `CONTAINER_TIMEOUT`; only one container run of 21 on the host had ended that way, and it was a patrol.
The chat path now also starts the timer, and stops the dots on the page, when the runner says `idle` and has received every message that was piped to it (`GroupQueue.markIdle`; the `received`
count is in the idle result). The text-result path is unchanged, and a Claude-harness container, which says `idle` only when its query ends, behaves as before.

## What it saves, and what it does not

For a class with weekly homework the estimate is about one weekly run per student plus a run for each new signal: **roughly 1.1 to 1.5 runs per student per week instead of 5**,
so about three quarters of the runs and of their tokens. That is an estimate from the course's rhythm, not a measurement: the real number is in `tai_live.sh patrol` after the
first week. A student who submits before Friday's patrol costs one run a week; one who waits until Sunday costs a second on Friday and a third on Tuesday if they are late.

The gate does **not** make a run that does happen cheaper: the model still reads the files with its tools (5 to 7 requests). Putting `COMPETENCY.md` and `COURSE_STATUS.md` in the
prompt would cut the requests, but it changes what the model sees and needs a model to check it against: not done. The model for the patrols alone is a different lever:
`tai_live.sh model NAME --background` (`SETTINGS.md`).

Tests: `src/patrol-gate.test.ts` (every signal and its boundaries, and a walk through the real calendar for a Monday 9:00 and a Tuesday 23:59 deadline), `src/task-scheduler.test.ts`
(a skip starts nothing and is logged; a run is told why and is kept only when it finished; a run whose model failed is a failed run; the container is closed a few seconds after the
runner says idle, and after `IDLE_TIMEOUT` when it never does; shadow and off), `container/agent-runner/test/protocol-output.test.ts`, `src/student-course.test.ts`,
`deploy/cs6650/test_tai_live.py` (`patrol`).
