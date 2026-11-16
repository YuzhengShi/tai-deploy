"""analyse_round3.py: reads the owner's answers of round 3 and applies the reading rules of PROTOCOL-round3.md exactly as they were fixed: naturalness primary, continuity secondary; each Kokoro condition
against the deployed local voice (better / worse / no detectable difference / mixed) and against the live voice (close / partway / far); Kokoro as a whole = the best condition, provisional; drift against the
round-2 clip heard again; retest of the repeated Kokoro clip; context against round 2. The repeats are left out of every condition mean. Prints and saves the reading (results/listening3-*.md) and copies
the answers into results/.

    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe -I -B analyse_round3.py [--root D:\\tai-voice-local\\listening-test3-20261115] [--round2 D:\\tai-voice-local\\listening-test2-20261115]
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

VARIANTS = ['kokoro-maple', 'kokoro-sol', 'kokoro-vale']            # amendment 2: three Kokoro conditions (the model itself, repaired ids, its own silences)
ORDER = ['flux-whole', 'local-control'] + VARIANTS + ['kokoro-maple-shipped', 'piper-anchor']      # kokoro-maple-shipped: the context clip, read by no Kokoro rule
PASSAGES = ['p3', 'p6', 'p9']
ROUND2 = {'flux-whole': (4.00, 3.67), 'local-control': (2.33, 3.00), 'piper-anchor': (1.00, 1.50)}     # round 2's means on its own passages (naturalness, continuity)


def verdict(d: list[float]) -> str:
    m = float(np.mean(d))
    if m >= 1.0 and min(d) >= 0:
        return 'better (provisional until it repeats)'
    if m <= -1.0 and max(d) <= 0:
        return 'worse'
    if abs(m) < 0.5:
        return 'no detectable difference'
    return 'mixed'


def closeness(flux_mean: float, mean: float) -> str:
    gap = flux_mean - mean
    return 'close to the live voice' if gap <= 0.5 else ('partway' if gap <= 1.0 else 'far')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=r'D:\tai-voice-local\listening-test3-20261115')
    ap.add_argument('--round2', default=r'D:\tai-voice-local\listening-test2-20261115')
    a = ap.parse_args()
    key = json.load(open(os.path.join(a.root, 'key.json'), encoding='utf-8'))
    files = sorted(f for f in glob.glob(os.path.join(a.root, 'results', '*.json')) if not os.path.basename(f).startswith('selftest-'))
    if not files:
        print('no answers yet in %s' % os.path.join(a.root, 'results'))
        return 1
    r2_files = sorted(glob.glob(os.path.join(a.round2, 'results', 'owner-*.json')))
    r2 = json.load(open(r2_files[-1], encoding='utf-8'))['ratings'] if r2_files else {}
    out_dir = os.path.join(HERE, '..', 'results')
    os.makedirs(out_dir, exist_ok=True)
    for f in files:
        data = json.load(open(f, encoding='utf-8'))
        shutil.copy(f, os.path.join(out_dir, 'listening3-' + os.path.basename(f)))
        r = data['ratings']
        per: dict[str, dict[str, tuple[int, int]]] = {}
        for cid, v in r.items():
            k = key[cid]
            if k['repeat_of'] or k['cond'] == 'round2-local-control':
                continue
            per.setdefault(k['cond'], {})[k['passage']] = (v['naturalness'], v['continuity'])
        L1 = ['### round 3, %s, %s (%d clips)\n' % (data.get('participant'), data.get('finished', '?')[:16], len(r))]
        wps: dict[str, list[float]] = {}
        for cid, k in key.items():
            if k.get('words_per_s') and not k['repeat_of']:
                wps.setdefault(k['cond'], []).append(k['words_per_s'])
        L1.append('| condition | naturalness p3 / p6 / p9 | mean | continuity p3 / p6 / p9 | mean | words/s |')
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
        L1.append('| condition | naturalness minus the deployed voice, per passage | mean | against the deployed voice (primary) | against the live voice | continuity minus the deployed voice | mean | reading (secondary) |')
        L1.append('|---|---|---|---|---|---|---|---|')
        best = None
        for v in VARIANTS:
            d = per.get(v, {})
            ps = [p for p in PASSAGES if p in d and p in ctl]
            if not ps:
                continue
            dn = [d[p][0] - ctl[p][0] for p in ps]
            dc = [d[p][1] - ctl[p][1] for p in ps]
            L1.append('| %s | %s | %+.2f | %s | %s | %s | %+.2f | %s |' % (v, ' / '.join('%+d' % x for x in dn), np.mean(dn), verdict(dn), closeness(flux_mean, means[v][0]), ' / '.join('%+d' % x for x in dc), np.mean(dc), verdict(dc)))
            if best is None or (means[v][0], means[v][1]) > (means[best][0], means[best][1]):
                best = v
        L1.append('')
        if best:
            L1.append('Kokoro as a whole (the best of the three conditions by mean naturalness, ties by continuity): **%s**, naturalness %.2f and continuity %.2f, %s; the live voice %.2f. A best of three is biased upward by roughly a quarter of a point, so any "close" or "better" is provisional until it repeats.' % (
                best, means[best][0], means[best][1], closeness(flux_mean, means[best][0]), flux_mean))
            L1.append('')
        # amendment 2: what the engine's defaults cost, the same voice (context, not part of the Kokoro verdict)
        sh = per.get('kokoro-maple-shipped', {})
        mp = per.get('kokoro-maple', {})
        ps = [p for p in PASSAGES if p in sh and p in mp]
        if ps:
            dn = [mp[p][0] - sh[p][0] for p in ps]
            dc = [mp[p][1] - sh[p][1] for p in ps]
            L1.append('Context (amendment 2), af_maple with the repairs and the model\'s own silences minus af_maple through the engine as it ships: naturalness %s (mean %+.2f: %s), continuity %s (mean %+.2f: %s). Not part of the Kokoro verdict.' % (
                ' / '.join('%+d' % x for x in dn), np.mean(dn), verdict(dn), ' / '.join('%+d' % x for x in dc), np.mean(dc), verdict(dc)))
            L1.append('')
        # drift against round 2 (the same clip, byte for byte), retest of the repeated Kokoro clip
        for cid, v in r.items():
            k = key[cid]
            if k['cond'] == 'round2-local-control':
                o = r2.get(k['round2_id'])
                if o:
                    dn, dc = abs(v['naturalness'] - o['naturalness']), abs(v['continuity'] - o['continuity'])
                    L1.append('Drift: the round-2 clip (the deployed local voice, p8) was rated %d and %d in round 2, %d and %d now: %s' % (
                        o['naturalness'], o['continuity'], v['naturalness'], v['continuity'], 'within 1.0 of round 2' if max(dn, dc) <= 1 else 'MORE than 1.0 away: round 3 is read within itself only'))
            if k['repeat_of'] and k['repeat_of'] in r:
                o = r[k['repeat_of']]
                dn, dc = abs(v['naturalness'] - o['naturalness']), abs(v['continuity'] - o['continuity'])
                L1.append('Retest: %s %s rated %d and %d, then %d and %d: %s' % (k['cond'], k['passage'], o['naturalness'], o['continuity'], v['naturalness'], v['continuity'],
                                                                                'stable (within 1 point)' if max(dn, dc) <= 1 else 'NOT stable (more than 1 point apart): do not interpret'))
        fl, pi, lc = means.get('flux-whole', (float('nan'),) * 2), means.get('piper-anchor', (float('nan'),) * 2), means.get('local-control', (float('nan'),) * 2)
        near = lambda x, y: 'near' if all(abs(a_ - b_) <= 1.0 for a_, b_ in zip(x, y)) else 'NOT near'
        L1.append('Context against round 2 (other passages): flux %.2f / %.2f (round 2: 4.00 / 3.67): %s; piper %.2f / %.2f (1.00 / 1.50): %s; the deployed local voice %.2f / %.2f (2.33 / 3.00): %s.' % (
            *fl, near(fl, ROUND2['flux-whole']), *pi, near(pi, ROUND2['piper-anchor']), *lc, near(lc, ROUND2['local-control'])))
        L1.append('')
        text = '\n'.join(L1)
        print(text)
        open(os.path.join(out_dir, 'listening3-' + os.path.basename(f).replace('.json', '.md')), 'w', encoding='utf-8').write(text + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
