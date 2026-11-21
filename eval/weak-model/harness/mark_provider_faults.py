"""Written AFTER the counted run (2026-11-16 ~02:30 UTC), when DeepSeek answered 402 "Insufficient Balance" from 01:42:59 UTC on.
It changes no check, class, threshold or regex of the frozen criteria; it only applies criteria 4.4 ("a transport fault: the provider or
the gateway returns 5xx, 429, a timeout, or the scratch environment itself broke" -> invalid, rerun) to runs the runner could not see
were hit: a patrol or a long-session turn that met a provider error produced no visible error reply the runner's validity test knew.

A run is marked invalid when the scratch gateway's own log (logs/gateway.jsonl, written by eval/litellm/tai_callbacks.py) has at least
one failed call with status 402, 429 or >= 500 inside the run's window [started - 1 s, started + wall_s + 5 s]. Runs are sequential, so
windows do not overlap.

  python3 mark_provider_faults.py RESULTS.jsonl GATEWAY.jsonl OUT.jsonl
"""
import json
import sys


def main():
    results, gateway, out = sys.argv[1:4]
    fails = [e for e in (json.loads(l) for l in open(gateway, encoding="utf-8") if l.strip())
             if e.get("event") == "fail" and (e.get("status") in (402, 429) or (isinstance(e.get("status"), int) and e["status"] >= 500))]
    marked = 0
    with open(out, "w", encoding="utf-8") as w:
        for line in open(results, encoding="utf-8"):
            if not line.strip():
                continue
            r = json.loads(line)
            t0 = float(r["started"])
            hit = [e for e in fails if t0 - 1 <= e["ts"] <= t0 + float(r.get("wall_s") or 0) + 5]
            if hit and not r.get("invalid"):
                r["invalid"] = True
                r["invalid_reason"] = "provider fault after the run (criteria 4.4): %d failed gateway call(s), status %s" % (
                    len(hit), sorted({e["status"] for e in hit}))
                marked += 1
                print("marked", r["scenario"], r["arm"], "run", r["run"], r["invalid_reason"])
            w.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("marked %d run(s) -> %s" % (marked, out))


if __name__ == "__main__":
    main()
