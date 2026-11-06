"""Does a line that changes between requests break the prompt cache for what comes after it? TAi puts "Current date and time: ... at 10:45 PM"
at the START of the text it appends to Claude Code's system prompt, ahead of the 27 KB persona, and the minute changes. Two variants, two
calls each, repeated TRIALS times with a new body every time (one trial can miss by chance: rate_probe.py saw a cache miss on an identical
prompt), straight to Cerebras (gpt-oss, whose bucket is not Nora's; the key is read from the world's .env on the box, never printed):
  A  the changing line first, then the body      (call 2 has a different line)
  B  the body first, then the changing line      (call 2 has a different line)
Prints cached_tokens of each call: if A's second call caches (almost) nothing and B's caches the body, a volatile line belongs at the end.
   python3 cache_probe.py [model] [trials] [words]"""
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

MODEL = sys.argv[1] if len(sys.argv) > 1 else "gpt-oss-120b"
TRIALS = int(sys.argv[2]) if len(sys.argv) > 2 else 3
WORDS_N = int(sys.argv[3]) if len(sys.argv) > 3 else 4000
EFFORT = "none" if MODEL.startswith("qwen") else "low"


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
    return "Reference text, to be ignored.\n" + " ".join("%s%d" % (rnd.choice(WORDS), rnd.randrange(1000)) for _ in range(WORDS_N))


def call(system, question):
    body = {"model": MODEL, "max_tokens": 16, "temperature": 0, "reasoning_effort": EFFORT,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": question}]}
    req = urllib.request.Request("https://api.cerebras.ai/v1/chat/completions", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": "Bearer " + KEY, "user-agent": "tai-eval-probe/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise SystemExit("HTTP %d: %s" % (e.code, e.read().decode("utf-8", "replace").replace(KEY, "<key>")[:300]))
    usage = data.get("usage", {})
    return usage.get("prompt_tokens"), (usage.get("prompt_tokens_details") or {}).get("cached_tokens")


stamp = int(time.strftime("%H%M%S"))
second = {"A: changing line first": [], "B: changing line last": []}
for trial in range(TRIALS):
    for label, volatile_first, offset in (("A: changing line first", True, 0), ("B: changing line last", False, 500)):
        body = body_text(stamp * 10 + trial * 2 + (1 if volatile_first else 0) + offset)
        for k, line in enumerate(("Current date and time: Sunday, November 1, 2026 at 10:45 PM UTC.", "Current date and time: Sunday, November 1, 2026 at 10:46 PM UTC."), 1):
            system = (line + "\n\n" + body) if volatile_first else (body + "\n\n" + line)
            prompt, cached = call(system, "Reply with the word ok.")
            print("trial %d %-24s call %d: prompt %s tokens, cached %s (%.0f%%)" % (trial + 1, label, k, prompt, cached, 100.0 * (cached or 0) / max(prompt or 1, 1)))
            if k == 2:
                second[label].append(100.0 * (cached or 0) / max(prompt or 1, 1))
            time.sleep(1)
for label, shares in second.items():
    print("%-24s second call cached share over %d trials: %s" % (label, len(shares), ", ".join("%.0f%%" % s for s in shares)))
