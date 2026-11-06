"""Does the first call of a NEW session get its prompt from Cerebras's cache? Upstream put the date (it changes every minute) and the
student's memory at the start of the system prompt, ahead of the 27 KB persona, so the persona behind them could not be a cache hit; the
persona now comes first and the rest after it (container/agent-runner/src/prompt.ts). This asks one question of a few fresh students in
a row, on the real model through the gateway, and reads what each turn's first model call was charged from the gateway's log:
the same persona and tool declarations at the front of every student's request, a different student after them.
  python3 cache_new_sessions.py [students=3] [gap_seconds=20] [harness]     (the stack must be up on the qwen or gpt-oss backend)
harness: leave the current one, or pi | claude to switch before the run (stack.sh harness)."""
import sys
import time

import tai
from tai import Chat

N = int(sys.argv[1]) if len(sys.argv) > 1 else 3
GAP = float(sys.argv[2]) if len(sys.argv) > 2 else 20
if len(sys.argv) > 3:
    print(tai.sh("bash %s/eval/host/remote/stack.sh harness %s" % (tai.T, sys.argv[3])))
print(tai.sh("bash %s/eval/host/remote/stack.sh harness" % tai.T))

QUESTION = "hey, i'm just getting started with cs6650 this week. where should i begin?"
stamp = time.strftime("%H%M%S")
results = []
for i in range(N):
    folder = "cache-%s-%d" % (stamp, i + 1)
    since = time.time()
    chat = Chat(folder, name="Student %s%d" % (stamp, i + 1))
    reply = chat.ask(QUESTION, timeout=240)
    calls = [r for r in tai.gateway_log(since) if r.get("event") == "ok"]
    first = calls[0] if calls else {}
    total_in = sum(r.get("in") or 0 for r in calls)
    total_cached = sum(r.get("cached") or 0 for r in calls)
    row = dict(student=folder, calls=len(calls), first_in=first.get("in"), first_cached=first.get("cached"),
               turn_in=total_in, turn_cached=total_cached, turn_uncached=total_in - total_cached, seconds=round(time.time() - since, 1),
               reply=(reply.text if hasattr(reply, "text") else str(reply))[:120])
    results.append(row)
    share = 100.0 * (row["first_cached"] or 0) / max(row["first_in"] or 1, 1)
    print("student %d: %d model call(s); first call %s tokens, %s cached (%.0f%%); the turn: %d input, %d uncached; %.0f s" % (
        i + 1, row["calls"], row["first_in"], row["first_cached"], share, total_in, total_in - total_cached, row["seconds"]))
    time.sleep(GAP)
print("saved:", tai.save("cache_new_sessions", results))
