"""Round 2, pilot only: look inside one captured request for text that changes per container (temp paths, ids, times)."""
import json
import re
import sys

sys.path.insert(0, "/home/ubuntu/tai-weak/tai/eval/harness")
from capture_diff import requests_in

PAT = re.compile(r"/tmp/\S{0,40}|pi-agent-\w+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b20\d\d-\d\d-\d\d[T ]\d\d:\d\d")
for path in sys.argv[1:]:
    for line, body in requests_in(path):
        if not body or not body.get("tools"):
            continue
        tools = body["tools"]
        print(path, "tools", len(tools))
        for t in tools:
            s = json.dumps(t, ensure_ascii=False)
            hits = PAT.findall(s)
            if hits:
                print("  ", t["function"]["name"], len(s), hits[:4])
        print("  first tool:", json.dumps(tools[0], ensure_ascii=False)[:700])
