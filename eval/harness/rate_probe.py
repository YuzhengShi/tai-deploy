"""Does a cached prompt prefix cost tokens-per-minute budget on Cerebras? Calls straight to Cerebras (not through the gateway) with the same
prefix and a different last line; after each, the usage the API reports and the rate-limit headers (remaining tokens in the minute). The
header shows the bucket as it was when the call arrived, so a call's own charge appears in the NEXT call's reading. Sequence:
  1 cold prefix P   2-4 the same P (cache hits)   5 a different prefix Q (a forced miss)   6 Q again (a hit)   7 Q again after a pause
If cached tokens were charged, calls 2-4 would each take about the prompt size; if they are not, about the uncached part and the
completion. Call 5's charge shows in call 6's reading, and the bucket refills during the pause.
The key is read from the world's .env on the box and never printed. Pass a small WORDS for the qwen bucket, which Nora shares.
   python3 rate_probe.py [model] [words]      e.g.  gpt-oss-120b 17000   or   qwen-3.8-27b 3000"""
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

MODEL = sys.argv[1] if len(sys.argv) > 1 else "gpt-oss-120b"
WORDS_N = int(sys.argv[2]) if len(sys.argv) > 2 else 17000
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


def prefix(seed):
    rnd = random.Random(seed)
    return "Reference text, to be ignored.\n" + " ".join("%s%d" % (rnd.choice(WORDS), rnd.randrange(1000)) for _ in range(WORDS_N))


def call(system, question):
    body = {"model": MODEL, "max_tokens": 16, "temperature": 0, "reasoning_effort": EFFORT,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": question}]}
    req = urllib.request.Request("https://api.cerebras.ai/v1/chat/completions", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": "Bearer " + KEY, "user-agent": "tai-eval-probe/1.0"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())
            headers = {k.lower(): v for k, v in r.headers.items() if k.lower().startswith("x-ratelimit")}
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace").replace(KEY, "<key>")
        raise SystemExit("HTTP %d: %s | %s" % (e.code, text[:300], {k: v for k, v in e.headers.items() if k.lower().startswith("x-ratelimit")}))
    usage = data.get("usage", {})
    return round(time.time() - t0, 2), usage.get("prompt_tokens"), (usage.get("prompt_tokens_details") or {}).get("cached_tokens"), usage.get("completion_tokens"), headers


stamp = int(time.strftime("%H%M%S"))
P, Q = prefix(stamp), prefix(stamp + 1)
plan = [("cold P", P, 0), ("P", P, 0), ("P", P, 0), ("P", P, 0), ("forced miss Q", Q, 0), ("Q", Q, 0), ("Q after 10 s", Q, 10)]
prev = None
for i, (label, system, pause) in enumerate(plan, 1):
    time.sleep(pause)
    seconds, prompt, cached, out, headers = call(system, "Reply with the word %d." % i)
    left = next((int(v) for k, v in headers.items() if "remaining-tokens-minute" in k), None)
    print("call %d %-14s: %.2f s, prompt %s tokens, cached %s, completion %s | tokens left in the minute %s%s" % (
        i, label, seconds, prompt, cached, out, left, "" if prev is None or left is None else " (%+d since the last reading)" % (left - prev)))
    prev = left
