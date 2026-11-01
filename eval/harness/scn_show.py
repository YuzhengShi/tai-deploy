"""Read saved scenario runs: python3 scn_show.py [scenario-prefix] [model] [--turns N] [--latest]

Prints, per run and turn: what the student said, what TAi sent back (as the student saw it), the tools it called, the failed checks
and the gateway numbers (calls, prompt tokens, 429s)."""
import glob
import json
import sys

import tai

args = [a for i, a in enumerate(sys.argv[1:], 1) if not a.startswith("--") and sys.argv[i - 1] != "--tag" and sys.argv[i - 1] != "--turns"]
prefix = args[0] if args else ""
model = args[1] if len(args) > 1 else ""
limit = int(sys.argv[sys.argv.index("--turns") + 1]) if "--turns" in sys.argv else 999
tag = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else ""
files = sorted(glob.glob(tai.RESULTS + ("/scenarios-%s-2*.json" % tag if tag else "/scenarios-2*.json")))
if "--latest" in sys.argv:
    files = files[-1:]
for path in files:
    for run in json.load(open(path)):
        if prefix and not run["scenario"].startswith(prefix):
            continue
        if model and run["model"] != model:
            continue
        print("=== %s | %s | run %d | %s" % (run["scenario"], run["model"], run["run"], path.rsplit("/", 1)[-1]))
        for i, t in enumerate(run["turns"][:limit]):
            bad = [k for k, c in t["checks"].items() if c["ok"] is False]
            g = t["gateway"]
            print(" [%d] student: %s" % (i + 1, t["user"][:100]))
            print("     TAi (%0.1fs, %d words): %s" % (t["seconds"], len(t["visible"].split()), t["visible"][:420].replace("\n", " / ")))
            print("     tools: %s" % ", ".join(t["tools"][:10]) + (" ..." if len(t["tools"]) > 10 else ""))
            print("     failed: %s | gateway calls %d, max prompt %d tok, cached %d, fails %s" % (bad or "none", g["calls"], g["max_prompt"], g["cached"], g["fails"]))
            why = ["%s (%s)" % (k, c["why"]) for k, c in t["checks"].items() if c["ok"] is False and c["why"]]
            if why:
                print("     why: %s" % "; ".join(why))
