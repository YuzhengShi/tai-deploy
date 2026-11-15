# Naturalness test of the local voice

Design and reading rules: `PROTOCOL.md` (written and committed before any clip was rendered). Results: `docs/LOCAL_VOICE.md` 9.20 and `results/`.

| file | what it does | where it runs |
|---|---|---|
| `passages.json` | the ten generic passages (40 sentences) | |
| `render_host.mjs` | renders the live voices (Flux hannah, Aura-2 thalia and mars) and the deployed container's local voice, per sentence and per passage; the key is read on the host and never printed | the host |
| `render_local_pc.py` | renders the local voice at 5, 16 and 24 steps with the service's own code and compares the 5-step clips with the container's, sample by sample | the PC |
| `nat_lib.py` | WAV, speech level, the lab's soft limiter, level and trim controls, the one resampler, YIN, the word normalizer, bootstrap, AUC | |
| `measure.py` | `levels`, `wer`, `flow`, `utmos`, `report` | the PC |
| `listening/` | the blind listening test: `make_kit.py` builds it, `serve.py` serves it on 127.0.0.1, `analyse_listening.py` reads the answers | the PC |
| `results/` | the small outputs: `summary.md`, `summary.json`, the listener's answers | |

The audio is not in git: it is under `D:\tai-voice-local\naturalness-bank-20261115\` (and the listening test under `D:\tai-voice-local\listening-test-20261115\`).

Re-run (PC, `D:\tai-voice-local\venv-tts\Scripts\python.exe -I -B`, with the bank copied to `<bank>\raw` from the host's `/tmp/nat-bank`):

    render_local_pc.py   measure.py levels   measure.py wer   measure.py flow   measure.py utmos   measure.py report

The predictor (`utmos22_strong.onnx`, `D:\tai-voice-local\predictors\`) is only needed by `measure.py utmos`.
