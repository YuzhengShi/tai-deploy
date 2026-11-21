"""Round 2, after the counted run: can a tool call get through the local server at all? Direct to llama-server on the PC loopback.

T1  tiny control: one tool (get_weather), a question that needs it; non-streamed and streamed.
T2  the captured pilot TAi request (system prompt + 32 tools), its student message replaced with s4's question, a fresh
    conversation; non-streamed (3 samples) and streamed (1 sample).
Prints only finish_reason, tool-call names/arguments and the start of the content. The key is read from the file, never printed.
"""
import json
import sys
import time
import urllib.request

URL = "http://127.0.0.1:18080/v1/chat/completions"
KEY = open(r"D:\tai-local-llm\r2\api.key", encoding="ascii").read().strip()


def post(body, stream):
    body = dict(body, stream=stream)
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=1800) as r:
        if not stream:
            j = json.loads(r.read())
            m = j["choices"][0]["message"]
            return j["choices"][0].get("finish_reason"), m.get("tool_calls") or [], m.get("content") or "", time.time() - t0
        calls, content, finish = {}, "", None
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            ch = json.loads(line[5:])["choices"]
            if not ch:
                continue
            d = ch[0].get("delta") or {}
            finish = ch[0].get("finish_reason") or finish
            content += d.get("content") or ""
            for tc in d.get("tool_calls") or []:
                c = calls.setdefault(tc.get("index", 0), {"function": {"name": "", "arguments": ""}})
                f = tc.get("function") or {}
                c["function"]["name"] += f.get("name") or ""
                c["function"]["arguments"] += f.get("arguments") or ""
        return finish, list(calls.values()), content, time.time() - t0


def show(label, res):
    finish, calls, content, secs = res
    print("%-28s %5.0f s finish=%s calls=%s" % (label, secs, finish,
          [(c["function"]["name"], c["function"]["arguments"][:160]) for c in calls]))
    print("    content:", repr(content[:400]))


tiny = {"model": "x", "max_tokens": 200, "messages": [
    {"role": "system", "content": "You are a helpful assistant. Use a tool when one fits."},
    {"role": "user", "content": "What's the weather in Paris right now?"}],
    "tools": [{"type": "function", "function": {"name": "get_weather", "description": "Current weather for a city.",
               "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]}
show("T1 tiny, not streamed", post(tiny, False))
show("T1 tiny, streamed", post(tiny, True))

b = json.load(open(sys.argv[1], encoding="utf-8"))
text = b["messages"][1]["content"][0]["text"]
old_hist = text[text.index("## Recent conversation history"):text.index("</memory_context>")]
text = text.replace(old_hist, "")
q_old = "i'm working on HW6, the circuit breaker part. i'm stuck on the half-open state, i don't get when it goes back to closed"
assert q_old in text
text = text.replace(q_old, "what's due this week? and how did I do on HW3?").replace("(they wrote 23)", "(they wrote 10)")
b["messages"][1]["content"][0]["text"] = text
b["max_tokens"] = 400
b.pop("stream", None)
for i in range(3):
    show("T2 TAi s4, not streamed #%d" % (i + 1), post(b, False))
show("T2 TAi s4, streamed", post(b, True))
