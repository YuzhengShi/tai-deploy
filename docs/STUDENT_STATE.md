# What TAi remembers of a student's work (design, 2026-11-06)

The owner asked (after a real mock interview) for persistent per-student state: "remember their repo, their past bugs and their competency, so each session picks up where the last one stopped".
Competency already persists (COMPETENCY.md, written by the host: `docs/STUDENT_MODEL.md`). What was missing is three small kinds of fact, and they go where TAi's notes about a student already live,
not in a new store: the `memories` table of the orchestrator's database (`src/memory.ts`), which the text agent reads (`memory_context.md`, `memory_store.json`), the voice call reads
(`src/voice/context-builder.ts`), and the server shows in "What TAi remembers" (`GET api/memory`, `POST api/memory/forget`, `src/portal/memory-view.ts`): the PAGE no longer has that sheet (removed 2026-11-03, docs/PORTAL.md),
so see "Open: the notes have no page" below.

## The three kinds (new categories of `memories`)

| category | what it is | key (one row per key, newest wins) | value | text | lives |
|---|---|---|---|---|---|
| `repo` | the GitHub repository that holds their code for an assignment | `repo:hw2` (a numbered homework: the same assignment next term has another Canvas id); `repo:<canvas assignment id>` only for an assignment with no number, and only from an interview | the repository name only (no owner: the account is the host's binding) | "Their code for Homework 2: MapReduce, Terraform, and Docker is in their repository `name`." | decay class `stable` (90 days), refreshed whenever it is used again |
| `thread` | where the last session stopped: what is left open, the next step | `thread:<slug of the topic>` | none | one sentence, dated: "Left open on Nov 6: ..." | decay class `active` (14 days) |
| `issue` | a concrete problem in THEIR work that they hit, described or showed: a bug, an error message, a design flaw, with where it was and (if known) how it ended | `issue:<slug>` | none | one sentence, dated, about 160 characters at most | decay class `stable` (90 days) |

Caps per student: 20 `repo`, 3 `thread`, 12 `issue`; past the cap the oldest of that category goes. A write with an existing key REPLACES that row (and renews its time): `upsertWorkFact` in `src/memory.ts`.
These rows are written by the HOST only (`source = 'host'`): the model's `save_memory` does not offer these categories, and the watcher of the container's IPC files refuses them whoever sent the file (`memoryStoreVerdict` in
`src/ipc.ts`, tested). The readers below check every value anyway (a `repo` can only name a repository of the student's own account, which is all the host ever reads, and every text is bounded again when it is read).

## Who writes them

1. **repo, from reading**: in a mock interview, when the interviewer's `query_github` (`file_content` or `repo_tree`) succeeds for a repository while the interview is of assignment A, the host records `repo:A`
   -> that repository (`src/voice/functions.ts`, the interview branch of `query_github`). The student's own words chose it ("it is in cs6650-hw2") or the matcher did; reading it is the proof it is theirs.
   A repository whose name belongs to another homework (`cs6650-hw2` read in an interview of HW3, or code of HW3 in `hw2-reuse`) is not remembered and not used (`repoMismatch`).
2. **repo, from matching**: when `lookUpRepo` (`src/voice/interview-repo.ts`) finds a repository for the interview's assignment, the same row (so the next interview starts from it).
3. **thread and issue, from a finished voice call** (`src/voice/session.ts postSessionSync`): the call-state extractor (below) reads the call's transcript and facts once.
4. **issue, from a text exchange**: after a substantive exchange whose student message shows code or an error or names a repository (a cheap prefilter), the same extractor (below), under its own per-student daily cap.
5. **repo, told**: the extractor may also report a repository the student NAMED as the home of an assignment's code ("my HW2 code is in cs6650-hw2"); it is kept like 1.

The **call-state extractor** (`src/student-state-writer.ts`) is a host-side model call (the gateway, the model of the competency writer: `TAI_STATE_MODEL`, default the competency writer's whole chain of model settings) that never talks to the
student. Its prompt follows the competency extractor's rules: what it reads is DATA (the exchange or the transcript, with angle brackets neutralised), it reports only what the STUDENT said or showed (never what TAi
guessed or claimed), at most 2 issues, 1 thread and 1 repository, each with a confidence, and the host keeps only confidence 0.85 or more; "when in doubt, report less". Everything it returns is
bounded by the host before it is stored: one line, 160 characters, no angle brackets, backticks, links, e-mail addresses, long digit or hex runs (ids, hashes, tokens), a repository name only by `^[A-Za-z0-9._-]{1,100}$`.
A conceptual confusion is NOT an issue (COMPETENCY.md's misconceptions hold those). The host keeps a repository only when its name is in the student's own words (not just the assignment's label, and the assignment must be a numbered homework), a thread only from a call, and at most 2 issues. `TAI_STATE_WRITER` is `on` (default), `shadow` (runs and logs counts, writes nothing) or `off`;
`TAI_STATE_DAILY_CAP` (default 20) counts its model calls per day for EACH student (typed exchanges may use three quarters of it, a call may use all of it); a failed model call also pauses typed exchanges for 60 seconds. A failed call, an unparsable answer or a full cap writes nothing and breaks nothing.

## Who reads them

* **The text agent**: `buildMemoryContext` (`src/memory.ts`) adds a section "Their work, from earlier sessions" with the student's `repo`, `thread` and `issue` rows (the other memories are
  searched by the words of the prompt and may not come up; these are not subject to it), the two newest repositories, two threads and three issues, cut to six lines, with a note that they may be out of date: use them to ask, never to assert.
  A resumed session keeps the section too (`storedMemoriesOnly` in the container's `prompt.ts`). The three kinds are kept out of the generic "Stored memories" list, so nothing appears twice.
* **The voice conversation and the interviewer**: the context builder (`loadStudentContext`, a `workFacts` dependency that reads the database; the export file `memory_store.json` is only the fallback: in production the voice
  `memories` dependency is not wired, `workFacts` is) gives the same lines to the conversation's prompt (six lines at most), and the interviewer's prompt gets a block of its own: the repository of the interview's own assignment (on a key
  match only), the newest thread, up to three issues, QUOTED as data like every text a student's words shaped (`quoted` with the call's nonce), with a note and one rule: ask about at most ONE of them, once, never as the first
  question. The block never costs the interview anything: an interview that starts from the chat (the usual one) gets it in the late update that brings the assignment's material, and only when the update fits its room with the
  material at its most generous level; one that starts from a link with a fresh `interview_context.json` has it in its first prompt, if the prompt fits `PROMPT_MAX` with it. The listener (talk-it-through) has none. The `recall_memory`
  file fallback no longer finds the three kinds: they come through the block.
* **The interviewer's repository**: `listRepository` asks the remembered repository of the interview's assignment first: it lists that repository's files directly; when it no longer exists the row is
  forgotten and the matcher runs as before.
* **The server's "What TAi remembers"** (`api/memory`) lists the notes with the words "Your code", "Where we stopped" and "A problem you ran into"; `api/memory/forget` takes one back by its id.

## What it is not

Not a score, not a grade, not a judgement of the student; not a copy of their code or of what they said (a one-sentence paraphrase, dated); not shared with other students; not shown on the teaching team's page.
Nothing here runs or reads code (that is a separate, later decision: a sandbox). A note expires by itself (the decay classes above).

## Open: the notes have no page

The sheet "What TAi remembers" was taken off the page on 2026-11-03 (docs/PORTAL.md: no account-menu entry, no dialog, no `memory.js`); the server calls stay and work, unused. So today a student cannot SEE these notes or take one
back from the page, and `src/ipc.ts`'s activity card for a note still points to an account-menu entry that does not exist. The notes are about the student's own work and are paraphrases a model wrote: before students other than the owner
are on the list, either the sheet comes back (a minimal one: the notes and a Forget button, nothing of COMPETENCY.md) or the writer is switched to `shadow` (`TAI_STATE_WRITER=shadow`). The owner decides.

## Tests and checks

The database code is tested on the host (this PC cannot load the native sqlite module): `host_vitest.sh src/memory-work.test.ts src/memory-context.test.ts src/ipc-memory-store.test.ts` (a script that tars the working tree to a scratch directory on the host, links the live `node_modules`, runs vitest there and deletes the copy). The extractor is tested with a fake gateway,
the readers and the panel without a database, and the whole with mutation checks. A real-model pass with scripted students (a pasted Go deadlock, an error message, "my code is in X", a conceptual question, small talk, TAi's claims the student never made, four sorts of prompt injection, calls) checks what the extractor keeps: 32 cases, 3 runs each, on `deepseek`, 96 of 96 right (2026-11-06).
