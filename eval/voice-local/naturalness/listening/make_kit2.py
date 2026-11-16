"""make_kit2.py: builds round 2 of the blind listening test (PROTOCOL-round2.md): 3 passages (p2, p5, p8) x [4 settings of the local voice + the live voice whole turn + Aura-2 whole passage], 2 Piper anchors,
one round-1 clip verbatim (drift between the sessions) and one clip of this round heard twice, at least 6 places apart (retest). Every clip is level-matched (-16 dBFS speech level, the lab's soft limiter),
trimmed to 250 ms of silence at each end, written as 24 kHz mono WAV under an opaque name. The answer key stays OUTSIDE the served folder.

    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe -I -B make_kit2.py [--out D:\\tai-voice-local\\listening-test2-20261115]
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..'))
import nat_lib as L   # noqa: E402
from make_kit import PASSAGES, finish, piper   # noqa: E402

BANK = r'D:\tai-voice-local\naturalness-bank-20261115'
ROUND1 = r'D:\tai-voice-local\listening-test-20261115'
KIT_PASSAGES = ['p2', 'p5', 'p8']
ANCHOR_PASSAGES = ['p2', 'p8']
# condition -> directory of the per-sentence clips (run 1), under the bank
LOCAL = {
    'local-control': os.path.join('raw', 'sent', 'local-F1', 'r1'),
    'local-pace1.1': os.path.join('pc', 'sent', 'local-F1-pace1.1-steps5', 'r1'),
    'local-pace1.0': os.path.join('raw', 'sent', 'local-F1-speed1.0', 'r1'),
    'local-steps24': os.path.join('pc', 'sent', 'local-F1-steps24', 'r1'),
}


def concat(sub: str, pid: str) -> tuple[np.ndarray, int]:
    xs, sr = [], 24000
    for k in range(1, 5):
        x, sr = L.read_wav(os.path.join(BANK, sub, '%s-s%d.wav' % (pid, k)))
        xs.append(x)
    return np.concatenate(xs), sr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=r'D:\tai-voice-local\listening-test2-20261115')
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

    def add(x: np.ndarray, cond: str, pid: str, **extra) -> str:
        i = new_id()
        L.write_wav(os.path.join(site, 'clips', i + '.wav'), x, 24000)
        words = sum(len(L.norm_words(s)) for s in PASSAGES[pid])
        sp = L.speech_seconds(x, 24000)
        key[i] = {'cond': cond, 'passage': pid, 'repeat_of': extra.pop('repeat_of', None), 'seconds': round(len(x) / 24000, 2), 'level_db': round(L.speech_level_db(x, 24000), 2),
                  'words_per_s': round(words / sp, 2) if sp else None, **extra}
        return i

    made: dict[tuple[str, str], tuple[str, np.ndarray]] = {}
    for pid in KIT_PASSAGES:
        x, sr = L.read_wav(os.path.join(BANK, 'raw', 'para', 'flux-hannah-whole', 'r1', pid + '.wav'))
        y = finish(x, sr)
        made[('flux-whole', pid)] = (add(y, 'flux-whole', pid), y)
        x, sr = L.read_wav(os.path.join(BANK, 'raw', 'para', 'aura-thalia-whole', 'r1', pid + '.wav'))
        y = finish(x, sr)
        made[('aura-whole', pid)] = (add(y, 'aura-whole', pid), y)
        for cond, sub in LOCAL.items():
            x, sr = concat(sub, pid)
            y = finish(x, sr)
            made[(cond, pid)] = (add(y, cond, pid), y)
    for pid in ANCHOR_PASSAGES:
        x, sr = piper(' '.join(PASSAGES[pid]))
        add(finish(x, sr), 'piper-anchor', pid)

    # the within-round repeat: the very same samples as the control of p5, under another name
    orig_id, y = made[('local-control', 'p5')]
    rep_id = add(y, 'local-control', 'p5', repeat_of=orig_id)

    # the round-1 clip, byte for byte: the local voice, one request per sentence, on p4
    k1 = json.load(open(os.path.join(ROUND1, 'key.json'), encoding='utf-8'))
    old = next(i for i, v in k1.items() if v['cond'] == 'local-persentence' and v['passage'] == 'p4' and not v['repeat_of'])
    new = new_id()
    shutil.copyfile(os.path.join(ROUND1, 'site', 'clips', old + '.wav'), os.path.join(site, 'clips', new + '.wav'))
    key[new] = {'cond': 'round1-local-persentence', 'passage': 'p4', 'repeat_of': None, 'round1_id': old, 'seconds': k1[old]['seconds'], 'level_db': k1[old]['level_db'], 'words_per_s': None}

    ids = list(key)
    np.random.default_rng().shuffle(ids)
    json.dump({'ids': ids, 'apart': [[orig_id, rep_id]]}, open(os.path.join(site, 'manifest.json'), 'w'))
    shutil.copy(os.path.join(HERE, 'index.html'), os.path.join(site, 'index.html'))
    json.dump(key, open(os.path.join(a.out, 'key.json'), 'w'), indent=1)
    total = sum(v['seconds'] for v in key.values())
    print('kit 2: %d clips, %.0f s of audio, in %s (key outside the served folder: %s)' % (len(key), total, site, os.path.join(a.out, 'key.json')))
    by: dict[str, list[float]] = {}
    for v in key.values():
        if v['words_per_s']:
            by.setdefault(v['cond'], []).append(v['words_per_s'])
    for c, w in sorted(by.items()):
        print('  %-16s words per second of speaking time (pauses included): %.2f' % (c, np.mean(w)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
