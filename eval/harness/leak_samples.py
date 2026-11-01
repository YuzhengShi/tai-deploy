"""The student-visible text of the turns analyze.py counts as "reasoning/markup leaked", with what leaked marked, so the outbound
filter (src/router.ts) is written against real samples and not guesses.
python3 leak_samples.py TAG [MODEL]"""
import glob
import json
import re
import sys

import tai

tag = sys.argv[1] if len(sys.argv) > 1 else "seq"
only = sys.argv[2] if len(sys.argv) > 2 else None
LEAK = re.compile(r"(^|\n)\s*(We|I) (need|should|must|will|have to) (to )?(introduce|respond|ask|check|answer|call|use|read)|<internal|</?commentary|to=functions|assistantfinal|\banalysis\b:", re.I)
n = 0
for path in sorted(glob.glob("%s/scenarios-%s-2*.json" % (tai.RESULTS, tag))):
    for run in json.load(open(path)):
        if only and run["model"] != only:
            continue
        for i, turn in enumerate(run["turns"], 1):
            for where, text in (("visible", turn["visible"]), ("text blocks", "\n".join(turn["texts"]))):
                m = LEAK.search(text)
                if m:
                    n += 1
                    print("=== %s %s turn %d (%s), match %r, %d chars" % (run["model"], run["scenario"], i, where, m.group(0).strip()[:40], len(text)))
                    print(repr(text[:700]))
print("%d samples" % n)
