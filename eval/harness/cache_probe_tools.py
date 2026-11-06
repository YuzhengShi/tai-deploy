"""Where does a line that changes between sessions belong when the request also carries tools? cache_probe.py answered it for the system text
alone (a changing line first kills the cache after it, last keeps it). A request has a tools array too, and a chat template may render it
AFTER the system text: then a changing date at the end of the system prompt still sits in front of the tool schemas (TAi's nanoclaw tools
are about 21 KB) and the whole conversation. Four variants, two calls each, only the changing line differs between the two calls, a new
body for every trial, tools identical in every call (straight to Cerebras, the key is read from the world's .env on the box, never printed):
  S-first  system = line + body       user = question
  S-last   system = body + line       user = question
  U        system = body              user = line + question        (the changing line rides in the message stream)
  fixed    system = body + line       user = question               (nothing changes between the calls: the ceiling)
Every call's `cached` says how much of the prompt Cerebras served from its cache. Two things to read off:
  call 1 of a variant (a new body, the same tools as the calls before): cached > 0 means the tools are rendered BEFORE the system text and are
         a shared prefix; cached ~ 0 means they come after it (or are not cached);
  call 2: how much survives the changing line. U and `fixed` show the ceiling, S-first the floor.
A sizing pair at the start (the same prompt without and with the tools) tells how many tokens the tools are.
   python3 cache_probe_tools.py [model] [trials] [body_words] [n_tools] [variants]
   e.g.  gpt-oss-120b 2 4000 20      qwen-3.8-27b 1 1200 8 S-last,U     (qwen is Nora's bucket: keep it small)"""
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

MODEL = sys.argv[1] if len(sys.argv) > 1 else "gpt-oss-120b"
TRIALS = int(sys.argv[2]) if len(sys.argv) > 2 else 2
BODY_WORDS = int(sys.argv[3]) if len(sys.argv) > 3 else 4000
N_TOOLS = int(sys.argv[4]) if len(sys.argv) > 4 else 20
VARIANTS = (sys.argv[5] if len(sys.argv) > 5 else "S-first,S-last,U,fixed").split(",")
EFFORT = "none" if MODEL.startswith("qwen") else "low"
PAUSE = 3 if MODEL.startswith("qwen") else 1


def env_value(path, key):
    with open(os.path.expanduser(path)) as f:
        for line in f:
            if line.startswith(key + "="):
                return line.strip().split("=", 1)[1]
    raise SystemExit("no %s in %s" % (key, path))


KEY = env_value(os.environ.get("WORLD_ENV", "~/cs6650-world/.env"), "CEREBRAS_API_KEY")
WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
         "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu"]


def body_text(seed):
    rnd = random.Random(seed)
    return "Reference text, to be ignored.\n" + " ".join("%s%d" % (rnd.choice(WORDS), rnd.randrange(1000)) for _ in range(BODY_WORDS))


def make_tools(n):
    rnd = random.Random(7)
    tools = []
    for i in range(n):
        props = {"field_%d" % j: {"type": "string", "description": " ".join(rnd.choice(WORDS) for _ in range(25))} for j in range(4)}
        tools.append({"type": "function", "function": {
            "name": "mcp_tool_%02d" % i, "description": " ".join(rnd.choice(WORDS) for _ in range(60)),
            "parameters": {"type": "object", "properties": props, "required": ["field_0"]}}})
    return tools


TOOLS = make_tools(N_TOOLS)


def call(system, user, tools=True):
    body = {"model": MODEL, "max_tokens": 16, "temperature": 0, "reasoning_effort": EFFORT,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if tools:
        body["tools"] = TOOLS
    req = urllib.request.Request("https://api.cerebras.ai/v1/chat/completions", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": "Bearer " + KEY, "user-agent": "tai-eval-probe/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise SystemExit("HTTP %d: %s" % (e.code, e.read().decode("utf-8", "replace").replace(KEY, "<key>")[:300]))
    usage = data.get("usage", {})
    return usage.get("prompt_tokens") or 0, (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0


LINES = ("Current date and time: Sunday, November 1, 2026 at 10:45 PM UTC.", "Current date and time: Sunday, November 1, 2026 at 10:46 PM UTC.")
QUESTION = "Reply with the word ok."


def build(variant, body, k):
    line = LINES[k]
    if variant == "S-first":
        return line + "\n\n" + body, QUESTION
    if variant == "S-last":
        return body + "\n\n" + line, QUESTION
    if variant == "U":
        return body, line + "\n\n" + QUESTION
    if variant == "fixed":
        return body + "\n\n" + LINES[0], QUESTION
    raise SystemExit("unknown variant " + variant)


stamp = int(time.strftime("%H%M%S"))
sizing_body = body_text(stamp * 100)
p_without, _ = call(sizing_body, QUESTION, tools=False)
p_with, _ = call(sizing_body, QUESTION, tools=True)
print("sizing: prompt without tools %d tokens, with %d tools %d tokens: the tools are about %d tokens" % (p_without, N_TOOLS, p_with, p_with - p_without))
print("model %s, body %d words, %d tools, %d trial(s), variants %s" % (MODEL, BODY_WORDS, N_TOOLS, TRIALS, ",".join(VARIANTS)))
results = {v: {"first": [], "second": []} for v in VARIANTS}
for trial in range(TRIALS):
    for vi, variant in enumerate(VARIANTS):
        body = body_text(stamp * 100 + 1 + trial * 10 + vi)
        for k in range(2):
            system, user = build(variant, body, k)
            prompt, cached = call(system, user)
            share = 100.0 * cached / max(prompt, 1)
            print("trial %d %-8s call %d: prompt %5d tokens, cached %5d (%3.0f%%)" % (trial + 1, variant, k + 1, prompt, cached, share))
            results[variant]["first" if k == 0 else "second"].append((prompt, cached))
            time.sleep(PAUSE)
print()
print("tools are about %d tokens, the body about %d" % (p_with - p_without, p_without))
for variant, r in results.items():
    f = ", ".join("%d" % c for _p, c in r["first"])
    s = ", ".join("%d/%d" % (c, p) for p, c in r["second"])
    print("%-8s call 1 cached (tokens): %-24s call 2 cached/prompt: %s" % (variant, f, s))
