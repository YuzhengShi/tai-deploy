# Chat objects, the viewer and the view

What the owner asked for (2026-11-07): during a voice call TAi should be able to put terminal output, PDFs and slides in the chat, the student should see them at the same moment and ask about them,
and TAi should know WHERE in them the student is looking. This file is the contract of the three batches that build it, written by the lead before any of them started. If a batch finds the contract
wrong it says so and the lead changes this file; it does not quietly build something else.

Built so far (the lead, tested, no feature yet): `src/chat-objects/` (the object types, their one gate, the view state and its description), `src/docs/types.ts` and `src/docs/words.ts` (what a prepared
document is and the pure functions on its words), the `object` kind in `src/portal/history.ts`, `portal/web/objects.js` and `view-state.js` with stubs for each card, the viewer's pane in `index.html`,
and the hooks in `app.js`, `src/portal/start.ts`, `src/voice/hub.ts`, `src/ipc.ts`, `src/index.ts` that carry the three of them.

**Status (2026-11-07, evening):** every batch below is built, wired in `src/index.ts` and checked on the host (the whole test suite, `tsc`, a real renderer and a real sandbox), and NOT deployed. What each one did, measured and left out is in its own file: batch A `RUN_CARDS.md`, B1a `DOCUMENTS.md`,
B1b `VIEWER_VOICE.md`, B2 `VIEWER.md`, C1 `COURSE_DOCS.md`, C2 `CARDS.md`, C3 `PREDICT.md`. What is still the owner's to decide is at the end of section 9.

## 1. The three pieces

* **Chat objects** (`kind: 'object'`): cards in the conversation beside the words. A line of the student's history with `obj` (one of the types in `src/chat-objects/types.ts`) and `text` (its one-line summary, which is what
  search, copy and a screen reader have). They are DRAWN by the page from DOM nodes, one renderer for each type (`portal/web/objects.js`); never from HTML or SVG that a model wrote. Only host code writes them, and only through
  `cleanObject` (every field bounded, no field it does not know): a model hands over DATA (a chart's numbers) and the host makes the card.
* **The view** (`src/chat-objects/view.ts`): where the student is looking, as far as the chat's own page can tell: the document and page open in the viewer, the words they selected or last clicked, the lines of a run card they
  selected, a chart's point, a trace's step, a few words of an earlier message. The page sends the WHOLE view each time; the host keeps the latest in memory (ten minutes) and describes it for the model when it is wanted:
  on every turn of a call (the relay adds a note to that request only), when a text message is sent, and when the model calls `look_at_screen`. The words of a selection are made by the HOST from the page's own words
  (`describeView`); the browser never supplies text the model reads, except a chat selection, which is the student's own and goes in as quoted data.
* **Documents** (`src/docs`): a PDF (or, in batch C, a deck) is turned into page images and the words of each page by a disposable container (no network, the Go sandbox's flags) and kept for the student; the viewer shows
  them; TAi can open one (`show_document`), point at a phrase on a page (`point_at`) and see what the student is looking at (`look_at_screen`).

The viewer, the cards and the selection helper share ONE view state object on the page (`portal/web/view-state.js`): each `set`s the part it owns, it sends the whole view debounced.

## 2. Chat objects

`src/chat-objects/types.ts` has the shapes; `clean.ts` is the one door (`cleanObject`, `objectSummary`, `clipObject`); a history line is written with `History.appendObject(raw)` or, from the voice side,
`appendChat(folder, 'assistant', '', { kind: 'object', obj })` (`src/voice/types.ts` ChatExtra). Both clean; what the gate refuses is not written. A line the history reads back whose object no longer passes is skipped.

| type | what it is | written by | page module |
|---|---|---|---|
| `run` | a run of the student's Go code: command, exit code, time, the cleaned output | the host, from the sandbox's own result (batch A) | `runcard.js` |
| `doc` | a prepared document's card (title, pages, opens at a page) that opens the viewer | the host, when `docs.open` succeeded (batch B) | `doccard.js` |
| `chart` | numbers a model gave (line, bar, scatter) drawn as DOM-built SVG | the host, from `show_chart` (batch C) | `chartcard.js` |
| `trace` | a message flow (Raft, Paxos, a request) to step through | the host, from `show_trace` (batch C) | `tracecard.js` |
| `predict` | code the student guesses the output of before it runs; their click runs it in the sandbox | the host, from `ask_to_predict` (batch C) | `predictcard.js` |

Rules: an object weighs at most `OBJECT_JSON_MAX` (24,000 characters of JSON). A card is no reply: it has no emoji, no unread count, and answers nothing. The `text` of its line is a SUMMARY: the page's search reads it, and
`recentChat` (what a call starts knowing of the chat) leaves object lines out. A card is permanent history; it never changes after it is written. What changes (a document being prepared, a run in progress) is a transient
message of the call's socket, not a line.

Page side (`portal/web/objects.js`): `registerObject(type, (entry, helpers) => ({ node, text?, destroy? }))`; a module registers on import and `app.js` imports every card module, so a card never touches `app.js`.
`helpers` is `{ el, icon, fullTime, renderMarkdown, view, viewer, toast }` (the DOM builder, the icons, the page's markdown renderer, the shared view state, the viewer API, the toast). `entry` is the history line:
`{ n, ts, role: 'assistant', text, kind: 'object', obj }`. A renderer that throws is skipped (the card is not drawn); nothing it does may break the conversation.

## 3. The view

```
ViewState = { v: 1,
  doc?:   { id, page },                              // the viewer is open on this prepared document at this page (1-based)
  sel?:   { doc, page, from, to },                   // words from..to (inclusive indexes into that page's words, reading order) are selected
  point?: { doc, page, x, y },                       // the last click on a page image, as fractions 0..1
  msg?:   { n, text },                               // words of chat line n that the student selected (<= 400 characters, as the page showed them)
  obj?:   { n, lines?: [a, b], series?, index?, step? } }   // a card on chat line n: output lines of a run card (1-based), a chart's series and point, a trace's step (0-based)
```

* The page sends the whole view. During a call: the call's socket, `{ type: 'view', view }` (voice.js `call.sendView(view)` returns true when it sent). Otherwise `POST api/view` with the view as the body (app.js).
  `parseViewState` checks everything (ids are 32 hex, pages 1..120, word indexes below 4000 and at most 600 words, fractions 0..1); a view that does not parse is dropped (the socket) or a 400 `{ error: 'bad-view' }` (the route).
  One `ViewStore` for the process (`src/portal/start.ts` makes it and gives it to the routes and, as `VoiceContext.views`, to the voice hub): a call's socket writes it, `POST api/view` writes it, readers get the latest or nothing after ten minutes.
* `describeView(folder, view, resolver, { ageMs })` makes the note for the model (English). The resolver is `docs` (meta, words, text) and the student's own chat objects (`object(folder, n)`: History.get(n).obj). It never trusts the browser's
  numbers beyond range checks: the words are the page's words, the nearest word to a click is found in the page's boxes, a run card's lines are the card's own. Everything that came from a document or a student is inside ONE quoted block
  with a marker the text cannot close, and the note says it is data. It is at most 2,000 characters; the page's text gives way first.
* **Calls**: Deepgram calls our relay for EVERY turn (`src/voice/relay.ts`). The relay takes an option `screenFor(sid) => string | undefined` (like `speechFor`) and, for that request only, puts the note in as a system message just before the
  last user message. Nothing is added to Deepgram's own conversation, so nothing accumulates (`UpdatePrompt` appends for good and must not be used for this). The note is added only while a view exists (a document open or a selection) and is
  at most ten minutes old; when the view is empty nothing is added.
* **Text chat**: `POST api/send` puts the note AFTER the student's words in the message the agent receives (a long note in front would push their words out of the start of the memory context and the interaction summary), each line opening with
  `[The student sees] ` (the reply budget, the competency and state writers already strip such lines), when a view exists, is at most three minutes old, and has changed since a note was last passed on (so a question about "this" works and a plain
  message does not carry stale screen); a send that fails takes the note back (`viewNoteUndo`). A voice note or the tap on an option does not carry it. A call that takes the message never asks for the note (it has the relay's). The talk-it-through
  kind of call has no per-turn note (its prompt does not know it).
* **Keep-alive**: a view that has not changed is still true: `view-state.js` says the same view again every two minutes while something is open (not while the tab is hidden), so the three and ten minutes above count from the last report and a student who
  reads one slide for four minutes is still looking at it for the server.
* **A pick kept while the student types**: a chart point or a trace step the student picked stays in the view when focus goes to the message box (which is how they ask about it) for two minutes (`KEEP_PICK_MS` in `chartcard.js`) and is then taken back; `CARDS.md` has the rule.
* **The model can ask**: voice function `look_at_screen` returns the same note fresh, or says nothing is open.

## 4. Documents

Layout: `<store>/portal/docs/<folder>/<id>/` with `meta.json` (`DocMeta`), `p001.png` (or `.jpg`: sniffed from the bytes, never from a name) and `w001.json` (`PageWords`) for each page. The id is 32 random hex digits and is the only thing that becomes a path
segment. Limits are `DOC_LIMITS` in `src/docs/types.ts` (source 20 MB, 120 pages, page image at most 1,100 px and 900 KB, 8 documents and 60 MB for a student, 6 opens in ten minutes and 20 a day, kept 30 days after the last open).
Batch C adds a course library (`<store>/course-docs/<id>/`, the same layout, shared by every student, read-only for them): ids are unique across both places, and every reader of the store looks in the student's own directory first and the library second.

`DocsApi` (`src/docs/types.ts`) is what everything else uses: `open(who, source)`, `meta`, `words`, `text`, `pageFile`, `list`, `library`, `searchLibrary`, `ready`, `reap`. `src/docs/docs.ts` makes the real one; tests of the voice side and the routes use a fake.

The renderer is a disposable container, like the Go sandbox's run container and with the same flags (`src/sandbox/docker.ts hardening()` is the model: `--network none`, `--cap-drop ALL`, `no-new-privileges`, read-only root, pids, memory, one CPU,
ulimits, no log driver, size-limited tmpfs, the host's user): the source file read-only at `/in`, an output directory the container may write, nothing else, nothing inherited from the host's environment. Its image is `tai-doc:live`
(`deploy/cs6650/doc-render/`: Debian with poppler-utils and python3, and LibreOffice's writer, impress and calc for Office files since batch C1: 941 MB), built by `tai_live.sh doc build` like the sandbox's. What it writes back is UNTRUSTED input: the host reads only files whose names match
`p<3 digits>.png|jpg`, `w<3 digits>.json` and `meta.json`, as regular files (lstat, no links, opened with no-follow), within size caps, checks a page image by its first bytes, and runs every words file through `validateWords`.
Nothing the container made is moved into the store as it is: the host reads the bytes and writes its own files.

The page: `GET api/doc/meta?d=<id>`, `GET api/doc/page?d=<id>&p=<n>` (the image; `nosniff`; private cache), `GET api/doc/words?d=<id>&p=<n>`, `POST api/doc/open` with `{ n, index }` (the file `index` of the student's own message `n`: the
server finds the stored name itself, the browser never names a path) or `{ doc: id }`, and `GET api/doc/job?j=<job>` while a document is prepared. Answers: `open` is 200 `{ ok: true, state: 'ready', doc, page }`, 202
`{ ok: true, state: 'preparing', job }`, or an error `{ error: 'off' | 'busy' | 'limit' | 'bad-file' | 'too-big' | 'not-found', message }`. All are `access: 'student'`, for the student's own documents only (a document of another student is a 404
as if it did not exist). `/api/me` says `features.viewer: true` when the service is on.

Messages of a call's socket, server to page: `{ type: 'show', doc, page, title, pages }` (open and go to this page), `{ type: 'point', doc, page, boxes: [[x0,y0,x1,y1], ...] }` (draw these boxes on that page of the open document for a few
seconds; `point` never navigates: when the viewer is not on that page the host sends `show` and then `point` a moment later, and the page keeps the boxes until that page is displayed), `{ type: 'doc_state', state: 'preparing' | 'failed', title?, message? }`. They are the only things TAi does to the student's screen; the viewer never runs anything a model wrote.

The viewer (`portal/web/viewer.js`, `viewer.css`; `index.html` has `<aside id="viewer" hidden>`): a pane beside the conversation on a wide screen and a sheet on a phone; the page image, previous and next, zoom, a Text tab with the page's words
(selectable by the browser), selection by dragging over the words of the image (words by index, in reading order), a click that reports a point, boxes TAi draws, close; the keyboard works (arrows, plus and minus, Escape); the call's controls stay
in reach; a reload re-opens the last document and page (localStorage, in a try/catch). It reports through the shared view state only. It is opened by `viewerApi.open(docId, page)` (a document card, a file chip's Open button, a `show` message).

## 5. What the model can do (names and arguments are fixed here)

Voice (host functions, no container; `src/voice/functions.ts`, `speech-governor.ts` FUNCTION_NAMES, `prompts.ts`):

| function | arguments | what it does |
|---|---|---|
| `show_document` | `{ document, page? }` | `document` is the title (or part of it) of one of the student's prepared documents, or the name of a file in their uploads, or (batch C) a course library entry. Prepares it if need be (answers early with "preparing" when it takes over about 8 seconds and finishes in the background), appends a `doc` card once for the call, sends `show`. Not found: the answer lists up to 8 titles. |
| `point_at` | `{ phrase }` | finds the phrase in the words of the page they have open (or the page of the document shown last when the viewer reports nothing) with `findPhrase`, sends `point`; not found: says so and gives the start of the page's text. No `page` in the model's schema since 2026-11-07: moving them is `show_document`'s (docs/VIEWER_VOICE.md section 9). |
| `look_at_screen` | `{}` | the note `describeView` makes now, or "their viewer is closed and nothing is selected". |
| `look_at_image` | `{ name, question? }` | (batch A) a picture the student attached, looked at by the tool host's own `look_at_image` (only where `TAI_VISION=1`); in the conversational and the interviewer modes. **ON since 2026-11-07** (the owner's decision): where `TAI_VISION=1` and not `TAI_CALL_VISION=0` (`RUN_CARDS.md`). |
| `find_course_document` | `{ query }` | (batch C1) a search of the course library by what its slides say; conversation only. |
| `show_chart`, `show_trace`, `ask_to_predict` | see `CARDS.md`, `PREDICT.md` | (batch C2, C3) cards made from a model's data; conversation only; they go through `cleanObject`. |

The functions of a call are now 24 (conversation), 9 (interviewer) and 6 (listener), and 25, 10 and 6 where a call may look at pictures; `VOICE.md` has the table.

Text agent (container MCP tools, `container/agent-runner/src/ipc-mcp-stdio.ts`, with an IPC verb each in `src/ipc.ts` like `sandbox_run`): `show_document({ name, page? })`, verb `doc_open`, answers `{ ok, message }` and appends the card.
`run_go` already exists; batch A leaves a `run` card for every run that happened. Batch C adds `show_chart`, `show_trace` and `ask_to_predict` for both (the data validated by the type's cleaner), and a course-library search.

A `run` card is made by the host from the sandbox's result: the voice side through `FunctionEnv.postObject`, the text agent's verb through `SandboxVerbEnv.postObject` (`src/ipc.ts` passes `IpcDeps.postObject`). The model's own words about a run
must not repeat the output: the notes it is given (`frameSandboxResult`, `runCodeAnswer`) say the student already sees the output in the chat as a card and tell it to refer to a line by its number. (The interviewer's "never put output in the
chat" was about the model pasting it; the card is the host's and the student's own program's output, and stays.)

## 6. Rules for everyone

* One gate for each thing a browser or a model can hand over: `cleanObject`, `parseViewState`, `validateWords`, the sandbox's `parseSandboxRequest`. No other code builds a card, a view or a words file from raw input.
* Nothing a model wrote is ever HTML or SVG on the page; the page builds nodes from text. No new npm or pip dependency in the tree (the renderer image installs its own Debian packages: that is the image's, built by the operator).
* The student's own data only: a route and a function know the folder from the session or the call, never from the request; ids are validated before they become paths; a document that is not the student's is "not found".
* Untrusted files go through the renderer container and nowhere else: never a parser in the orchestrator's process.
* Every bound in this file is a constant with a test. Every new route has the server's checks (a POST is JSON with the page's header and origin, the cookie, the read limit); the renderer's work is rate limited and queued like the sandbox's.
* Safe file handling as in `src/safe-fs.ts` (no following links, exclusive creates, atomic writes, reads checked against the group folder).
* Wording in briefs, prompts, comments and docs stays plain and defensive: describe what is validated and bounded, not how something could be abused.

## 7. The batches and who owns what

A file has ONE owner while a batch is running; a change to a file somebody else owns goes in the report as the exact edit and the lead applies it. Files marked CRLF (`portal/web/*.js|html|css` that already existed, `portal/qa/*`,
`src/portal/server.ts`) must keep CRLF line endings: edit them in a way that does, and look at `git diff --stat` for a whole-file change. New files may be LF.

| batch | does | owns (edits) |
|---|---|---|
| **A** | `run` cards for the text agent's `run_go` and the voice `run_code` (and the notes that say so); the selection helper "Ask TAi about this" (`msg` and `obj.lines` of the view; a button that quotes into the message box); `look_at_image` for calls; the page accepts `.tgz` and `.tar.gz` so the sandbox's upload path is reachable | `src/sandbox/ipc-verb.ts`, `src/voice/run-code.ts`, `src/voice/look-image.ts` (new), `src/portal/uploads.ts`, `portal/web/runcard.js|css`, `portal/web/askhere.js|css`, their tests, `docs/RUN_CARDS.md` (new) |
| **B1a** | the documents service: renderer image and script, runner, store, quotas, routes, `features.viewer`, IPC verb `doc_open`, the text agent's `show_document` tool, `tai_live.sh doc build|status|smoke`, a real smoke with real PDFs | `src/docs/*` (except `types.ts`, `words.ts`, the lead's: ask for a change), `deploy/cs6650/doc-render/` (new), `src/portal/doc-routes.ts` (new), `src/portal/start.ts` (routes and feature), `src/ipc.ts` (the `doc_open` case), `container/agent-runner/src/ipc-mcp-stdio.ts`, `tool-limits.ts`, `deploy/cs6650/tai_live.sh`, `docs/DOCUMENTS.md` (new) |
| **B1b** | the view on the voice and text sides: the `view` message in the hub, the latest view in the store, `screenFor` in the relay, `show_document`, `point_at`, `look_at_screen` (and the sockets' `show`, `point`, `doc_state`), the persona text, the view note in `POST api/send`; optional: `picture` mode of `look_at_screen` | `src/voice/hub.ts`, `session.ts`, `relay.ts`, `functions.ts`, `speech-governor.ts`, `prompts.ts`, `src/voice/screen.ts` (new), `src/portal/server.ts` (the send path only), `groups/global/CLAUDE.md` (the viewer section), tests, `docs/VIEWER_VOICE.md` (new) |
| **B2** | the page's viewer and the document card, the `view` and `show`/`point` handling of the call's socket, an Open button on a document file's chip, the QA harness's fake routes | `portal/web/viewer.js|css`, `portal/web/doccard.js`, `portal/web/voice.js` (`call.sendView`, `onScreen`), `portal/qa/dev_server.mjs`, `portal/qa/portal_e2e.py`, tests, `docs/VIEWER.md` (new) |
| **C** | see section 8 | |

The lead owns `app.js`, `index.html`, `objects.js`, `view-state.js`, `src/chat-objects/*`, `src/docs/types.ts|words.ts`, `src/portal/history.ts`, `src/index.ts`, and the wiring at the end. Each agent writes the exact wiring it needs from a file it does not own
as a snippet in its report.

Acceptance, for every batch: its own tests pass (`npx vitest run <paths>` on this PC for the pure parts; the host runs the rest: the scratchpad's `host_vitest.sh`), `tsc` is clean on the host, nothing outside the owned files changed,
and a real check on the host where there is something real to check (the renderer image and real PDFs; a real run through the real sandbox for a card).

## 8. Batch C (after A and B are wired and checked)

* **C1 - slides (built; `COURSE_DOCS.md`)**: LibreOffice in the renderer image (Office files become PDFs inside the container, then the same path), `doc-render` takes `pdf` or `office`; the course library (`<store>/course-docs/`), an operator command that adds a directory of decks or
  a Canvas course's files (the owner's token, read-only) and builds each deck's page images and words offline, plus a one-line description of each page's pictures when vision is on; `find_course_document(query)` and the course entries for `show_document`;
  student PPTX/DOCX through the same container; the source for a Canvas file the student names (a container tool that saves it into `uploads/`).
* **C2 - charts and traces (built; `CARDS.md`)**: their cards (DOM-built SVG, keyboard and screen-reader text, the view's `obj.series/index/step`), `show_chart` and `show_trace` for the voice and the text agent. The cleaners are written and tested (the lead: `src/chat-objects/chart.ts`, `trace.ts`, tests in `batch-c-objects.test.ts`): a model's data goes through `cleanObject` and what comes out is what the card draws.
* **C3 - predictions** (built): the `predict` card (its cleaner runs the files through the sandbox's own gate), `POST api/predict/run` and `GET api/predict/state` (`src/portal/predict-routes.ts`; the browser sends only the card's line number and the guess, the program is the card's own copy), the student's guess as THEIR line `My guess: ...` (it carries `to: n`, which is how a reload knows the card ran) followed at once by the run card, one run per card,
  and TAi told what happened: in a text chat as a message that follows the guess, with four `[The student sees]` lines and the output quoted as data; in a call as a user turn that opens `[System note, not from the student: ...]` (`hub.tellCall`). `ask_to_predict` (C2) only creates the card: the model never runs its program itself. Details: docs/PREDICT.md.

## 9. Decisions made and why

* One generic `object` kind with a typed payload, not a kind for each card: history, the server and the page change once.
* Cards are drawn from data, never from model-written markup: the page has a strict CSP, and SVG is not an image type the media store accepts for a reason.
* The view is reported by the page and described by the host, never the other way: the model cannot be told something about the student's screen that the host did not make.
* The renderer is a container because PDF and Office parsers are large and its input is untrusted; the orchestrator never parses a document.
* The per-turn note goes in at the relay because it is the one place that sees every turn and can add to a single request; `UpdatePrompt` is permanent.
* Not built: sharing the student's whole screen, live terminal mirroring, an IDE extension (secrets in terminals, cost, consent): each is a later decision of the owner.
* Decided by the owner on 2026-11-07: `look_at_image` in calls is ON (`RUN_CARDS.md`), and the course library was filled the same day from Canvas (15 decks: `COURSE_DOCS.md`). Not built in C1: a description of the pictures in a slide (no vision model reads them at import,
  only the words and boxes of the page), the old `.doc`, `.ppt` and `.xls` formats, password-protected files. A Canvas file a student names was added afterwards, differently (2026-11-07, `COURSE_DOCS.md` "Canvas files"): the host downloads it and opens it as their own document with the origin `canvas`, nothing is saved into `uploads/`.
