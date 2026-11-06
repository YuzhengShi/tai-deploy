"""How much of the input the model was sent was a cache hit, in the real runs saved by scenarios.py: the answer to "what would a smaller
fixed prompt (system prompt + tool definitions) save?". Cerebras caches the prefix of a request; a cached token is cheap and is given
back to the tokens-per-minute bucket after the call, but a request is admitted only if the bucket has room for its full size.
  python3 cache_share.py [glob-prefix]      (read-only: reads ~/tai-eval/results/scenarios-*.json)
"""
import glob
import json
import sys

import tai

prefix = sys.argv[1] if len(sys.argv) > 1 else "scenarios-"
files = [f for f in sorted(glob.glob("%s/%s*.json" % (tai.RESULTS, prefix))) if "partial" not in f]
by_model = {}
firsts = {}
for path in files:
    for run in json.load(open(path)):
        for i, t in enumerate(run["turns"]):
            g = t.get("gateway") or {}
            calls, total, cached = g.get("calls") or 0, g.get("in") or 0, g.get("cached") or 0     # "in" is the whole prompt, cached tokens included
            uncached = total - cached
            if not calls:
                continue
            m = by_model.setdefault(run["model"], dict(turns=0, calls=0, uncached=0, cached=0, biggest=0))
            m["turns"] += 1
            m["calls"] += calls
            m["uncached"] += uncached
            m["cached"] += cached
            m["biggest"] = max(m["biggest"], g.get("max_prompt") or 0)
            if i == 0:   # the first turn of a conversation in a fresh folder: the prefix may be cold
                f = firsts.setdefault(run["model"], dict(turns=0, calls=0, uncached=0, cached=0))
                f["turns"] += 1
                f["calls"] += calls
                f["uncached"] += uncached
                f["cached"] += cached
print("%d result files" % len(files))
for model, m in sorted(by_model.items()):
    total = m["uncached"] + m["cached"]
    print("%-8s %3d turns, %4d model calls: input %9d tokens = %9d uncached + %9d cached (%.0f%% cache hits); per turn %d input, %d uncached, %.1f calls; biggest prompt %d" % (
        model, m["turns"], m["calls"], total, m["uncached"], m["cached"], 100.0 * m["cached"] / max(total, 1),
        total // max(m["turns"], 1), m["uncached"] // max(m["turns"], 1), m["calls"] / max(m["turns"], 1), m["biggest"]))
for model, f in sorted(firsts.items()):
    total = f["uncached"] + f["cached"]
    print("%-8s first turn of a conversation: %d turns, %d calls, %.0f%% cache hits, %d input and %d uncached tokens per turn" % (
        model, f["turns"], f["calls"], 100.0 * f["cached"] / max(total, 1), total // max(f["turns"], 1), f["uncached"] // max(f["turns"], 1)))
