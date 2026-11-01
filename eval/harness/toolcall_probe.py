"""Is the empty-arguments tool call (`github_query {}`) the model's doing or the gateway's?

qwen's runs in scenarios.py showed tool calls with no arguments at all (MCP error -32602, missing `action`), and then a correct retry. This
sends the same kind of request, which invites several tool calls in one turn, N times down two paths and counts calls whose arguments
came out empty:
  A  straight to Cerebras (/v1/chat/completions, stream, the OpenAI shape), reassembling tool_calls deltas by index;
  B  through the LiteLLM gateway on the Anthropic /v1/messages route (stream), reassembling input_json_delta by block.
Keys are read from files on the box and never printed.  python3 toolcall_probe.py [model-alias] [N]   (alias: qwen | gpt-oss)"""
import json
import os
import sys
import urllib.error
import urllib.request

alias = sys.argv[1] if len(sys.argv) > 1 else "qwen"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 8
upstream = {"qwen": "qwen-3.8-27b", "gpt-oss": "gpt-oss-120b"}[alias]
reasoning = "none" if alias == "qwen" else "low"


def env_value(path, key):
    with open(os.path.expanduser(path)) as f:
        for line in f:
            if line.startswith(key + "="):
                return line.strip().split("=", 1)[1]
    raise SystemExit("no %s in %s" % (key, path))


CEREBRAS_KEY = env_value(os.environ.get("WORLD_ENV", "~/cs6650-world/.env"), "CEREBRAS_API_KEY")
GATEWAY_KEY = env_value(os.environ.get("SECRETS_ENV", "~/tai-eval/secrets.env"), "LITELLM_MASTER_KEY")

TOOLS = [
    ("github_query", "Query GitHub for student repository data (read-only).", {"action": {"type": "string"}, "params": {"type": "object", "additionalProperties": {"type": "string"}}}, ["action"]),
    ("canvas_query", "Query Canvas LMS for real-time course data (read-only).", {"action": {"type": "string"}, "params": {"type": "object", "additionalProperties": {"type": "string"}}}, ["action"]),
    ("react_to_message", "React to the student's message with an emoji.", {"message_id": {"type": "string"}, "emoji": {"type": "string"}}, ["message_id", "emoji"]),
]
PROMPT = ("The student wrote: 'can you look at my HW3 repo ann-eval/cs6650-hw3 and tell me why my worker pool hangs?' (message id 1234). "
          "In ONE step, issue every call you need: github_query repo_tree for the repo, github_query file_content for worker/pool.go and main.go, "
          "and react_to_message to message 1234 with a magnifier emoji.")


def post(url, headers, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=dict({"content-type": "application/json", "user-agent": "tai-eval-probe/1.0"}, **headers), method="POST")
    try:
        return urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:                 # say why, with any key masked
        text = e.read().decode("utf-8", "replace")
        for k in (CEREBRAS_KEY, GATEWAY_KEY):
            text = text.replace(k, "<key>")
        raise RuntimeError("HTTP %d: %s" % (e.code, text[:300]))


def path_a():
    body = {"model": upstream, "stream": True, "max_tokens": 1500, "reasoning_effort": reasoning, "temperature": 1,
            "messages": [{"role": "user", "content": PROMPT}],
            "tools": [{"type": "function", "function": {"name": n, "description": d, "parameters": {"type": "object", "properties": p, "required": r}}} for n, d, p, r in TOOLS]}
    calls = {}
    with post("https://api.cerebras.ai/v1/chat/completions", {"authorization": "Bearer " + CEREBRAS_KEY}, body) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data:") or line.endswith("[DONE]"):
                continue
            delta = (json.loads(line[5:])["choices"] or [{}])[0].get("delta", {})
            for tc in delta.get("tool_calls") or []:
                c = calls.setdefault(tc.get("index", 0), {"name": "", "args": ""})
                c["name"] += (tc.get("function") or {}).get("name") or ""
                c["args"] += (tc.get("function") or {}).get("arguments") or ""
    if not getattr(path_a, "shown", False):
        path_a.shown = True
        print("   one raw Cerebras answer, tool calls as streamed:", json.dumps(calls)[:500])
    return [(c["name"], c["args"]) for _i, c in sorted(calls.items())]


def path_b():
    body = {"model": alias, "stream": True, "max_tokens": 1500, "messages": [{"role": "user", "content": PROMPT}],
            "tools": [{"name": n, "description": d, "input_schema": {"type": "object", "properties": p, "required": r}} for n, d, p, r in TOOLS]}
    blocks = {}
    with post("http://tai-litellm:4000/v1/messages", {"x-api-key": GATEWAY_KEY, "anthropic-version": "2023-06-01"}, body) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:])
            if ev.get("type") == "content_block_start" and ev["content_block"].get("type") == "tool_use":
                blocks[ev["index"]] = {"name": ev["content_block"]["name"], "args": ""}
            elif ev.get("type") == "content_block_delta" and ev["delta"].get("type") == "input_json_delta" and ev["index"] in blocks:
                blocks[ev["index"]]["args"] += ev["delta"].get("partial_json", "")
    if not getattr(path_b, "shown", False):
        path_b.shown = True
        print("   one raw gateway answer, tool blocks as the gateway streamed them:", json.dumps(blocks)[:500])
    return [(b["name"], b["args"]) for _i, b in sorted(blocks.items())]


def empty(args):
    try:
        return not json.loads(args or "{}")
    except ValueError:
        return True


for label, fn in (("A direct to Cerebras", path_a), ("B through the gateway", path_b)):
    total, empties, per_run = 0, 0, []
    for _ in range(N):
        try:
            calls = fn()
        except Exception as exc:
            per_run.append("error %s" % str(exc)[:200])
            continue
        total += len(calls)
        bad = sum(1 for _n, a in calls if empty(a))
        empties += bad
        per_run.append("%d calls, %d empty" % (len(calls), bad))
    print("%-24s %s: %d tool calls, %d with empty arguments | runs: %s" % (label, alias, total, empties, "; ".join(per_run)))
