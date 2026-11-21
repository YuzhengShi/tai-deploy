"""Uncounted plumbing test of the scratch stack on the scripted model (criteria 0: a pilot may fix plumbing only). Nothing here is a result.

  python3 weak_plumb.py turns      a scripted turn that calls canvas_query, run_go and github_query, then echoes what they returned
  python3 weak_plumb.py patrol     P1 (the gate should skip) and P2 (the gate should let the model run) on the scripted model
"""
import json
import sys
import time

import weak_scenarios as ws
from weak_scenarios import tai

PROGRAM = "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tch := make(chan int)\n\tch <- 1\n\tfmt.Println(<-ch)\n}\n"


def turns():
    steps = [
        {"tool": "mcp__nanoclaw__canvas_query", "input": {"action": "upcoming"}},
        {"tool": "mcp__nanoclaw__run_go", "input": {"action": "run", "files": [{"path": "main.go", "content": PROGRAM}]}},
        {"tool": "mcp__nanoclaw__github_query", "input": {"action": "file_content", "owner": "ann-eval", "repo": "cs6650-hw3", "path": "worker/pool.go"}},
        {"tool": "mcp__nanoclaw__canvas_query", "input": {"action": "grades"}},
    ]
    directive = tai.write_script("plumb1", steps, {"echo": "all"})
    folder = "plumb_%s" % ws.STAMP
    chat = tai.Chat(folder, name=folder, canvas="1001", github="ann-eval")
    ws.scenarios.seed(folder, "ann")
    t = ws.do_turn(chat, folder, "please check %s now" % directive, ["nonempty"], 1)
    print("reply (%.1f s, timed out %s): %s" % (t["seconds"], t["timed_out"], t["visible"][:600].replace("\n", " | ")))
    for e in t["events"]:
        print("  tool %-32s err=%s result: %s" % (e["name"], e["error"], (e["result"] or "")[:260].replace("\n", " ")))
    print("writer:", {k: v for k, v in t["writer"].items() if k != "body"})
    print("containers at reply:", t["containers"], "| gateway:", t["gateway"])


def patrol():
    for sid in ("p1_clean", "p2_misconception"):
        scn = ws.all_scenarios()[sid]
        r = ws.run_patrol("mock", scn, 1)
        print(sid, "| task", r["task_id"], "| %.0f s" % r["seconds"])
        print("  run logs:", json.dumps(r["run_logs"])[:500])
        before = (r["files_before"].get("competency/intervention-log.md") or "").count("\n")
        after = (r["files_after"].get("competency/intervention-log.md") or "").count("\n")
        print("  intervention-log lines: %d -> %d" % (before, after), "| outbox:", [e["text"][:120] for e in r["outbox"]])
        print("  tools:", [e["name"] for e in r["events"]])


if __name__ == "__main__":
    {"turns": turns, "patrol": patrol}[sys.argv[1] if len(sys.argv) > 1 else "turns"]()
