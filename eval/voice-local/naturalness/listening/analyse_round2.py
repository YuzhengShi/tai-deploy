"""analyse_round2.py: reads the owner's answers of round 2 and applies the reading rules of PROTOCOL-round2.md exactly as they were fixed: naturalness primary, continuity secondary; improved / no detectable change
/ mixed against the control; close / partway / far against the live voice; drift against the round-1 clip heard again; retest of the repeated control; context clips against round 1. Prints and saves
the reading (results/listening2-*.md) and copies the answers into results/.

    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe -I -B analyse_round2.py [--root D:\\tai-voice-local\\listening-test2-20261115] [--round1 D:\\tai-voice-local\\listening-test-20261115]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import nat_lib as L   # noqa: E402

VARIANTS = ['local-pace1.1', 'local-pace1.0', 'local-steps24']
ORDER = ['flux-whole', 'aura-whole', 'local-control'] + VARIANTS + ['piper-anchor']
PASSAGES = ['p2', 'p5', 'p8']
ROUND1 = {'flux-whole': (4.00, 4.33), 'aura-whole': (4.33, 4.33), 'piper-anchor': (2.00, 3.00), 'local': (2.00, 2.67)}


def verdict(d: list[float]) -> str:
    m = float(np.mean(d))
    if m >= 1.0 and min(d) >= 0:
        return 'improved (provisional until it repeats)'
    if abs(m) < 0.5:
        return 'no detectable change'
    return 'mixed'


def closeness(flux_mean: float, mean: float) -> str:
    gap = flux_mean - mean
    return 'close to the live voice' if gap <= 0.5 else ('partway' if gap <= 1.0 else 'far')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=r'D:\tai-voice-local\listening-test2-20261115')
    ap.add_argument('--round1', default=r'D:\tai-voice-local\listening-test-20261115')
    a = ap.parse_args()
    key = json.load(open(os.path.join(a.root, 'key.json'), encoding='utf-8'))
    files = sorted(glob.glob(os.path.join(a.root, 'results', '*.json')))
    if not files:
        print('no answers yet in %s' % os.path.join(a.root, 'results'))
        return 1
    r1_files = sorted(glob.glob(os.path.join(a.round1, 'results', 'owner-*.json')))
    r1 = json.load(open(r1_files[-1], encoding='utf-8'))['ratings'] if r1_files else {}
    out_dir = os.path.join(HERE, '..', 'results')
    os.makedirs(out_dir, exist_ok=True)
    for f in files:
        data = json.load(open(f, encoding='utf-8'))
        shutil.copy(f, os.path.join(out_dir, 'listening2-' + os.path.basename(f)))
        r = data['ratings']
        per: dict[str, dict[str, tuple[int, int]]] = {}
        for cid, v in r.items():
            k = key[cid]
            if k['repeat_of'] or k['cond'] == 'round1-local-persentence':
                continue
            per.setdefault(k['cond'], {})[k['passage']] = (v['naturalness'], v['continuity'])
        L1 = ['### round 2, %s, %s (%d clips)\n' % (data.get('participant'), data.get('finished', '?')[:16], len(r))]
        wps: dict[str, list[float]] = {}
        for cid, k in key.items():
            if k.get('words_per_s') and not k['repeat_of']:
                wps.setdefault(k['cond'], []).append(k['words_per_s'])
        L1.append('| condition | naturalness p2 / p5 / p8 | mean | continuity p2 / p5 / p8 | mean | words/s |')
        L1.append('|---|---|---|---|---|---|')
        means: dict[str, tuple[float, float]] = {}
        for cond in ORDER:
            d = per.get(cond, {})
            if not d:
                continue
            ps = [p for p in PASSAGES if p in d] if cond != 'piper-anchor' else sorted(d)
            nat = [d[p][0] for p in ps]
            con = [d[p][1] for p in ps]
            means[cond] = (float(np.mean(nat)), float(np.mean(con)))
            L1.append('| %s | %s | %.2f | %s | %.2f | %s |' % (cond, ' / '.join(str(x) for x in nat), means[cond][0], ' / '.join(str(x) for x in con), means[cond][1], '%.2f' % np.mean(wps[cond]) if cond in wps else '-'))
        L1.append('')
        ctl = per.get('local-control', {})
        flux_mean = means.get('flux-whole', (float('nan'), 0))[0]
        L1.append('| variant | naturalness minus control, per passage | mean | reading (primary) | against the live voice | continuity minus control | mean | reading (secondary) |')
        L1.append('|---|---|---|---|---|---|---|---|')
        for v in VARIANTS:
            d = per.get(v, {})
            ps = [p for p in PASSAGES if p in d and p in ctl]
            if not ps:
                continue
            dn = [d[p][0] - ctl[p][0] for p in ps]
            dc = [d[p][1] - ctl[p][1] for p in ps]
            L1.append('| %s | %s | %+.2f | %s | %s | %s | %+.2f | %s |' % (v, ' / '.join('%+d' % x for x in dn), np.mean(dn), verdict(dn), closeness(flux_mean, means[v][0]), ' / '.join('%+d' % x for x in dc), np.mean(dc), verdict(dc)))
        L1.append('')
        # drift against round 1 (the same clip, byte for byte), retest of the repeated control
        for cid, v in r.items():
            k = key[cid]
            if k['cond'] == 'round1-local-persentence':
                o = r1.get(k['round1_id'])
                if o:
                    dn, dc = abs(v['naturalness'] - o['naturalness']), abs(v['continuity'] - o['continuity'])
                    L1.append('Drift: the round-1 clip (local, one request per sentence, p4) was rated %d and %d in round 1, %d and %d now: %s' % (
                        o['naturalness'], o['continuity'], v['naturalness'], v['continuity'], 'within 1.0 of round 1' if max(dn, dc) <= 1 else 'MORE than 1.0 away: round 2 is read within itself only'))
            if k['repeat_of'] and k['repeat_of'] in r:
                o = r[k['repeat_of']]
                dn, dc = abs(v['naturalness'] - o['naturalness']), abs(v['continuity'] - o['continuity'])
                L1.append('Retest: local-control p5 rated %d and %d, then %d and %d: %s' % (o['naturalness'], o['continuity'], v['naturalness'], v['continuity'],
                                                                                         'stable (within 1 point)' if max(dn, dc) <= 1 else 'NOT stable (more than 1 point apart): do not interpret'))
        if 'local-control' in means:
            L1.append('Control against round 1\'s local voice (2.00 and 2.67, other passages): %.2f and %.2f.' % means['local-control'])
        L1.append('Context against round 1: flux %.2f / %.2f (round 1: 4.00 / 4.33), aura whole %.2f / %.2f (4.33 / 4.33), piper %.2f / %.2f (2.00 / 3.00).' % (
            *means.get('flux-whole', (float('nan'),) * 2), *means.get('aura-whole', (float('nan'),) * 2), *means.get('piper-anchor', (float('nan'),) * 2)))
        L1.append('')
        text = '\n'.join(L1)
        print(text)
        open(os.path.join(out_dir, 'listening2-' + os.path.basename(f).replace('.json', '.md')), 'w', encoding='utf-8').write(text + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
