"""Round 2, pilot only: where in a captured request does a string occur (system / which tool / which message)."""
import json
import sys

sys.path.insert(0, "/home/ubuntu/tai-weak/tai/eval/harness")
from capture_diff import requests_in

path, needles = sys.argv[1], sys.argv[2:]
for line, body in requests_in(path):
    if not body or not body.get("tools"):
        continue
    for n in needles:
        for i, t in enumerate(body["tools"]):
            s = json.dumps(t, ensure_ascii=False)
            k = s.find(n)
            if k >= 0:
                print("%r in tool %d %s: ...%s..." % (n, i, t["function"]["name"], s[max(0, k - 150):k + 80]))
        for i, m in enumerate(body["messages"]):
            s = json.dumps(m, ensure_ascii=False)
            if n in s:
                print("%r in message %d (%s)" % (n, i, m.get("role")))
