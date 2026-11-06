# How much TAi reads like a bot

Every change to how TAi writes or speaks used to be found by the owner reading a chat or a call transcript by hand. This is the same
reading, counted: `bash deploy/cs6650/tai_live.sh humanness [--days 7] [--split ISO] [--judge N] [--include-main]` (read-only, on the host;
`src/humanness/`, `node dist/humanness/cli.js` there). It reads the page's histories (`store/portal/*.jsonl`), the call transcripts
(`groups/*/competency/voice-transcripts/*.md`) and the relay's dump (`TAI_VOICE_RELAY_DUMP`); the teaching-team chat (`main`) is left out
unless `--include-main`. `--split` puts the replies before and after a change side by side; `--judge N` has the gateway's model grade a
sample of N exchanges (see below).

## What is counted

| Column | Meaning | Where it came from |
|---|---|---|
| words: mean / median / p90 / max | length of a reply (Chinese counts two characters as a word) | 2026-11-02, the owner's own chat: 28 replies, median 59, longest 229, for questions of 5-7 words |
| over 60 words | the persona's hard cap for a reply nobody asked to be deep | `groups/global/CLAUDE.md` |
| bullets, bold | a list or a bold label in a chat message | the persona forbids both; gpt-oss wrote them in about a third of its replies |
| closing formula or offer | the last sentence is "let me know if...", "feel free...", "need anything else?" or "would you like me to...?" | the chatbot tell the owner kept finding |
| ends with ? / 2+ questions | a question at the end of nearly every message; two or more in one | the old persona demanded exactly one question at the end of every reply |
| 2+ links | a list of links, with their signed addresses | |
| same opening words | of the last 30 replies, the share that start with the same two words as another | |

Voice: the same shapes on TAi's turns (over 40 words is long for speech), the short lines said more than once in a call ("one sec." four
times is a script), and from the relay's dump the share of requests whose sentences the speech governor cut, the function calls the model
wrote as text, and the answer time.

What the students did: the emoji they put on TAi's messages and the ratings (`kind: 'feedback'`: up, down, and why: too long, sounds
robotic, wrong, other), with the length of the replies marked too long.

## The judge

A model grades up to N exchanges (half typed, half spoken, evenly spaced over the period) on three scores of 1-5, **human** (sounds like a
person), **brief** (as short as the question deserved), **honest** (claims nothing it could not know), and names up to three tells ("closing
offer", "bullet list"). It is a model grading a model: good for a trend and for the list of tells, not for a verdict on one reply. It needs the
gateway key, which `tai_live.sh humanness` reads from `orch.env` and never prints.

## What keeps replies short (src/reply-shape.ts)

* The persona's first section, "How you write" (`groups/global/CLAUDE.md`): length follows the student's message, answer first, no closers,
  plain text, their language, don't narrate yourself, don't describe what you did not read.
* A `<reply_rule>` after the student's messages (`withReplyRule`, `src/index.ts`; not in the teaching-team chat): a word budget worked out from
  what they wrote (a five-word question about 25 words, an explanation 60, "in detail" 110 in paragraphs, a pasted error in proportion, half
  of that after "too long"), the shapes to avoid, and the language to answer in when they wrote Chinese, Japanese or Korean. gpt-oss and qwen
  both keep to it; a rule inside 28 KB of persona is outweighed by what sits next to the question.
* The same line tells the model to look when the student asks whether it **can** open, read or find something ("can you view the first pdf?"):
  gpt-oss answered that from memory ("I can't open PDFs here", no tool call) in six of six tries, with the old persona and the new, and read the
  PDF as soon as the same words were a task; with the line four of four used `canvas_query` and answered from what they saw.
* The persona says what the page's bracketed notes mean ("[The student said your earlier message was too long: ...]": shorter and plainer from
  here on, never quoted back), and that the teaching-team chat keeps the format its own group file gives it.
* `trimClosingFormula` takes a closing formula ("Let me know if you need anything else.") off the end of a reply; an offer or a question that
  says something stays.
* `TAI_REPLY_RULE=0` (orch.env, then restart) switches the last two off; the persona stays.

Measured on 24 of the owner's real messages, one answer each after the facts a tool would have returned, K=3 (the probe is in the session's
scratchpad, `style_probe.mts`; it calls the gateway through ssh, so the key stays on the host): the old persona 61 words on average (median
53, longest 184; bold in 24%, bullets in 11%, a closing formula or offer in 17%, two questions or more in 18%); the new persona and the
rule 24 words (median 20, longest 118; no bold, no bullets, 7% closers, 3% two questions). qwen: 25 words. The real agent after the deploy
(isolated smoke chats, nine of the owner's questions, one answer each): 27 words on average, median 22, longest 56; the owner's own chat
before it: 64 / 56 / 215. Not measured: the real agent over a week of real chats: run this report with `--split` at the time of the change.

## The voice model

The voice's thinking model is `TAI_VOICE_MODEL` (gpt-oss) and the relay's speech governor is written around its habits. Compared on the owner's
long-call scenarios (`probe_voice_ab.mts` in the session's scratchpad; six runs of four scenarios): gpt-oss 15 spoken words, the governor cut
nothing, 1.4 tool calls a run, and on "can you read the YouTube video" it answered evasively or off the point five times in six ("sorry, that's
a bit long"); qwen 26 words, the governor cut a sentence in 29% of runs, 2.2 tool calls a run, and said honestly that it cannot watch a video,
in six of six. The talk-it-through listener needs qwen (gpt-oss wrote a script of nudges and feedback in one answer: `TAI_VOICE_TALK_MODEL`,
default qwen, `VOICE.md`). The owner chose to move the conversation to qwen as well (`TAI_VOICE_MODEL=qwen`, live since 2026-11-02 22:14 UTC): it shares
Nora's qwen bucket under the budget guard, and the extra tool calls cost a second or so on a look-up. On the relay's dump the requests took a
median of 620 ms with qwen (3 requests) against 462 ms with gpt-oss (4 requests): too few to say more. Not measured: the call's answer time
with each model on a real call (`LatencyReport`). Back: `tai_live.sh set TAI_VOICE_MODEL=gpt-oss`, then `restart`.

## What is not verified

A real microphone, a phone, Safari and Firefox (the browser checks use Edge and a fake Deepgram); the talk-it-through entry through a signed-in browser (the e2e has it against a fake server). The thumbs and the
"What TAi remembers" sheet that this report once counted were taken off the page on 2026-11-03: the report still reads the thumb lines that
earlier histories hold and finds none after that; Deepgram's acceptance of the talk-it-through's end-of-turn settings in a long call (a smoke call of 20 seconds
was answered); the slow-look-up promotion (`TAI_VOICE_ASYNC_AFTER_MS`, off: unit tests and a probe with qwen only).

## Known limits

* A model that offers a rundown of a video it cannot open and is then asked for it writes one anyway, in any length (the owner's chat, n=93).
  The persona now says not to offer, and to take an offer back; a single-turn "the videos posted in Canvas" is answered honestly in every probe.
* The first reply to a student with no history used to be the introduction instead of an answer; it is now one sentence and the answer.
