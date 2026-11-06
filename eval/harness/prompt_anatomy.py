"""What TAi's first request to the model weighs, by part, before the student has said anything that matters.

A student chat sends one message; the scripted model (mock_llm.py) logs the weight of the first request Claude Code makes in that
conversation: the system prompt blocks, each tool definition (built-in ones and the MCP servers' ones) and the messages (which carry the
CLAUDE.md files Claude Code injects, or pi's session context). Works for either harness (stack.sh harness pi | claude). Bytes of JSON; the token counts of the real models are about a quarter to a third of that
(eval/RESULTS.md has the gateway's counts for the same first request). Needs: orchestrator running, backend mock, stack.sh mocks.
  python3 prompt_anatomy.py
"""
import json
import time

import tai
from tai import Chat, write_script

since = time.time()
folder = "anatomy" + time.strftime("%H%M%S")
chat = Chat(folder, name="Anatomy", canvas="1001", github="ann-eval")
reply = chat.ask("hello TAi %s" % write_script("anatomy", [], {"text": "ok"}), timeout=240)
rows = [r for r in tai.mock_log(since) if r.get("kind") in ("step", "final") and r.get("n_messages") == 1]
if not rows:
    raise SystemExit("no first request found in the scripted model's log (reply: %r)" % reply)
r = rows[0]
sizes = r.get("tool_sizes", {})


def group(name):
    if name.startswith("mcp__nanoclaw__"):
        return "MCP nanoclaw (TAi's own tools)"
    if name.startswith("mcp__leanrag__"):
        return "MCP leanrag (knowledge)"
    return "built into the harness"


by_group = {}
for name, size in sizes.items():
    g = by_group.setdefault(group(name), [0, 0])
    g[0] += 1
    g[1] += size
total = r["bytes"]
print("first request of a student's conversation: %d bytes in all" % total)
print("  system prompt: %d chars in %d blocks %s" % (r["system_len"], len(r["system_blocks"]), r["system_blocks"]))
print("  messages: %d bytes (the student's message, with what the harness adds: Claude Code's CLAUDE.md reminder, pi's session context)" % r["messages_bytes"])
print("  tools: %d definitions, %d bytes" % (len(sizes), r["tools_bytes"]))
for g, (n, size) in sorted(by_group.items(), key=lambda kv: -kv[1][1]):
    print("     %-34s %2d tools %7d bytes" % (g, n, size))
print("  biggest tool definitions:", sorted(sizes.items(), key=lambda kv: -kv[1])[:14])
claude_code = r["system_blocks"][-1] if r["system_blocks"] else 0
print("  share of the request: the harness's built-in tools %.0f%%, MCP tools %.0f%%, system prompt %.0f%%, messages %.0f%%" % (
    100.0 * by_group.get("built into the harness", [0, 0])[1] / total,
    100.0 * (by_group.get("MCP nanoclaw (TAi's own tools)", [0, 0])[1] + by_group.get("MCP leanrag (knowledge)", [0, 0])[1]) / total,
    100.0 * r["system_len"] / total, 100.0 * r["messages_bytes"] / total))
print(json.dumps({"bytes": total, "system": r["system_len"], "system_blocks": r["system_blocks"], "messages": r["messages_bytes"],
                  "tools": r["tools_bytes"], "by_group": by_group}))
