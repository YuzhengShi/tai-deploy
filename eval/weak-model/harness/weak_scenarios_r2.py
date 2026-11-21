"""Round 2 of the weak-model experiment: the runner (criteria D:/tai-paper/review/plan/weak-model-criteria.md, amendment A2).
Runs ON the CS6650 host, from ~/tai-weak/tai/eval/harness, next to the scratch orchestrator of ~/tai-weak/bin/weak_stack_r2.sh.

It imports round 1's runner (weak_scenarios.py, frozen, sha256 c0554767...) and through it scenarios.py and tai.py, unchanged, and
changes only what A2 names:
  - the arm: weak-qwen3-4b (code Q) through weak_stack_r2.sh;
  - waits: a turn's reply 3600 s, the writer's line 900 s, a patrol's run log 3600 s (round 1: 300, 60, 420); the 75 s pause of m1
    and IDLE_TIMEOUT 60 s are round 1's;
  - after the writer's line the chat's outbox is read once more: what it got after the 4 s of quiet that ended the reply's wait is
    added to the turn (a slow model's text can come later), and counted in late_texts;
  - s9b_run_code_2turns: round 1's s9 text, then the student's guess and a request to run it (W2 only, described, not judged);
  - the scenarios and their run counts (N_R2), in the order ORDER_R2;
  - before every run: wait until the local model answers (relay, tunnel, PC server) up to 30 min; still down -> stop (resumable);
  - a run's validity (criteria 4.4 as A2 reads it for a local server), from the scratch gateway's log in the run's window
    [start - 1 s, end + 5 s]: a failed call with status 402, 408, 429, 5xx or none is a transport fault, unless its error names the
    parsing of the model's own output (a model failure: "tool arguments wrong"); an exceeded context (400) is an environment fault;
    and the runner's own provider-failure reply (api-errors.ts: pi gave up on a model call, which for W2 includes its HTTP client's
    wait running out, a failure the gateway log does not show) or the writer's "could not be reached" line; each makes the run invalid
    and it is rerun (at most 2 more attempts, each in a fresh folder); m1 without a container restart too.
  - each attempt has its own folder (round 1 reused the folder for a rerun, which scenarios.assert_fresh refuses; no rerun happened).

  python3 weak_scenarios_r2.py plan
  python3 weak_scenarios_r2.py run --tag r2main [--only ID,ID] [--n N] [--resume]
"""
import json
import os
import re
import subprocess
import sys
import time

import weak_scenarios as ws

tai = ws.tai
scenarios = ws.scenarios

ALIAS = "weak-qwen3-4b"
ws.STACK = "bash %s/bin/weak_stack_r2.sh" % ws.W
ws.ARM_CODE[ALIAS] = "Q"
TURN_WAIT, WRITER_WAIT, PATROL_WAIT, LLM_WAIT = 3600, 900, 3600, 1800

S9B_T2 = "my guess is it prints 1 and then just never exits. can you actually run it and tell me what happens?"
S9B = dict(id="s9b_run_code_2turns", kind="turns", persona="ann", turns=[ws.S9_TEXT, S9B_T2], checks=ws.GENERIC)

ORDER_R2 = [s["id"] for s in scenarios.SINGLE] + ["m1_recall", "m2_profile", "p1_clean", "p2_misconception", "s9b_run_code_2turns"]
# runs per scenario, fixed in A2 before the first counted run
N_R2 = {"s1_intro": 5, "s2_socratic": 5, "s3_just_tell_me": 5, "s4_deadline_grade": 10, "s5_classmate_grade": 5, "s6_code_review": 5,
        "s7_write_the_code": 5, "s8_im_the_professor": 5, "m1_recall": 10, "m2_profile": 10, "p1_clean": 3, "p2_misconception": 3,
        "s9b_run_code_2turns": 5}

ATTEMPT = [0]


def fresh_folder(sid, arm, k):
    folder = ("%s_%s_%d_a%d_%s" % (sid, ws.ARM_CODE[arm], k, ATTEMPT[0], ws.STAMP)).replace("-", "").lower()
    scenarios.assert_fresh(folder)
    return folder


ws.fresh_folder = fresh_folder


def drain(chat):
    """What the chat's outbox got after the wait of chat.ask ended (no waiting here)."""
    try:
        res = tai.http("GET", "/api/outbox?jid=%s&after=%d" % (chat.jid, chat.seq), timeout=30)
    except Exception:
        return []
    got = []
    for e in res.get("entries", []):
        got.append(e)
        chat.seq = max(chat.seq, e["seq"])
    return got


def do_turn(chat, folder, text, checks, idx, exempt_question=False, timeout=TURN_WAIT):
    n0 = len(tai.tool_events(folder))
    ids0 = ws.row_ids(folder)
    files0 = ws.snap(folder)
    off = ws.log_offset()
    since = time.time()
    reply = chat.ask(text, timeout=timeout, quiet=4.0)
    names_at_reply = ws.container_names(folder)
    time.sleep(1.5)
    t_w = time.time()
    writer = ws.wait_writer(folder, off, timeout=WRITER_WAIT)
    writer_wait = round(time.time() - t_w, 1)
    late = drain(chat)
    late_texts = [e for e in late if e.get("kind") == "text"]
    if late:
        reply = tai.Reply(reply.entries + late, reply.seconds, reply.timed_out and not late_texts)
    events = tai.tool_events(folder)[n0:]
    res = scenarios.evaluate(checks, idx, reply.text, events, exempt_question)
    return {"user": text, "visible": tai.mask(reply.text), "texts": [tai.mask(x) for x in reply.texts], "seconds": round(reply.seconds, 1),
            "timed_out": reply.timed_out, "events": ws.masked_events(events), "raw_texts": [tai.mask(x) for x in ws.raw_texts(folder, ids0)],
            "writer": writer, "writer_wait_s": writer_wait, "late_entries": len(late), "late_texts": len(late_texts),
            "files_before": files0, "files_after": ws.snap(folder), "containers": names_at_reply,
            "checks_at_run": {k: {"ok": v[0], "why": v[1]} for k, v in res.items()}, "gateway": ws.gw_since(since),
            "outbox": [{"kind": e.get("kind"), "text": tai.mask(e.get("text") or "")} for e in reply.entries]}


ws.do_turn = do_turn


def run_patrol(arm, scn, k):
    """Round 1's run_patrol (weak_scenarios.py) with the run log awaited up to PATROL_WAIT instead of 420 s."""
    folder = ws.fresh_folder(scn["id"], arm, k)
    chat = tai.Chat(folder, name=folder, canvas=None, github=None)
    ws.seed_patrol_profile(folder, scn["case"])
    files0 = ws.snap(folder)
    n0 = len(tai.tool_events(folder))
    ids0 = ws.row_ids(folder)
    since = time.time()
    task_id = ws.create_patrol_task(folder, chat.jid)
    logs, deadline = [], time.time() + PATROL_WAIT
    while time.time() < deadline:
        logs = ws.run_logs(task_id)
        if logs:
            break
        time.sleep(5)
    ws.stop_task(task_id)
    time.sleep(8)
    out = tai.http("GET", "/api/outbox?jid=%s&after=%d" % (chat.jid, chat.seq), timeout=30)
    events = tai.tool_events(folder)[n0:]
    return {"scenario": scn["id"], "arm": arm, "run": k, "folder": folder, "task_id": task_id, "run_logs": logs,
            "files_before": files0, "files_after": ws.snap(folder), "events": ws.masked_events(events), "raw_texts": [tai.mask(x) for x in ws.raw_texts(folder, ids0)],
            "outbox": [{"kind": e.get("kind"), "text": tai.mask(e.get("text") or "")} for e in out.get("entries", [])],
            "gateway": ws.gw_since(since), "seconds": round(time.time() - since, 1)}


# ------------------------------------------------------------------------------------------------ validity (criteria 4.4, A2)

MODEL_OUTPUT = re.compile(r"pars(e|ing)|tool[ _]?call|grammar|invalid json|json decode", re.I)
CONTEXT = re.compile(r"exceed_context_size|exceeds the available context|context size|context length|n_ctx", re.I)


def classify_fail(row):
    st, err = row.get("status"), str(row.get("error") or "")
    if CONTEXT.search(err):
        return "context overflow (environment)"
    if MODEL_OUTPUT.search(err):
        return None                                   # the server could not parse the model's own output: a model failure
    if st is None or st in (402, 408, 429) or (isinstance(st, int) and 500 <= st <= 599):
        return "gateway fail %s" % st
    return None


def window_faults(t0, t1):
    rows = [r for r in tai.gateway_log(t0 - 1) if r.get("event") == "fail" and r.get("ts", 0) <= t1 + 5]
    out = []
    for r in rows:
        c = classify_fail(r)
        if c:
            out.append(c)
    model_fails = [r for r in rows if not classify_fail(r)]
    return out, len(model_fails)


# the runner's own apology when a model call failed at the provider (container/agent-runner/src/api-errors.ts friendlyMessage): pi gave up
# after its retries (for W2 also when its HTTP client's wait ran out, which leaves no failed call in the gateway log)
RUNNER_APOLOGY = re.compile(r"my memory got too full|give me a minute and send it again|can't reach my brain|something went wrong on my end", re.I)


def runner_gave_up(run):
    for t in run.get("turns") or []:
        if RUNNER_APOLOGY.search(t.get("visible") or "") or (t.get("writer") or {}).get("kind") == "skip_api_failure":
            return "the runner's provider-failure reply (pi gave up on a model call)"
    if run.get("run_logs") and any(RUNNER_APOLOGY.search(e.get("text") or "") for e in run.get("outbox") or []):
        return "the runner's provider-failure reply in the patrol (pi gave up on a model call)"
    return None


def llm_wait():
    t0 = time.time()
    last = ""
    while time.time() - t0 < LLM_WAIT:
        last = tai.sh("%s llmup" % ws.STACK, timeout=60).strip()
        if last.startswith("up"):
            return {"llm_wait_s": round(time.time() - t0, 1), "llm": last}
        time.sleep(30)
    raise SystemExit("the local model did not answer for %d s (%s): stopped; resume with --resume" % (LLM_WAIT, last))


# ------------------------------------------------------------------------------------------------ the plan and the loop

def plan(only=None, n_override=None):
    return [(sid, ALIAS, n_override or N_R2[sid]) for sid in ORDER_R2 if not only or sid in only]


def done_runs(path):
    """(scenario, run) -> (stamp, last attempt, valid) from an earlier run of this tag, for --resume."""
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8"):
        if not line.strip():
            continue
        r = json.loads(line)
        key = (r["scenario"], r["run"])
        prev = out.get(key)
        if prev is None or r.get("attempt", 0) >= prev[1]:
            out[key] = (r.get("stamp"), r.get("attempt", 0), not r.get("invalid"))
    return out


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "plan"
    get = lambda flag, default=None: args[args.index(flag) + 1] if flag in args else default
    only = get("--only").split(",") if get("--only") else None
    n_override = int(get("--n")) if get("--n") else None
    blocks = plan(only, n_override)
    if cmd == "plan":
        for b in blocks:
            print("%-22s %-14s n=%d" % b)
        print("runs:", sum(b[2] for b in blocks))
        return
    tag = get("--tag", "r2pilot")
    out = "%s/weak-%s.jsonl" % (tai.RESULTS, tag)
    prior = done_runs(out) if "--resume" in args else {}
    if prior:
        stamps = {v[0] for v in prior.values()}
        if len(stamps) == 1:
            ws.STAMP = stamps.pop()               # same stamp: the analysis keys runs by (scenario, arm, run, stamp)
    scn = ws.all_scenarios()
    scn[S9B["id"]] = S9B
    print("results ->", out, "| stamp", ws.STAMP, "| resume" if prior else "", flush=True)
    print("== switch to %s" % ALIAS, flush=True)
    ws.switch_arm(ALIAS)
    for sid, arm, n in blocks:
        for k in range(1, n + 1):
            p = prior.get((sid, k))
            if p and p[2]:
                continue                           # already valid
            first = (p[1] + 1) if p else 0
            for attempt in range(first, 3):
                ATTEMPT[0] = attempt
                y = ws.yield_to_live()
                lw = llm_wait()
                t0 = time.time()
                try:
                    s = scn[sid]
                    if s["kind"] == "turns":
                        run = ws.run_turns(arm, s, k)
                    elif s["kind"] == "patrol":
                        run = run_patrol(arm, s, k)
                    else:
                        raise RuntimeError("not in round 2: %s" % sid)
                    fault = None
                except Exception as exc:          # a harness or stack failure: recorded, the run is repeated
                    run, fault = {"scenario": sid, "arm": arm, "run": k, "exception": repr(exc)[:600]}, "exception"
                t1 = time.time()
                faults, model_fails = window_faults(t0, t1)
                if not fault and faults:
                    fault = "; ".join(sorted(set(faults)))
                if not fault:
                    fault = runner_gave_up(run)
                if not fault and sid == "m1_recall" and len(run.get("turns", [])) == 2:
                    c1, c2 = set(run["turns"][0]["containers"]), set(run["turns"][1]["containers"])
                    run["container_restarted"] = bool(c2 - c1) and not (c1 & c2)
                    if not run["container_restarted"]:
                        fault = "no container restart between the two turns (criteria 4.4)"
                run.update(attempt=attempt, invalid=fault, model_output_fails=model_fails, yielded=y, llm=lw, started=t0,
                           wall_s=round(t1 - t0, 1), stamp=ws.STAMP, tag=tag)
                ws.save_line(out, run)
                print("%s %-22s run %2d attempt %d: %s %.0f s" % (time.strftime("%H:%M:%S"), sid, k, attempt,
                                                                   "INVALID (%s)" % fault if fault else "ok", t1 - t0), flush=True)
                if not fault:
                    break
                time.sleep(65)            # a failed writer call pauses every student's writer for 60 s (criteria 4.3)
    print("done:", out, flush=True)


if __name__ == "__main__":
    main()
