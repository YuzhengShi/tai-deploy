"""render_local_pc.py: the local voice's per-sentence clips made on the PC with the service's OWN code (`localvoice.tts.SupertonicBackend`, the class the container runs), for the settings the container
does not have: 16 and 24 synthesis steps. At every setting it compares each clip with the clip the deployed container made on the host (`<bank>/raw/sent/local-F1/r1`) in LENGTH, which the engine
repeats exactly (the duration predictor is deterministic) while the waveform is NOT repeated (the vocoder starts from fresh noise at every synthesis: two renders of one sentence are uncorrelated),
and in speech level. Equal lengths for all 40 sentences and the same level mean that the PC makes the container's voice, so that the 16- and 24-step rows can be read as "the same voice with more steps".

    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe render_local_pc.py [--bank D:\\tai-voice-local\\naturalness-bank-20261115] [--steps 5 16 24]

Settings as the lab sends them: voice F1, request speed 1.2 (the engine runs at 1.05 x 1.2 = 1.26), one request per sentence. Raw, no gain (the gain is applied by the analysis).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # so that `python -I` (no script directory on the path) finds nat_lib
import nat_lib as L   # noqa: E402,F401  (puts the service's package on sys.path)
from localvoice.tts import SupertonicBackend, pcm16_24k   # noqa: E402

MODEL_DIR = r'D:\tai-voice-local\supertonic\v1'


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--bank', default=r'D:\tai-voice-local\naturalness-bank-20261115')
    ap.add_argument('--steps', type=int, nargs='+', default=[5, 16, 24])
    ap.add_argument('--threads', type=int, default=4)
    args = ap.parse_args()
    passages = json.load(open(os.path.join(L.HERE, 'passages.json'), encoding='utf-8'))['passages']
    report = {}
    for steps in args.steps:
        backend = SupertonicBackend(MODEL_DIR, steps=steps, threads=args.threads, instances=1)
        backend.synthesize('Warm up.', 1.2, 'F1')
        rate = backend.sample_rate
        out_dir = os.path.join(args.bank, 'pc', 'sent', 'local-F1-steps%d' % steps, 'r1')
        os.makedirs(out_dir, exist_ok=True)
        t0 = time.time()
        audio_s = 0.0
        same = diff = missing = 0
        worst = 0.0
        level_diffs: list[float] = []
        for p in passages:
            for k, text in enumerate(p['sentences'], 1):
                samples = backend.synthesize(text, 1.2, 'F1')
                pcm = pcm16_24k(samples, rate)
                x = np.frombuffer(pcm, dtype='<i2')
                audio_s += len(x) / 24000
                L.write_wav(os.path.join(out_dir, '%s-s%d.wav' % (p['id'], k)), x.astype(np.float32) / 32768.0, 24000)
                host = os.path.join(args.bank, 'raw', 'sent', 'local-F1', 'r1', '%s-s%d.wav' % (p['id'], k))
                if not os.path.exists(host):
                    missing += 1
                    continue
                h, _ = L.read_pcm_i16(host)
                if len(h) == len(x):
                    same += 1
                else:
                    diff += 1
                    worst = max(worst, float(abs(len(h) - len(x))))
                hx, _ = L.read_wav(host)
                level_diffs.append(L.speech_level_db(x.astype(np.float32) / 32768.0, 24000) - L.speech_level_db(hx, 24000))
        wall = time.time() - t0
        report[steps] = {'clips': sum(len(p['sentences']) for p in passages), 'audio_s': round(audio_s, 1), 'wall_s': round(wall, 1), 'rtf': round(wall / audio_s, 3)}
        report[steps].update({'same_length_as_container': same, 'different_length': diff, 'missing': missing, 'max_length_difference_samples': worst,
                              'mean_level_difference_db': round(float(np.mean(level_diffs)), 2) if level_diffs else None})
        print(json.dumps({'steps': steps, **report[steps]}))
    path = os.path.join(args.bank, 'pc', 'render_local_pc.json')
    merged = json.load(open(path)) if os.path.exists(path) else {}
    merged.update({str(k): v for k, v in report.items()})        # a re-run of one setting keeps the others
    json.dump(merged, open(path, 'w'), indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
