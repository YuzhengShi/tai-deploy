"""analyse_listening.py: reads the answers saved by serve.py, joins them with the answer key, and prints the reading PROTOCOL.md fixes: per condition the mean ratings, the paired difference to the Flux whole
turn per passage with a bootstrap interval over the passages (3: very wide), the repeated clip's two ratings, and the anchor's ratings. Also copies the answers into results/ (the repo).

    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe analyse_listening.py [--root D:\\tai-voice-local\\listening-test-20261115] [--participant owner]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import nat_lib as L   # noqa: E402

ORDER = ['flux-whole', 'aura-whole', 'aura-persentence', 'local-whole', 'local-persentence', 'piper-anchor']


def ranks(v) -> np.ndarray:
    """Ranks with ties given their average rank."""
    v = np.asarray(v, dtype=float)
    order = v.argsort(kind='mergesort')
    out = np.empty(len(v))
    sv = v[order]
    i = 0
    while i < len(v):
        j = i
        while j + 1 < len(v) and sv[j + 1] == sv[i]:
            j += 1
        out[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return out


def spearman(x, y) -> float:
    return float(np.corrcoef(ranks(x), ranks(y))[0, 1])


def kit_utmos(root: str) -> dict[str, float]:
    """UTMOS of every clip of the kit as the listener heard it (level-matched, 250 ms of silence at each end), cached beside the key."""
    import measure as M
    cache = os.path.join(root, 'utmos-kit.json')
    if os.path.exists(cache):
        return json.load(open(cache))
    scorer = M.Utmos(M.UTMOS_ONNX)
    out = {}
    for f in sorted(glob.glob(os.path.join(root, 'site', 'clips', '*.wav'))):
        x, sr = L.read_wav(f)
        out[os.path.basename(f)[:-4]] = round(scorer(L.to16k(x, sr)), 4)
    json.dump(out, open(cache, 'w'), indent=1)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=r'D:\tai-voice-local\listening-test-20261115')
    ap.add_argument('--participant', default=None)
    ap.add_argument('--utmos', action='store_true', help="also score the kit's clips with the predictor and compare its scores with the ratings")
    a = ap.parse_args()
    key = json.load(open(os.path.join(a.root, 'key.json'), encoding='utf-8'))
    files = sorted(glob.glob(os.path.join(a.root, 'results', '*.json')))
    if not files:
        print('no answers yet in %s' % os.path.join(a.root, 'results'))
        return 1
    out_dir = os.path.join(L.HERE, 'results')
    os.makedirs(out_dir, exist_ok=True)
    for f in files:
        data = json.load(open(f, encoding='utf-8'))
        if a.participant and data.get('participant') != a.participant:
            continue
        shutil.copy(f, os.path.join(out_dir, 'listening-' + os.path.basename(f)))
        r = data['ratings']
        lines = ['### %s, %s (%d clips)\n' % (data.get('participant'), data.get('finished', '?')[:16], len(r)), '| way of speaking | clips | naturalness | continuity |', '|---|---|---|---|']
        by: dict[str, list[tuple[str, int, int]]] = {}
        for cid, v in r.items():
            k = key[cid]
            if k['repeat_of']:
                continue
            by.setdefault(k['cond'], []).append((k['passage'], v['naturalness'], v['continuity']))
        for cond in ORDER:
            rows = by.get(cond, [])
            if rows:
                lines.append('| %s | %d | %.2f | %.2f |' % (cond, len(rows), np.mean([x[1] for x in rows]), np.mean([x[2] for x in rows])))
        lines.append('')
        # paired differences to the Flux whole turn, per passage
        base = {p: (n, c) for p, n, c in by.get('flux-whole', [])}
        lines.append('| minus Flux whole turn, per passage | naturalness [95 % interval over passages] | continuity [95 % interval over passages] |')
        lines.append('|---|---|---|')
        for cond in ORDER[1:]:
            rows = [(p, n, c) for p, n, c in by.get(cond, []) if p in base]
            if not rows:
                continue
            dn = np.array([n - base[p][0] for p, n, c in rows], dtype=float)
            dc = np.array([c - base[p][1] for p, n, c in rows], dtype=float)
            mn, ln, hn = L.bootstrap_ci(dn)
            mc, lc, hc = L.bootstrap_ci(dc)
            lines.append('| %s | %+.2f [%+.2f, %+.2f] | %+.2f [%+.2f, %+.2f] |' % (cond, mn, ln, hn, mc, lc, hc))
        lines.append('')
        # the repeated clip
        for cid, v in r.items():
            k = key[cid]
            if k['repeat_of'] and k['repeat_of'] in r:
                o = r[k['repeat_of']]
                dn, dc = abs(v['naturalness'] - o['naturalness']), abs(v['continuity'] - o['continuity'])
                lines.append('Repeated clip (%s, %s): naturalness %d then %d, continuity %d then %d; %s' % (k['cond'], k['passage'], o['naturalness'], v['naturalness'], o['continuity'], v['continuity'],
                                                                                                       'stable (within 1 point)' if max(dn, dc) <= 1 else 'NOT stable (more than 1 point apart): do not interpret'))
        lines.append('')
        if a.utmos:
            u = kit_utmos(a.root)
            ids = [c for c in r if c in u]
            nat = [r[c]['naturalness'] for c in ids]
            con = [r[c]['continuity'] for c in ids]
            sc = [u[c] for c in ids]
            lines.append('| way of speaking | UTMOS of the clips | his naturalness | his continuity |')
            lines.append('|---|---|---|---|')
            means = {}
            for cond in ORDER:
                cs = [c for c in ids if key[c]['cond'] == cond and not key[c]['repeat_of']]
                if cs:
                    means[cond] = (np.mean([u[c] for c in cs]), np.mean([r[c]['naturalness'] for c in cs]), np.mean([r[c]['continuity'] for c in cs]))
                    lines.append('| %s | %.2f | %.2f | %.2f |' % (cond, *means[cond]))
            lines.append('')
            lines.append('Spearman correlation of UTMOS with his naturalness over the %d clips: %+.2f; with his continuity: %+.2f; over the %d ways of speaking (means): %+.2f (naturalness), %+.2f (continuity).' % (
                len(ids), spearman(sc, nat), spearman(sc, con), len(means), spearman([m[0] for m in means.values()], [m[1] for m in means.values()]), spearman([m[0] for m in means.values()], [m[2] for m in means.values()])))
            lines.append('')
        text = '\n'.join(lines)
        print(text)
        open(os.path.join(out_dir, 'listening-' + os.path.basename(f).replace('.json', '.md')), 'w', encoding='utf-8').write(text + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
