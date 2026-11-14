# TAi's call on a self-built voice chain (the voice lab): design, criteria, results

Branch `claude/voice-selfbuilt-289fc0`, cut from `voice-lab-base` (a5ee859, the snapshot of the live working tree of 2026-11-13).
Everything here is behind **`TAI_VOICE_LAB`** (default off). **Nothing is deployed, nothing on the live host is changed, until the owner says "部署".**

## 0. The question, and how it will be answered

Today's call is a Deepgram Voice Agent: recognition, turn-taking, synthesis and barge-in are one hosted service, and its recognizer must be
Deepgram's own (Deepgram's docs, read 2026-11-13: the agent's `listen` provider type "must be deepgram"; own endpoints exist for think and
speak only). LabGPU's GPU box (lab-gpu, 192.0.2.29) has a recognizer that is far better on CS terms (Qwen3-ASR on `:8803`) and a TTS
(`:8805`). Using it means building the chain ourselves. On 2026-11-05 the owner said that is worth doing only if it **reproduces today's call
quality**; on 2026-11-13 he reopened it. So this is an experiment with a verdict, not only a build:

> **Does a self-built chain (LabGPU's recognizer and synthesizer, our own end-of-turn, barge-in and fillers) reproduce the quality of today's call?**
> Verdicts: *reproduces* / *partly* / *does not*, decided by the rule in section 9.6, written before any lab measurement.

Synthetic tests are necessary and not sufficient: the verdict needs the owner's real calls too (he is a Chinese-L1 speaker; the synthetic
voices are native and say nothing about that).

**Order of work, and what was read before the criteria.** Orientation (code, docs, Nora's `nora/voice.py`, `agent/lk_audio.py`, `agent/asr.py`,
`agent/tts.py`, `tools/cs6650/speech_check.sh`) and a read-only look at the live call's own latency log (section 2: the baseline) came first.
**No lab number existed when this file was committed**: every lab measurement (section 10) is dated after the commit of this file, and the criteria
in section 9 are only changed through the amendments log (section 11).

## 1. What "today's call" is (the reference)

`portal/web/voice.js` (microphone, AudioWorklet, 16 kHz PCM16 up, 24 kHz PCM16 down) -> `/tai/api/voice` -> `src/voice/hub.ts` -> `VoiceSession`
(`src/voice/session.ts`, one per student) -> **one websocket to `wss://agent.deepgram.com/v1/agent/converse`**:
`Settings` (listen `flux-general-en` v2 with `eot_threshold` 0.75/0.88/0.9 and `eot_timeout_ms` 5000/8000/10000 for chat/interview/talk, `KEYTERMS`;
think = our relay `/voice-llm/v1/chat/completions` with a bearer token; speak `flux-hannah-en` (chat and talk) or `aura-2-mars-en` (interview) at the student's
pace; greeting; `context.messages`), then audio both ways. Deepgram posts every think request to the relay (`src/voice/relay.ts`: rewrite, speech filter and
governor, handoff silence, screen note, dump), and sends `FunctionCallRequest` events that `session.ts` runs through `src/voice/functions.ts` (24/9/6 definitions in
three modes, 29 distinct, pinned by `functions.test.ts`; 25/10/6 on the live host, where `look_at_image` is offered in calls; the tool host in a container, host-side code). Fillers ("one sec", "still looking") are **`InjectAgentMessage` lines written by `session.ts`** at 1.5 s and 6.5 s of a
long function: they are not Deepgram's, so they are the same on any chain that speaks the same protocol.

## 2. Context: what the live call does today (read before the criteria, from the live log)

Source: `journalctl -u tai-live`, the line "voice turn latency" (Deepgram's own `LatencyReport`), 214 turns of the owner's real calls from
2026-11-06 to 2026-11-10 (model DeepSeek since 11-04; the owner's account; no student words read). **Definition caveat:** Deepgram's `total_latency` is
"the end of the student's words to the first sound" as Deepgram measures it, and its `stt` part is 0 at the median, so its clock starts after Flux has
already confirmed the end of the turn: **the end-of-turn wait is not in these numbers**. A client-side clock that starts at the last speech sample (section 9.2)
will read about the end-of-turn wait higher for the same call. That is why the criteria are *relative* (lab against live, same client, same scenarios, same
hour) and these numbers are context only.

| turns (Deepgram's `total`, ms) | n | p10 | p50 | p90 | max |
|---|---|---|---|---|---|
| conversation, no function | 70 | 1325 | 1560 | 1923 | 3536 |
| interview, no function | 10 | 1197 | 1463 | 1785 | 1901 |
| conversation, with a function | 124 | 1913 | 3601 | 6253 | 10050 |
| interview, with a function | 10 | 1006 | 2088 | 6441 | 7198 |
| all 214 | 214 | | 2620 | 5884 | |

First model token (`ttt`) is 1.5 s at the median for plain turns and 2.7 s over all turns; Deepgram's TTS part (`tts`) is 77 to 96 ms at the median.
Day to day the plain-turn median moved between 1.46 and 1.66 s, so a comparison must be interleaved in time (section 9.2).

## 3. Architecture: a stand-in for Deepgram's Voice Agent, driven by an unmodified `VoiceSession`

Writing a second session would copy 2,470 lines of logic (modes, functions, fillers, lead-in and claim checks, limits, summaries, the competency
writer). Instead the lab is **a local server that speaks the same V1 agent protocol `session.ts` already speaks** (`Welcome`, `Settings`,
`SettingsApplied`, events, binary audio) and puts our own chain behind it. A lab call is the same `VoiceSession` as a live call, with `deepgramUrl`
pointed at the stand-in. What differs between live and lab is exactly what is under test: recognition, end of turn, synthesis, barge-in.

```
browser (voice.js, ?voice=lab)  --WS /tai/api/voice-lab-->  portal upgrade (owner only, flag on)  -->  the SAME VoiceHub (same slots, same tool host pool, same usage)
                                                                                                         |
                                                              VoiceSession (unmodified) --WS ws://127.0.0.1:<p>/v1/agent/converse (lab token)--> LabAgent (src/voice/lab)
                                                                                                         |           per connection: ears -> turns -> think -> mouth
                                  ears (pluggable)   LabGPU :8803 (Deepgram-compatible /v1/listen) | Deepgram Flux v2 | nova-3        |
                                  think              POST the hub's own relay handler through a loopback-only HTTP listener (bearer token from Settings), SSE -> sentences
                                  mouth (pluggable)  LabGPU :8805 POST /tts (whole sentence, PCM) | Deepgram Aura (/v1/speak, linear16 24 kHz)
                                  functions          FunctionCallRequest -> the session's executor -> FunctionCallResponse -> the next think request
```

What the lab reuses **unchanged**: `session.ts`, `functions.ts` and the tool hosts, `relay.ts` (filter, governor, handoff silence, screen note, dump), `prompts.ts` (the fillers),
`settings.ts`, `context-builder.ts`, the competency and summary writers, the hub's limits. What is **new** is under `src/voice/lab/` plus small hooks (section 4).

**Why the relay is called through a loopback listener of our own.** Deepgram reaches the relay at the public `/voice-llm/` route; both the live path and the lab use the
same `RelayTokens` key, and the hub that owns the session answers `isLive(sid)`. The lab engine lives in the same process as that hub and posts to a listener bound to
`127.0.0.1` on an ephemeral port that does nothing but call `hub.relay(req, res)`, with the bearer token the session put in the Settings. No byte leaves the machine for it.

**Hub hooks (the whole of the change to existing code, all inert with the flag off):** `Hub.upgradeLab()` (an upgrade flagged `lab` that starts the next `start` message with the
lab URL, the lab token as the "Deepgram key" and the loopback relay URL), `loadVoiceConfig` untouched (the lab reads its own keys in `src/voice/lab/config.ts`), a
`PortalVoice.upgradeLab?` and a branch in `server.ts upgrade()` for `/api/voice-lab` (owner role only, 404 otherwise), one line in `voice.js` that chooses `api/voice-lab` when the page address
has `?voice=lab`, and `tai_live.sh voice-lab` (read the trace). **One hub, not two**: one call per student across live and lab (`CallSlots`), one tool host pool, one daily budget.

### 3.1 What the stand-in must reproduce of Deepgram (from docs/VOICE.md and the structure of 1,006 real relay requests; roles only, no text, were read)

| Client message | The stand-in does |
|---|---|
| `Settings` {audio, agent.listen/think/speak/greeting/context} | connect the ears (fallback if they fail), `SettingsApplied`, then speak the greeting **without the model** (audio, then `ConversationText assistant`); `context.messages` become the history (`function_calls` items become an assistant message with `tool_calls` and the `tool` replies) |
| binary PCM16 16 kHz | to the ears and the VAD (never to a log) |
| `UpdatePrompt` | **appends** to the system prompt, acknowledges `PromptUpdated` |
| `UpdateThink` | **replaces the whole think block** (prompt, functions, endpoint), `ThinkUpdated` |
| `UpdateSpeak` / `UpdateListen` | another voice and pace / the turn-taking fields of the new mode, `SpeakUpdated` / `ListenUpdated` |
| `InjectAgentMessage` | refuse (`InjectionRefused`) while the student speaks or the agent is speaking; otherwise speak the text verbatim as the assistant's turn (fillers come from a pre-synthesised cache: no synthesis wait) |
| `InjectUserMessage` | a user turn typed in the chat (and the host's notes): `ConversationText user`, then a think turn |
| `FunctionCallResponse` | the result goes to the pending call; when all are in, the next think request carries them |
| `KeepAlive` | ignored (the engine's own sockets have their own) |

| Event the stand-in sends | When |
|---|---|
| `Welcome` | on connect |
| `UserStartedSpeaking` | speech onset (VAD, or Flux `StartOfTurn`); on a barge-in it is the cut |
| `ConversationText` user | the turn is committed (the end of turn) |
| `AgentThinking` | the think request is sent |
| `FunctionCallRequest` / `FunctionCallCancelled` | the model's tool calls; **cancelled** for calls still pending when the student barges in or a new turn is committed |
| audio (binary PCM16 24 kHz) | paced near real time with a lead of about 0.5 s, so a barge-in finds little in the browser's queue and the spoken text can be told |
| `ConversationText` assistant | one per sentence, as its audio begins |
| `AgentAudioDone` | the last sentence of the turn has been played out (not merely sent) |
| `LatencyReport` | one per turn, Deepgram-style (`total_latency`, `ttt_text_latency`, `tts_latency`, `stt_latency` in seconds, clock from the committed end of turn) so the lab's journal lines compare with the live ones |
| `Error` / `Warning` | the Settings cannot be applied (both recognizers down), a think request failed |
| **never** `AgentStartedSpeaking` | the live service does not send it: the first audio chunk means "speaking" |

Deepgram behaviours reproduced on purpose: consecutive lines of one role are merged; the history keeps **only what was actually spoken** of an interrupted answer (sentences started, the
last one cut by the played fraction); one function at a time; a `defer_until_eot` function is held until the turn is committed; the relay's handoff silence is a normal empty answer.

## 4. Route, protocol, access

- **Browser protocol:** exactly docs/VOICE.md "Browser protocol" (`start`, `text`, `mute`, `end`, `ping`, `view`; `ready`, `status`, `transcript`, `agent_interrupted`, `mode`, `timer`, `show`, `point`, `doc_state`, `notice`, `error`, `closed`, binary audio). The page's call client is unchanged except for the URL it opens.
- **Route:** the portal's `upgrade()` accepts `/api/voice-lab` (behind traefik: **`wss://tai.example.edu/tai/api/voice-lab`**, no traefik change: the `tai` router owns `PathPrefix(/tai/)`).
  The existing page opens it with `https://tai.example.edu/tai/?voice=lab`. Not linked from anywhere.
- **Access:** flag on (`TAI_VOICE_LAB=1`), a valid session cookie, Origin the page's own, and `user.role === 'owner'`; any other answer is 404 (flag off or no lab hub) or 403 (not the owner). A student cannot reach it.
- **Stand-in listener:** `127.0.0.1`, ephemeral port, a random per-process token that the hub hands the session through the `deepgramKey` hook (so the real Deepgram key never reaches the stand-in's socket) and that the stand-in compares in constant time; it reads the real key itself only for the Deepgram control plug-ins.

## 5. The chain

### 5.1 Ears (pluggable, `TAI_VOICE_LAB_EARS`)
- **`labgpu`** (default): LabGPU's `:8803`, a Deepgram-compatible `/v1/listen` websocket in front of Qwen3-ASR-1.7B (facts from the 2026-11-05 note; **re-verified by the probes of section 10.1**):
  `ws://192.0.2.29:8803/v1/listen?encoding=linear16&sample_rate=16000&language=en&label=tai-lab` (`language=en`: `auto` heard English filler as Chinese). The adapter decodes one stream at a time (serialised, about 6 streams at p95 0.44 s per 1 s of audio), does its **own energy endpointing** (RMS > 350, 700 ms, stretched to 1500 ms after a dangling word, 300 ms pre-roll, 90 s force-final), sends partials about once a second and one `speech_final` `Results` per utterance, takes no credentials and has no idle close.
- **`flux`**: Deepgram's v2 listen (`wss://api.deepgram.com/v2/listen`, `model=flux-general-en`, the same `eot_*` fields and `KEYTERMS` as the live Settings), `StartOfTurn`/`EndOfTurn` events. The control that tells orchestration from models.
- **`nova`**: the v1 client against Deepgram's `nova-3` (same client as `labgpu`, other URL and headers), for the recognition comparison.
- A failing recognizer falls back to `flux` (`TAI_VOICE_LAB_EARS_FALLBACK`, default `flux`): at connect time (refused, handshake timeout, no data for 8 s while the VAD hears speech), the page gets a `notice`.
- Optional **`hybrid`** (stretch, only if `labgpu` alone fails turn-taking and time allows): Flux decides when the turn ends, LabGPU's text goes to the model.

### 5.2 End of turn: what replaces Flux's judgement (the part most likely to fail)
Flux is a model that judges completeness; LabGPU's adapter is an energy gate. Without new dependencies (no ONNX, no model of our own) the tools are a hold-off, a text check and resets on new speech.
The rule (initial values; tunable **only on `turntaking.tuning`** of the test set, every change written into section 11):

1. Own VAD on the PCM: 20 ms frames, speech when RMS >= max(350, 3 x the quietest frame of the last 3 s) (Nora's `speech_gate.py` numbers; the browser sends noise-suppressed, levelled audio), onset after 3 voiced frames.
2. The candidate end is the adapter's `speech_final` text (or, if the probe of 10.1 shows the adapter accepts `Finalize`, a finalize that our VAD asks for after 400 ms of silence when the latest text ends a sentence).
3. Commit rule on the candidate text `T`: empty or only fillers (um, uh, er, hmm, mm) -> discard and keep waiting; `T` ends with `. ? !` and is not a lone opener -> commit after `hold_complete` (chat 0 ms, interview 600 ms, talk 2000 ms) of silence beyond the candidate;
   otherwise (no terminal punctuation, a dangling last word such as and/but/so/because/that/the/to/of/with/if, a comma) -> commit only after `hold_incomplete` of total silence (chat 1800 ms, interview 3500 ms, talk 6000 ms); never later than `eot_timeout_ms` from the Settings (5000/8000/10000) after the last speech.
4. New speech before the commit extends the same turn (the pieces are joined with a space). New speech after the commit and before the first audio of the answer cancels the think request and the answer, and the turn is re-committed with the merged text (Flux's `TurnResumed`).
5. `EagerEndOfTurn`-style early model calls are **not** built first; they are an option only if the latency criterion fails by the end-of-turn wait alone (and they must not run `defer_until_eot` functions).

### 5.3 Think
The Settings' endpoint (the loopback relay URL for lab sessions) and bearer header are used as given. The request is OpenAI chat-completions streamed: `messages` = system prompt (+ appended updates), history, turns, tool calls and tool results; `tools` from the Settings' functions;
`temperature` from the Settings. The SSE is read as it arrives: `delta.content` is cut into sentences (the relay's governor already emits sentence-sized pieces; the cutter handles several in one piece and the rest at the end), each sentence goes to the mouth at once;
`delta.tool_calls` are assembled into `FunctionCallRequest`. A cancelled turn aborts the HTTP request. The relay keeps its own limits (120 requests a minute, 4 at once per call).

### 5.4 Mouth (pluggable, `TAI_VOICE_LAB_MOUTH`) and fillers
- **`labgpu`** (default): `POST http://192.0.2.29:8805/tts {"text","voice"}` -> PCM s16le at 24 kHz (or a WAV that is unwrapped), whole sentence in one response (RTF about 0.02, from the 2026-11-05 note and Nora's code). **A response with an `X-TTS-Fallback` header is a failure**: the adapter then served the text from ElevenLabs, i.e. the text left the private network; that audio is dropped, the sentence is spoken through the Aura control, the event is logged and counted. Text is cleaned with Nora's `spoken()` character rules first (an unindexable code point is what triggers the fallback).
- **`aura`**: Deepgram `POST /v1/speak?model=aura-2-...&encoding=linear16&sample_rate=24000&container=none`, streamed. The control for naturalness and pace.
- The next sentence is synthesised while the current one plays. Output is paced (lead about 0.5 s). The fixed filler lines of `prompts.ts` (24) and the mode greetings are synthesised once per voice into a PCM cache (Nora's static-line cache idea), so a filler starts without a synthesis wait.

### 5.5 Barge-in
While the agent speaks, the VAD must see **240 ms of voiced frames** at 1.5x the normal threshold (`bargeMinVoicedMs`, `bargeRmsFactor`; tunable on `bargein.tuning` only) before it counts as a barge-in (the browser's echo cancellation leaves a little echo; a cough is shorter).
Then, in this order, at once: stop sending audio and drop the synthesis queue, abort the think request, send `UserStartedSpeaking` (the session sends `agent_interrupted` to the page), `FunctionCallCancelled` for pending calls, and cut the history to what was spoken (section 3.1).
With `flux` ears, `StartOfTurn` during agent speech is the trigger (closest to live). A student who speaks while the agent is silent is not a barge-in.

### 5.6 Functions and fillers
`FunctionCallRequest` goes to the session exactly as Deepgram's does; `session.ts` runs it (`functions.ts`, tool host, host code), sends the filler `InjectAgentMessage` itself when a function runs long, and answers with `FunctionCallResponse`. The stand-in only has to carry the call and the result and to speak an injected line promptly. Interview and talk-through come with the session (`UpdateThink`/`UpdateSpeak`/`UpdateListen`); the end-of-turn parameters follow `UpdateListen`.

## 6. Per-turn trace

`<data dir>/voice-lab/turns.jsonl` (host: `~/tai-live/tai/data/voice-lab/turns.jsonl`; `tai_live.sh voice-lab` prints the last turns or one call): one JSON line per turn, monotonic milliseconds from the call's start:
`sid, mode, ears, mouth, turn, speechStart, speechEnd (VAD), earsPartialFirst, earsFinal, commit (end of turn), thinkSent, firstToken, firstSentence, ttsSent, ttsFirstByte, firstAudioOut, audioDone,`
`bargeIn {onset, confirmed, audioStopped, spokenSentences}, functions [{name, startedAt, answeredAt}], fillers [{kind, injectedAt, audioAt}], fallbacks [..], userText (first 80 characters), agentWords, derived {eotWait, total (Deepgram-style), fromSpeechEnd}`.
It holds the owner's own words only (the endpoint is owner-only) and no secret. The per-turn "voice turn latency" journal line is also written by the session from the stand-in's `LatencyReport`.

## 7. Settings (all optional; the lab is off unless `TAI_VOICE_LAB=1`)

| Key | Default |
|---|---|
| `TAI_VOICE_LAB` | off (`1` builds the stand-in and the route) |
| `TAI_VOICE_LAB_EARS` / `_EARS_FALLBACK` | `labgpu` / `flux` |
| `TAI_VOICE_LAB_EARS_URL` | `ws://192.0.2.29:8803/v1/listen?encoding=linear16&sample_rate=16000&language=en&label=tai-lab` |
| `TAI_VOICE_LAB_MOUTH` / `_TTS_URL` | `labgpu` / `http://192.0.2.29:8805` |
| `TAI_VOICE_LAB_VOICE_CHAT` / `_VOICE_INTERVIEW` | LabGPU's voices chosen from `GET /voices` (recorded in section 10.1); Aura: `aura-2-thalia-en` / `aura-2-mars-en` |
| `TAI_VOICE_LAB_HOLD_*`, `_BARGE_*` | the numbers of 5.2 and 5.5 |

## 8. Safety and shared-resource rules (hard)

S1 No student data or student audio: the endpoint is owner-only, tests use synthetic voices and the owner's own calls. S2 A lab call contacts only LabGPU (192.0.2.29:8803, :8805), Deepgram (`api.deepgram.com`) and the loopback relay: a test records every outbound target.
S3 The Deepgram key is never sent to the stand-in socket and never logged. S4 `X-TTS-Fallback` is a failure (section 5.4). S5 Flag off: no listener, no hub change, `/api/voice-lab` answers 404, nothing dials LabGPU: pinned by tests. S6 LabGPU's box is another person's shared 12 GB GPU slice and **Nora already uses `:8803`
(serialised)**: at most 2 lab streams at once, 3 never without the owner's yes, no stress or soak test, nothing on that box but ordinary websocket and HTTP client calls to the three adapters, no ssh to it. A lab call slows Nora's recognition a little: say so to the owner.

## 9. Criteria (frozen when this file is committed; see section 11 for amendments)

### 9.1 Chains
**L** = today's call (`/api/voice`, the Deepgram Voice Agent). **D** = lab, `labgpu` ears + `labgpu` mouth. **C** = lab control, `flux` ears + `aura` mouth (our orchestration over Deepgram's models). Ablations **DA** (labgpu ears, aura mouth) and **FD** (flux ears, labgpu mouth) are run only to explain a failure. C against L isolates the orchestration; D against C isolates LabGPU's models.

### 9.2 How a number is taken (the same for every chain)
The client (`src/voice/lab/measure.ts`) calls as the owner through the host's portal socket (a signed cookie, like `smoke-client.ts`), `start` in the mode under test, waits for `ready` and for the greeting to end, and plays scenarios one after the other: 600 ms of silence, the clips of the scenario with its pauses, then silence until the agent has answered and 1.5 s more. Audio goes out in real time, 40 ms frames, each send time recorded; arrivals are stamped on the same monotonic clock.

- **UE** (end of speech) = the send time of the frame that carries the last speech sample (the last sample above max(200, 2 % of the clip's peak), as `speech_check.sh` finds it; the clips are trimmed and the pauses put back by the client, so UE is exact to one frame).
- **Turn latency** = first binary agent frame after UE minus UE. **EOT latency** = arrival of the `transcript` event with role `user` minus UE (the moment the page learns the turn ended).
- **Barge-in stop time** = arrival of `agent_interrupted` minus the send time of the first frame of the interrupting speech; the time of the last agent audio frame after the onset is reported too.
- A turn is a **tool turn** if a `status working` event occurs between UE and the first agent audio, otherwise a **plain turn**. Both are reported; the latency criterion binds plain turns, tool turns are held to their own line.
- **Interleaving:** calls alternate L, lab, L, lab ... in one time window (one session of at most two hours), the same scenario list in the same order, the voices alternating David/Zira by scenario number. Runs with a client socket error are repeated once; no other trial is excluded; all raw logs are kept. A model/gateway outage ends the session and it is repeated.
- **Statistics:** n, p50 and p90 (the value at index floor((n-1)p) of the sorted sample), rates as k/n with a Wilson 95 % interval. A criterion passes if the point estimate is within its tolerance; where the interval of the difference includes zero the report says "not distinguishable at this n" next to the verdict. The verdict never rests on one number.

### 9.3 The test set
`eval/voice-lab/testset.json` (written before any run; sha256 in 9.7): 26 recognition sentences, 10 latency prompts, turn-taking scenarios (10 tuning + 30 eval: 10 mid-thought pauses of 1.2-2.0 s, 10 short answers, 10 filler openers), barge-in (2 tuning + 8 eval interruptions, each with the same long-answer question), interview (5) and talk (3) pause scenarios; spoken by David and Zira through `eval/voice-lab/make_audio.ps1`.
Tuning of end-of-turn and barge-in parameters uses only the `tuning` parts; an eval scenario that is looked at for tuning is replaced by a new one and the replacement is logged in section 11.

### 9.4 The criteria

| # | What | How many | Pass (lab = D unless said; "live" = L in the same session) |
|---|---|---|---|
| **C0** | Call start | 20 calls per chain | start -> `ready`: p50 <= live + 500 ms; start -> first greeting audio: p50 <= live + 700 ms; no call fails to start |
| **C1** | End of speech to first audio, **plain turns** | 10 prompts x 3 runs = 30 turns per chain (more are taken until 30 turns of each chain are plain) | p50 <= live p50 + 300 ms **and** p90 <= live p90 + 600 ms. Tool turns (n >= 15 each chain): p50 <= live p50 + 300 ms. Interview answers with `evaluate_answer` (n >= 10): same. EOT latency and the parts (recognizer final, first token, first sentence, TTS first byte) reported |
| **C2** | Turn-taking, conversation | 10 pause + 10 short + 10 filler scenarios x 3 runs = 90 trials per chain | **Cut-in rate** (pause and filler classes: more than one user turn for the scenario, or an agent audio frame before UE + 300 ms): lab <= live + 10 percentage points. **Too-long wait** (EOT latency > 3.0 s on a complete utterance, all classes): lab <= live + 5 points. Short answers: committed (an answer arrives) in every trial |
| **C3** | Barge-in | 8 interruptions x 3 runs = 24 per chain, plus every turn in which the agent speaks and the student is silent | `agent_interrupted` after the onset: p50 <= live p50 + 100 ms and p90 <= live p90 + 200 ms; audio stops arriving at the client: p90 <= live p90 + 300 ms. **False barge-ins** (an `agent_interrupted` with no scripted interruption): 0 in at least 40 agent turns. The assistant message of the next request holds only what was spoken (checked in the trace: sentences started, none after the onset) |
| **C4** | Fillers | scripted tool latency 0.5 s, 3 s, 8 s | by construction the same logic as live (it is `session.ts`); lab-only: an injected filler's first audio byte <= 300 ms after the injection (p90); none for the 0.5 s function; "one sec" near 1.5 s and "still looking" near 6.5 s for the 8 s one |
| **C5** | Functions | every definition of the three modes (24 conversation, 9 interview, 6 talk-through as pinned by `functions.test.ts`, 29 distinct; `look_at_image` too where the switch offers it) | with a scripted gateway, the real executor and fake tool hosts (no real side effects): each call reaches the session, its result reaches the next think request (engine overhead from `FunctionCallResponse` to the next request <= 100 ms), and an answer is spoken. After deployment, one real `query_knowledge`, `query_canvas find` and `show_document` in a synthetic call |
| **C6** | Recognition of CS terms | 26 sentences x 2 voices = 52 utterances, from the host | WER (words of `[a-z0-9']+`, lower case, as `speech_check.sh`) and key-term recall (strict whole-term match) of **Qwen3-ASR vs Deepgram Flux with the live `KEYTERMS`**: Qwen term recall >= Flux's **and** Qwen WER <= Flux WER + 2 points. nova-3 reported for reference. Final latency (end of the clip's speech to the final) reported for each |
| **C7** | Synthesis | 5 runs of one fixed 39-word text; 20 sentences for first byte | pace of LabGPU's voice within +-10 % of the live voices' measured pace (3.45 words/s: flux-hannah at 1.2 and aura-2-mars at 1.1, `settings.ts`) after the speed adjustment, coefficient of variation <= 10 % over the runs; first byte for a 15-word sentence p90 <= 500 ms; `X-TTS-Fallback` count 0. **Naturalness is the owner's ear, not a number**: the verdict records what he says |
| **C8** | LabGPU's box down | scripted with loopback fakes, and once with the real client pointed at a closed port | ears refused at call start: `ready` within 3 s on the fallback recognizer, a `notice`, the first turn answered; ears silent mid-call (frames accepted, no output for 8 s while the VAD hears speech): switched within 10 s with a `notice`; TTS refused, 5xx, or the fallback header: the sentence is spoken through Aura within 1.5 s extra and the call goes on |
| **C9** | Concurrency | two lab calls at once for 3 minutes of plain turns (never 3 without the owner's yes) | each call's plain-turn p50 <= the single-call lab p50 + 300 ms; no recognition failure; LabGPU's adapter reports no "falling behind" in the lab client's view (no partial gaps > 3 s) |
| **C10** | Interview and talk-through turn-taking | 5 interview + 3 talk pause scenarios x 3 runs per chain | cut-in rate <= live + 10 points in each mode; the mode switch (`UpdateThink`/`UpdateSpeak`/`UpdateListen`) completes and the hold-off follows it |
| **C11** | Flag off and safety (tests) | unit and integration tests | with `TAI_VOICE_LAB` unset: no lab listener, `Hub.upgradeLab` refuses, `/api/voice-lab` answers 404, no connection to 192.0.2.29, the existing voice suite unchanged; with it on: owner only (403 for a student), a lab call dials only LabGPU, Deepgram and the loopback relay (S2), the Deepgram key never appears on the stand-in socket or in the logs |

### 9.5 Not covered by synthetic tests (said now, so nobody has to read it into a pass)
Chinese-L1 speech; the real microphone's echo and noise; the owner's real network; how a voice *sounds*; calls longer than a few minutes; Nora's load on `:8803` at class time. They are covered by the owner's real calls, which the verdict waits for.

### 9.6 The verdict rule
- **Reproduces:** C0-C3, C6-C8 and C10 pass on the synthetic runs, C11 passes, **and** the owner's real calls (at least three, 30 minutes in all, in conversation and at least one interview) show no regression he names against today's call.
- **Partly:** C6 passes (the recognizer is better on CS terms) but at least one of C1-C3 or C10 misses its tolerance by at most twice the tolerance, or the owner names a regression that a parameter explains; the report then says which part (orchestration, by C against L, or LabGPU's models, by D against C) and what it would cost to close.
- **Does not:** turn-taking or barge-in is clearly worse (cut-in more than live + 20 points, or barge-in stop p90 more than live + 500 ms, or false barge-ins in the owner's calls), or C6 fails, or the owner's real call is worse in a way he names that no single parameter fixes.
- A verdict from synthetic runs alone is written "provisional" and is not called a success.

### 9.7 The test set's fingerprint
`eval/voice-lab/testset.json`: git blob `5066b76d5863429013bebd953f4305b5771f834b` (authoritative, `git hash-object eval/voice-lab/testset.json`), sha256 of the LF file `89b4b8d2a10568988e21841fa8d15f118914ece03e73e0f13aff141d1edf7612`. The scenario and sentence texts are fixed by this commit; the first lab run checks the hash again and says so.

## 10. Build status and results (filled in after this commit; each entry has a date and a method)

*Nothing measured yet.* Sections 10.1 (component probes from the host), 10.2 (the build and its tests), 10.3 (synthetic calls against live), 10.4 (the owner's real calls) and the verdict are added as they happen.

### 10.1 Questions the first probes answer (and what each would change)
| # | Question | If yes / if no |
|---|---|---|
| P1 | Does `:8803` accept a `Finalize` (or `CloseStream`) text frame and answer at once with a final? | yes: our VAD may ask for the final after about 400 ms of silence when the text ends a sentence, cutting the 700 ms endpoint; no: the adapter's own 700 ms (1500 ms) plus decode is the floor, our VAD can only add hold-off, and the latency criterion may be out of reach |
| P2 | Partial cadence and `speech_final` timing on the real adapter; what `language=en` does to fillers ("um"); does a long silence keep the socket open | sets the hold-off and keepalive |
| P3 | Flux v2 listen: event names, the `keyterm` parameter, `Configure` | from Deepgram's own docs, not guessed |
| P4 | `:8805`: `/voices`, a `speed` field, first-byte time, pace, the fallback header | picks the voices and the speed mapping |
| P5 | Does Deepgram's `/v1/speak` take a `speed` for Aura | pace parity with the live interviewer voice |

## 11. Amendments (changes to anything above after the commit that introduced it)
*None.*
