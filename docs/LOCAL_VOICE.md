# The local voice service (design, parameters, measurements)

The service is in `deploy/cs6650/local-voice/` (its `README.md` lists every setting and how to run it). It is the answer to amendment A13 of `docs/VOICE_SELFBUILT.md` ("can what the lab needs from LabGPU be
replaced by models on our own CPU?") in the form the lab can use: **one Python process that imitates both of LabGPU's interfaces on one loopback port**, so that the lab engine uses it by changing
two settings and no code:

```
TAI_VOICE_LAB_EARS_URL=ws://<address>:18800/v1/listen
TAI_VOICE_LAB_TTS_URL=http://<address>:18800
```

(`<address>` is 127.0.0.1 for the process on the same machine and 172.29.88.2 for the container of section 9. The ears address needs no query: LabGPU's default has `?encoding=linear16&sample_rate=16000&language=en&label=tai-lab`,
which the service accepts and does not need, and the operator's `tai_live.sh set` takes no `?` or `&` in a value.)

**Those two settings make the lab LOCAL IN FUNCTION, not in data.** The lab's own defaults still send each call's audio to Deepgram (a Flux "shadow" recognizer on the same audio, `TAI_VOICE_LAB_SHADOW_EARS`
`auto` = Flux when the ears are LabGPU's), switch to Flux when the ears fail and to Aura when the mouth fails (`TAI_VOICE_LAB_EARS_FALLBACK`, `TAI_VOICE_LAB_MOUTH_FALLBACK`), and a call that asks for `?chain=d|h|fd|c`
(the owner's measurement route, `forChain` in `src/voice/lab/config.ts`) gets those parts back whatever the environment says. A call that sends nothing to a third party (the language model aside) needs
`TAI_VOICE_LAB_SHADOW_EARS=none`, `TAI_VOICE_LAB_EARS_FALLBACK=none` and `TAI_VOICE_LAB_MOUTH_FALLBACK=none` as well, and no `?chain=`; then a failure of the service is a failed call and not a silent switch
to Deepgram. The lab uses one LabGPU voice name for every mode (`af_bella`), which the service accepts. No code guard or local-only chain has been added: the lab is owner-only today, and the choice is
the owner's.

The ears are NVIDIA Parakeet-TDT-0.6B-v2 (int8, sherpa-onnx 1.13.8), the engine stage 1 of A13 measured (10.11). The mouth is **Supertonic** (`supertonic` 1.0.0, English model, ONNX Runtime), the engine behind LabGPU's
adapter, with the voice style F1 at the package defaults: of the ten styles it is the closest to LabGPU's own recordings of two sentences by length (3.73 s against 3.74 s) and pitch (198 Hz against 203 Hz)
(`docs/VOICE_SELFBUILT.md` 10.13). F2 is nearer by the average spectrum, so which of the two is the voice the owner means is for his ear to say, and both are available (`voice` F1 or F2). The owner listened to
Piper and Kokoro and did not accept either; Piper is kept as an optional backend (`LOCAL_VOICE_TTS_BACKEND=piper`) for comparisons.

The service opens no outgoing connection and fetches no model, and nothing in it ever writes a transcript, the text of a synthesis request or audio to a log, an error message or a file. One library inside it
would phone home on its own (the pip onnxruntime 1.32.0 has a Microsoft telemetry client that asks for `mobile.events.data.microsoft.com` as soon as it is imported: measured 2026-11-14); it is switched off by
an environment variable and the container runs on a network with no route out (section 9, and the README under "Why an internal network").

## 1. What the lab's own code requires (the client is the specification)

| fact | where | consequence here |
|---|---|---|
| audio arrives as binary messages of exactly 640 bytes (20 ms of 16 kHz PCM16); text messages `KeepAlive`, `Finalize`, `CloseStream` | `ears/v1.ts` `WsEars`, `V1Ears` | any piece size is accepted (regrouped); `Finalize` is honoured (LabGPU's adapter ignores it), `CloseStream` flushes and closes with 1000 |
| a message with neither flag is a partial, `is_final` a finished segment, `speech_final` or `from_finalize` ends the utterance; the final must be the WHOLE utterance; an empty text never makes an event | `UtteranceJoiner` | partials carry the whole utterance so far, the final the whole utterance; an utterance with no text sends nothing |
| the first text that arrives 350 ms or more after the end of speech counts as covering the speech, and in a conversation the engine answers on it at once | `turn.ts` `TurnTracker.noteCover`, `coverAfterMs` | a segment is closed after a 350 ms pause and decoded then; a partial that lacks the last words must never arrive after those 350 ms (see 3.4) |
| `judgeTurnText` reads the punctuation of the text: a closing `?` makes "Can you explain what a mutex is?" a finished question; the same words without it end on "is" and are held 1.8 s as unfinished | `turn.ts` | the key-term layer works on the spans of the words and keeps the model's case and punctuation |
| a recognizer that sends no partial or final for `silentEarsMs` (8 s) after the onset of speech is given up, and the call falls back to Flux | `agent.ts` `waitingForEarsSince` | a partial at least every few seconds of continuous speech (interims, 3.3) |
| the mouth's body is raw PCM s16le 24 kHz, a `content-type` that is not JSON or text, and no `X-TTS-Fallback` header; a body that starts with `RIFF` is taken for a WAV | `mouth/labgpu.ts` `streamPcm`, `LabGPUMouth` | exactly that, chunked in about ten pieces; the first four bytes are never `RIFF` (guarded) |
| a voice name matches `[A-Za-z0-9_.-]{1,64}` and is never `DrBerg`; the lab asks for `af_bella` and never sends `speed` | `checkLabGPUVoice`, `config.ts` | `default`, `af_bella`, `af_heart` and the styles `F1`..`F5`, `M1`..`M5` are accepted, anything else is a 400 |
| the 'labgpu' mouth is time-stretched by 3.45 / 2.69 when `TAI_VOICE_LAB_TEMPO` is on (to the live voices' pace); since amendment A6 the lab runs with `TAI_VOICE_LAB_TEMPO=0`, the natural pace the owner asked for | `agent.ts` `tempoFactor` | Supertonic F1 at the package defaults speaks at LabGPU's natural pace (same length for the same sentences): leave TEMPO at 0, as it is. Piper speaks 3.7 words a second at its natural pace (faster than LabGPU's) |

## 2. Shape

```
                                      one loopback port (httpd.py: one request head is read, then it is routed)
 lab engine ---- ws /v1/listen ---->  wsconn.py  --audio-->  Segmenter  --events-->  queue  -->  one emitter task per connection
 (LabGPUMouth, V1Ears)                 (websockets' sans-I/O                                       decodes on the shared ASR pool, sends Results
                                       ServerProtocol + our I/O)
              ---- POST /tts ---->    httpd.py  -- validates, then the TTS pool: engine.synthesize -> resample 24 kHz -> PCM -> ~10 chunks
              ---- GET /health --->   httpd.py
```

The websocket library's own server cannot take a `POST` with a body (it parses the request head itself and then expects frames), and the synthesizer must share the port, so the front is written here
(`httpio.py`: strict, small, one request per connection) and the library is used for what it is good at: its sans-I/O `ServerProtocol` does the handshake, the framing, masking, UTF-8, size limits, close codes
and the answers to pings, and is handed the very bytes the front has read. The two engines run on thread pools (sherpa-onnx and ONNX Runtime release the GIL), never on the event loop.

## 3. The recognizer

### 3.1 Segmenting (`segmenter.py`)

Parakeet is an offline model, so the service decides what a buffer is. A pure state machine on 20 ms frames (audio time, never the wall clock: the same bytes give the same events at any speed, which is what lets the
tests stream a minute of audio in milliseconds):

* **VAD** (`vad.py`): a frame is speech when its level is at least 350 and three times the quietest frame of the last two seconds (the lab's own VAD rule and LabGPU's threshold); onset after 3 speech frames; 200 ms of
  audio before the onset is kept. A `FrameVad` interface lets `LOCAL_VOICE_SILERO_MODEL` swap in Silero (wired and unit-tested with a stand-in detector; no model file is on the development PC).
* a pause of `SEG_PAUSE_MS` (350) closes a **segment**, which is decoded at once and answered with a partial; a pause of `END_PAUSE_MS` (600) ends the **utterance** and sends the final; `MAX_UTTERANCE_MS` (30 s)
  forces the end (and the next utterance begins where it stopped); a segment with under 200 ms of speech is dropped; `Finalize` and `CloseStream` end it now; if no audio arrives for `IDLE_COMMIT_MS` (3 s of wall
  clock) while an utterance is open, it is ended too (a stream that simply stops would otherwise stay open for ever: the nemotron adapter's README, 2026-08-20).

### 3.2 The key-term layer (`keyterms.py`, `spoken_forms.py`)

The rules are the frozen ones of A13a (`spoken_forms.py` is a verbatim copy and a test fails if it drifts from `eval/voice-local/spoken_forms.py`): a recognizer writes "map reduce", "ec two", "wait group"; the layer
writes MapReduce, EC2, WaitGroup. The replacement is made on the spans of the matched words in the model's own text, so case and punctuation stay; a test checks, on hundreds of variants of the 64 sentences of
set 2, that the words are exactly those the frozen `apply_layer` gives. The terms come from `keyterms.json` (generated from `src/voice/settings.ts` by `regenerate_keyterms.py`; a test fails when it is stale),
plus any `keyterm=` values of the websocket address.

### 3.3 Partials during a long stretch (interims)

A student who explains something can speak for more than 8 s without a pause of 350 ms, and the lab gives up a recognizer that is silent that long after an onset. So while a segment is open its audio so far
(`interim_ms` 3 s, 6 s...) is decoded and sent as a partial. The segment itself is not cut, and its final decode covers all of it, so the final text loses nothing. An interim is a convenience and
a segment's decode is what the engine waits for, so an interim is not started while the decode workers are nearly all busy (a gate shared by all connections leaves one worker for segments), and an
unbroken stretch costs more CPU the longer it is (a 30 s one: nine interims, about 15 s of decoding spread over its 30 s, on top of the final's 3.4 s). The alternative, a **soft cut** of the
segment at its quietest spot (`MAX_SEGMENT_MS`, off by default), is worse for the text: on set 2 it cut 66 of 128 clips and took the word error rate from 4.54 % to 5.97 % (3.10 to 4.75 % with the layer) and
the key terms from 234 to 226 of 272 ("CAP theorem" became "capital" and "Theorem"). It would shorten the wait after the end of speech for long unbroken speech, which is why it stays as an option.

### 3.4 A partial must not be taken for the whole story

An interim decode takes 0.3 to 1 s. One that was offered just before the student stopped would arrive after the 350 ms the engine waits for and lack the last words, and the engine would answer on it. So an interim
result is dropped when something newer is queued behind it (the segment has closed: its own, complete decode follows) or when the audio has been silent for 200 ms by the time it is ready. The same holds for
the partial of a piece cut by the soft cut. (Cost: an interim decode that is still running when the speech ends delays the covering partial by what remains of it; a few per cent of utterances, under 0.5 s.)

### 3.5 Resources and refusals

One `OfflineRecognizer` is shared by all connections (measured: 108 concurrent decodes from 2 to 4 threads gave the transcripts of a sequential run; ONNX Runtime's thread pool, `ASR_THREADS`, bounds the CPU).
Per connection: one queue and one emitter, so segment N is sent before N+1 and the final of utterance N before anything of N+1; the queue holds at most `MAX_PENDING_SEGMENTS` (6), beyond which the connection stops
being read and TCP slows the sender (a client that streams faster than real time is held to the decode speed). At most `MAX_CONNECTIONS` (4) at once: the next is accepted and closed at once with 1013. The
server pings every 20 s and drops a connection from which nothing at all has been heard for 40 s, so that a client that vanished cannot keep a slot. Messages are at most 64 KiB (1009 beyond), heads and
bodies at most 16 KiB, 64 sockets open at once. Requests that carry an `Origin` header (a web page) are refused, `/tts` wants `Content-Type: application/json` (which a page cannot send across origins without
a preflight request that is never answered), and `encoding` and `sample_rate` in the address must say what the service speaks.

## 4. The synthesizer

`TtsBackend.synthesize(text, speed, voice) -> float32 samples` is all the server asks of an engine. `SupertonicBackend` keeps one engine object per worker (their ONNX sessions are never shared between two threads;
measured faster than one shared object, 5.9 s against 7.0 s for 24 sentences at three workers) and never downloads (`auto_download=False`). The model makes a whole sentence at once and its output LENGTH IS
DETERMINISTIC for a text, style and speed, so "F1 and default give the same length" is exact. The request's `speed` multiplies the natural pace (the package's 1.05) and is clamped to the package's 0.7 to 2.0, so
a request for 0.5 gets 0.67. `ST_STEPS` is the package's quality knob. The 44.1 kHz output goes to 24 kHz with the windowed-sinc function of `eval/voice-local/st_bench.py` (the one the owner's samples were made
with). The finished PCM is sent in about ten HTTP chunks (100 ms to 64 KB each): the first byte is the end of the synthesis, as with LabGPU's adapter.

What the lab's text cleaner lets through but the engine cannot say is not left to fail (the adapter's failure is its fallback to a third party): `=` is said "equals", `<` and `>` in words, `^ { } ~` dropped, a grave
accent or `ae`-type letter folded to plain letters. Text that still cannot be said (Chinese) is a 400 that does not repeat it. The package's own error message lists the characters of the request, so it is never
passed on or logged (only the class of an exception and where it was raised are).

## 5. The numbers this PC gave (Ryzen 5 6600H, 12 threads; the host is a different CPU, and decides)

**Accuracy**, set 2 (128 clips, 272 key-term instances, the scorer of `asr_bench.py`; `eval_set.py`):

| | WER raw | key terms raw | WER with layer | key terms with layer |
|---|---|---|---|---|
| each clip decoded whole (stage 1; reproduced here) | 3.83 % | 224 / 272 = 82.4 % | 2.82 % | 234 / 272 = 86.0 % |
| **the service's pipeline** (segments of the default settings, 1.72 per clip) | 4.54 % | 219 / 272 = 80.5 % | **3.10 %** | **234 / 272 = 86.0 %** |
| the pipeline with the soft cut at 4000 ms (66 of 128 clips cut) | 5.97 % | 213 / 272 = 78.3 % | 4.75 % | 226 / 272 = 83.1 % |

So segmenting at pauses costs about 0.7 points of WER raw (a pause inside a sentence loses the context: "TAi," alone became "Ty") and nothing in key terms once the layer is on. These are the numbers of the shipped
configuration; stage 2 of A13 (set 3, on the host) is the measurement that counts.

**Time**, real-time streams of 5 to 6 s clips (`smoke.py`), one at a time (three runs) and three at once; Parakeet decodes at about 0.11 s per second of audio on 4 threads (the server's own log: a 5.4 s
segment in about 0.6 s):

| | one at a time | three at once |
|---|---|---|
| first partial (an interim), after the start of the audio | 3.3 to 3.5 s | 3.6 s |
| the first text that covers the speech, after the END OF SPEECH: 0.35 s of pause + the decode of the last segment | 0.57 to 0.68 s when the sentence had a pause in it (a short last segment); 0.93 to 1.17 s for one unbroken 5.2 s segment | 0.68 s; 1.19 to 1.20 s |
| the final (`speech_final`) | the same moment (the segment's decode ends after the 600 ms) | the same |

LabGPU's adapter gives its final 1.0 to 1.6 s after the end of speech (docs 5.1). The wait grows with the length of the LAST segment (about 0.11 s per second of it, plus 0.35 s): that is the price of an offline
model, and the A13 clause of 800 ms for the final (p90, three streams) is likely NOT met on this PC for unbroken sentences of 5 s or more (the host's CPU may change that, and decides). The levers, none applied:
`ASR_THREADS` (measured here for one decode: 2 threads 0.146 s per second of audio, 4 threads 0.112, 6 and 8 threads 0.113 and 0.110, so nothing beyond 4 on this PC; three decodes at once take 1.0 s for the
three, against 0.67 s if they did not compete), a decode that starts before the 350 ms are over (it would save at most 0.2 s and waste decodes when the speaker goes on), a soft cut (costs accuracy, above), a smaller model.

`/tts` (Supertonic F1, 5 steps, 2 threads per engine, three engines): first byte (the same as the total: the model makes the whole sentence at once) 313 to 1015 ms for 2.1 to 8.7 s of audio (29 to 141
characters), median 480 to 610 ms over three runs (a real-time factor of 0.11 to 0.16); three requests at once 570 to 870 ms. A13's clause is 300 ms for a typical sentence. The levers, one engine and five
typical sentences (`ST_STEPS` / `TTS_THREADS`: median, p90): 5 / 2 488 ms, 903 ms; 5 / 4 373 ms, 648 ms; 2 / 2 325 ms, 616 ms; 2 / 4 266 ms, 394 ms. The lead's own measurement on a Ryzen with 4 threads was a
median of 381 ms at 5 steps and 280 ms at 2.

**Memory**: about 1.8 GB resident after a run (Parakeet about 1 GB, three Supertonic engines of 250 MB of models each plus working memory); `TTS_WORKERS=2` saves 250 MB. **Start**: 7.5 to 9 s to load and warm both models,
and the port opens only after that, so a health check that answers means a call can be served.

## 6. What was checked, and how

* **139 unit and protocol tests** (`python -m unittest discover -s tests -t .`, about a minute with the models): the VAD and the segmenter on synthetic audio (onsets, pauses, utterance end, hard cap, blips,
  `Finalize`, `CloseStream`, pieces of any size, audio time against wall time, interims, the soft cut); the key-term layer against the frozen one; the websocket protocol with the real client library, with the
  messages fed through a Python port of the lab client's joiner (`tests/joiner.py`: the TypeScript cannot be run from the checkout, which has no `node_modules`); the connection limit (1013), pings, backstops,
  oversize messages, garbage on the port, an out-of-date interim; `/tts` over a raw socket (chunk framing, headers, voices, speed, text, body rules, disconnects before the audio, while it is queued and in the middle,
  a flood, parallel requests); and that no marker text put into a request, a transcript or an error ever reaches the captured log.
* **The real models** (`tests/test_real_models.py`; skipped where the folders are not): two clips of set 2 under 15 % WER; the service hearing its own voice; Supertonic's pace between 2.5 and 4 words a second, F1,
  `default`, `af_bella` and `af_heart` the same length within 5 %; speed; the characters the lab's cleaner passes; three things at once; Piper.
* **Other clients**: Node's own `fetch` (undici, what `LabGPUMouth` uses) and Node's own `WebSocket` against the service. And the lab's OWN TypeScript, `LabGPUMouth` (with `streamPcm`) and `V1Ears` (with
  `UtteranceJoiner`), run through Node 26 against the service with the real models (scratch, not delivered: Node's strip-only mode needed three constructors rewritten and `ws`, which is not installed, replaced by
  a shim over Node's WebSocket): the mouth gave 3.9 s of audio in 12 pieces and refused an unlisted voice as the lab expects, and the ears gave a partial from an interim, a partial of the whole sentence and the
  final, with its punctuation and "Raft" and "Paxos" written as such.

## 7. Where this differs from LabGPU's adapter, as the engine will see it

Partials come from interims and segments, not every 1.1 s. `Finalize` and `speed` are honoured (the adapter ignores both). No `SpeechStarted` (the client ignores it; its own VAD hears onsets), no `Metadata`. An
utterance ends at a fixed pause of 600 ms, not 700 ms (1500 after a dangling word): the engine's own hold-off decides what is finished. The final comes 0.6 to 1.2 s after the end of speech, the adapter's 1.0
to 1.6 s. The text has the model's own punctuation and the key terms written as terms (the adapter's raw text had "map reduce" for MapReduce in 5 of 10 cases).

## 8. Known limits and what is not done

* The wait after the end of speech grows with the last segment (5). No speculative decode, no overlap-and-merge decoding.
* An interim decode in flight at the end of speech delays the covering partial by what remains of it (3.4).
* The image was built and run on the cs6650 host (scratch folder, 2026-11-14, section 9): it builds from `requirements.txt` with `--no-deps`, the two ONNX Runtimes (sherpa-onnx's 1.28.2 and the pip package's
  1.32.0) share one Linux process (the service's own order: sherpa-onnx first; both orders were tested on Windows), and a read-only root, no capabilities and a non-root user are enough.
  `supertonic` was installed with `--no-deps` (it pins numpy below 2 and pulls soundfile and huggingface-hub, which nothing here uses): numpy 2.5.4 for everything, and the Supertonic backend was also run on 1.26.4.
* Silero VAD is wired and tested with a stand-in detector only.
* A client that closes its sending side before the audio of a `/tts` request is ready is taken to have gone away (the request is dropped); HTTP clients do not do that.
* No authentication: the port is meant for 127.0.0.1 (the image binds 0.0.0.0 inside the container and says to publish it on 127.0.0.1 only).
* The soft cut, `MAX_SEGMENT_MS`, is lossy (3.3). A `SEG_PAUSE_MS` below 350 closes segments earlier, and the text that covers the speech still arrives 350 ms after its end only while the decode makes up the
  difference (a very short last segment would not: the engine would wait for the final instead); it also splits more sentences at their pauses.

## 9. The host check (2026-11-14, scratch folder; amendment A14 of `docs/VOICE_SELFBUILT.md`) and how the service would be put behind the lab

### 9.1 What was run

The image was built on the cs6650 host from a copy of this folder (the pins of `requirements.txt`, `--no-deps`; 205 MB of packages) and run the way the README says: read-only root, no capabilities, user 10001, 4 CPUs at
most and low priority, 4 GB, on an `--internal` network at 172.29.88.2 (the host reaches it there; nothing is published), the models read-only from the scratch folder (the same files as on the PC, equal fingerprints),
and its DNS pointed at a sinkhole that logs every name asked. It was healthy 7 s after the start. The live service, its settings, LabGPU's box and the lab were not touched. The measurements are those of A14, made with the lab's
OWN recognition client (`recognize.js run --ears labgpu --url ...`: the lab's `V1Ears` with the real `ws` library on Linux, the same client and scorer as the LabGPU, Flux and nova-3 rows of 10.12), one utterance after
another in real time, synthetic voices (Windows' David and Zira), the container's default settings, nothing changed between the runs.

### 9.2 Results

**Network.** Zero questions reached the sinkhole during the whole of it: the start, the models, `smoke.py` (three runs, 210 clips and their `/tts` calls), and the A14 runs (160 + 3 x 128 utterances), so nothing in the running service tried
to reach a name. Without the opt-out variable the pip onnxruntime asks for `mobile.events.data.microsoft.com` at import (README, "Why an internal network"; `check_egress.sh` repeats it).

**Accuracy** (the shipped pipeline: segments at pauses, interims, the key-term layer; paired against the rows of 10.12, the margins of A13):

| | WER | key terms | against Flux: recall, WER | against LabGPU: recall, WER |
|---|---|---|---|---|
| set 3, one stream (A14 (4), run once, never seen before) | 4.39 % | 222 / 274 = 81.0 % | **-5.5 points [-9.4, -1.7]**, +0.32 [-0.60, +1.23] | +4.0 [-0.6, +8.7], -0.52 [-1.76, +0.67] |
| set 2, three streams (the three streams' texts are identical) | 3.54 % | 230 / 272 = 84.6 % | -2.6 [-6.9, +1.7], -0.19 [-1.08, +0.66] | +10.3 [+5.0, +15.6], -2.42 [-3.76, -1.20] |

(Flux: 4.07 %, 237 / 274 on set 3 and 3.73 %, 237 / 272 on set 2; LabGPU: 4.92 %, 211 / 274 and 5.96 %, 202 / 272; whole-clip Parakeet with the layer on set 3: 3.61 %, 228 / 274.) **A13's clause (recall at most 5 points below
Flux's, WER at most 2 points above) is NOT met for the shipped pipeline on set 3, by half a point** (the interval does not exclude -5 either way), and is met on set 2 (-2.6); the WER half is met on both. Against LabGPU's
ears the service is better on both sets (non-inferiority shown; on set 2 the interval excludes zero). Segmenting is what costs: against whole-clip decoding of the same audio the service lost 8 key-term instances on set 3 and
gained 2, all of them the second sentence of an utterance decoded without the first ("So Terraform" came out as "Soterraform", "wait group" as "weight group", "Locust" as "locused", "Lamport" as "lampoard"). The names no
setting here fixes: TAi 0 of 12 (heard as "Ty"; Flux 8), Coady 0 of 10 (Flux 0), goroutine 1 of 10 (Flux 6), WaitGroup 2 of 10 (Flux 1). No setting was changed after seeing this (A14).

**The final after the end of speech** (A14's event; the lab engine answers on the first text 350 ms or more after the end of speech, which for a long last segment is the same moment, and for a short one earlier):

| | p50 | p90 | max | over 800 ms |
|---|---|---|---|---|
| service, one stream, set 3 (160 utterances of 9 to 19 words) | 623 ms | 1049 ms | 1402 ms | 15 % |
| service, three streams started 2.5 s apart, set 2 (384 utterances pooled; per stream p90 1562, 1693, 1615) | 1059 ms | 1609 ms | 2717 ms | 83 % |
| Flux on set 3 / set 2 (10.12 / 10.8) | 1533 / 1416 ms | 1856 / 1936 ms | | |
| LabGPU's adapter on set 3 / set 2 | 1754 / 1899 ms | 2130 / 2346 ms | | |

**A14's ears line (p90 at most 800 ms) is not met, alone (1049) or with three at once (1609)**, as written in advance. It is faster than Flux's and LabGPU's own finals on the same audio, by about 0.9 s and 1.1 s alone
and 0.4 s and 0.8 s with three at once, at the median. `smoke.py` (three clips in lockstep, the worst case) gave the same on 210 clips in three runs: covering partial and final p50 0.97 to 1.02 s, p90 1.52 to 1.56 s; the first partial
comes 3.3 s after the start of the audio (the interim).

**The mouth** (`smoke.py`, 5 steps, 2 threads per engine, three engines): first byte one at a time median 480 to 496 ms (max 1.03 to 1.08 s); three requests at once 0.8 to 1.5 s. A13's lines (300 ms alone, 500 ms with three at
once) are not met; LabGPU's GPU adapter is at 115 ms (10.1). `docs/VOICE_SELFBUILT.md` 10.13 found the three-at-once line met with three staggered component streams (each one sentence after the other, p90 at most 418 ms);
three requests at the same instant through the service is the harsher case, and a likely cause of the difference is the 4-CPU cap against three engines of 2 threads (not tested). The knobs, `ST_STEPS` and `TTS_THREADS`,
are in section 5.

**Load and memory.** The host's busy cores averaged 1.87 of 8 over the one-stream run and 3.43 of 8 over the three-stream run (the whole host, the live service's own use included): under A13's 4. The container's
memory settles near 2.05 GiB (9.4).

### 9.3 What it adds up to

Against LabGPU's two parts the local service is better at hearing (the finding that blocked chain d) and faster to a final; its mouth costs about 0.4 s more at the start of each sentence (about 500 ms against 115 ms). Against
Flux (the ears of today's call) it hears about as many words and 3 to 6 points fewer course terms, and its final is earlier. On A13's own numeric lines it fails three (the recall clause on set 3 by half a point, the ears line, the
mouth line) and meets the rest (WER, load, no network). Nothing here says how the whole chain feels or measures against today's call: only the owner's calls and, for numbers, a window of section 9 of
`docs/VOICE_SELFBUILT.md` can.

### 9.4 Memory over a long run

The container's resident memory after 30 clips was 1.77 GiB, after the A14 runs and 30 more clips 1.98 GiB, then 2.02 GiB after 60 more clips and 2.05 GiB after 120 more (and unchanged a minute later, idle): the growth per
clip falls (0.57 MB, then 0.23 MB) and the service sits near 2.05 GiB, which is what the ONNX Runtime's arenas filling up to the longest inputs look like, not a leak that would end at the 4 GiB limit. A kill by the limit would be
restarted by `--restart unless-stopped`; the log shows one warning line in the whole session, the start-up note that the service is bound to the container's own address and has no authentication.

### 9.5 Putting it behind the lab (the plan; done on 2026-11-14 on the owner's "部署", see 9.6)

Before anything: no call in the last 3 hours, not during class (Wednesday 15:15 to 17:15 Pacific), `TAI_VOICE_DAILY_MIN` back at 45, the rollback material made first (`orch.env` and the build, as for every deploy).

1. **Models** to a durable folder outside the release tree (a deploy replaces `~/tai-live/tai`): `~/voice-local/models/parakeet-tdt-0.6b-v2-int8` and `~/voice-local/supertonic/v1`, copied from the scratch folder, fingerprints checked against the PC's.
2. **Image**: the live tree (release 3afd82d) does not contain `deploy/cs6650/local-voice`, so ship the folder from the branch head to `~/voice-local/build` and build from it:
   `docker build -t tai-local-voice:YYYYMMDD -t tai-local-voice:live ~/voice-local/build` (the pip layer is cached from the scratch build, so it takes seconds). Never retag `tai-local-voice:scratch`: it was built before the last
   edits (the warning text of `server.py`, the tests). The previous `:live` tag, if any, stays for the rollback.
3. **Network and container** as in the README (`tai-voice-net`, 172.29.88.2, the hardening flags, `--restart unless-stopped`); wait for `/health` from the host.
4. **`check_egress.sh all`** against `tai-local-voice:live`: it must print PASS (the control asks, the shipped image and the running service do not).
5. **Lab settings** (orch.env, with `tai_live.sh set`, then `restart` with no call on): `TAI_VOICE_LAB_EARS_URL=ws://172.29.88.2:18800/v1/listen` and `TAI_VOICE_LAB_TTS_URL=http://172.29.88.2:18800`. For calls that
   keep the audio and the text inside, also `TAI_VOICE_LAB_SHADOW_EARS=none`, `TAI_VOICE_LAB_EARS_FALLBACK=none` and `TAI_VOICE_LAB_MOUTH_FALLBACK=none` (strict: a failure of the service is a failed call; with the fallbacks left on a
   failure is hidden and the audio goes to Deepgram, which makes a judgement of the local chain meaningless). The voice is `TAI_VOICE_LAB_LABGPU_VOICE` (default `af_bella` = style F1; `F2` is the other candidate). `?chain=d|h|fd|c`
   routes keep their Deepgram parts whatever is set; `TAI_VOICE_LAB_TEMPO` stays 0. **The URLs are global:** pointing them at the service turns the LabGPU parts of the `?chain=d|h|fd` routes into the local service as
   well (d becomes local ears and mouth with the Flux shadow and fallbacks, h the same with the eager end of turn, fd Flux ears and the local mouth; c, Flux and Aura, is unchanged), so after this change the round-2 chain
   labels no longer mean what they meant in 10.10 of `docs/VOICE_SELFBUILT.md`. The route without a chain, `api/voice-lab`, runs on the process settings and is the one that is local in the strict sense. The installed
   unit (`tai-live`) has no network restriction (`PrivateNetwork=no`, no `IPAddressDeny`, `RestrictAddressFamilies` empty: read on the host 2026-11-14), so it reaches 172.29.88.2 as the measuring client did.
6. **A synthetic call through the lab's route** with the measuring client (one scenario), then the owner calls it himself; a window (`TAI_VOICE_DAILY_MIN` raised for its length and put back) only if he wants numbers.
7. **Rollback**: restore `orch.env` from the rollback material, `restart`, `docker stop tai-local-voice`; nothing else was changed.

### 9.6 Deployed (2026-11-14, 22:42 to 22:51 UTC, on the owner's "部署")

The question he answered named these changes: a new container on an internal network, five lab settings, one restart (no call was on: the last lab call ended 18:47 UTC), the daily cap left at 45, no code deploy. Done in this order:

- **Rollback material** first: `~/tai-live/rollback-pre-localvoice/` (`orch.env.before`, `DEPLOYED-before.json`, `docker-before.txt`, `ROLLBACK.txt`).
- **Models** copied to `~/voice-local/` (886 MB; ten files compared with the PC's by SHA-256, all equal; `~/voice-local/FINGERPRINTS.txt` lists all 22).
- **Image** `tai-local-voice:20261114`, also tagged `:live` (d38bb9463b8a), built from commit c3aa542 (`git archive` of the branch head into `~/voice-local/build`, which names the commit in `SHIPPED_FROM_COMMIT`); `:scratch` was not reused.
- **Network** `tai-voice-net` (`--internal`, 172.29.88.0/24) and **container** `tai-local-voice` at 172.29.88.2 with the README's flags (read-only root, no capabilities, user 10001, 4 CPUs at most at low priority, 4 GB, `--restart unless-stopped`);
  healthy 7 s after the start.
- **`check_egress.sh all`** against `:live`: PASS (the control asked for Microsoft's collector, the shipped image and the running service asked for nothing).
- **The lab's own `LabGPUMouth`** (Node 22.23.4 on the host) against the container: `af_bella` (style F1), `F2` and `M1` each spoke two sentences, first piece 0.3 to 0.6 s; `DrBerg` is refused by the lab itself.
- **Five settings** in `orch.env` (`tai_live.sh set`): `TAI_VOICE_LAB_EARS_URL=ws://172.29.88.2:18800/v1/listen`, `TAI_VOICE_LAB_TTS_URL=http://172.29.88.2:18800`, `TAI_VOICE_LAB_SHADOW_EARS=none`,
  `TAI_VOICE_LAB_EARS_FALLBACK=none`, `TAI_VOICE_LAB_MOUTH_FALLBACK=none`; then `tai_live.sh restart` (22:50:49 UTC), `status` and `check` fine; `voice lab` now reads "fallback ears none". The cap stays 45; release 3afd82d and its lab
  code are unchanged (`TAI_VOICE_LAB_TEMPO=0`, `TAI_VOICE_LAB_AURA_SPEED_SCALE=0.85` as before).
- **How the owner reaches it:** the page address with `?voice=lab` (and no `chain`): the call runs on the process settings, so ears and mouth are the local service, with no Flux shadow and no fallback (a failure of the service is a
  failed call). The voice is style F1 (`af_bella`); another style is one setting, `TAI_VOICE_LAB_LABGPU_VOICE` (F1 to F5, M1 to M5, then `restart`).
- **The synthetic call through the lab route could not be made, and was not needed.** It was planned for 00:01 UTC (`~/voice-local/lv-verify.sh`) and refused with "You have used today's 45 minutes of voice calls" (start-failed, no minute spent):
  the usage counter's day is the app's time zone, America/Los_Angeles (`src/voice/usage.ts` takes a `timeZone`), so a day ends at 08:00 UTC in winter, not at UTC midnight (an earlier note of this branch said "the host day is UTC": wrong for
  the voice budget). The path was verified by the owner's own calls instead: the container logged his recognition connections (22:58, 22:59, 23:46 UTC) and the lab's trace holds his 12 turns on it (9.7).

### 9.7 The owner's first calls on it (22:58 and 23:46 UTC) and what he said

**His words after the calls (2026-11-14 about 23:50 UTC):** shadow listening off but the fallbacks NOT off; "the lab's voice sounds unnatural and not fluent; it has not the smooth, human-like conversation feel that Deepgram's has; the reaction is slow too". Applied at once as he said: `TAI_VOICE_LAB_EARS_FALLBACK=flux` and `TAI_VOICE_LAB_MOUTH_FALLBACK=aura` (the lab's own defaults, written out because `tai_live.sh set` cannot unset a key), `TAI_VOICE_LAB_SHADOW_EARS=none` unchanged, one restart at 23:55:21 UTC with no call on. With the fallbacks on, a failure of the local service no longer fails the call: the sentence or the recognizer is taken over by Aura or Flux, and the audio or the text of that part goes to Deepgram. Nothing was used so far: the calls below had no fallback in the trace.

**What the trace says about those two calls** (12 turns; the lab's own `turns.jsonl`, numbers only; the container's log of the same minutes):

| | this call, plain turns (no tool) | the earlier lab turns, all chains (n = 464) |
|---|---|---|
| end of speech to the committed turn | p50 535 ms | 893 ms (the local ears finish earlier than LabGPU's and Flux's) |
| the model's first token after the request | p50 1179 ms | 1172 ms (the same model, the same relay) |
| a sentence sent to the mouth to its first audio | p50 308 ms, 145 to 2455 ms | LabGPU's GPU 132 ms, Aura 213 ms |
| end of speech to first audio | p50 1995 ms (n = 9; 1424 to 5494) | 2090 ms (live call L, window of 10.10: 2069 ms) |

So in the steady state the reaction is the same as today's call, about 2 s, and the mouth is 0.2 s slower than LabGPU's or Aura's at the median. What he felt as slow is the first two turns of the first call (3574 and 5494 ms): the mouth took 1206 and 2455 ms for their first sentences. The container's log shows why: at the start of a call the lab renders its whole set of filler phrases through the mouth (`warmFillers`, about 40 short sentences one after another: 22:58:01 to 22:58:21, 0.2 to 1.5 s each), in the same container and on the same 4 CPUs as the recognizer and the real sentences, and the tool host of the call starts at the same time. On LabGPU's GPU that cost nothing; on this CPU the first replies wait behind it. It happens once per process (the phrases stay in the cache: the second and third call had no burst), so every restart of `tai-live` brings it back for the first call after it. The other things he felt are not in the numbers: Supertonic is not Aura (prosody and naturalness are the voice's, and no setting changes them), the pace is LabGPU's natural 2.7 words a second since A6 (the live voices speak 3.45), and the answers were four and five sentences long (he interrupted three times: the barge-in lines of the trace).

**Reading:** by his ears the local mouth does not reproduce today's call, which was the condition of this whole experiment (2026-11-05) and C7's judgement. The local ears did what was asked of them (better than LabGPU's, a little below Flux's on key terms, earlier than both). What would still need a code change if the local mouth were kept: warm the phrase cache at start-up or give it a low priority, and one voice per mode.

### 9.8 The owner's call on chain c: the control was not the live voice (2026-11-15, 00:20 UTC)

**His words:** Flux listening plus Aura speaking, with our own orchestration, "still does not sound like the live call. Every sentence sounds like a new sentence, not sentences said in one go. Hard to explain, but very unnatural."

**Cause found in our own settings and code:** the live call's conversation voice is **`flux-hannah-en`, a Flux TTS voice** (`src/voice/config.ts`: `TAI_VOICE_VOICE_CHAT`, default `flux-hannah-en`; the interviewer is `aura-2-mars-en`). Flux TTS is Deepgram's newer conversational synthesizer (`/v2/speak`; its voices are not served by the REST endpoint `/v1/speak`, as the comment at `auraVoiceChat` in `src/voice/lab/config.ts` already says). Per Deepgram's documentation the text is streamed into one turn over a WebSocket (`Speak` messages as the model writes, one `Flush` at the end of the turn), the server places sentence and clause boundaries itself, and "prosody carries across turns" because the model keeps the conversation's state. The lab's control chain c used `AuraMouth`: **Aura-2 REST, `aura-2-thalia-en`, one independent request per sentence**, each starting with a fresh sentence-opening intonation (`src/voice/lab/mouth/aura.ts`, `speaker.ts`: a queue of sentences, each synthesized by its own call). So chain c was never "Deepgram's voice with our orchestration": it was the older voice, spoken sentence by sentence. That also means the control chain of every round-2 comparison used a different voice from the live one (the latency numbers stand; the naturalness comparison was not like for like: amendment A15 of `docs/VOICE_SELFBUILT.md`).

**Samples to hear it** (the same four generic sentences, about 20 s each, made on the host with its own key, text only, nothing from a student; `D:\tai-voice-local\samples\tts-ab\`):
A = Aura-2 thalia, one request per sentence (the silences at the joins are small: 10 to 150 ms of lead and 10 to 40 ms of trail per clip, so the "new sentence" feeling is the intonation, not gaps), B = Flux TTS hannah through the WebSocket as an LLM stream would feed it (one `Speak` per sentence, one `Flush`; first audio 122 ms after the text), C = the same voice from the batch endpoint with the whole text (answered after 14 s: not for calls). The `SpeechMetadata` event closes a turn; audio frames come after `Flushed`.

**What a lab that sounds like the live call needs:** a Flux TTS WebSocket mouth (a streaming one, not the per-sentence `Mouth` interface: text deltas in, one flush per turn, `Interrupt` with `text_spoken` for barge-in), the speaker paced as now, and the transcript lines kept per sentence by an estimate. Flux TTS was priced at $0.045 per 1,000 characters on Deepgram's product page (one source, not confirmed on the pricing page), against $0.030 for Aura-2.


### 9.9 The Flux TTS mouth: an answer as one continuous speech (built 2026-11-15; code and tests only, nothing deployed)

**His words**, after hearing the samples of 9.8 and a pair that followed them (B2 = the whole answer as one Flux turn, D2 = one Flux turn per sentence on the same socket): "不一样连贯。请做 B2 那种整段一轮" (D2 is not as connected: build the whole answer as one turn). So the lab now has a mouth that does what the live call does, in the live call's own voice.

**What the service does** (probes of 2026-11-15 from the host with its own key, generic sentences only, `flux-hannah-en`; the documentation says less than this):
- `wss://api.deepgram.com/v2/speak?model=flux-hannah-en&encoding=linear16&sample_rate=24000[&speed=1.2]`, the key in the `Authorization: Token` header. A turn is the text between two `Flush`es; the turns of one socket are served one after the other.
- Audio begins about 120 ms after the first text, before any `Flush`, and is made 1.28 to 1.35 times faster than it plays. `Flushed` is not the end of the audio: `SpeechMetadata` is (its `audio_duration_ms` is the length of the turn).
- `Interrupt` with a `playback_offset` answers `SpeechInterrupted` with `text_spoken` and `text_remaining`, drops every turn queued behind it, and the socket stays usable. It counts the audio the session has MADE, not what played: the offset of an interrupt is the audio received before the turn began plus what of the turn had played, and each offset must be larger than the one before (else a warning `INVALID_INTERRUPT_OFFSET`). With no audio yet it is ignored (`NO_AUDIO_GENERATED`).
- The pace follows `speed` (0.5 to 1.5 in steps of 0.05), in the address or by `Configure` (one 190-character text: 0.8 gave 16.2 s of audio, 1.0 gave 11.1 s, 1.2 gave 9.3 s in one run and 12.6 s in another, 1.5 gave 7.1 s; on one socket `Configure` took effect on the very next speech in both directions: 11.8, 7.8, 7.5, 12.5, 12.3 s for 1.0, 1.5, 1.5, 1.0, 1.0). The length of the same text is not always the same: the voice is sampled, and one run in thirteen came out a third longer than the others at its speed.

**What was built.** `src/voice/lab/mouth/flux.ts` (`FluxTtsMouth`: one socket per call, a `SpeechTurn` per speech, the key read at every connection and only in the header, no error or log line with the key, the text or the service's own words, only codes), the `SpeechTurn` interface in `types.ts`, a streaming mode in `speaker.ts`, the choice of voice and the failure handling in `agent.ts`, the setting `TAI_VOICE_LAB_MOUTH=flux` (and `TAI_VOICE_LAB_FLUX_TTS_URL`, `TAI_VOICE_LAB_FLUX_SPEED_SCALE`), and the chain `cf` (Flux ears and the Flux mouth, LabGPU's ears and Aura as the fallbacks: chain c with the live voice in the live delivery mode, so that it is the control chain c was meant to be; `?voice=lab&chain=cf` on the page). A protocol-faithful fake of the service (`testing/fake-flux-tts.ts`) records what a client sends and checks it against the rules above.

**How an answer is spoken.**
1. The voice is the Settings' own when it is a Flux one (the live call's conversation voice, `flux-hannah-en`), at the Settings' pace. A call whose voice is an Aura one (the interviewer, `aura-2-mars-en`, which the session sets by `UpdateSpeak` as it does for the live agent) is spoken sentence by sentence through Aura, as in the live call; `UpdateSpeak` moves a call between the two ways.
2. The first sentence of an answer opens a speech; every sentence is a `Speak` (cleaned for speech as before); the end of the model's text for the round is the `Flush`. A function call ends a round, so the words before it and the answer after it are two speeches. The greeting and a line the session has the agent say are speeches of their own.
3. The socket is opened when the call starts, so that the first answer does not wait for the handshake (the first audio came after 114 to 115 ms on an open socket, 315 to 454 ms with the handshake in the live probe). The fixed filler lines are not rendered ahead of time as the other mouths do (a streaming mouth serves one speech after the other and is billed by the character): a filler is a speech of its own when it is needed.
4. The service says where the audio is, not where a sentence begins, so the speaker places the sentences of a speech on its timeline by their characters (60 / speed ms a character at first, the service's own length once it has said it) and sends each transcript line to the page when the clock reaches its place. When the student speaks over the answer, the history is cut at once by the same estimate, and a moment later by what the service says was heard: the speech is interrupted with the played offset, and `text_spoken` (cut at a whole word) replaces the estimate while the history still ends with it.
5. Failures. A speech that fails before it made any audio (the socket refused, the key rejected, the service down) is made again sentence by sentence through the fallback mouth, so that the answer is still heard, and the Flux mouth is left alone for 30 seconds (a warning `LAB_SPEECH_FAILED` goes to the page once). A speech that fails after some audio ends where its audio ended, with the same 30 seconds. The turn trace's `mouth` is the mouth that really speaks (the interviewer's turns read `aura`).

**What was checked** (host, 2026-11-15, scratch copy of this branch; the live service untouched, no restart, no setting changed):
- Type check clean. The unit and integration tests of the lab (the fake service, the mouth, the speaker's streaming mode, the agent through its socket with the real mouth against the fake: one speech per answer and the exact `Speak`/`Flush` sequence, two speeches around a function call, the greeting, the socket opened before the first sentence, the interviewer's voice through Aura, `UpdateSpeak` both ways, barge-in with the exact history, chain `cf`, a failing speech, the recognizer watchdog of 9.10): see the run at the end of this section.
- The real service with the lab's own mouth (`live-flux.probe.test.ts`, not in the repository, generic Raft and Go sentences, about 3,200 characters in all, about 15 cents at the list price): one speech of three sentences at speed 1.2 gave 11,520 ms of audio, which equals the `SpeechMetadata` length, 3.6 words a second (the live voices: 3.45); a speech cut at 1,000 ms of played audio returned 11 spoken and 214 remaining characters, and one cut at 900 ms returned 20 and 151, both cut at a whole word, both a prefix of the text that was sent, the two parts joining back to the whole; a third speech after two interrupts worked on the same socket (114 ms to first audio, 1,440 ms of audio, no warning, no error); the one-sentence path and `Configure` work as above.

**What it does not decide.** How it sounds: that is the owner's ears on `?voice=lab&chain=cf`, against the live call. No number is claimed for naturalness, and the criteria of `docs/VOICE_SELFBUILT.md` are not touched (A16). It is also not a local chain: the text of every answer goes to Deepgram, as in the live call (Flux TTS was priced at $0.045 per 1,000 characters on Deepgram's product page, one source, against $0.030 for Aura-2). The chains `d`, `h` and `fd` keep their own parts, LabGPU's or the local service's, and are not changed by it. **Known limits:** the transcript line of a sentence appears by estimate until the service has said the length of the speech (generation runs ahead of playback, so that is most of the speech): when the voice speaks slower or faster than the estimate for a particular answer the line is early or late by a part of a second to a second or two; a speech that fails halfway ends the answer there; a call whose Settings name a voice that is neither `flux-<name>-<language>` nor an Aura one is spoken as a conversation in the lab's default Flux voice.

### 9.10 The recognizer watchdog counts speech, not time (2026-11-15)

**Seen twice.** In the owner's own call of 2026-11-14 the watchdog gave a false alarm once (22:59:06 UTC: a stale timer, started by a blip that the local service drops). It was found again by the Flux mouth's own barge-in test (the first run of the new tests: 94 of 95 passed, and the one that failed had been switched to the fallback recognizer in the middle of the test): 360 ms of loud speech, a pause of 350 ms in the audio, audio again, and the lab said `LAB_EARS_SWITCHED`, "The recognizer is now flux". The watchdog (`agent.ts`, the tick; `docs/VOICE_SELFBUILT.md` 9.4 C8) gave the recognizer up when the VAD said the student was speaking and `silentEarsMs` (8 s) had passed since the first onset of the wait. That wait began at the first onset and ended only when the recognizer said a word, so a click or a cough that the recognizer rightly ignored stayed on the books, and the next real utterance, 8 seconds or any time later, tripped the watchdog at its own onset, before the recognizer had had a moment to answer; and a pause in the audio leaves the VAD's "speaking" flag set, so audio that resumed after it tripped it as well.

**Now:** the wait records the VAD's total voiced time when it begins (`Vad.voicedTotalMs`), and the recognizer is given up after `silentEarsMs` of SPEECH since then; a wait older than three times that is stale and starts again at the next onset (so that blips of noise spread over a long time never add up). A recognizer that says nothing during real speech is still given up, as before; background noise that the VAD takes for speech and the recognizer ignores still adds up (the VAD cannot tell them apart), but it needs 8 s of it. Two tests in `agent.test.ts` (a short stretch of speech and a pause in the audio; ten blips of noise spread over four seconds): neither switches now, and both did under the old rule; the existing test of a recognizer that says nothing during 900 ms of speech (the rig's limit is 600 ms) still switches.
