"""Extra readings of the saved scenario runs that the per-check table cannot give:
  * reasoning or tool-call markup that leaked into what the student saw (gpt-oss writes its planning or its tool call as text sometimes)
  * the memory probes re-scored with typographic hyphens folded to '-' (gpt-oss writes "half-open" with U+2011)
  * how the prompt grew over the 30-turn session (tokens in the biggest call of each turn)
  * how often a turn opened with the first-message introduction although the student is not new
python3 analyze.py TAG"""
import glob
import json
import re
import sys
import unicodedata

import tai

tag = sys.argv[1] if len(sys.argv) > 1 else "kb2"
runs = []
for path in sorted(glob.glob("%s/scenarios-%s-2*.json" % (tai.RESULTS, tag))):
    runs += json.load(open(path))


def fold(text):
    return unicodedata.normalize("NFKC", text).replace("‐", "-").replace("‑", "-").replace("‒", "-").replace("–", "-").replace("—", "-")


LEAK = re.compile(r"(^|\n)\s*(We|I) (need|should|must|will|have to) (to )?(introduce|respond|ask|check|answer|call|use|read)|<internal|</?commentary|to=functions|assistantfinal|\banalysis\b:", re.I)
INTRO = re.compile(r"i'?m TAi\b|i am TAi\b", re.I)
for model in sorted({r["model"] for r in runs}):
    mine = [r for r in runs if r["model"] == model]
    turns = [(r["scenario"], i, t) for r in mine for i, t in enumerate(r["turns"], 1)]
    leaks = [(s, i) for s, i, t in turns if LEAK.search(t["visible"]) or LEAK.search("\n".join(t["texts"]))]
    not_new = [(s, i, t) for s, i, t in turns if s != "s1_intro"]
    intros = [(s, i) for s, i, t in not_new if INTRO.search(t["visible"])]
    print("%-8s turns %d | reasoning/markup leaked into the visible reply: %d %s | opened with the new-student introduction though Ann is not new: %d of %d turns %s" % (
        model, len(turns), len(leaks), leaks[:6], len(intros), len(not_new), intros[:8]))

for r in runs:
    if r["scenario"] != "long_session":
        continue
    probes = [(t["user"][:40], any(fold(k).lower() in fold(t["visible"]).lower() for k in ["half-open", "half open"] + ["HW6", "Homework 6", "circuit"]))
              for t in r["turns"] if "memory_recall" in t["checks"]]
    growth = [t["gateway"]["max_prompt"] for t in r["turns"]]
    cached = [t["gateway"]["cached"] for t in r["turns"]]
    print("%-8s long session: memory probes re-scored %s | biggest prompt per turn: first %d, turn 10 %d, turn 20 %d, last %d tokens | most tokens a single turn put through the gateway (all calls, cached included): %d" % (
        r["model"], probes, growth[0], growth[9], growth[19], growth[-1], max(t["gateway"]["in"] + t["gateway"]["cached"] for t in r["turns"])))
    tools = {}
    for t in r["turns"]:
        for b in t["tools"]:
            name = b.split("(")[0]
            tools[name] = tools.get(name, 0) + 1
    print("         tool calls over the 30 turns:", tools)


print("")
print("slowest turns per model (to tell a retry from a long answer: calls, seconds the model spent in them, failures the gateway logged)")
for model in sorted({r["model"] for r in runs}):
    turns = [(t["seconds"], r["scenario"], i, t["gateway"]["calls"], t["gateway"]["model_seconds"], t["gateway"]["fails"], len(t["tools"]))
             for r in runs if r["model"] == model for i, t in enumerate(r["turns"], 1)]
    for sec, scn, i, calls, ms, fails, ntools in sorted(turns, reverse=True)[:4]:
        print("  %-8s %5.1f s  %s turn %d: %d model calls (%.1f s in the model), %d tool calls, gateway failures %s" % (model, sec, scn, i, calls, ms, ntools, fails or "none"))
