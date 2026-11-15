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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=r'D:\tai-voice-local\listening-test-20261115')
    ap.add_argument('--participant', default=None)
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
        text = '\n'.join(lines)
        print(text)
        open(os.path.join(out_dir, 'listening-' + os.path.basename(f).replace('.json', '.md')), 'w', encoding='utf-8').write(text + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
