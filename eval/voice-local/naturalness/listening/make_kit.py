"""make_kit.py: builds the blind listening test (PROTOCOL.md, E) from the bank: 3 passages x 5 ways of speaking them + 2 clips of Piper (the voice the owner rejected, a low anchor) + 1 repeated clip.
Every clip is level-matched (-16 dBFS speech level, the lab's soft limiter), trimmed to 250 ms of silence at each end, written as 24 kHz mono WAV under an opaque name. The answer key stays OUTSIDE the
served folder.

    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe make_kit.py [--out D:\\tai-voice-local\\listening-test-20261115]
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import nat_lib as L   # noqa: E402

BANK = r'D:\tai-voice-local\naturalness-bank-20261115'
PIPER = r'D:\tai-voice-local\tts\vits-piper-en_US-lessac-medium'
PASSAGES = {p['id']: p['sentences'] for p in json.load(open(os.path.join(L.HERE, 'passages.json'), encoding='utf-8'))['passages']}
KIT_PASSAGES = ['p1', 'p4', 'p7']
ANCHOR_PASSAGES = ['p1', 'p4']
REPEAT = ('local-persentence', 'p1')


def concat(cond_dir: str, pid: str) -> tuple[np.ndarray, int]:
    xs, sr = [], 24000
    for k in range(1, 5):
        x, sr = L.read_wav(os.path.join(BANK, 'raw', 'sent', cond_dir, 'r1', '%s-s%d.wav' % (pid, k)))
        xs.append(x)
    return np.concatenate(xs), sr


def piper(text: str) -> tuple[np.ndarray, int]:
    import sherpa_onnx
    vits = sherpa_onnx.OfflineTtsVitsModelConfig(model=os.path.join(PIPER, 'en_US-lessac-medium.onnx'), tokens=os.path.join(PIPER, 'tokens.txt'), data_dir=os.path.join(PIPER, 'espeak-ng-data'))
    cfg = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(vits=vits, num_threads=4, provider='cpu'), max_num_sentences=1)
    tts = sherpa_onnx.OfflineTts(cfg)
    audio = tts.generate(text, sid=0, speed=1.2)
    return np.asarray(audio.samples, dtype=np.float32), int(audio.sample_rate)


def finish(x: np.ndarray, sr: int) -> np.ndarray:
    if sr != 24000:
        x = L._resample(x.astype(np.float32), sr, 24000)
        sr = 24000
    x = L.trim(x, sr, pad_ms=250)
    y, _ = L.normalize_level(x, sr)
    return y


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=r'D:\tai-voice-local\listening-test-20261115')
    a = ap.parse_args()
    site = os.path.join(a.out, 'site')
    if os.path.exists(site):
        shutil.rmtree(site)
    os.makedirs(os.path.join(site, 'clips'))
    used: set[str] = set()

    def new_id() -> str:
        while True:
            i = 'k' + secrets.token_hex(3)
            if i not in used:
                used.add(i)
                return i

    key: dict[str, dict] = {}

    def add(x: np.ndarray, cond: str, pid: str, repeat_of: str | None = None) -> str:
        i = new_id()
        L.write_wav(os.path.join(site, 'clips', i + '.wav'), x, 24000)
        key[i] = {'cond': cond, 'passage': pid, 'repeat_of': repeat_of, 'seconds': round(len(x) / 24000, 2), 'level_db': round(L.speech_level_db(x, 24000), 2)}
        return i

    made: dict[tuple[str, str], str] = {}
    for pid in KIT_PASSAGES:
        x, sr = L.read_wav(os.path.join(BANK, 'raw', 'para', 'flux-hannah-whole', 'r1', pid + '.wav'))
        made[('flux-whole', pid)] = add(finish(x, sr), 'flux-whole', pid)
        x, sr = concat('aura-thalia', pid)
        made[('aura-persentence', pid)] = add(finish(x, sr), 'aura-persentence', pid)
        x, sr = L.read_wav(os.path.join(BANK, 'raw', 'para', 'aura-thalia-whole', 'r1', pid + '.wav'))
        made[('aura-whole', pid)] = add(finish(x, sr), 'aura-whole', pid)
        x, sr = concat('local-F1', pid)
        made[('local-persentence', pid)] = add(finish(x, sr), 'local-persentence', pid)
        x, sr = L.read_wav(os.path.join(BANK, 'raw', 'para', 'local-F1-whole', 'r1', pid + '.wav'))
        made[('local-whole', pid)] = add(finish(x, sr), 'local-whole', pid)
    for pid in ANCHOR_PASSAGES:
        x, sr = piper(' '.join(PASSAGES[pid]))
        add(finish(x, sr), 'piper-anchor', pid)
    cond, pid = REPEAT
    x, sr = concat('local-F1', pid)
    add(finish(x, sr), cond, pid, repeat_of=made[(cond, pid)])

    ids = list(key)
    rng = np.random.default_rng()
    rng.shuffle(ids)
    json.dump({'ids': ids}, open(os.path.join(site, 'manifest.json'), 'w'))
    shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html'), os.path.join(site, 'index.html'))
    json.dump(key, open(os.path.join(a.out, 'key.json'), 'w'), indent=1)
    total = sum(v['seconds'] for v in key.values())
    print('kit: %d clips, %.0f s of audio, in %s (key outside the served folder: %s)' % (len(key), total, site, os.path.join(a.out, 'key.json')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
