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
- **Shadow ears** (diagnostic, `TAI_VOICE_LAB_SHADOW_EARS`, default `auto`: Flux when the ears are LabGPU's, LabGPU's when they are Flux; `none` turns it off): a second recognizer gets the same audio, its finals never drive the turn, and the trace of every turn carries what it heard next to what the primary heard. It is how the one claim the synthetic set cannot test (Qwen3-ASR on Chinese-accented English) is tested on the owner's own real calls, without asking him to read anything; it costs Deepgram minutes on his calls only.

### 5.2 End of turn: what replaces Flux's judgement (the part most likely to fail)
Flux is a model that judges completeness; LabGPU's adapter is an energy gate. Without new dependencies (no ONNX, no model of our own) the tools are a hold-off, a text check and resets on new speech.
The rule as built (`src/voice/lab/turn.ts`, `vad.ts`; the numbers are initial values, tunable **only on `turntaking.tuning`** of the test set, every change written into section 11). The probes of 10.1 shaped it: the adapter takes no `Finalize`, its final is 1.0 to 1.6 s after the end of speech, and its text carries full stops after sentences the student has not finished, so **punctuation is not used as a sign of completeness**.

1. Own VAD on the PCM: 20 ms frames, speech when RMS >= max(350, 3 x the quietest frame of the last 3 s) (Nora's `speech_gate.py` numbers; the browser sends noise-suppressed, levelled audio), onset after 3 voiced frames, the end of speech is the last voiced frame.
2. The text that counts is the first partial or final that **arrives at least 350 ms after the end of speech** (`TAI_VOICE_LAB_COVER_MS`): the recognizer's round that follows holds the whole utterance (measured: 0.4 to 1.1 s after the end, against the final at 1.0 to 1.6 s). A partial that arrived earlier may lack the last words and is not taken.
3. The text is judged (`judgeTurnText`): **filler** (um, uh, er, hmm, mm ... or no Latin letter at all) -> forgotten, the turn stays open; **unfinished** (it ends on a conjunction, preposition, article, possessive, relative pronoun, auxiliary or modal; or on a comma, dash or ellipsis; or it is an opening clause with no main clause: "If I put the lock around the whole function") -> committed only after `incompleteMs` of total silence (chat 1800 ms, interview 3500 ms, talk 6000 ms); **finished** -> committed after `completeMs` (chat 0 ms, interview 600 ms, talk 2000 ms); never later than the Settings' `eot_timeout_ms` (5000 / 8000 / 10000), at which the best text there is goes. The mode is told by the turn fields of the Settings and of each `UpdateListen`.
4. New speech before the commit extends the same turn: the adapter ends its utterance in any pause of 1.5 s, so a final that came during the pause is kept as the first part and what follows is appended (`TurnTracker`'s prefix). New speech after the commit and before the first audio of the answer (240 ms of it) aborts the model request, and the words go on with the next turn, which is answered once as one (the history joins consecutive student lines). The adapter's late final of a turn already committed is recognised and dropped.
5. `EagerEndOfTurn`-style early model calls are **not** built; they are an option only if the latency criterion fails by the end-of-turn wait alone (and they must not run `defer_until_eot` functions).

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

`<data dir>/voice-lab/turns.jsonl` (host: `~/tai-live/tai/data/voice-lab/turns.jsonl`; `tai_live.sh voice lab [N]` prints the last N turns with the waits and their p50/p90): one JSON line per turn, monotonic milliseconds from the call's start:
`sid, mode, ears, mouth, turn, speechStart, speechEnd (VAD), earsPartialFirst, earsFinal, commit (end of turn), thinkSent, firstToken, firstSentence, ttsSent, ttsFirstByte, firstAudioOut, audioDone,`
`bargeIn {onset, confirmed, audioStopped, spokenSentences}, functions [{name, startedAt, answeredAt}], rounds [{thinkSent, firstToken, afterAnswerMs}] (every request to the model of the turn; `afterAnswerMs` is the engine's part of a function round trip, amendment A3), fillers [{kind, injectedAt, audioAt}], fallbacks [..], userText (first 80 characters), agentWords, derived {eotWait, total (Deepgram-style), fromSpeechEnd}`.
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

Entries are added as they happen, each with its date and method. Everything below this line was measured **after** the commit of section 9 (`2e979d6`).

### 10.1 Component probes from the host (2026-11-13 evening to 2026-11-14 04:50 UTC; the criteria's C6 and C7 inputs, and answers to the design's open questions)

*Method.* Scratch Node scripts in `/tmp/vlab-probe-1113/` on the cs6650 host (removed afterwards), the repo's `ws` module, one stream at a time, synthetic audio only (Windows David and Zira, `eval/voice-lab/make_audio.ps1`, 16 kHz), real time in 20 ms frames (Deepgram: 80 ms), end of speech = the last sample above max(200, 2 % of the clip's peak), exactly as `speech_check.sh` finds it. The Deepgram key was read on the host by the script and never printed. **A bug of mine, found and fixed on the first run:** the wait loop of the first version of the probe sent silence frames unpaced (one-frame calls that did not wait), so one stream got a flood of silence for about 40 s; the adapter stayed up, answered a paced sanity run normally (two utterances, finals at UE + 1.5 s), and nothing else on that box was touched. Nora shares `:8803`: this is said here and in the report to the owner.

| # | Question | Answer |
|---|---|---|
| P1 | Does `:8803` take `Finalize` or `CloseStream`, an `endpointing` parameter, or a burst of padding silence to finalise sooner? | **No to all four.** `Finalize`, `CloseStream` and `KeepAlive` text frames change nothing (final at UE + 1439..1523 ms with or without; no `from_finalize`); `endpointing`, `interim_results` and `vad_events` in the URL are ignored; 0.8, 1.5 and 2.5 s of digital silence sent at once at UE + 250 ms do not move the final either (24 runs: UE + 1063..1523 ms): the adapter works in wall-clock rounds, not audio time. Message types seen: `SpeechStarted`, `Results`, `UtteranceEnd`. **So the adapter's final is a floor of about 1.0 to 1.6 s after the end of speech, and our VAD can only add hold-off, as the design said it might.** |
| P2 | Partial cadence, `speech_final` timing, fillers, pauses | Partials every **1.1 s** of wall clock, `SpeechStarted` about **1.1 s after the speech onset** (useless for barge-in: the lab has its own VAD); the **first partial that arrives 0.4 to 1.1 s after the end of speech already holds the whole text**, the final repeats it at UE + 1.2..1.6 s. Over the 52 utterances of C6: final after the end of speech p10 1295, **p50 1486, p90 1803 ms**, min 1179, max 2032. The text is punctuated even when the speaker is mid-sentence (`"The thing I do not get about Paxos is."`, `"If I put the lock around the whole function."`), so a full stop says nothing about completeness; the adapter ends its utterance during a 1.5 s pause (a 1.0 s pause is merged into one utterance); fillers come back as `"Um."`, `"Ah, so."`, and once as `"啊。"` although `language=en` (the turn policy treats a text with no Latin letters as a filler). |
| P3 | Flux v2 listen protocol | From Deepgram's own pages (`/docs/flux/quickstart`, `/docs/flux/state`, `/reference/speech-to-text/listen-flux`, read 2026-11-13): `wss://api.deepgram.com/v2/listen`, `model=flux-general-en`, `eot_threshold`, `eager_eot_threshold`, `eot_timeout_ms`, repeated `keyterm=`, `mip_opt_out`; `Connected`, `TurnInfo {event: StartOfTurn \| Update \| EagerEndOfTurn \| TurnResumed \| EndOfTurn, turn_index, transcript, words, end_of_turn_confidence, trigger?}`; client `CloseStream`, `ForceEndTurn`, `Configure {thresholds, keyterms, ...}`; 80 ms chunks recommended; `StartOfTurn` always has a non-empty transcript ("reliably triggers barge-in"). `Configure`'s exact payload types were not probed. |
| P4 | `:8805` | `GET /health`: `{"status":"ok","engine":"supertonic","backend":true,"fallback":"armed"}` (**the adapter can fall back to ElevenLabs: the `X-TTS-Fallback` guard matters**); `/voices`: `DrBerg` (not used: its authorisation is open), `af_bella`, `af_heart`, `default` (**the same single English voice**: identical audio), `ef_dora`, `ff_siwis`, `jf_gongitsune`, `pf_dora`, `zf_xiaobei`; `POST /tts {"text","voice"}` answers raw PCM s16le **24 kHz** (`application/octet-stream`, about 10 chunks); a 15-word sentence: first byte **p50 115 ms, p90 282, max 452** (n = 20), whole sentence p50 136 ms; the 39-word passage: **2.69 words/s, CV 0.0 %** over 5 runs (the live voices: 3.3 to 3.7); **the `speed` field is ignored** (14.48 s at 0.9, 1.1, 1.2 and 1.3); no `X-TTS-Fallback` in 40 calls; a prime sign, a long dash and a curly quote went through without a fallback. So one English voice (no male voice for the interviewer) and a pace 22 % under the live voices: the engine must time-stretch it (WSOLA, `mouth/tempo.ts`) to reach 3.45 words/s. |
| P5 | Aura REST `speed` | **Works**, and streams faster than real time: `aura-2-mars-en` 2.7..3.0 words/s at speed 1.0, 2.85..3.0 at 1.1, 3.1..3.45 at 1.2; `aura-2-thalia-en` 3.2..3.3 at 1.2; first byte 110..280 ms (p50 111, p90 119 for a 15-word sentence). **The Voice Agent's scale differs**: on 2026-11-06 the live mars at 1.2 measured 4.0 to 4.5 words/s on its greeting; through REST it is 3.1 to 3.45 on my passage, so pace parity with the live interviewer must be measured through the call, not assumed from the speed number. |

**C6, recognition of CS terms (26 sentences x 2 voices = 52 utterances; strict whole-term match, WER on `[a-z0-9']+` words; the live Flux settings: `eot_threshold` 0.75, `eot_timeout_ms` 5000, the 25 live `KEYTERMS`).**

| recognizer | mean WER | key terms | final after the end of speech, p50 / p90 |
|---|---|---|---|
| LabGPU, Qwen3-ASR `:8803` (`language=en`) | **3.16 %** | **60 / 72** | 1486 / 1803 ms |
| Deepgram Flux, live settings and keyterms | 3.71 % | **63 / 72** | 990 / 1239 ms |
| Deepgram nova-3, the same keyterms, `endpointing=300` (reference) | 4.26 % | 64 / 72 | 490 / 543 ms |

The pre-registered rule is "Qwen term recall >= Flux's **and** Qwen WER <= Flux WER + 2 points". WER passes (3.16 against 3.71); **term recall does not (60 against 63)**: so **C6 fails on the synthetic set, by the rule as written.** What each got wrong: Qwen "wait group" (twice, for `WaitGroup`), "EC two", "Teraform", "Dynamo DB", "SQSQ", "Lampport", "Cody" (twice, for Coady), "Amdal" and "Emdal", "GRPC"; Flux "weight group" (twice), "by us" for "buy us", "EC two" (twice), "SQ SQ", "Cody" (twice), "Amdell" and "Emdal", "back end", and once it ended a turn at the comma of "Can you say that again," (a cut-in by Flux itself, which C2 will see on the live side too). Against the nova-3 **without** keyterms of 2026-11-05 (WER 10.7 %, terms 13/16 on five sentences) Qwen looked far better; against Flux **with** the live keyterms the gap is gone on native synthetic voices. The claim that matters (Qwen3-ASR is stronger on Chinese-accented English) is not tested by this set and cannot be: it needs the owner's own voice (section 9.5), which is why the lab will run a **shadow recognizer** on his real calls (section 5.1) and put both texts of every turn into the trace.

**What C6's result does to the verdict (written now, before any end-to-end number exists).** Section 9.6 lets "reproduces" and "partly" through only when C6 passes, and lists "C6 fails" under "does not". So **the only verdict the synthetic runs can reach is "does not (provisional)"; no measurement of C1 to C5 or C7 to C10 can change that.** Per section 9.2 the C6 difference is also reported as what it is: term recall 60/72 (Wilson 95 % interval 73 to 90 %) against 63/72 (78 to 93 %), a gap of three terms: **not distinguishable at this n**, while the rule as written still fails it. C6 is not amended. What the later runs can still tell is two other things: whether the lab's own orchestration is as good as Deepgram's (chain C against L, same models), and, from the owner's real calls, whether Qwen3-ASR does better on his own voice (question Q1 in section 11, added after this result and before any call of his; it is exploratory and cannot move the verdict of 9.6).

### 10.2 The lab's own client classes against the real services (2026-11-14, about 05:50 to 06:00 UTC, from the host, one stream at a time, synthetic audio)

*Method.* The compiled `V1Ears`, `FluxEars`, `LabGPUMouth`, `AuraMouth` and `stretch` of this branch, shipped to `/tmp` on the host (removed afterwards) and run against LabGPU's adapters and Deepgram, with the audio played as the page sends it (40 ms frames, real time). The Deepgram key was read on the host by the script and never printed.

| Part | Result |
|---|---|
| `V1Ears` -> `:8803` | 30 connect-and-close cycles: connect p50 4 ms, p90 5, max 9, **0 failures**. Six utterances played as 40 ms frames that the class regroups into the adapter's 20 ms frames: final at UE + 1212..1846 ms (p50 1526, p90 1678), the first partial that covers the speech at UE + 434..1105 ms, `down` never. |
| `FluxEars` -> Deepgram | connect 274..284 ms; `StartOfTurn` 611..650 ms after the speech began (a barge-in on Flux's own signal is slower than the lab's VAD, which needs about 300 ms); finals at UE + 478, 1099 and 1472 ms (trigger `model`); **a `Configure` with `thresholds` (numbers) was accepted** ("Flux applied a Configure"), which settles the open point of P3. |
| `LabGPUMouth` -> `:8805` | 104 sequential sentences, **0 errors**: first byte p50 116 ms, p90 127, max 147; whole sentence p50 134, p90 147. The 39-word passage: 2.69 words/s, CV 0.0 % over 5 runs; **after `stretch(1.28)`: 3.45 words/s**, CV 0.0 %, the stretch took p50 36 ms for 14.5 s of audio. |
| `AuraMouth` -> Deepgram | `aura-2-thalia-en` at speed 1.2: 3.36..3.52 words/s, first byte 269..388 ms; `aura-2-mars-en` at 1.08 (the live interviewer's number): **3.00..3.17**; at 1.3: 3.51..3.74. So the interviewer control needs `TAI_VOICE_LAB_AURA_SPEED_SCALE` of about 1.2 to sit at the live pace (3.3 to 3.7): to be set after the live pace has been measured through a call. |

Four listening samples (the same three sentences: LabGPU as it comes, LabGPU stretched to the live pace, Aura thalia, Aura mars) were made for the owner; naturalness is his call (C7).

### 10.3 Build status and the deploy plan (2026-11-14; nothing is deployed, no end-to-end number exists yet)

**Built** (branch `claude/voice-selfbuilt-289fc0`, local commits only): the stand-in for Deepgram's agent protocol (`src/voice/lab`: `agent.ts`, `engine.ts`, `turn.ts`, `vad.ts`, `speaker.ts`, `history.ts`, `think.ts`, `trace.ts`, `config.ts`, `factories.ts`), the parts (`ears/v1.ts` for LabGPU's `:8803`, `ears/flux.ts`, `mouth/labgpu.ts`, `mouth/aura.ts`, `mouth/tempo.ts`, `mouth/cache.ts`, `sentences.ts`), the measuring client (`measure/`, `cli.ts run|interleave|analyze`), the hub, portal and page hooks (`hub.ts`, `server.ts`, `voice.js`: one route `/api/voice-lab`, owner only, the page opens it with `?voice=lab`), and `tai_live.sh voice lab [N]`. The first sentence of an answer is released as soon as it is complete (a one-word opener does not wait for the sentence after it).

**Checked.** Type check on the host with the host's own `node_modules` (real `@types/ws`): clean. `vitest` on the host over `src/voice`, `src/portal` and `portal/web`: 121 files, 2,467 tests, all green at `a3f128e` (the lab's own: 25 files, 574 tests, 164 of them the measuring client's). `deploy/cs6650/test_tai_live.py`: 67 tests green. The real-time lab tests flaked under load (found by running them beside twelve busy loops): a 100 ms bound at 105 ms; a trace file read between its creation and its first line; two trace lines appended in the wrong order (found by the new trace test); waits at their limits (a 3 s wait, a 15 s test limit). The first three were fixed in the code or the test and the waits made generous; of six loaded runs after the first fixes, four passed and the two failures were the waits now fixed (8 s and 60 s). With `TAI_VOICE_LAB` unset nothing of the lab runs (C11 pins in `lab.test.ts`). Everything above ran on loopback fakes and on component probes (10.1, 10.2): **no number of the lab as a whole call exists until it is deployed.**

**What a deploy ships.** The base snapshot (`voice-lab-base`) carries the main checkout's LeanRAG work, which has never been deployed (33 new files, 6 changed ones, one of them under `container/`, whose hash would trigger an agent image rebuild). A deploy from this worktree would ship it. So the deploy is made from a **release tree**: the head of this branch in a detached worktree, the new LeanRAG files removed, the six changed ones put back to the host's bytes, one local commit on top (so that `DEPLOYED.json` names a tree without LeanRAG). Checked against the host's files by sha256 (2026-11-14, last at `a3f128e`): 67 files would change on the host, exactly the 67 this branch changed since the base; `container/` is identical to the host's (no image rebuild); every base file this branch changed is still, on the host, the base's version (nobody has deployed a newer one). The check is repeated at deploy time, and the main checkout is compared with `voice-lab-base` again. A later deploy from the main checkout turns the lab off.

**Measurement plan (after the owner's word).** Calls are made through the portal socket by `measure/cli.ts`, L (`/api/voice`) and D (`/api/voice-lab`) interleaved in one window, `--set` by `--set` (latency, pause, short, filler, bargein, interview, talk), three runs each; the control chain C (Flux ears, Aura mouth) only when D misses something and the cause is to be told apart. About an hour of call time per chain for the full set, two hours for L and D together (a few dollars of Deepgram minutes for L); so the runs are several sessions, see A5. Three things follow from what the code does, and are put to the owner with the request: (1) every spoken line of a call is appended to the caller's chat, so hundreds of synthetic calls would fill the owner's own chat and student model: the calls are made as a **separate test identity** (owner role, own folder) added for the window and removed afterwards; (2) `TAI_VOICE_DAILY_MIN` is 45 minutes per folder per day, so the window raises it and restores it afterwards; (3) a lab call takes one stream on `:8803`, which Nora also uses: at most two lab streams at once, no soak test.

**Rollback.** Material is prepared before the deploy (`~/tai-live/rollback-pre-voicelab`: the host's versions of the changed files, a list of the new ones, `DEPLOYED.json` before). `TAI_VOICE_LAB=0` (or unset) turns the lab off without a deploy.

### 10.4 Deploy log

**2026-11-14 07:10:46 UTC (Friday 23:10 Pacific; no voice turn in the three hours before): deployed**, on the owner's word 部署. From the release tree: the local commit `d2e0b45` (the branch head `2d8f695` without the LeanRAG work), `treeHash 0ebaf993dcea4a05` (kept as `~/tai-live/releases/0ebaf993dcea4a05.tgz`). Before it: the main checkout compared with the snapshot (779 files, identical), a data backup (`tai-20261114T070753Z.tgz`), the release check (67 files to change, `container/` identical, no stale base), and the rollback material `~/tai-live/rollback-pre-voicelab` (the host's 7 files as they were, the list of the 60 new ones, `dist-before.tgz`, the settings and `DEPLOYED.json` as they were, `ROLLBACK.txt`). The agent image and the gateway were left alone (container hash `04819fca58accdec` unchanged). `tai_live.sh check` green. With the flag still off, an unauthenticated upgrade of `/api/voice-lab` answers 401 like `/api/voice` (the lab's 404 is for a signed-in user).
**07:12 UTC:** `TAI_VOICE_LAB=1` and `TAI_VOICE_DAILY_MIN=240` (for the measurement window; the default is 45, restore with `tai_live.sh set TAI_VOICE_DAILY_MIN=45` and a restart) set, service restarted: "voice lab: the stand-in is listening on loopback", no warning in the journal, `check` green again; the live page script carries `?voice=lab`. The 257 synthetic clips are on the host in `~/tai-live/voice-lab-audio` (25 MB).
**07:15 UTC:** the measurement cannot start without a caller, so `TAI_VOICE_DAILY_MIN` was put back to 45 (a second restart, no call on); it is raised again only when a measurement window opens. The lab stays on: only the owner can reach it.
**Not done:** the measurement needs a caller. Adding the test identity (an owner-role entry in `users.json`) was refused by the session's permission classifier, so it waits for the owner's answer. Nothing has been called as the owner, and no whole-call number exists yet.

## 11. Amendments (changes to anything above after the commit that introduced it)

**A1, 2026-11-14, made before any end-to-end number of the lab or of the live call on the test set existed (only the component probes of 10.1 were in): what a cut-in is, and which user line the end-of-turn wait is read from.**
Section 9.4 C2 said a cut-in is "more than one user turn for the scenario, or an agent audio frame before UE + 300 ms". Building the end-of-turn rule (5.2) showed the first half does not mean the same thing on both chains. The lab commits a turn at the first text that covers the speech (0.4 to 1.1 s after the end of speech) and takes the commit back, before any audio, when the student goes on (5.2 rule 4): the page then holds two lines of the student's words, but TAi never spoke over them; Flux's chain does not commit early, so for it a second line has always meant an answer that was started. A count of lines would mark the lab as cutting in where nobody was cut in. So, from here on:
- **Cut-in** = an agent audio frame (not the greeting, not a filler the session injects while a function runs) arrives before UE + 300 ms: the agent began to talk before the student had finished. Both chains, same definition.
- **Split lines** = more than one `transcript` user event for the scenario: reported next to the cut-in rate for every chain, not part of any pass/fail. The report says what it means (the student's words are in two lines of the chat; TAi answered once, or twice).
- **EOT latency** = the first `transcript` user event that arrives at or after UE, minus UE (a line that arrived before UE belongs to a fragment).
The tolerances of C2 are unchanged (+10 points cut-in, +5 points too-long wait). Nothing else of section 9 is changed.

**A2, 2026-11-14, a correction of a name, no criterion or number changed.** Section 9.2 says the measuring client is `src/voice/lab/measure.ts`. It is the directory `src/voice/lab/measure/` (`cli.ts` is the entry: `run`, `interleave`, `analyze`), with the same method as 9.2 describes.

**A6, 2026-11-14, after the owner's first call on the lab and before any measurement of the lab as a whole: the pace.** The owner heard the lab (LabGPU's voice time-stretched to the live voices' pace of 3.45 words/s, which is the live Settings' speed 1.2) and said the voice is too fast and he wants normal speaking pace, not 1.2x. So the lab now speaks at the voice's natural pace: `TAI_VOICE_LAB_TEMPO=0` (LabGPU's voice as it comes, 2.69 words/s, no stretch; it therefore also ignores the student's pace setting) and `TAI_VOICE_LAB_AURA_SPEED_SCALE=0.85` (the Aura fallback and control at about speed 1.0 for the conversation voice and 0.92 for the interviewer). **C7's pace clause** ("within +-10 % of the live voices' pace of 3.45 words/s") is replaced by the owner's decision: natural pace, and his ear on naturalness. The other clauses of C7 (variation at most 10 % over the runs, first byte for a 15-word sentence p90 at most 500 ms, no fallback header) stand. It changes no verdict: C6 has already failed (section 10.1).

**Q1, 2026-11-14, a new question added AFTER C6's result (section 10.1) and BEFORE any real call of the owner's; exploratory, not a criterion, and it cannot move the verdict of section 9.6 (C6 is not amended).**
*Question:* does Qwen3-ASR on `:8803` hear the owner (Chinese-accented English, a real microphone) better than Deepgram Flux with the live keyterms? *Data:* in the owner's lab calls the trace holds both recognizers' texts for every turn (shadow ears, 5.1). *Reading rule, fixed now:* the report lists every turn in which the two texts differ in a word of the live `KEYTERMS` or by more than one word otherwise; each such turn is marked "LabGPU right", "Flux right", "both wrong" or "equal enough", by the owner where he is willing (he knows what he said), otherwise by the lead and then labelled "lead's reading", marking only turns where one text is evidently a mishearing of a term ("wait group" for `WaitGroup`, "Cody" for Coady). The report gives the counts as k/n. "Qwen3-ASR is better for him" is said only if LabGPU is right in at least twice as many marked turns as Flux and in at least 5 of them; otherwise it says "no difference shown", with the counts. Calls made with the shadow recognizer off, or with `ears=flux`, do not count.

**A3, 2026-11-14, before any end-to-end number: where C5's 100 ms comes from.** C5 asks for an engine overhead of at most 100 ms from `FunctionCallResponse` to the next think request. The unit test that first held that bound failed once in two full runs of the suite (105 ms, with 24 test files running at once on a busy machine), so it now guards only against a gross regression (300 ms, from the request's arrival time at the relay, not from a poll). The criterion's 100 ms is read from the trace of the host runs: `rounds[].afterAnswerMs` (the next request's `thinkSent` minus the moment the last function of the previous round answered; the trace holds every request of a turn), p90 over all tool turns, printed by `tai_live.sh voice lab`. The trace sink also writes synchronously now (two asynchronous appends could finish in either order, and a reader could see the file before its first line). Nothing else of C5 changes.

**A4, 2026-11-14, before any end-to-end number: how the measuring client reads three criteria (the client was written against A1; these are the points A1 left open).**
- *Too-long wait (C2).* A complete utterance for which **no end-of-turn line arrives at or after UE within the scenario's window** counts as a too-long wait: the wait has no end, and a chain that never committed a scenario would otherwise pass the criterion by silence. It is also listed as "not committed" (k/n), and for the short answers it is also a failure of "committed in every trial".
- *Cut-in (C2, C10).* Agent audio counts only if the run of speech it belongs to began inside the scenario: a late answer to an earlier scenario, the greeting and an injected filler do not. Audio that begins during the scenario's 600 ms lead counts, and is listed as "stray".
- *False barge-in (C3).* The hub sends `agent_interrupted` at every user speech onset, not only at a barge-in; so a false one is an `agent_interrupted` that no scripted utterance explains (from 100 ms before its first frame to 1 s after its last). The 40 agent turns it is counted against are the times the agent began to speak outside scripted speech (the greeting included). A barge-in with no `agent_interrupted` is an infinite stop time, not a dropped trial; an interruption over an agent that was not audible at the onset (by a playout clock with 150 ms of slack) is not a barge-in and is counted apart.
- *What a client cannot see.* `evaluate_answer` is invisible in the browser protocol: the interview class is a tool turn in a call started in interview mode. The half of C10 that says "the mode switch completes" is checked by the unit tests (`lab.test.ts`); the client only checks that `ready` names the mode it asked for. That the assistant message of the next request holds only what was spoken (C3) is a check of the server's trace, marked as such in the client's report.

**A5, 2026-11-14, before any end-to-end number: how the interleaved sessions are cut.** Section 9.2 asks for calls alternating L, lab, L, lab ... in one session of at most two hours. The whole test set takes about an hour of call time per chain, two hours for L and D together, plus the gaps and the busy retries: it does not fit in one session. So: **one session per `--set`** (latency, pause, short, filler, bargein, interview, talk), each interleaved L, D, L, D ... and each at most two hours, the sessions of one evening where possible and never in class hours. A criterion that pools several sets (C2: pause, short and filler; the tool-turn line of C1) pools their sessions; the report's "calls span more than two hours" warning is then expected, and each session's window is written into section 10 with its results. A session with a model or gateway outage, or with unanswered turns on the live side, is repeated whole (9.2).
