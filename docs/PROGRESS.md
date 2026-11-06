# Progress, the line, and "Looked at"

What a student sees while TAi works on a message, whether they are waiting for a container, and what TAi opened to write the reply; and how an
idle container stops making a student wait. Code: `container/agent-runner/src/{protocol,progress}.ts` (the runner), `src/turn-status.ts`,
`src/sources.ts`, `src/group-queue.ts`, `src/container-runner.ts`, `src/index.ts` (the forwarding), `src/channels/web.ts`, `src/portal/server.ts`
(`status` and `sv`), `portal/web/{status,sources}.js` and `status.css` (the page). Settings: `SETTINGS.md` (`TAI_PREEMPT_IDLE`, `TAI_SOURCE_HOSTS`).

## Why: where a student waited (derived from the code, not measured by this round)

A chat container is started for a message, answers, and then waits for the student's next message: `src/index.ts` arms `resetIdleTimer()` on a result
with text, and `IDLE_TIMEOUT` (120 s, `src/config.ts`) later closes its stdin, the runner exits, and only then is the slot free
(`runForGroup`'s `finally` in `src/group-queue.ts` is what lowers `activeCount`). There are `MAX_CONCURRENT_CONTAINERS` = 5 slots. A message that finds all
five taken waits in `waitingGroups` and **did not** take an idle container's slot. So a slot is held for

    hold = start + work (W) + IDLE_TIMEOUT (120 s) + exit

W was 19-36 s on 2026-11-04 (as reported in the brief of this round; the start is not separated out). With W = 30 s, hold is about 150 s, so five slots
serve five students per 150 s. Twenty students writing at once (before a deadline) are four waves of five: the last wave starts after three holds,
3 x 150 s = 450 s (7.5 minutes), and its reply comes at 480 s (8 minutes), with the three dots and a seconds counter on screen. The brief's "about 7 minutes" is
the 450 s wait before the container even starts. Two of the five slots may be the morning patrol (`TAI_MAX_CONCURRENT_TASKS` = 2), which leaves three for chats
at 9 am. A turn that ended with no text (the answer went out through `send_message`) armed no timer at all and held its slot to `CONTAINER_TIMEOUT` (15
minutes): in the end-to-end run below, the `send_message` turn's result had `result: null`, so the old `if (result.result)` never fired for it.

With preemption a slot is held for W + exit instead: the last wave starts after 3 x (30 s + exit) = 90 s plus three exits, and its reply is at about 120 s plus
three exits; 120 s is also the floor (20 replies x 30 s of work / 5 slots). That is about 8 minutes down to about 2 (and the student sees "Waiting for a free
slot, N ahead" instead of dots for those two). The time a container takes to go away after its stdin ends was measured in the end-to-end run only as far as the
runner's own exit: 12 ms from EOF to process exit; Docker's removal of the container is not included and was **not measured**.

## The protocol

Besides its results (`---NANOCLAW_OUTPUT_START---` ... `---NANOCLAW_OUTPUT_END---`) the runner writes progress, one line each on stdout:

    ---NANOCLAW_PROGRESS--- {"type":"thinking"}
    ---NANOCLAW_PROGRESS--- {"type":"tool","name":"canvas_query","phase":"start"}
    ---NANOCLAW_PROGRESS--- {"type":"sources","seq":2,"items":[{"kind":"canvas","label":"Homework 6","url":"https://..."}]}

* `thinking`: a model request begins (pi `turn_start`; Claude Code: the session's `init`). `tool`: a call starts or ends (pi `tool_execution_start/end`;
  Claude Code `PreToolUse`, `PostToolUse`, `PostToolUseFailure`). The name is **coarse**: no `mcp__<server>__` prefix, Claude Code's names as pi's, never an
  argument, and `read_upload` for a `read` whose path is under `/workspace/group/uploads/` (every other read is TAi's own notes). `sources`: the chips one
  lookup returned (below); `seq` is the order in which the calls started (pi runs them side by side and ends them in the order they finish), and the host puts
  chips in that order.
* `idle` results now carry `received`: how many follow-up messages the runner has taken in since it started. The host counts what it piped and takes a runner for
  idle only when the two agree. Without it a stale marker is taken for a fact in two real cases: a message piped between the marker and its processing, and the
  `[SYSTEM]` nudge that `src/index.ts` pipes in answer to an empty result, which comes before the marker is read. In the end-to-end run `received` was 0, 1, 2 and 4
  at the four idle markers (two messages sent at once were answered in two turns and one marker said 4). An image that does not count leaves it out, and the host then
  takes the container for idle only if nothing was ever piped to it.
* A scheduled task's runner (`isScheduledTask`) says nothing, nor does the voice tool host (`TAI_MODE=tool-host`: its stdout is the host's protocol).
* A fourth kind, `text` (the reply as the model writes it, a preview on the page), exists only for a container started with `TAI_PORTAL_STREAM=1` and is **off by default**: with the flag
  off the lines above are all there is, and the host skips a `text` line like any other it does not know. `STREAMING.md` has the line, the filters and the safety rules.
* The host (`runContainerAgent`'s optional `onProgress`, `src/turn-status.ts parseProgressLine`) reads a line only if it starts with the marker, is under 8 KB and is one of
  the three kinds; a tool name must be `[A-Za-z0-9_.:-]{1,64}`. Events go through the same chain as the results, so a result still being delivered is not overtaken.
  Progress is **not** output: it does not set "had streaming output" (a container stopped by its timeout after only progress is still a timeout with no output) and it does
  not reset the hard timeout (a loop of tool calls is still stopped). Callers that pass no `onProgress` (the scheduler) see what they always saw.
* Container stdout is writable by whatever runs in the container (the model's `bash` can write to `/proc/1/fd/1`), so none of this is trusted: the label table and the
  host allowlist below are the boundary, and the one thing the host cannot check is whether a chip's label was really returned by the tool it names.

## The label table

The words are a fixed table (`STATUS_LABELS` in `src/turn-status.ts`; `portal/web/status.js` holds the same nine and `status.test.js` compares them). A status is never
text from a model, a tool or a student.

| Coarse name | Label |
| --- | --- |
| `canvas_query` | Checking Canvas |
| `github_query` | Looking at your GitHub |
| `piazza_query` | Searching Piazza |
| `query_knowledge` | Looking in the course materials |
| `render_diagram`, `generate_teaching_image` | Drawing a diagram |
| `read_upload` | Reading your file |
| `web_fetch` | Reading a web page |
| the model is thinking, or no tool is open | Thinking |
| `send_message`, `react_to_message`, `memory_store`, `memory_query`, `set_student_identity`, the task tools, `read`, `write`, `edit`, `grep`, `find`, `ls` | Thinking (TAi's own housekeeping is not something to tell the student about) |
| any other tool (`bash`, a new one) | Working |

`read` of TAi's own COMPETENCY.md happens every turn, so it must not say "Reading your file": only a read under `uploads/` does (`..` is resolved first). The label is the
newest tool still open; with none open it is "Thinking". A model request that begins clears every open tool (a call a guard refused starts and never ends).

## The line and preemption (`src/group-queue.ts`)

* **Status `queued`**: a message that waits for a slot. The page asks `GroupQueue.queuePosition(jid)` through the web channel when it polls, so it is never stale:
  `ahead` is the number of **other** students' messages in the line before it (a waiting task never goes before a message). It is said only when the queue gives it;
  a message that does not wait has no `ahead`. It becomes `working` when the container starts (`processGroupMessages` begins the turn).
* **`markIdle(jid, received)`** (called from the chat output callback in `src/index.ts` on an `idle` result): the container is idle when the runner has caught up with what
  was piped, nothing is queued behind it, and it is not a task's. Then the dots stop (a turn that ended with no text used to leave them on) and the idle timer starts (the
  one-line fix `if (result.idle) resetIdleTimer()`, with the exactness above; the text-result path is unchanged, so the Claude harness, which says `idle` only when its query
  ends, behaves as before).
* **Preemption** (`TAI_PREEMPT_IDLE`, default on): when a message must wait at the cap, and again each time a container becomes idle while one waits, the container that has been
  idle **longest** has its stdin closed (the runner exits at the end of it), so its slot goes to the first in line. One close per waiting message, counting containers already on
  their way out (for 15 s; after that a container that never leaves stops counting). Never a busy container, one a message was piped to that the runner has not received, one with a
  message or a task queued behind it (its slot would go to that), nor a scheduled task's. When the student of a preempted container writes while it is closing, they go to the back
  of the line: the slot is the one it was closed for.
* A student whose container was closed pays a cold start on their next message (8-18 s was measured for the voice tool host, `SETTINGS.md`; for a chat container not measured here).
  Preemption only happens when someone is waiting.
* Not changed: the stale idle timer. The timer armed by a result is not cancelled when the student's next message is piped, so it may close a container that is busy with that message
  (the runner finishes the turn and exits). Cancelling it would leave a Claude-harness turn with no text without any timer, so it was left.

## Looked at

`sources` on the history line of a reply (`src/portal/history.ts`): at most four chips `{kind, label, url?}`, drawn under the words as "Looked at: Canvas · Homework 6" in `portal/web/sources.js`.
It is **what TAi's tools returned for that message**, not what the reply cites, and the page says "Looked at". Nothing shows when no lookup ran, and never on activity cards, spoken lines or
reactions; the copy button copies the words alone.

* Collected in the runner from the tool **results**, one rule per action (`progress.ts sourcesOf`, tested over the real output of `canvas_api.py` and `github_api.py` run against
  `eval/mock_services.py`, and of the real formatters of `piazza_query.py` and `leanrag/mcp_server.py`: `container/agent-runner/test/fixtures/tool-results.json`). Never from the model's words;
  a failed call, a refusal (`{"error": ...}`) and an empty list show nothing. A call that returned up to three things gives a chip for each; a longer list gives one chip for the list
  ("Assignments", "Commits in ann/hw3"), so "looked at" is exactly what the call returned.
* Canvas: title and `html_url` (assignments, module items, a discussion); a page, the syllabus and a file have a label only (a page is named by a slug, a file's `url` is a signed download link:
  neither is ever shown); `my_grades` is "Your grades", no score. GitHub: repository `full_name` and `html_url`, a pull request `#n title` and `html_url`, a commit's sha and first line (its
  `url` when listed), a file by its `path` (the script's result has no address for a file or a directory: not made up). Piazza: `@id subject`, no address (a login is needed). Course materials:
  the documents `query_knowledge` lists as sources, by file name without folder or extension.
* The host clips again (`clipSources`): a kind from the list, one line of 80 characters (control, bidi and zero-width characters become spaces), an address only if it is https with no user
  name or port and its **host is in the allowlist**: the Canvas host (`CANVAS_BASE_URL`), the GitHub web host (`GITHUB_BASE_URL`; `api.github.com` is `github.com`; unset: the department's
  GitHub Enterprise, the default of `github_api.py`), `github.com`, and `TAI_SOURCE_HOSTS`. The course site is not guessed: it is that setting. Any other address is dropped and the chip stays as a label.
  The page checks again (https, no credentials, no port) and opens links in a new tab with `rel="noopener noreferrer"`; labels are text, never HTML.
* Reaching the message the student sees, by either path: the chips are held per chat (`SourceNotes`), and the next **answer** takes them: the result text (`processGroupMessages`) or the
  `send_message` tool (the IPC watcher, which delivers up to a second after the lookup and after the runner has gone idle, so the turn's end is not what clears them). They are cleared when a
  new turn begins (a container starts, or a message is piped to an idle one) and after two minutes; **not** when the container goes (with a student waiting it is closed within
  milliseconds of going idle, before the IPC watcher has delivered the answer). A notice that is not an answer (the apology) takes none; a patrol's `send_message` within two minutes of an
  answer that has not taken them can.

## What the page does

`/api/me` and `/api/poll` carry `status` (`{state: 'working' | 'queued', label?, ahead?}`; present only while TAi works or waits, and only while the chat is typing, so a label never outlives the
work) and `sv`, the version of it; `typing` is as before. The poll takes `sv` of the last one seen and returns at once if there is a newer one (a change between two polls is not lost); a
change wakes a waiting poll at most once a second, with a trailing wake. The typing bubble shows the label beside the dots ("Checking Canvas…", `Waiting for a free slot · 2 ahead`; "Waiting
for a free slot" alone when no place is known) in a box as wide as the longest label (no layout shift) on one line; a label that is not in the list is shown as "Working"; the note says "Waiting… N s"
for a message in line, not "Still working". A polite live region announces a change at most every four seconds (the label itself is `aria-hidden`).
With `TAI_PORTAL_STREAM=1` a `working` status may also carry `partial`, the first sentences of the reply being written, which the page draws in the bubble in place of the dots
(`STREAMING.md`); without the flag the field is never there.

## NOT verified

* The glue in `src/index.ts` (idle handling, `beginTurnView`, `answerExtras`, the waiting-line listener) has no unit test (the pure parts it calls are tested: `GroupQueue`, `TurnStatus`,
  `progressForwarder`, `SourceNotes`); it was only type-checked. Nothing was run against the real orchestrator, a real Docker daemon, WhatsApp or a real model.
* The pi hooks were run end to end only against a scripted OpenAI-style gateway and a stub MCP server serving the recorded real tool output, in a throwaway container of the live image (compiled
  with its own tsc): events for MCP and built-in tools, two calls side by side, the upload read, the `send_message` turn and `received`. The Claude-harness hooks were compiled with the image's
  tsc and never run.
* That preemption raises the number of model calls in flight at once: the model's tokens per minute, not the slot count, is the binding limit (`SETTINGS.md`, `MAX_CONCURRENT_CONTAINERS`).
  Whether the gateway's limit is reached sooner under a burst was not measured.
* Cold-start time of a chat container, and Docker's teardown time after EOF.
* That the chips of a real Canvas, GitHub and Piazza look like the fixtures (the scripts' own formatting is what is read, but the data was the evaluation's stand-in).
* The browser suite (`portal/qa/portal_e2e.py`) needs Playwright, which this PC does not have: no flow was added to it.
