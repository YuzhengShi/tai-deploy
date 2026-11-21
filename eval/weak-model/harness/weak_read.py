"""The transcripts criteria section 8 says to read after counting: every failure of F1-F5, every failure of a code check, and two random pairs
per scenario (one run of each arm, chosen with a fixed seed). Reading changes no count; what it finds goes into the results' limits.

  python3 weak_read.py RESULTS.jsonl --base deepseek-pro --weak deepseek [--seed 20261115] > reading.txt
"""
import json
import random
import sys

import weak_analyze as wa


def brief(e):
    inp = e.get("input") or {}
    key = inp.get("file_path") or inp.get("command") or inp.get("action") or inp.get("question") or json.dumps(inp)[:120]
    return "%s(%s)%s" % (e["name"].replace("mcp__", ""), str(key)[:100].replace("\n", " "), " ERR" if e.get("error") else "")


def show(run, why):
    print("=" * 110)
    print("%s | %s | run %s | folder %s | %s" % (run["scenario"], run["arm"], run["run"], run.get("folder"), why))
    if "turns" in run:
        for i, t in enumerate(run["turns"], 1):
            print("-- turn %d (%.0f s) student: %s" % (i, t.get("seconds") or 0, t["user"][:300].replace("\n", " / ")))
            print("   tools:", [brief(e) for e in t.get("events") or []])
            print("   writer:", (t.get("writer") or {}).get("kind"), (t.get("writer") or {}).get("reason") or "")
            print("   TAi:", (t.get("visible") or "")[:1500].replace("\n", " / "))
    else:
        print("   run logs:", json.dumps(run.get("run_logs"))[:600])
        print("   tools:", [brief(e) for e in run.get("events") or []])
        print("   messages to the student:", [e["text"][:800] for e in run.get("outbox") or [] if e.get("kind") == "text"])


def main():
    args = sys.argv[1:]
    get = lambda flag, d: args[args.index(flag) + 1] if flag in args else d
    base, weak = get("--base", "deepseek-pro"), get("--weak", "deepseek")
    rng = random.Random(int(get("--seed", "20261115")))
    runs = [r for r in wa.load([a for a in args if a.endswith(".jsonl")]) if not r.get("invalid") and r["scenario"] != "long_session"]
    fn_checks = {c for _f, (_s, c) in wa.FUNCTIONS.items()}
    for r in sorted(runs, key=lambda r: (r["scenario"], r["arm"], r["run"])):
        cs = wa.checks_of(r)
        bad = [c for c, v in cs.items() if v is False and (c in fn_checks or wa.klass(c) == "code")]
        if bad:
            show(r, "failed: %s" % ", ".join(sorted(bad)))
    by = {}
    for r in runs:
        by.setdefault((r["scenario"], r["arm"]), []).append(r)
    for sid in sorted({r["scenario"] for r in runs}):
        for _pair in range(2):
            for arm in (base, weak):
                pool = sorted(by.get((sid, arm), []), key=lambda r: r["run"])
                if pool:
                    show(rng.choice(pool), "random pair")


if __name__ == "__main__":
    main()
