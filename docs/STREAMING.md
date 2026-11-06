# The reply as it is written (TAI_PORTAL_STREAM)

A student's page can show TAi's reply a sentence at a time while the model writes it, in the bubble where the three dots were, and then swap in the
reply itself. **Off by default and off for any chat on any doubt**; with `TAI_PORTAL_STREAM` unset nothing changes anywhere: no new line from the runner,
no new field in any payload, the same bytes on the wire (tests below). It extends the progress channel (`PROGRESS.md`), it is not another one.
Code: `container/agent-runner/src/{progress,protocol,pi-runner}.ts` (the runner), `src/stream-preview.ts` (what may be shown), `src/turn-status.ts`,
`src/container-runner.ts`, `src/channels/web.ts`, `src/index.ts` (the forwarding), `src/portal/server.ts` (`partial`), `portal/web/{status.js,status.css}` and the
hook in `app.js`; `portal/qa/dev_server.mjs` has a `/partial` fake. Settings: `SETTINGS.md` (`TAI_PORTAL_STREAM`). pi harness only (the Claude Code runner says
nothing).

## Why it is worth little (a measurement, not a promise)

The lead measured model calls on the live gateway before this round: median 1.3 s, p90 2 s, max 3.3 s, and replies of one to three sentences. A turn takes 19 to 36 s
and most of that is tool rounds, which the status labels already cover. The first sentence can be on the page about one sentence-length before the reply (a few
hundred milliseconds), the last sentence never is, and the page advances at most once a second (`STATUS_WAKE_MS`, left alone: a student's polls are limited).
**Under a second saved per turn is the ceiling**; the owner asked for it anyway. In the scripted run below (a model that writes 9 characters per 120 ms, much slower
than the real one) the runner had said the first sentence 1.2 s before the reply was done; the page is further behind by the host's filter and the poll (up to a second).

## How it works

    model --pi message_update--> runner (cumulative text, at most every 150 ms) --stdout line--> container-runner (only if started with the flag)
      --> progressForwarder --> WebChannel.previewEvent --> PreviewTurn (filters, holds back, checks, drops) --> status.partial
      --> /api/poll, /api/me (`status.partial`, `sv`) --> status.js previewText --> a bubble where the dots were --> the reply replaces it in place

* The runner (`TAI_PORTAL_STREAM=1` in its environment; the host sets it only for a student's chat on the web page, never the admin chat, a scheduled task, another channel or
  a voice call's tool host): `---NANOCLAW_PROGRESS--- {"type":"text","n":3,"text":"..."}`, `text` everything of assistant message `n` so far, at most 3,000 characters and one line
  per 150 ms; `n` goes up over the container's whole life; an empty `text` takes the message back (it went on to call a tool: sent at pi's `toolcall_start`, seconds before the
  tool runs; or it got too long). Nothing more of the turn after `send_message`, `render_diagram` or `generate_teaching_image` (the three tools that leave `.send_message_used`: the
  host drops the turn's closing words, so they are not previewed). pi's `message_*` handlers are registered only with the flag.
* The host reads a text line only from a container it started with the flag (`parseProgressLine(line, { text: true })`); a line of that kind that does not parse, is over 8 KB, has
  `U+FFFD` in it or a bad `n` is a `textError`, which ends the turn's preview. Such a container's stdout is decoded with a `StringDecoder` (a chunk of the pipe can end inside a
  character) and text lines are removed from what a log keeps (`withoutTextEvents`).
* `PreviewTurn` (per chat, in `WebChannel`): the accumulated text goes through `formatOutbound` and, for a student, `trimClosingFormula`, **the filters the final goes through**;
  the preview is the **stable prefix** of that: whole sentences or paragraphs followed by the first character of the next one, ending before the first tag-like `<x`, with an even
  number of backticks (no half code span or fence), a list number, an initial or an abbreviation not counting as an end. The sentence still being written is never in it. It only
  grows; a rewrite, a message number going back, a new message while words are still shown, a text over 4,000 characters, over 2,000 events or a bad line **drops** it for the rest of
  the turn (nothing shown, the reply arrives as it always did). `src/index.ts` also holds it back while `.send_message_used` exists.
* The page: `status.partial` in a status that is `working` (never `queued`). The words are drawn by the markdown renderer (nodes, never HTML) in the typing row's bubble, `aria-hidden`
  (`#messages` is a live region: the reply is read once, when whole), with the reply bubble's padding and an invisible copy of the reaction button, so the reply's bubble has the same left
  edge and width, hence the same line breaks for the words already there (measured below). When the reply arrives its row has `no-rise` (no fade-in over the preview). A response that brings
  a reply line (not an activity card) is drawn without `partial`.

## The six rules, and what holds each

| Rule | Held by | Tested in |
| --- | --- | --- |
| A preview shows only text that passed the final's filters, as a stable prefix | `previewParts`, `stablePrefix`; the check `full.startsWith(shown)` at every event | `src/stream-preview.test.ts`: every prefix of every reply, the property "what is shown is the start of the final" |
| A fingerprint, an `<internal>` tag or an options block split by a chunk leaks no byte | the partial one is always in the last sentence, which is held back; `cutPoints` never cuts inside a tag-like `<` | the same file: every fingerprint (read from `router.ts`) at every split, tags, options, a seeded fuzz of 120 replies |
| A preview is not the message: replaced in place, removed without a final, cleared at a tool | status field, never an outbox entry; `push` and `setStatus(null)` and `setTyping` delete it; `toolcall_start` and `tool start` clear it | `src/channels/web-partial.test.ts`, `container/agent-runner/test/text-stream.test.ts`, `portal/web/preview.test.js`, the look below |
| Nothing treats it as a message (history, cards, unread, title, notifications) | listeners hear only `kind:'status'` entries with no `text`; `src/notify/notifier.ts` returns on anything but typing, text and image | `web-partial.test.ts` ("is never a message") |
| Off by default, off on any doubt | env var read by the host (`portalStreamOn`: exactly `1`), set in `docker run` per chat; handlers registered only with it; every unusual event drops | `src/stream-env.test.ts`, `src/turn-status-text.test.ts`, `web-partial.test.ts` (flag off: same entries, same statuses), `src/portal/status.test.ts` (same bytes) |
| Never log what a preview contained | nothing here logs text; the drop reason is one word at debug level; logs of a streaming container's stdout lose the text lines | `stream-env.test.ts` ("are in no log") |

## What it cannot know, and other limits

* Filter rules that delete **earlier** text when a **later** marker arrives (`assistantfinal`, a `to=functions.` line, three fingerprints replacing the whole output) cannot be seen in
  advance. After the marker arrives the check `full.startsWith(shown)` fails and the preview is dropped; before it, what was shown is the model's own sentences, never a fingerprint,
  a tag or an option. (Those rules date from the gpt-oss and qwen days; whether DeepSeek ever writes such a marker was not checked.) A closed `<internal>…</internal>` block, which the persona asks for, is handled: it is gone from the filtered text.
* `.send_message_used` is only removed by a result **with text** (`src/index.ts`). A `send_message` turn that ends with an empty result leaves it, which mutes previews of later turns
  (the safe direction) and, as before this round, would suppress the next turn's own answer. Not changed here; see the report.
* The moment the reply replaces the preview is not proven to be seamless: the host pushes the reply and then stops typing a moment later, so the poll that carries the reply may still say
  TAi is typing. The preview is then not drawn (the page strips it from a response that brings a reply), but the dots come back under the reply until the next poll, and the list may scroll with it.
  This is what the dots always did; not measured in production, and in the dev server the pretend TAi never stops typing, so the look there shows the dots under the reply. A fix (no dots for that one
  response) was not built: it would hide the dots if TAi really kept working.
* A student on a flaky connection sees at most one step a second, and a reply with no stable sentence (one sentence) shows nothing before the reply.
* Replies in a language without spaces end a sentence at `。！？` followed by anything; other terminators need a space after them.

## Verified, and NOT verified

Verified (run): the unit tests above (the whole suite: the same 9 files fail as before the round, for this PC's environment); the runner in a throwaway container of the live image
against a scripted streaming gateway (`host_container_run.sh`): with the flag on 20 text lines in three turns, `n` 1 to 4, the take-back (`text` empty) written before `tool start` (5 ms
before it here, where the arguments are short), silence after `send_message`; with it off 0 text lines and the same non-text lines in the same order; `tsc` of the runner with the image's compiler; the page in the dev server
(`/partial`) at 1100 px and 375 px: the preview bubble and the reply that replaces it have the same left edge and width (700 and 307 px), same reaction-button room, no fade (`animation: none`),
no horizontal scroll, the draft `aria-hidden`; one screenshot (dark theme).

NOT verified: a real model, the live gateway or a real Docker daemon (the glue in `src/index.ts` has no unit test; it type-checks); the real Pi `message_update` rate and the real latency
saving; the light theme and tablet width; a screen reader; many students at once; the Claude Code harness (it never writes text lines); the browser suite (`portal/qa/portal_e2e.py` needs Playwright).
