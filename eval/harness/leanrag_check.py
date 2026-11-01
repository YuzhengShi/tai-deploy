"""Is the knowledge tool really there for the model? Calls mcp__leanrag__query_knowledge by script through a real container (the scripted
model; no Cerebras tokens) and prints what the tool returned. If it were missing or broken, every 'leanrag_used 0/3' in scenarios.py would be
a defect of this setup, not of a model."""
import tai
from tai import Chat, write_script

print(tai.backend("mock"))
chat = Chat("lrcheck", name="lrcheck", canvas="1001", github="ann-eval")
steps = [dict(tool="mcp__leanrag__query_knowledge", input={"question": "How does Raft handle split votes during leader election?", "difficulty": "auto"}),
         dict(tool="mcp__leanrag__query_knowledge", input={"question": "Homework 3 Threading and Load Tests"})]
reply = chat.ask("go %s" % write_script("lrcheck", steps), timeout=240)
events = tai.tool_events("lrcheck")
print("reply:", reply.text[:200].replace("\n", " "))
for i, e in enumerate(events):
    result = tai.mask(e["result"] or "")
    print("[%d] %s %s: %d chars: %s" % (i, e["name"], "ERROR" if e["error"] else "ok", len(result), result[:400].replace("\n", " / ")))
