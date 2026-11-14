# Chart and sequence cards, and how TAi makes cards from a call or a chat (batch C2 of docs/CHAT_OBJECTS.md, 2026-11-07)

TAi can put three kinds of card in the chat from data it gives: a **chart** of numbers (line, bar or scatter), a **sequence** the student steps through (who sends what to whom, in order) and a **prediction**
card (a small Go program the student guesses the output of before it runs: its page and routes are docs/PREDICT.md). This file is what batch C2 built: the chart card and the sequence card on the page, the
functions and tools by which a call and the text agent make all three, and the words the models are given. The contract is docs/CHAT_OBJECTS.md (sections 2, 3, 5 and 6); the shapes and their one gate are
`src/chat-objects` (`ChartObject`, `TraceObject`, `PredictObject`, `cleanObject`).

## 1. What the model may send

A model hands over DATA; the host makes the card. The arguments are the same for a call and for the text agent (snake_case; camelCase is taken too):

| tool | arguments |
|---|---|
| `show_chart` | `{ title, kind (line, bar or scatter), x_label, y_label, x_unit?, y_unit?, categories?, series: [{ name, points }], note? }`: a point is a number (its x is its position in the list, a bar's its category) or a pair `[x, y]` |
| `show_trace` | `{ title, actors (2 to 8), events: [{ from, to?, label, note?, state?: [{ actor, text }] }] (at most 120), note? }`: with no `to` a step is something that happens at `from` |
| `ask_to_predict` | `{ question, action (run or test), pkg?, files: [{ path, content }], choices? }` |

Each goes through ONE builder (`chartFromArgs`, `traceFromArgs`, `predictFromArgs` in `src/chat-objects/chart.ts`, `trace.ts`, `predict.ts`) and then `cleanObject`, the history's gate, which is what the page draws. A card the gate
refuses is answered with `whyNotChart`, `whyNotTrace` or `whyNotPredict`: the first thing wrong in a plain sentence ("step 3: from is "Z", which is not one of the actors (A, B, C)", "series 2 has no point the chart
can draw", "the sandbox's check refused the program: ..."), so that the model can fix it; each is a sentence exactly when `cleanObject` gives nothing (tested over odd inputs), and each also says "too big" when the
cleaned object passes its type's cleaner but not the gate's 24,000 characters (six series of 200 pairs does not). What the cleaner LEFT OUT (series and points that were not numbers, steps that name an actor the trace
does not have, options that were fewer than two) is said in the answer too (`chartDropped`, `traceDropped`, `predictDropped`), so the model does not describe a card that is not the one drawn.

The model is told, in the descriptions, the prompt and the persona: draw a **sequence instead of a long description** when a picture of how something works helps (an election, a replication round, a request through a
service); a **chart only of numbers it was given or measured**, never numbers it made up, and say what the numbers are (`note`); a **prediction card only for a small program the student has not seen answered yet**
(the rule "predict first"), never a graded solution; and never read a card aloud or retell its steps.

## 2. The chart card (`portal/web/chartcard.js`, `chartcard.css`)

A chart object is drawn as SVG built with `createElementNS` from numbers and text: nothing a model sent is ever markup and nothing is an inline style (the CSP forbids one); the series colours are classes
(`.ch-s0` to `.ch-s5`, set from `--ch-1` to `--ch-6`, six colours for the light, auto and dark themes, 3:1 or better on the card). **Colour is never the only signal:** each series also has its own marker (circle, square,
triangle, diamond, cross, plus), its own dash for a line and its own hatching for bars (solid, diagonal, dots, the other diagonal, lines, grid; patterns are defined once per card and the legend uses the same). The page's own
icon rule (`svg { stroke: currentColor ... }` in style.css) is reset on the card's SVGs, or every label would be stroked.

* **Axes.** `niceTicks` (steps of 1, 2 or 5 times a power of ten, at most six ticks; the vertical axis reaches round the data, the horizontal one stays inside its range); a few x values (thread counts 1, 2, 4, 8, 16) are labelled
  where they are when each has room; a bar chart's categories are labelled every one when a band holds about six characters, every nth with the room of the bands it stands for when there are many. Units are in the titles of the axes
  (`latency (ms)`); the y title is at the top left, so no room is spent on a rotated one.
* **Width.** The geometry (`chartGeometry(obj, width)`, pure) is made for the width the card has, one SVG unit to one CSS pixel, and made again when a `ResizeObserver` says the width changed, so text stays 12 px on a phone (a plain
  `viewBox` would shrink it). Between 240 and 760 units wide; the height follows.
* **Reading a point.** Hover (mouse and pen) or arrow keys show the point in a **readout line under the chart** (a polite live region, never a floating tooltip): `gin, point 3 of 5: threads 4, p99 latency 31 ms`. The plot is **one tab stop**
  (`role="application"`, named, described by the keys): left and right move along a series (by x for a scatter chart), up and down change series (to the nearest x), Home and End go to the ends of a series, Enter or Space picks the
  point, Escape lets it go. A click or tap picks the nearest point within 26 units (a click on the empty plot lets it go); a finger moving over the plot scrolls the page. The readout keeps room for two lines at phone width, so the conversation does not move.
* **Show data.** A button that builds a real HTML table the first time (caption, `th scope`, grouped numbers, row N is "point N" of the readout), scrolling inside the card, for a screen reader and for copying.
* The `note` and the title are text. Nothing animates, so there is nothing for a reduced-motion setting to turn off.

**What it reports to the view** (`helpers.view.set`): `obj: { n, series, index }` when a point is PICKED (click, tap, Enter or Space): the series and the index into the series' own list, as the host numbers them (`describeView` reads
`obj.series[series].points[index]`; a plain number's x is its position and a bar's is its category). It is taken back when focus leaves the card, **with two exceptions** (see `createFocusKeeper`): when only the window lost focus,
and when focus went to a place the student TYPES in (the message box), which is how they ask about what they picked: it is kept there for two minutes (`KEEP_PICK_MS`) and then taken back. Only a part that is still this card's is
taken back (a run card's lines or another card's point may have replaced it). The card never sets the view as it is drawn.

## 3. The sequence card (`portal/web/tracecard.js`, `tracecard.css`)

A lane for each actor with its name in a pill at the top (a header of its own, sticky, so the names stay in view when a long trace scrolls), an arrow for each message with its label on it, a mark on the lane for something that happens
at one actor. A card too narrow to give each lane 96 units is made wider and scrolls sideways inside itself, and so does a long trace vertically (`max-height: min(420px, 70vh)`, `overscroll-behavior: contain`: never the page). The diagram
follows the current step by setting its own `scrollTop` and `scrollLeft` (`scrollForRow`, `scrollInto`).

* **Steps.** Steps up to the current one are solid with their labels, the current one has a band, a blue arrow and a bolder label, the later ones are dashed and faint with no label; **Show all** draws them all solid. A click on a row goes to it.
* **Controls.** Previous, Next (they stay focusable and say `aria-disabled` at the ends), **Play** (one step each 1.2 s, `PLAY_MS`; it stops at the end, when Pause is pressed, at any other control, when focus leaves the card and when the card is
  no longer on the page; pressed at the end it starts again from the first step), a native range slider (`aria-valuetext` says the step), and the arrow keys on the diagram (left and right, Home and End; up and down scroll it).
  Nothing animates and the scroll is instant, so reduced motion needs nothing; Play still steps when the student presses it.
* **The step in words**, under the diagram, in a polite live region: `Step 3 of 12`, `A to B: RequestVote` (`At A: ...` for a mark), the step's note, and, for a screen reader, the states this step gave; below it, the state boxes the actors hold after
  the step (the last state each was given; the ones this step changed say "updated").

**What it reports to the view:** `obj: { n, step }` (0-based, in the events as kept) whenever the student moves to a step, Play's steps too; taken back the same way as the chart's pick (it imports `createFocusKeeper` from `chartcard.js`).

## 4. The plumbing

**A call** (`src/voice/objects-fn.ts`; dispatch in `functions.ts`; `FUNCTION_WORDS` in `speech-governor.ts`; the prompt in `prompts.ts`): host functions in the conversation only (none in the interview or the talk-through: not in their lists, and
the dispatch refuses them too), `defer_until_eot` (a card is something the student sees), no tool host, no filler, never answered for now. Each builds the raw object, `whyNot...`, `cleanObject`, then `env.postObject` (the session's
`appendChat(folder, 'assistant', '', { kind: 'object', obj })`). The answer to a card that was made carries `card: "A card for it is in the chat now."` in the words show_document uses: the claim guard looks for "in the chat now" in a
function's result and `session.ts` counts the answer as a send to the chat (`CARD_FUNCTIONS`); it is said only when `postObject` did not throw. A call may make 5 charts, 6 sequences and 4 prediction cards (`CARDS`, counted in the call's
`ScreenState`; a refusal is not counted). The answer for a prediction card says what C3 built: the student's own press of Run runs it (once, as one of their runs), a System note brings their guess and the output, the model sets them side by side and
asks what they make of it, and it never runs the program itself with `run_code`.

**The text agent:** three container MCP tools (`container/agent-runner/src/ipc-mcp-stdio.ts`, logic and descriptions in `chat-cards.ts`) write an IPC request `chat_object` (`{ kind, args }`, the model's arguments untouched) and wait for the
host's answer file, like `show_document`; in a scheduled task and in a call's tool host they refuse at once; 6 charts, 6 sequences and 4 predictions a conversation (`tool-limits.ts`). The host's verb (`src/chat-objects/ipc-verb.ts`, the
`chat_object` case of `src/ipc.ts`) is synchronous: the student is the folder of the IPC directory (a folder that is not a registered group is refused, the admin chat may ask), the kind is one of three, a request over 150,000 characters is
refused unread, the builder and the gate make the object, `IpcDeps.postObject` leaves the card (the answer says "it is in the chat now" only if it did not throw), and exactly one answer (at most 900 characters, a twin constant in the
container, tested) is written whatever happens. A student may be given 24 cards an hour whatever a container counts (it is started again for each conversation). The log has the kind and how it ended, never the data.

**The persona** (`groups/global/CLAUDE.md`, "Charts, sequences and predictions"): the same rules, and that a card is not a reply: the agent's own words still follow (the rule that text is suppressed is `render_diagram`'s alone).

## 5. What the models are told, and what it costs

Every character of a description rides every turn.

| where | added characters |
|---|---|
| conversational function definitions (3: show_chart 1,245, show_trace 1,292, ask_to_predict 1,054 as JSON; descriptions 434, 432 and 448) | 3,591 (21,260 to 24,854, as JSON) |
| interviewer and listener function definitions | 0 |
| conversational prompt: section "CHARTS, SEQUENCES AND PREDICTIONS" (710) and rule 10 naming the functions (135 to 200) | 775 (the prompt is 12,508 of the 24,000 `PROMPT_MAX`) |
| interviewer and talk-through prompts | 0 |
| the text agent's three tool descriptions (1,086, 1,084, 1,156) and their schemas | about 3,300 and the schemas |

`functions-cards.test.ts` pins the sizes (a description at most 450 characters, a definition at most 1,300, 1,350 and 1,060, the three at most 3,600; the section at most 850) and that no schema uses `oneOf`, `anyOf` or a tuple. `points` is described in
words (`items` left open in the voice schema, `z.array(z.unknown())` in the text agent's), not as a union: a union through Deepgram and the gateway is unverified, and no other tool of the MCP server sends one. The text
agent's runtimes allow its tools by the pattern `mcp__nanoclaw__*` (the Claude Agent SDK and pi alike), so the three need no list of their own; the status line shows the generic "Working" for them, as for `run_go` and `show_document`.

## 6. Limits (each a constant with a test)

| what | value | where |
|---|---|---|
| a chart | 6 series of 200 points, 24 bars, numbers under 1e12 | `cleanChart` |
| a trace | 2 to 8 actors, 120 steps | `cleanTrace` |
| a card's JSON | 24,000 characters | `OBJECT_JSON_MAX` |
| cards in a call | 5 charts, 6 sequences, 4 predictions | `CARDS` (objects-fn.ts) |
| cards in a text conversation | 6, 6 and 4 | `TOOL_LIMITS` |
| cards a student is given | 24 an hour | `CHAT_OBJECT_LIMITS` (ipc-verb.ts) |
| the host's answer | 900 characters | `CHAT_OBJECT_ANSWER_CHARS` |
| a pick kept while the student types | 2 minutes | `KEEP_PICK_MS` |
| Play | one step each 1.2 s | `PLAY_MS` |
| the chart's width | 240 to 760 units | `CHART` |

## 7. What was checked, and what was not

Tests: `src/chat-objects/make-objects.test.ts` (the builders, `whyNot...`, what the gate left out, the sample cards), `ipc-verb.test.ts`, `src/ipc-chat-objects.test.ts` (the verb through `processTaskIpc`; needs the database, so it runs on the
host), `src/voice/functions-cards.test.ts` (definitions, prompt, the functions, the hub: the card in the chat and the session's count), `container/agent-runner/test/chat-cards.test.ts` (the tools, the twins of the host's numbers, the real
host verb against the real tools), `portal/web/chartcard.test.js` and `tracecard.test.js` (the pure parts and the card in a stand-in DOM that refuses innerHTML and every inline style).

The cards were looked at in a browser on a stand-alone page with the page's own style.css and a strict content policy (`default-src 'self'; style-src 'self'`): light and dark themes, desktop and 375 px wide, the console clean (a deliberate inline style
is the one thing that logged). Seen: the line, bar (hatching), scatter and 24-bar charts, the readout, the keyboard and a real click picking a point and the view carrying it, the pick kept when the message box is clicked and taken back
at a button, Show data, the sequence stepping with the view carrying the step, a long eight-lane trace scrolling in both directions with its header fixed and following the step. Found there: the page's icon rule stroking every label.

Not checked: the cards inside the real page (portal-dev serves only `PAGE_FILES`, so they wait for the wiring), a real finger on a phone, a real screen reader (the plot is a `role="application"` with a live readout: how NVDA, JAWS and VoiceOver
treat it is not known), a real call making a card, the container image with the new tools (it must be rebuilt), and the model's choice of when to draw (the descriptions say it; a real model was not asked).
