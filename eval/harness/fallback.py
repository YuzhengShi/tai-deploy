"""Does the gateway answer with gpt-oss when qwen cannot, on the route Claude Code uses (Anthropic Messages, /v1/messages, streaming) and, with
the argument `chat`, on the route pi uses (OpenAI chat completions, /v1/chat/completions, streaming)?

LiteLLM documents router fallbacks for /chat/completions; whether they apply to the Anthropic-format route is what the first cases
check, with a deployment that always fails (the alias test-bad-key: Cerebras answers 401) whose fallback is gpt-oss, in a plain and in
a streaming request. The last case checks the other mechanism, the qwen budget (tai_callbacks.py): started with a small
TAI_QWEN_TPM_BUDGET, requests that find the budget used up are sent to gpt-oss. Evidence is the gateway's own log (one line per
upstream call, with the status of a failed one), not what a model says.

Runs in a container on nanoclaw-net, because tai-litellm is only reachable there:   stack.sh fallbacktest [budget] [chat]
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("GATEWAY", "http://tai-litellm:4000")
LOG = os.environ.get("GATEWAY_LOG", "/logs/gateway.jsonl")


def key():
    for line in open(os.environ.get("SECRETS_ENV", "/secrets.env")):
        if line.startswith("LITELLM_MASTER_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no LITELLM_MASTER_KEY in the secrets file")


KEY = key()
rows = []
ROUTE = "chat" if "chat" in sys.argv[1:] else "messages"


def events(since):
    out = []
    try:
        with open(LOG, encoding="utf-8") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("ts", 0) >= since:
                    out.append(e)
    except FileNotFoundError:
        pass
    return out


def ask(model, stream=False, text="Reply with the single word: pong"):
    body = {"model": model, "max_tokens": 200, "messages": [{"role": "user", "content": text}], "stream": stream}
    headers = {"content-type": "application/json", "authorization": "Bearer " + KEY}
    if ROUTE == "chat":
        path = "/v1/chat/completions"
        if stream:
            body["stream_options"] = {"include_usage": True}
    else:
        path = "/v1/messages"
        headers["anthropic-version"] = "2023-06-01"
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method="POST", headers=headers)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode("utf-8", "replace")
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read().decode("utf-8", "replace"), e.code
    answer = ""
    if status == 200 and stream:
        for line in raw.splitlines():
            if line.startswith("data:") and line[5:].strip() != "[DONE]":
                try:
                    d = json.loads(line[5:])
                except ValueError:
                    continue
                if ROUTE == "chat":
                    for choice in d.get("choices") or []:
                        answer += (choice.get("delta") or {}).get("content") or ""
                elif d.get("type") == "content_block_delta" and d.get("delta", {}).get("type") == "text_delta":
                    answer += d["delta"].get("text", "")
    elif status == 200:
        try:
            data = json.loads(raw)
            if ROUTE == "chat":
                answer = "".join((c.get("message") or {}).get("content") or "" for c in data.get("choices", []))
            else:
                answer = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        except ValueError:
            pass
    time.sleep(1.5)     # the success/failure callbacks write the log line a moment after the response
    return status, answer, events(t0 - 0.5), raw[:160]


def note(case, what, expected, observed, ok):
    rows.append(dict(case=case, what=what, expected=expected, observed=observed, verdict="OK" if ok else "NOT AS EXPECTED"))
    print("%-24s %-8s %s | expected %s | observed %s" % (case, "OK" if ok else "DIFFERS", what, expected, observed), flush=True)


def models(evs, kind="ok"):
    return [str(e.get("model")) for e in evs if e.get("event") == kind]


def fallback_case(label, stream):
    status, answer, evs, raw = ask("test-bad-key", stream=stream)
    fails = [(e.get("model"), e.get("status")) for e in evs if e.get("event") == "fail"]
    served = models(evs)
    note(label, "alias test-bad-key (always fails, fallback gpt-oss), %s" % ("streaming" if stream else "plain"),
         "200, an answer, served by gpt-oss after a logged failure of the bad deployment",
         "HTTP %s, answer %r, failures %s, served by %s" % (status, answer[:40], fails or "none", served or "nobody (%s)" % raw),
         status == 200 and bool(answer) and any("gpt-oss" in m for m in served) and bool(fails))


def main():
    budget_case = "budget" in sys.argv[1:]
    status, answer, evs, raw = ask("qwen")
    note("F1_qwen", "qwen alias, plain, route " + ROUTE, "200, answer, served by qwen", "HTTP %s, %r, served by %s" % (status, answer[:30], models(evs)),
         status == 200 and bool(answer) and any("qwen" in m for m in models(evs)))
    status, answer, evs, raw = ask("gpt-oss")
    note("F2_gpt_oss", "gpt-oss alias, plain", "200, answer, served by gpt-oss", "HTTP %s, %r, served by %s" % (status, answer[:30], models(evs)),
         status == 200 and bool(answer) and any("gpt-oss" in m for m in models(evs)))
    fallback_case("F3_fallback_plain", False)
    fallback_case("F4_fallback_stream", True)
    status, answer, evs, raw = ask("no-such-alias")
    note("F5_unknown_alias", "an alias the gateway does not know (control: no fallback for it)", "an error, nothing served", "HTTP %s, served by %s" % (status, models(evs)),
         status >= 400 and not models(evs))
    if budget_case:
        seen = []
        for i in range(6):
            status, answer, evs, raw = ask("qwen")
            spilled = [e for e in evs if e.get("event") == "spill"]
            seen.append((i + 1, status, "spill" if spilled else "qwen", models(evs)))
        print("      per request (n, status, route, served by):", seen)
        first_on_qwen = seen[0][2] == "qwen" and any("qwen" in m for m in seen[0][3])
        spills = [s for s in seen if s[2] == "spill"]
        note("F6_budget_spill", "qwen alias against a small TAI_QWEN_TPM_BUDGET", "the first request on qwen, later ones sent to gpt-oss and answered",
             "first on qwen: %s; %d of 6 spilled; served after a spill: %s" % (first_on_qwen, len(spills), [s[3] for s in spills][:2]),
             first_on_qwen and bool(spills) and all(s[1] == 200 and any("gpt-oss" in m for m in s[3]) for s in spills))
    os.makedirs("/logs", exist_ok=True)
    with open("/logs/fallback-result%s.json" % ("-chat" if ROUTE == "chat" else ""), "w") as f:
        json.dump(rows, f, indent=1)
    print("%d cases, %d not as expected" % (len(rows), sum(1 for r in rows if r["verdict"] != "OK")))


if __name__ == "__main__":
    main()
