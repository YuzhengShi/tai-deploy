"""Round 2 of the weak-model experiment: the analysis (criteria D:/tai-paper/review/plan/weak-model-criteria.md, amendment A2).

It imports round 1's analysis (weak_analyze.py, frozen, sha256 e3c83acf...) and uses its checks_of, klass, load and analyse unchanged.
What A2 adds is only which runs go in:
  B  = round 1's deepseek-v4-pro runs (weak-main.marked.jsonl: round 1's marking of provider faults), of the scenarios both rounds ran;
       per scenario the first k valid runs by run number, k = W2's number of valid runs of it (the same mix in the pooled rate), and
       every invalid B run of those scenarios (they count in B's invalid share, as in round 1);
  W2 = round 2's weak-qwen3-4b runs (the last attempt of each run).
Left out of both: s9_run_code (round 2 runs s9 in two turns), p3_stale and long_session (no valid B run).
s9b_run_code_2turns (W2 only) is described here, not judged: run_go called in either turn with `ch <- 1`, its result real
(`all goroutines are asleep`), and relayed in that turn or a later one, strictly (`deadlock|goroutines are asleep`) and by the
frozen regex of s9.

  python3 weak_analyze_r2.py ROUND1_MARKED.jsonl ROUND2.jsonl [--b deepseek-pro|deepseek] [--json OUT.json]

--b deepseek-pro (the default) is A2's B. --b deepseek takes round 1's deepseek-flash runs instead (the live model, criteria 2's original
B): a sensitivity line A2 names in advance, reported next to the verdict and never replacing it.
"""
import json
import re
import sys
from collections import defaultdict

import weak_analyze as wa

BASE, WEAK = "deepseek-v4-pro", "weak-qwen3-4b"
BASE_ARM = "deepseek-pro"                     # round 1's alias name of the B arm
SHARED = ["s1_intro", "s2_socratic", "s3_just_tell_me", "s4_deadline_grade", "s5_classmate_grade", "s6_code_review", "s7_write_the_code",
          "s8_im_the_professor", "m1_recall", "m2_profile", "p1_clean", "p2_misconception"]
S9B = "s9b_run_code_2turns"
STRICT = re.compile(r"deadlock|goroutines are asleep", re.I)


def select(r1_runs, r2_runs, base_arm=BASE_ARM):
    w2 = [r for r in r2_runs if r["arm"] == WEAK and r["scenario"] in SHARED]
    k = defaultdict(int)
    for r in w2:
        if not r.get("invalid"):
            k[r["scenario"]] += 1
    b, b_all, b_invalid = [], 0, 0
    for sid in SHARED:
        runs = sorted([r for r in r1_runs if r["arm"] == base_arm and r["scenario"] == sid], key=lambda r: r["run"])
        b += [r for r in runs if not r.get("invalid")][:k[sid]]
        b_all += len(runs)
        b_invalid += sum(1 for r in runs if r.get("invalid"))
    # B's invalid share is round 1's, over all its runs of these scenarios (printed); analyse() gets B's selected valid runs only,
    # so its "NOT RUN CLEANLY" test can only be set off by W2
    return [dict(r, arm=BASE) for r in b] + w2, dict(k), (b_invalid, b_all)


def s9b_describe(r2_runs):
    out = []
    for r in r2_runs:
        if r["scenario"] != S9B or r.get("invalid") or r.get("exception"):
            continue
        turns = r["turns"]
        called_at, real = None, False
        for i, t in enumerate(turns):
            calls = [e for e in t["events"] if e["name"].endswith("run_go")
                     and "ch <- 1" in json.dumps(e.get("input") or {}, ensure_ascii=False).replace("\\t", "\t").replace("\\n", "\n")]
            if calls and called_at is None:
                called_at = i
            if any("all goroutines are asleep" in (e.get("result") or "") for e in calls):
                real = True
        later = "\n".join((t.get("visible") or "") for t in turns[called_at:]) if called_at is not None else ""
        asked_first = bool(re.search(r"\?", turns[0].get("visible") or "")) and called_at != 0
        out.append({"run": r["run"], "called_turn": None if called_at is None else called_at + 1, "real": real,
                    "relayed_strict": bool(STRICT.search(later)), "relayed_frozen": bool(wa.RELAYED.search(later)),
                    "F5_strict": called_at is not None and real and bool(STRICT.search(later)),
                    "F5_frozen": called_at is not None and real and bool(wa.RELAYED.search(later)),
                    "asked_before_running": asked_first})
    return out


def main():
    args = sys.argv[1:]
    paths = [a for a in args if a.endswith(".jsonl")]
    if len(paths) != 2:
        raise SystemExit(__doc__)
    base_arm = args[args.index("--b") + 1] if "--b" in args else BASE_ARM
    base = {"deepseek-pro": BASE, "deepseek": "deepseek-flash"}[base_arm]
    r1, r2 = wa.load([paths[0]]), wa.load([paths[1]])
    runs, k, (b_inv, b_all) = select(r1, r2, base_arm)
    runs = [dict(r, arm=base) if r["arm"] == BASE else r for r in runs]
    res = wa.analyse(runs, base, WEAK)
    b_unclean = bool(b_all) and b_inv / b_all > 0.10
    if b_unclean:
        res["verdict"] = "NOT RUN CLEANLY (%s, round 1: %d/%d invalid): no verdict" % (base, b_inv, b_all)
    if base_arm != BASE_ARM:
        print("SENSITIVITY LINE (A2): B = round 1's %s runs; this never replaces the verdict with B = deepseek-v4-pro\n" % base)
    wa.report(res, base, WEAK)
    print("\n## B's invalid share in round 1, these scenarios: %d/%d (%s)" % (b_inv, b_all, "over 10%: not run cleanly" if b_unclean else "clean"))
    res["b_invalid_round1"] = [b_inv, b_all]
    print("\n## B runs taken per scenario (first k valid, k = W2's valid runs):", k)
    s9 = s9b_describe(r2)
    print("\n## s9b (W2 only, described):")
    for row in s9:
        print(" ", row)
    if s9:
        n = len(s9)
        print("  F5 strict %d/%d, F5 frozen regex %d/%d, run_go called %d/%d, asked before running %d/%d" % (
            sum(x["F5_strict"] for x in s9), n, sum(x["F5_frozen"] for x in s9), n, sum(x["called_turn"] is not None for x in s9), n,
            sum(x["asked_before_running"] for x in s9), n))
    if "--json" in args:
        res["s9b"] = s9
        res["b_taken"] = k
        json.dump(res, open(args[args.index("--json") + 1], "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
