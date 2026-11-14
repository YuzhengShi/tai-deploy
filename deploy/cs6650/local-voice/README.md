# local-voice

LabGPU's two voice services on **our own CPU, behind one loopback port**: the recognizer (`/v1/listen`, a Deepgram-compatible websocket) and the synthesizer (`POST /tts`). The lab engine
(`src/voice/lab/`) uses it by changing two settings, with no change to its code. Design, measurements and the reasons for the numbers: `docs/LOCAL_VOICE.md`.

| | engine | where it comes from |
|---|---|---|
| ears | NVIDIA Parakeet-TDT-0.6B-v2, int8, through sherpa-onnx 1.13.8 (an offline model: this service decides what a buffer is) | `D:\tai-voice-local\models\parakeet-tdt-0.6b-v2-int8` |
| mouth | **Supertonic** v1 (the engine behind LabGPU's adapter), voice style F1 at the package defaults = the style nearest LabGPU's voice by length and pitch (`docs/VOICE_SELFBUILT.md` 10.13), `supertonic` 1.0.0 | `D:\tai-voice-local\supertonic\v1` |
| mouth, optional | Piper `en_US-lessac-medium` through sherpa-onnx (`LOCAL_VOICE_TTS_BACKEND=piper`) | `D:\tai-voice-local\tts\vits-piper-en_US-lessac-medium` |

## Using it from the lab

```
TAI_VOICE_LAB_EARS_URL=ws://<address>:18800/v1/listen
TAI_VOICE_LAB_TTS_URL=http://<address>:18800
```

`<address>` is 127.0.0.1 for the process run below and 172.29.88.2 for the container below. The ears address needs no query: LabGPU's default carries `?encoding=linear16&sample_rate=16000&language=en&label=tai-lab`, which the service
accepts and does not need, and the operator's `tai_live.sh set` takes no `?` or `&` in a value (a test covers the bare address). With those two the lab uses the service wherever it used LabGPU's services. They do NOT by themselves keep the audio and the text inside: the lab's defaults still stream every call's audio to Deepgram's Flux as
a second ("shadow") recognizer, fall back to Flux when the ears fail and to Aura when the mouth fails, and a call that asks for `?chain=d|h|fd|c` (the owner's measurement route) gets those parts back whatever the
settings say. For calls that send nothing to a third party also set

```
TAI_VOICE_LAB_SHADOW_EARS=none
TAI_VOICE_LAB_EARS_FALLBACK=none
TAI_VOICE_LAB_MOUTH_FALLBACK=none
```

and do not use `?chain=` (a failure of the service is then a failed call, not a silent switch to Deepgram). The language model is a separate matter (the relay). Pace: since amendment A6 the lab runs with
`TAI_VOICE_LAB_TEMPO=0` (the voice at its natural pace; the owner did not want the 1.2x stretch), and this voice at its natural pace is LabGPU's pace (same length for the same sentences), so leave it at 0. Piper
speaks 3.7 words a second at its natural pace, faster than LabGPU's. The ears URL may carry `keyterm=` values (merged with the service's own list) and nothing else that matters; `encoding` must be `linear16` and
`sample_rate` 16000 if given (anything else is refused with HTTP 400 before the upgrade).

## Run it

Windows, PowerShell, the development PC's environment (it has sherpa-onnx, onnxruntime, supertonic and websockets):

```powershell
cd deploy\cs6650\local-voice
$env:LOCAL_VOICE_ASR_MODEL_DIR = 'D:\tai-voice-local\models\parakeet-tdt-0.6b-v2-int8'
$env:LOCAL_VOICE_ST_MODEL_DIR  = 'D:\tai-voice-local\supertonic\v1'
D:\tai-voice-local\venv-tts\Scripts\python.exe -B server.py          # 127.0.0.1:18800; about 9 s to load and warm both models, then the port opens
curl.exe http://127.0.0.1:18800/health                                # {"ok":true,"asr":"parakeet-tdt-0.6b-v2-int8","tts":"supertonic-v1"}
```

Docker (built and run on the cs6650 host in a scratch folder on 2026-11-14; see `docs/LOCAL_VOICE.md` section 9 for what it measured):

```
docker build -t tai-local-voice:latest deploy/cs6650/local-voice
docker network create --internal --subnet 172.29.88.0/24 tai-voice-net          # once: a network with NO route out
docker run -d --name tai-local-voice --restart unless-stopped --network tai-voice-net --ip 172.29.88.2 \
    --cpu-shares 128 --cpus 4 --memory 4g --memory-swap 4g --pids-limit 256 \
    --read-only --tmpfs /tmp:rw,size=64m -e HOME=/tmp --cap-drop ALL --security-opt no-new-privileges \
    -v /srv/tai-voice/models/parakeet-tdt-0.6b-v2-int8:/models/parakeet-tdt-0.6b-v2-int8:ro \
    -v /srv/tai-voice/models/supertonic/v1:/models/supertonic/v1:ro tai-local-voice:latest
curl http://172.29.88.2:18800/health         # from the host: the container's address on the bridge; no port is published
```

**Why an internal network.** The pip `onnxruntime` 1.32.0 that the speech engine uses contains a Microsoft OneCollector telemetry client that is on by default: measured on 2026-11-14 (a DNS sinkhole on an internal
network), `import onnxruntime` alone asks for `mobile.events.data.microsoft.com`, twice, and `onnxruntime.disable_telemetry_events()` after the import does not stop the first attempt. What the events carry was not
inspected. The environment variable `ORT_DISABLE_TELEMETRY=1` does stop it (zero questions for the import and for a model load); the package sets it before anything imports the library, the image sets it, and the
container runs on an `--internal` network (no route out; Docker's DNS does not forward names from it), so a later version of a library that behaves differently still reaches nothing. sherpa-onnx's own runtime (1.28.2) asked for
nothing without the variable. `check_egress.sh` repeats the measurement on a real container: the control (variable removed) must ask, the shipped image and a whole service run must not. The trial runs of 2026-11-14 on the
development PC and in the host's scratch folder used the library without the variable (synthetic audio only): its own library telemetry may have left then.

Memory measured on the PC after a run: about 1.8 GB resident (Parakeet about 1 GB, three Supertonic engines of 250 MB each and their working memory); 1.77 GiB in the container on the host after 30 calls. `LOCAL_VOICE_TTS_WORKERS=2` saves 250 MB.

## Tests, smoke, accuracy

```powershell
$py = 'D:\tai-voice-local\venv-tts\Scripts\python.exe'
& $py -B -m unittest discover -s tests -t . -v      # 143 tests; the ones that need models skip themselves when the folders are not there (see the top of tests/test_real_models.py)
& $py -B smoke.py                                   # starts the server, streams 4 clips in real time, calls /tts; prints message kinds and times, never a transcript
& $py -B smoke.py --concurrent 3                    # the clips three at a time
& $py -B eval_set.py --set ..\..\..\eval\voice-lab\recognition2.json --audio <folder with manifest.json> [--whole-clip]
```

`eval_set.py` runs the service's own pipeline (segmenter, decode, layer) over a recognition set offline and scores it with the scorer of `eval/voice-local/asr_bench.py`; `--whole-clip` decodes each clip whole,
as stage 1 of A13 did. Do not run it on a set that is reserved for a measurement made later.

`python regenerate_keyterms.py` rewrites `keyterms.json` from `KEYTERMS` in `src/voice/settings.ts` (a test fails when the file is out of date).

## Settings (environment; a value that does not parse or is out of range stops the start with a message naming it)

| variable | default | what it is |
|---|---|---|
| `LOCAL_VOICE_HOST` | `127.0.0.1` | address to bind. The Docker image sets `0.0.0.0` (publish the port on 127.0.0.1 only); the service warns when bound to anything else |
| `LOCAL_VOICE_PORT` | `18800` | port; 0 takes a free one |
| `LOCAL_VOICE_ASR_MODEL_DIR` | `/models/parakeet-tdt-0.6b-v2-int8` | folder with `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt` |
| `LOCAL_VOICE_ASR_THREADS` | `4` | ONNX Runtime threads of the ONE recognizer shared by all connections: what bounds the CPU decoding can take |
| `LOCAL_VOICE_ASR_WORKERS` | `3` | threads that decode (decodes of different connections overlap on them; one connection's decodes are in order) |
| `LOCAL_VOICE_TTS_BACKEND` | `supertonic` | `supertonic` or `piper` |
| `LOCAL_VOICE_ST_MODEL_DIR` | `/models/supertonic/v1` | the Supertonic model folder (`onnx/`, `voice_styles/`); it is never downloaded into: a folder without the model stops the start |
| `LOCAL_VOICE_ST_STEPS` | `5` | synthesis steps (the package default; 2 is faster and a little rougher) |
| `LOCAL_VOICE_PIPER_MODEL_DIR` | `/models/vits-piper-en_US-lessac-medium` | the Piper folder (`en_US-lessac-medium.onnx`, `tokens.txt`, `espeak-ng-data/`) |
| `LOCAL_VOICE_TTS_THREADS` | `2` | ONNX Runtime threads of each speech engine |
| `LOCAL_VOICE_TTS_WORKERS` | `3` | speech engines = synthesis threads (one engine each, never shared between two threads) |
| `LOCAL_VOICE_KEYTERMS_FILE` | `keyterms.json` beside `server.py` | JSON list of the course terms the layer writes back (and the only list; the lab's ears URL carries none) |
| `LOCAL_VOICE_SILERO_MODEL` | none | path of `silero_vad.onnx`: replaces the energy VAD (not tested with a real model: none is on the development PC) |
| `LOCAL_VOICE_MAX_CONNECTIONS` | `4` | simultaneous recognition connections; the next is accepted and closed at once with 1013 |
| `LOCAL_VOICE_SEG_PAUSE_MS` (or `SEG_PAUSE_MS`) | `350` | a pause this long inside speech closes a segment, which is decoded at once; the engine counts the first text that arrives 350 ms after the end of speech as covering it (`coverAfterMs`), see the doc before going below |
| `LOCAL_VOICE_END_PAUSE_MS` (or `END_PAUSE_MS`) | `600` | a pause this long after the last speech ends the utterance (the final) |
| `LOCAL_VOICE_MAX_UTTERANCE_MS` | `30000` | hard cap: the utterance is ended by force (and the next one begins where it stopped) |
| `LOCAL_VOICE_MIN_SPEECH_MS` | `200` | a segment with less speech than this (a click, a cough) is dropped |
| `LOCAL_VOICE_PREROLL_MS` | `200` | audio kept before an onset |
| `LOCAL_VOICE_TRAIL_KEEP_MS` | `200` | silence kept after a segment |
| `LOCAL_VOICE_ONSET_MS` | `60` | speech this long (3 frames) opens a segment |
| `LOCAL_VOICE_INTERIM_MS` | `3000` | while a segment is open, its audio so far is decoded for a partial every this many ms (0 = never); it keeps the lab's 8 s silent-recognizer watchdog fed during a long stretch of speech |
| `LOCAL_VOICE_MAX_SEGMENT_MS` | `0` | soft cut: close a segment at its quietest spot after this long (0 = never; it costs accuracy, see the doc) |
| `LOCAL_VOICE_CUT_WINDOW_MS` | `400` | where the soft cut looks for the quietest spot |
| `LOCAL_VOICE_VAD_RMS_MIN` | `350` | the energy VAD: a frame is speech when its level (16-bit units) is at least this and `VAD_RATIO` times the quietest frame of the last `VAD_FLOOR_MS` (the lab's own rule) |
| `LOCAL_VOICE_VAD_RATIO` | `3` | |
| `LOCAL_VOICE_VAD_FLOOR_MS` | `2000` | |
| `LOCAL_VOICE_IDLE_COMMIT_MS` | `3000` | wall-clock backstop: with an utterance open and no audio for this long, the utterance is ended (a stream that simply stops) |
| `LOCAL_VOICE_STALE_SILENCE_MS` | `200` | an interim result is dropped when the audio has been silent this long by the time it is ready (it would lack the last words): keep it below the engine's `TAI_VOICE_LAB_COVER_MS` (350) |
| `LOCAL_VOICE_MAX_PENDING_SEGMENTS` | `6` | segments waiting for the decoder per connection; beyond that the connection stops being read (TCP slows the sender) |
| `LOCAL_VOICE_WS_PING_S`, `LOCAL_VOICE_WS_PING_TIMEOUT_S` | `20`, `20` | the server pings this often; a connection from which nothing at all was heard for the two together is dropped |
| `LOCAL_VOICE_MAX_TTS_PENDING` | `16` | `/tts` requests waiting for or using a synthesis thread; the next gets 503 |
| `LOCAL_VOICE_LOG_LEVEL` | `INFO` | `debug`, `info`, `warning`, `error` |

Fixed limits (constants in the code): 16 KiB for a request head and for a `/tts` body, 1000 characters of text, speed 0.5 to 2.0, 64 sockets open at once, 64 KiB per websocket message.

## The interfaces in one screen

* `GET /health` -> `{"ok":true,"asr":"...","tts":"..."}`.
* `GET /v1/listen` (websocket): binary messages are audio (16 kHz mono PCM16 little-endian, any size; the lab sends 640 bytes); text messages `{"type":"KeepAlive"}` (ignored), `{"type":"Finalize"}`
  (end the utterance now and answer, with an empty transcript if there was nothing) and `{"type":"CloseStream"}` (flush, then close with 1000). The server sends `{"type":"Results","is_final","speech_final",
  "from_finalize","channel":{"alternatives":[{"transcript","confidence"}]},"duration","start"}` and `{"type":"UtteranceEnd","last_word_end"}`: a partial (`is_final` false) is the text of the whole utterance so
  far, the final (`is_final` and `speech_final`) is the whole utterance; an utterance with no text sends nothing. The text keeps the model's capitals and punctuation, with the course terms written as the terms.
* `POST /tts` with `Content-Type: application/json` and `{"text":"...","voice":"af_bella","speed":1.0}` -> `200 application/octet-stream`, raw PCM s16le mono **24 kHz**, chunked (about ten pieces), never an
  `X-TTS-Fallback` header. Voices (Supertonic): `default`, `af_bella`, `af_heart` (all one voice, as in LabGPU's adapter: style F1) and the styles `F1`..`F5`, `M1`..`M5`; (Piper): `default`, `af_bella`, `lessac`. Any other name, `DrBerg`
  included, is a 400. `speed` multiplies the natural pace. Text the voice cannot say (Chinese, say) is a 400; `x = 5`, grave accents and the like are said (as words, or folded to plain letters).
  Errors are `{"error":"..."}` with a fixed message that never repeats what was sent.

## Files

`server.py` entry point; `localvoice/` the package (`config`, `vad`, `segmenter` the state machine, `asr`, `keyterms` + `spoken_forms` (verbatim copy of the frozen rules), `tts`, `listen` the per-connection
session, `wsconn` the websocket side, `httpio` + `httpd` the HTTP front and `/tts`, `services`, `logutil`); `tests/`; `smoke.py`; `eval_set.py`; `regenerate_keyterms.py`; `check_egress.sh` (the network
check above); `keyterms.json`; `requirements.txt`; `Dockerfile`, `.dockerignore`.

## Privacy

No transcript, no text of a synthesis request and no audio is ever written to a log, an error message or a file. The log has counts, durations and connection events; an exception is described by its class and the
place it was raised, never its message; the websocket library gets a switched-off logger; the address of a request is logged without its query. `tests/test_protocol.py` and `tests/test_tts_http.py` search the
captured log for marker texts. The service opens no outgoing connection and fetches no model (`auto_download` is always off); the library telemetry that would leave is switched off and cut off as described under
"Why an internal network".
