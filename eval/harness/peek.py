"""Look at what a group's session really contained: python3 peek.py FOLDER [first N events] [env]

Prints each tool call Claude Code made for the group with the input it recorded and what the tool returned (keys masked), and with
`env` the NAMES (never the values) of the variables a Bash `env > ENV.out` left visible to the agent."""
import re
import sys

import tai

folder = sys.argv[1]
limit = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 12
last = int(sys.argv[2][1:]) if len(sys.argv) > 2 and sys.argv[2].startswith("-") and sys.argv[2][1:].isdigit() else 0   # -N: the last N events
events = tai.tool_events(folder)
print("%d tool events for %s" % (len(events), folder))
first = max(0, len(events) - last) if last else 0
for i, e in enumerate(events[first:first + (last or limit)], first):
    inp = tai.mask(str(e["input"]))[:170].replace("\n", " ")
    res = tai.mask(e["result"] or "")[:170].replace("\n", " ")
    print("[%2d] %s %s\n     in : %s\n     out: %s" % (i, e["name"], "ERROR" if e["error"] else "", inp, res))
if "env" in sys.argv:
    env = tai.get(folder, "ENV.out") or ""
    names = sorted({line.split("=", 1)[0] for line in env.splitlines() if "=" in line and re.match(r"^[A-Z_][A-Z0-9_]*$", line.split("=", 1)[0])})
    sens = [n for n in names if re.search(r"KEY|TOKEN|SECRET|PASSWORD|AWS|CANVAS|GITHUB|ANTHROPIC|CLAUDE|EMAIL|VOICE|PIAZZA|MS_", n)]
    print("variables visible to Bash that look sensitive:", sens)
