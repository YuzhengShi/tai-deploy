# Run cards, "Ask TAi about this", pictures in a call, and archives (batch A of docs/CHAT_OBJECTS.md, 2026-11-07)

The owner asked that terminal output be in the chat as a thing the student can read, select and ask about, not only words that TAi says. This document is what batch A built: the card a run leaves in the
chat, the selection helper that lets the student ask about what they selected, the voice function that looks at a picture, and the page's acceptance of `.tgz` and `.tar.gz` so that the Go sandbox's attached-archive
path can be reached. The contract is docs/CHAT_OBJECTS.md (sections 2, 3 and 5); the sandbox is docs/GO_SANDBOX.md.

## The run card

A run card is one line of the student's history with `kind: 'object'` and an `obj` of type `run` (src/chat-objects/types.ts `RunObject`): the command, whether it ran, the exit code, whether it timed out, how long it
took, the program's cleaned output, whether the output was cut, and one sentence of the host's. Only the host writes it, from the sandbox's own result and the request the sandbox's gate validated
(`src/sandbox/run-card.ts`); a model never writes one and never sees the card as something it made.

**When one is left.** After a run that HAPPENED (`SandboxResult.ok` true): the text agent's `run_go` (src/sandbox/ipc-verb.ts, through `SandboxVerbEnv.postObject`, which `src/ipc.ts` passes from `IpcDeps.postObject`) and the
voice function `run_code` (src/voice/run-code.ts, through `FunctionEnv.postObject`). A refusal, a busy sandbox, a limit answer, a runner that failed or did not answer in time are sentences for the model and leave
nothing. In a call, only a run that finished inside the function's wait (50 seconds) leaves one: a run that is still going when the function answers has no card, and its late result is not delivered either.
The card is made BEFORE the answer goes back to the container or the call, so it is in the chat before TAi's words about it; the watchdog's late result (the text agent was told the run may or may not have happened)
leaves none.

**What is in it.** `command` is the host's own words for the request (`commandLine`); the numbers are the result's; `output` is the program's text with terminal escapes and control characters taken out and the middle cut
when it is long (`cleanProgramOutput`, at most `RUN_OUTPUT_CHARS`, 16,000 characters). The card is made from the whole result, not from the shorter cut the model is given (6,000 characters for the text agent, 1,800 in a
call). The chat's history takes an object only through `cleanObject`, which refuses one whose JSON is over `OBJECT_JSON_MAX` (24,000 characters), and JSON doubles every quote, backslash, tab and line break (a lone surrogate
becomes six characters): so `runCard` builds the card through the same gate and cuts the output further, in the middle, until it passes (tests: all quotes, all backslashes, tabs, lone surrogates). A run that
happened always leaves a card. The first cut leaves room under the gate's own cap, so that the output is never cut a second time with a wrong count of the characters left out.

**What the model is told.** The note in the framed result says, only when the card was really left (`frameSandboxResult(..., { card: true })`, `RUN_CARD_NOTE`): the student already sees this output in the chat as a card; do
not paste it or read it out again; a line can be named by its number (the first line is line 1; after a line that says characters in the middle are not shown, the card has more lines than the model was given, so it names
no number there). When no card was left (nothing wired, the posting threw), the note is the one there was before cards. The voice note still tells the model to say one or two sentences and never read the output aloud;
the interviewer's "never put it in the chat" is now "never put it in the chat yourself" (the card is the host's, and stays).

**On the page** (`portal/web/runcard.js`, `runcard.css`): a header with the command, a badge in words (`exit 0` calm, `exit N` red, `timed out` amber, `stopped` amber, `did not run` grey: the colour is never the only signal)
and how long it took (the time of day is its tooltip); the output as numbered lines in a region the keyboard can reach (`tabindex="0"`, `role="region"`, named for its command and its number of lines); a note line when the host
had a sentence; a foot with "Show all N lines" (the output is folded to its first 24 lines when it is longer) and Copy (the whole output as it is). Everything is DOM built from text: nothing the program printed is ever
markup. The numbers are a column of their own, not text of the output: a selection and a copy never carry them (`user-select: none`, and a `copy` handler that puts only the selected text on the clipboard as plain text).
Lines of `go test` output are coloured by a classifier of a line each: `ok  pkg`, `PASS` and `--- PASS` green; `FAIL`, `--- FAIL` and `panic:` red, and so are Go's `fatal error:` and the race detector's
`WARNING: DATA RACE`; the rest plain. The look is the page's own tokens (`--bubble`, `--code-bg`, `--line`, `--ok`, `--danger`, `--mono`, and the warm tone of `--name-interviewer` for amber), in the light, auto and dark
themes. At phone width the output scrolls sideways inside the card with the numbers staying in view, never the page. The conversation is a polite live region, so the card sets `aria-live="off"`: it is not read out line by
line as it arrives (the Copy button's own status still is).

**The selection.** What the student selects in the output is part of the view (docs/CHAT_OBJECTS.md, "The view"): `obj: { n, lines: [a, b] }`, numbered the way the host numbers them (the output split at its line breaks,
the first line 1; `describeView` quotes the same lines back). One listener of the page's `selectionchange` serves every card; it reports once the selection has been still for 300 ms and takes its report back when the selection
empties or leaves the card, and only its own (a chart card may have set `obj` since: batch C). A line break at an end of a selection holds no line of its own (a triple click ends at the start of the next line), a span of 400 lines
or more is cut to 400 (the view keeps no longer range).

## Ask TAi about this

`portal/web/askhere.js`, `askhere.css`. The selection of words in TAi's messages (the `.md` inside `li.row.assistant[data-n]`, and the lines TAi said in a call: `li.row.speech.tai[data-n] .say-text`) becomes `msg:
{ n, text }` in the view: one line of at most 400 characters, cut the way the host cuts it, once the selection has stopped changing for 300 ms. Both ends must be in the same message (a drag over several messages is
none); a triple click, which ends at the start of the NEXT block, counts for the part inside the message.

A chip above the message box offers to ask about it: the words (shortened) with an "Ask TAi" button and a way to send it away. It is drawn over the conversation, never into it (absolute, like the "N new messages" pill;
it rides above the pill when both are there), so it never moves a line of the conversation; selection handles and the browser's own toolbar make a floating button at the selection unreliable on a phone. "Ask TAi" calls
`quote(text, { focus })`: the words go in the message box as a quotation (a message's words as they were selected, lines kept; a card's lines under "Lines 3-5 of go test ./...:"), `focus` is true only where the page has hover
(a phone's keyboard would cover the conversation), and the chip and the browser's selection go away. In a call (`inCall()`) the button says "Ask TAi by voice" and only shows the toast "Now say your question": the view
already carries the selection, and TAi hears it on its next turn. Tapping the chip must not undo the selection it is about: a mouse button down on it does not clear the selection, and while a pointer is down on it changes of
the selection are not acted on (for as long as the pointer is down, at most five seconds). The chip is a labelled group, its buttons are real buttons, and what it shows is said politely by a live region that is always there.
The decisions are `createAskModel` (pure, tested with a clock the test turns).

## Looking at a picture in a call

`src/voice/look-image.ts`: `LOOK_IMAGE_DEF` (arguments `{ name, question? }`) and `lookAtImage(args, env)`. It maps onto the tool of the same name that the student's agent container has (`look_at_image`, docs/VISION.md), the
way `read_file` maps onto the container's reader: the call's tool host runs it. It checks the name like the other upload names (letters, digits and `._-`, at most 100 characters, a picture's extension, the file name only),
builds the path itself (`/workspace/group/uploads/<name>`), says that it is not available unless the host's switch is on (`TAI_VISION=1`, src/vision-env.ts: the same one the page's words follow), looks at each picture once
in a call (the first description is kept in the call's cache and handed back, not fetched again), and relays the tool's answer, which the container frames as data. The picture goes to an outside vision service: the
description of the function says so.

**Offered to a call (since 2026-11-07, the owner's decision).** ONE switch decides everything a call does about pictures: `callVisionOn` (`src/vision-env.ts`), that is `TAI_VISION=1` and not `TAI_CALL_VISION=0`. Where it is on:
(1) the call's tool host is started as a student's chat container is for the tool (`spawnToolHost` asks `visionForCall`: `-e TAI_VISION=1`, and the alias when `TAI_VISION_MODEL` names one), so that `buildMcpServers` gives the nanoclaw server the gateway's
completions URL, the key the container already holds as a secret (the key a student's chat container holds: the host makes no second copy of it, and none is on a command line) and the alias, and the server registers `look_at_image`
(`container/agent-runner/src/vision.ts`: the exclusion of the tool host is gone); the tool host counts the five looks of a call (`TOOL_LIMITS`) and takes the key out of any answer, as it does every secret it was handed;
(2) `functionsFor` gives the conversation and the interview `look_at_image` right after `run_code` (the listener never; the contract's lists are as they were: 25 and 10 functions where the switch is on, 24 and 9 where it is off);
(3) the conversation prompt's sentence about pictures says to look once at a picture the message names with the function (`pictureRule` in `src/voice/prompts.ts`), instead of "You cannot see pictures";
(4) `UploadStore.messageFor(..., 'call')` names a stored picture with the function (`callVision`: `src/portal/start.ts` passes `callVisionOn`), still after `(a picture, ` and without the words "you cannot see pictures", so that the page's notice (session.ts) shows only for a
picture that still cannot be seen. `TAI_CALL_VISION=0` (`tai_live.sh set TAI_CALL_VISION=0`, then a restart) takes all four away from calls and leaves the chat's picture reading as it is. The picture goes to z.ai through the gateway's `glm-vision` alias, as it does from the chat;
the function's description tells the model to say so if the student asks. Tests: `src/voice/look-image-offered.test.ts` (the lists, the prompt, the switch), `src/vision-env.test.ts` (the tool host's start with and without the switch), the container's `vision.test.ts` and `vision-mcp-env.test.ts` (the tool in a tool host).

## Archives the page accepts

The sandbox's `upload` source takes a `.go` file or a `.tgz` / `.tar.gz` archive of a project (`parseSandboxRequest`). The page's file picker now offers them: `src/portal/uploads.ts` has a kind `archive`, recognised by the
NAME (it ends `.tgz` or `.tar.gz`) AND the first bytes (gzip's, `1f 8b`), no larger than any other file (`UPLOAD_MAX_BYTES`, 5 MB; the sandbox takes 20). A renamed file is refused (415), and so is a plain `.gz`. The extensions
the server lists for the picker are `tgz` and `gz`: the page keeps single extensions without a dot (`readFeatures`), so a `.tar.gz` can only be matched by its last one; the server decides again.

An archive is kept in the student's `uploads/` like a document and cleaned up like one (taken back, expired). Its name keeps `.tar.gz` whole: a second `project.tar.gz` is `project-2.tar.gz`, not `project.tar-2.gz`, and
the 80-character cut keeps the ending, because the sandbox's gate refuses a name that does not end `.tgz` or `.tar.gz`. A name never starts with a dot, an underscore or a dash (the gate wants a letter or a digit first,
and a dash can pass for an option). The agent is told, in the style of the other attachments: `- /workspace/group/uploads/project.tgz (archive, 1 MB): a project they packed, not text to read; run it with run_go using
upload: project.tgz (action run, test, vet or build; pkg is a package inside the project, like ./...)`; a call is told `run_code` instead. The archive is never unpacked on this side: the sandbox's own containers do that.

## What was checked, and what was not

Pure tests: `src/sandbox/run-card.test.ts`, `ipc-verb.test.ts` (the card, its order, the words the model is told, the watchdog), `types.test.ts`; `src/voice/run-code.test.ts`, `look-image.test.ts`;
`src/portal/uploads-archive.test.ts`, `uploads-vision.test.ts`; `portal/web/runcard.test.js`, `askhere.test.js`. The page was checked in a browser against the QA dev server and a stand-alone page: the card in the light and the
dark theme and at phone width, the sideways scroll with the numbers in view, the fold, a real selection and a triple click (the lines the view carries, the chip, the quotation, in and out of a call), the chip beside the
"new messages" pill, and that the chip does not move the conversation. Not checked: a real finger on a phone (a long press in one of TAi's bubbles opens the emoji picker and clears the selection: `wireLongPress` in app.js,
so on a touch screen the words of a message cannot be selected by a long press; a card's output can), a real screen reader, a real run through the real sandbox, and a real call with a picture.

**Checked live after the deploy of 2026-11-07 (16:38 UTC).** A real voice tool host, started as a call starts it (the live agent image, the live `.env` and the service's own settings), was ready in 12.3 s and looked at a bar chart drawn for the purpose (four bars, the last the tallest) through the real tool, gateway and z.ai vision model: it answered in 10.3 s the first time and in 4.3 s and then 3.2 s on a second run (the first look of a cold tool host can be slow; a call says its pre-written "taking a look" lines meanwhile) and the description named four bars and the tallest, framed as data; a path outside the uploads folder was refused; nothing was left behind (no container, no folder). A synthetic call afterwards went through with no error. Not checked: a real student's call with a real picture.
