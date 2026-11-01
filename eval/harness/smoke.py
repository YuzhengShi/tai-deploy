"""The first thing to run: one scripted message through the real orchestrator and a real agent container, end to end.

student chat -> web channel -> SQLite -> message loop -> debounce -> GroupQueue -> docker run (the agent image) -> Claude Code
-> the scripted model (mock_llm.py) -> a Bash tool call through TAi's hooks -> the answer back out of the web channel.
Needs: orchestrator running (stack.sh orch start), backend mock (stack.sh backend mock), stack.sh mocks.
"""
import sys
import time

import tai

since = time.time()
chat = tai.Chat("smoke", name="Smoke Test")
directive = tai.write_script("smoke", [tai.bash("echo smoke-ok > /workspace/group/smoke.txt; id -un")], {"echo": "all"})
reply = chat.ask("hello TAi %s" % directive, timeout=180)
print(reply)
print("file written by the tool inside the container:", repr(tai.get("smoke", "smoke.txt")))
rows = [r for r in tai.mock_log(since) if r.get("kind") in ("step", "final")]
print("scripted-model requests that were part of the conversation:", [(r["kind"], r.get("step"), r["n_messages"]) for r in rows])
print("session stored by the orchestrator:", tai.sessions().get("smoke"))
ok = (not reply.timed_out) and tai.get("smoke", "smoke.txt") == "smoke-ok\n" and "RESULTS" in reply.text
print("SMOKE", "PASSED" if ok else "FAILED")
sys.exit(0 if ok else 1)
