# The local voice service (design, parameters, measurements)

The service is in `deploy/cs6650/local-voice/` (its `README.md` lists every setting and how to run it). It is the answer to amendment A13 of `docs/VOICE_SELFBUILT.md` ("can what the lab needs from LabGPU be
replaced by models on our own CPU?") in the form the lab can use: **one Python process that imitates both of LabGPU's interfaces on one loopback port**, so that the lab engine switches to it by changing
two settings and no code:

```
TAI_VOICE_LAB_EARS_URL=ws://127.0.0.1:18800/v1/listen?encoding=linear16&sample_rate=16000&language=en&label=tai-lab
TAI_VOICE_LAB_TTS_URL=http://127.0.0.1:18800
```

The ears are NVIDIA Parakeet-TDT-0.6B-v2 (int8, sherpa-onnx 1.13.8), the engine stage 1 of A13 measured (10.11). The mouth is **Supertonic** (`supertonic` 1.0.0, English model, ONNX Runtime), the engine behind LabGPU's
adapter, with the voice style F1 at the package defaults: of the ten styles it is the closest to LabGPU's own recordings of two sentences by length (3.73 s against 3.74 s) and pitch (198 Hz against 203 Hz)
(`docs/VOICE_SELFBUILT.md` 10.13). F2 is nearer by the average spectrum, so which of the two is the voice the owner means is for his ear to say, and both are available (`voice` F1 or F2). The owner listened to
Piper and Kokoro and did not accept either; Piper is kept as an optional backend (`LOCAL_VOICE_TTS_BACKEND=piper`) for comparisons.

Nothing in the service calls out to a network, and nothing in it ever writes a transcript, the text of a synthesis request or audio to a log, an error message or a file.

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
| the 'labgpu' mouth is time-stretched by 3.45 / 2.69 (LabGPU's pace) when `TAI_VOICE_LAB_TEMPO` is on | `agent.ts` `tempoFactor` | Supertonic F1 at the package defaults speaks at LabGPU's pace (same length for the same sentences), so TEMPO stays on; Piper (3.7 words a second) needs `TAI_VOICE_LAB_TEMPO=0` |

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
* `Dockerfile` has not been built (no Docker on the development PC). Two ONNX Runtimes (sherpa-onnx's 1.28.2 and the pip package's 1.32.0) share the process: tested on Windows in both import orders, not on Linux.
  `supertonic` was installed with `--no-deps` (it pins numpy below 2 and pulls soundfile and huggingface-hub, which nothing here uses): numpy 2.5.4 for everything, and the Supertonic backend was also run on 1.26.4.
* Silero VAD is wired and tested with a stand-in detector only.
* A client that closes its sending side before the audio of a `/tts` request is ready is taken to have gone away (the request is dropped); HTTP clients do not do that.
* No authentication: the port is meant for 127.0.0.1 (the image binds 0.0.0.0 inside the container and says to publish it on 127.0.0.1 only).
* The soft cut, `MAX_SEGMENT_MS`, is lossy (3.3). A `SEG_PAUSE_MS` below 350 closes segments earlier, and the text that covers the speech still arrives 350 ms after its end only while the decode makes up the
  difference (a very short last segment would not: the engine would wait for the final instead); it also splits more sentences at their pauses.
