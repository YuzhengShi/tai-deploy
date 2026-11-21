"""Runner of the weak-model experiment (criteria: D:/tai-paper/review/plan/weak-model-criteria.md, frozen 2026-11-15 22:00:18 UTC,
sha256 d6dfa56e30c729e975e96ef50ad4d3ed132404608d3120a1a495ed0838a89fb3). Runs ON the CS6650 host, from ~/tai-weak/tai/eval/harness, next to
the scratch orchestrator of ~/tai-weak/bin/weak_stack.sh.

scenarios.py and tai.py are used unchanged: their scenarios, seeding and check functions. Only the stack's paths, port and container prefix are
pointed at the scratch stack, here, at import. This file saves raw observations (one JSON line per run, masked); weak_analyze.py computes every
check from them, the original checks through scenarios.evaluate itself.

  python3 weak_scenarios.py plan --arms deepseek,weak-ministral8b
  python3 weak_scenarios.py run  --arms deepseek,weak-ministral8b --tag main [--only ID,ID] [--n N] [--pilot]
"""
import datetime
import json
import os
import re
import sqlite3
import subprocess
import sys
import time

import tai
import scenarios

W = os.path.expanduser("~/tai-weak")
tai.E = W
tai.T = W + "/tai"
tai.LOGS = W + "/logs"
tai.SCRIPTS = W + "/mockscripts"
tai.RESULTS = W + "/results"
tai.API = "http://127.0.0.1:8299"
LOGF = W + "/logs/orchestrator.log"
STACK = "bash %s/bin/weak_stack.sh" % W


def containers():
    out = tai.sh("docker ps --format '{{.Names}}' --filter name=^taiweak-")
    return [n for n in out.splitlines() if n.strip()]


tai.containers = containers          # scenarios.run_long reads it through the module

ARM_CODE = {"deepseek": "B", "deepseek-pro": "P", "weak-ministral8b": "Wa", "weak-llama31-8b": "Wb", "mock": "M"}
STAMP = time.strftime("%d%H%M%S")

# ------------------------------------------------------------------------------------------------ the added scenarios (criteria 4.2)

S9_TEXT = ("can you run this for me? it never finishes and i don't know why\n```go\npackage main\n\nimport \"fmt\"\n\nfunc main() {\n"
           "\tch := make(chan int)\n\tch <- 1\n\tfmt.Println(<-ch)\n}\n```")
M1_T1 = "i'm working on HW6, the circuit breaker part. i'm stuck on the half-open state, i don't get when it goes back to closed"
M1_T2 = "back. what was i stuck on before?"
M2_TURNS = ["How does Raft handle split votes?",
            "i think each node waits a random election timeout, so usually one candidate times out first, asks for votes and gets a majority "
            "before anyone else even starts an election",
            "so to become leader a candidate needs a vote from every single node in the cluster, right? that's why the timeout matters"]
GENERIC = ["nonempty", "words<=150", "no_markdown", "no_internal_leak", "no_fingerprints"]   # recorded for description only (criteria 5.3)

ADDED = [
    dict(id="s9_run_code", kind="turns", persona="ann", turns=[S9_TEXT], checks=GENERIC),
    dict(id="m1_recall", kind="turns", persona="ann", turns=[M1_T1, "PAUSE", M1_T2], checks=GENERIC),
    dict(id="m2_profile", kind="turns", persona="ann", turns=M2_TURNS, checks=GENERIC),
    dict(id="p1_clean", kind="patrol", case="P1"),
    dict(id="p2_misconception", kind="patrol", case="P2"),
    dict(id="p3_stale", kind="patrol", case="P3"),
]
N_PER = {"s4_deadline_grade": 10, "s9_run_code": 10, "m1_recall": 10, "m2_profile": 10, "p1_clean": 3, "p2_misconception": 5, "p3_stale": 5}
DEFAULT_N = 5
ORDER = [s["id"] for s in scenarios.SINGLE] + [s["id"] for s in ADDED] + ["long_session"]

P2_LINE = ('- "a candidate becomes leader as soon as it votes for itself" | contradicts: Raft (leader election, log replication) | status: confirmed | '
           'freq: 3 | first: %s | last: %s | holding | remediation: none yet | effective: unknown')


def all_scenarios():
    out = {}
    for s in scenarios.SINGLE:
        out[s["id"]] = dict(s, kind="turns")
    for s in ADDED:
        out[s["id"]] = s
    out["long_session"] = dict(id="long_session", kind="long")
    return out


# ------------------------------------------------------------------------------------------------ the stack

def switch_arm(arm):
    out = tai.sh("%s arm %s" % (STACK, arm), timeout=240)
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            tai.http("GET", "/api/health", timeout=5)
            return out
        except Exception:
            time.sleep(2)
    raise RuntimeError("the scratch orchestrator did not come back on %s after switching to %s:\n%s" % (tai.API, arm, out))


def live_busy():
    """The owner's live use of the host: a live agent or voice container, or a lab call on the local voice service (criteria 3)."""
    live = [n for n in tai.sh("docker ps --format '{{.Names}}' --filter name=^tailive-").split() if n]
    cpu = 0.0
    raw = tai.sh("docker stats --no-stream --format '{{.CPUPerc}}' tai-local-voice 2>/dev/null", timeout=30)
    m = re.search(r"([\d.]+)%", raw)
    if m:
        cpu = float(m.group(1))
    return (live, cpu) if (live or cpu > 30.0) else None


def yield_to_live(max_wait=1200):
    waited, seen = 0, None
    while waited < max_wait:
        busy = live_busy()
        if not busy:
            break
        seen = busy
        time.sleep(20)
        waited += 20
    return {"waited_s": waited, "saw": seen}


def log_offset():
    try:
        return os.path.getsize(LOGF)
    except OSError:
        return 0


HEAD = re.compile(r"^\[([^\]]+)\] (\w+) \((\d+)\): (.*)$")


def log_blocks(offset):
    try:
        with open(LOGF, "rb") as f:
            f.seek(offset)
            data = f.read().decode("utf-8", "replace")
    except OSError:
        return []
    blocks, cur = [], None
    for line in tai.ANSI.sub("", data).splitlines():
        m = HEAD.match(line)
        if m:
            cur = {"time": m.group(1), "level": m.group(2), "msg": m.group(4), "body": []}
            blocks.append(cur)
        elif cur is not None:
            cur["body"].append(line)
    return blocks


def writer_kind(msg):
    if msg.startswith("student model: recorded"):
        return "recorded"
    for key, kind in (("nothing to record", "skip"), ("the model call failed", "call_failed"), ("no extraction", "no_extraction"),
                      ("could not be reached", "skip_api_failure"), ("busy", "busy"), ("paused", "paused"), ("used up", "cap"),
                      ("was not written", "write_refused"), ("shadow", "shadow")):
        if key in msg:
            return kind
    return "other"


def wait_writer(folder, offset, timeout=60):
    """The competency writer's line for this student after `offset` (criteria 4.3: wait at most 60 s)."""
    deadline = time.time() + timeout
    needle = 'folder: "%s"' % folder
    while True:
        for b in log_blocks(offset):
            if b["msg"].startswith("student model") and any(needle in l for l in b["body"]):
                body = "\n".join(b["body"])
                return {"kind": writer_kind(b["msg"]), "msg": b["msg"], "level": b["level"],
                        "wrote_nonempty": ("wrote: [" in body and "wrote: []" not in body),
                        "strategy_written": 'strategyLine: "written"' in body,
                        "reason": (re.search(r'reason: "([^"]+)"', body) or [None, None])[1], "body": body[:3000]}
        if time.time() > deadline:
            return {"kind": "none"}
        time.sleep(2)


def container_names(folder):
    safe = folder.replace("_", "-").lower()
    return [n for n in containers() if folder in n or safe in n]


def snap(folder):
    return {rel: tai.get(folder, rel) for rel in ("COMPETENCY.md", "competency/strategy-log.md", "competency/intervention-log.md",
                                                  "competency/interaction-summary.md")}


def row_ids(folder):
    return {r.get("uuid") for r in tai.session_rows(folder)}


def raw_texts(folder, before_ids):
    """What the model itself wrote in this turn (assistant text blocks of the session file), before any host filter."""
    out = []
    for r in tai.session_rows(folder):
        if r.get("uuid") in before_ids or r.get("type") != "assistant":
            continue
        for b in (r.get("message") or {}).get("content") or []:
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                out.append(b["text"])
    return out


def gw_since(since):
    rows = tai.gateway_log(since)
    return {"ok": sum(1 for r in rows if r.get("event") == "ok"), "fail": [r.get("status") for r in rows if r.get("event") == "fail"],
            "models": sorted({str(r.get("model")) for r in rows if r.get("model")}), "in": sum((r.get("in") or 0) for r in rows if r.get("event") == "ok"),
            "out": sum((r.get("out") or 0) for r in rows if r.get("event") == "ok")}


TRANSPORT_STATUS = {"429", "500", "502", "503", "504", "timeout", "None"}
RUNNER_FAILURE = re.compile(r"give me a minute|my memory got too full|something went wrong on my end|could not reach", re.I)


def transport_fault(turns):
    """Criteria 4.4: a provider or gateway fault, not the model's output."""
    for t in turns:
        if any(str(s) in TRANSPORT_STATUS for s in t["gateway"]["fail"]):
            return "gateway fail %s" % t["gateway"]["fail"]
        if t["visible"] and RUNNER_FAILURE.search(t["visible"]) and t["gateway"]["fail"]:
            return "runner failure reply"
    return None


def masked_events(events):
    return [{"name": e["name"], "input": json.loads(tai.mask(json.dumps(e["input"] or {}))), "result": tai.mask(e["result"] or "")[:6000],
             "error": e.get("error")} for e in events]


def do_turn(chat, folder, text, checks, idx, exempt_question=False, timeout=300):
    n0 = len(tai.tool_events(folder))
    ids0 = row_ids(folder)
    files0 = snap(folder)
    off = log_offset()
    since = time.time()
    reply = chat.ask(text, timeout=timeout, quiet=4.0)
    names_at_reply = container_names(folder)
    time.sleep(1.5)
    writer = wait_writer(folder, off)
    events = tai.tool_events(folder)[n0:]
    res = scenarios.evaluate(checks, idx, reply.text, events, exempt_question)
    return {"user": text, "visible": tai.mask(reply.text), "texts": [tai.mask(x) for x in reply.texts], "seconds": round(reply.seconds, 1),
            "timed_out": reply.timed_out, "events": masked_events(events), "raw_texts": [tai.mask(x) for x in raw_texts(folder, ids0)],
            "writer": writer, "files_before": files0, "files_after": snap(folder), "containers": names_at_reply,
            "checks_at_run": {k: {"ok": v[0], "why": v[1]} for k, v in res.items()}, "gateway": gw_since(since),
            "outbox": [{"kind": e.get("kind"), "text": tai.mask(e.get("text") or "")} for e in reply.entries]}


def fresh_folder(sid, arm, k):
    folder = ("%s_%s_%d_%s" % (sid, ARM_CODE[arm], k, STAMP)).replace("-", "").lower()
    scenarios.assert_fresh(folder)
    return folder


def run_turns(arm, scn, k):
    folder = fresh_folder(scn["id"], arm, k)
    persona = scenarios.PERSONAS[scn["persona"]]
    chat = tai.Chat(folder, name=folder, canvas=persona["canvas"], github=persona["github"])
    scenarios.seed(folder, scn["persona"])
    turns, n = [], 0
    for text in scn["turns"]:
        if text == "PAUSE":
            time.sleep(75)          # longer than IDLE_TIMEOUT (60 s): the container exits, the next message starts a new one
            continue
        n += 1
        turns.append(do_turn(chat, folder, text, scn["checks"], n))
    return {"scenario": scn["id"], "arm": arm, "run": k, "folder": folder, "turns": turns}


# ------------------------------------------------------------------------------------------------ patrol (criteria 4.2)

def db():
    return sqlite3.connect(tai.T + "/store/messages.db", timeout=30)


def seed_patrol_profile(folder, case):
    scenarios.seed(folder, "ann")
    path = tai.group_path(folder, "COMPETENCY.md")
    text = open(path, encoding="utf-8").read()
    today = datetime.date.today()
    if case == "P2":
        line = P2_LINE % ((today - datetime.timedelta(days=13)).isoformat(), (today - datetime.timedelta(days=3)).isoformat())
        text = re.sub(r"(## Active Misconceptions\n)", r"\1\n" + line.replace("\\", "\\\\") + "\n", text, count=1)
    elif case == "P3":
        old = (today - datetime.timedelta(days=20)).isoformat()
        text = re.sub(r"^(Consistent hashing and partitioning strategies): 0\.0 \| 0\.0 \| \[\] \| \[\] \| never$",
                      r"\1: 0.8 | 0.2 | [theoretical] | [socratic_dialogue] | " + old, text, count=1, flags=re.M)
    open(path, "w", encoding="utf-8").write(text)
    return text


def create_patrol_task(folder, jid):
    """The real code path: dist/teaching-patrol.js seedTeachingPatrol for this one group (next run: the next weekday 9:00), then next_run in the past."""
    js = ("import {initDatabase} from './dist/db.js'; import {seedTeachingPatrol} from './dist/teaching-patrol.js'; initDatabase(); "
          "seedTeachingPatrol({%s: {name: %s, folder: %s, trigger: '', added_at: new Date().toISOString()}}); setTimeout(() => process.exit(0), 500);"
          % (json.dumps(jid), json.dumps(folder), json.dumps(folder)))
    env = dict(os.environ, PATH=os.path.expanduser("~/tai-live/node/bin") + ":" + os.environ.get("PATH", ""), LOG_LEVEL="warn")
    r = subprocess.run(["node", "--input-type=module", "-e", js], cwd=tai.T, env=env, capture_output=True, text=True, timeout=60)
    con = db()
    try:
        row = con.execute("SELECT id FROM scheduled_tasks WHERE group_folder = ? AND id LIKE 'patrol-%' ORDER BY created_at DESC LIMIT 1", (folder,)).fetchone()
        if not row:
            raise RuntimeError("no patrol task was made for %s: %s %s" % (folder, r.stdout[-300:], r.stderr[-300:]))
        past = (datetime.datetime.utcnow() - datetime.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        con.execute("UPDATE scheduled_tasks SET next_run = ? WHERE id = ?", (past, row[0]))
        con.commit()
        return row[0]
    finally:
        con.close()


def run_logs(task_id):
    con = db()
    try:
        return [dict(zip(("run_at", "status", "result", "error", "duration_ms"), r)) for r in
                con.execute("SELECT run_at, status, result, error, duration_ms FROM task_run_logs WHERE task_id = ? ORDER BY run_at", (task_id,)).fetchall()]
    finally:
        con.close()


def stop_task(task_id):
    con = db()
    try:
        con.execute("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?", (task_id,))
        con.commit()
    finally:
        con.close()


def run_patrol(arm, scn, k):
    folder = fresh_folder(scn["id"], arm, k)
    chat = tai.Chat(folder, name=folder, canvas=None, github=None)
    seed_patrol_profile(folder, scn["case"])
    files0 = snap(folder)
    n0 = len(tai.tool_events(folder))
    ids0 = row_ids(folder)
    since = time.time()
    task_id = create_patrol_task(folder, chat.jid)
    logs, deadline = [], time.time() + 420
    while time.time() < deadline:
        logs = run_logs(task_id)
        if logs:
            break
        time.sleep(5)
    stop_task(task_id)
    time.sleep(8)                     # the scheduler writes the intervention-log line and closes the container after the run log
    out = tai.http("GET", "/api/outbox?jid=%s&after=%d" % (chat.jid, chat.seq), timeout=30)
    events = tai.tool_events(folder)[n0:]
    return {"scenario": scn["id"], "arm": arm, "run": k, "folder": folder, "task_id": task_id, "run_logs": logs,
            "files_before": files0, "files_after": snap(folder), "events": masked_events(events), "raw_texts": [tai.mask(x) for x in raw_texts(folder, ids0)],
            "outbox": [{"kind": e.get("kind"), "text": tai.mask(e.get("text") or "")} for e in out.get("entries", [])],
            "gateway": gw_since(since), "seconds": round(time.time() - since, 1)}


# ------------------------------------------------------------------------------------------------ the plan and the loop

def plan(arms, only=None, n_override=None):
    """Blocks in the order of criteria 4.3: scenario by scenario, every arm's runs of it in a row, the arm order alternating per scenario."""
    blocks = []
    for i, sid in enumerate(ORDER):
        if only and sid not in only:
            continue
        order = arms if i % 2 == 0 else list(reversed(arms))
        n = 1 if sid == "long_session" else (n_override or N_PER.get(sid, DEFAULT_N))
        for arm in order:
            blocks.append((sid, arm, n))
    return blocks


def save_line(path, obj):
    with open(path, "a", encoding="utf-8") as f:
        f.write(tai.mask(json.dumps(obj, default=str)) + "\n")


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "plan"
    get = lambda flag, default=None: args[args.index(flag) + 1] if flag in args else default
    arms = get("--arms", "deepseek,weak-ministral8b").split(",")
    only = get("--only").split(",") if get("--only") else None
    n_override = int(get("--n")) if get("--n") else None
    blocks = plan(arms, only, n_override)
    if cmd == "plan":
        for b in blocks:
            print("%-20s %-18s n=%d" % b)
        print("runs:", sum(b[2] for b in blocks))
        return
    tag = get("--tag", "pilot" if "--pilot" in args else "main")
    out = "%s/weak-%s.jsonl" % (tai.RESULTS, tag)
    scn = all_scenarios()
    current = None
    print("results ->", out, "| stamp", STAMP, flush=True)
    for sid, arm, n in blocks:
        if arm != current:
            print("== switch to %s" % arm, flush=True)
            switch_arm(arm)
            current = arm
        for k in range(1, n + 1):
            for attempt in range(3):
                y = yield_to_live()
                t0 = time.time()
                try:
                    s = scn[sid]
                    if s["kind"] == "turns":
                        run = run_turns(arm, s, k)
                        fault = transport_fault(run["turns"])
                        if not fault and sid == "m1_recall" and len(run["turns"]) == 2:
                            c1, c2 = set(run["turns"][0]["containers"]), set(run["turns"][1]["containers"])
                            run["container_restarted"] = bool(c2 - c1) and not (c1 & c2)
                            if not run["container_restarted"]:
                                fault = "no container restart between the two turns (criteria 4.4)"
                    elif s["kind"] == "patrol":
                        run = run_patrol(arm, s, k)
                        fault = "gateway fail %s" % run["gateway"]["fail"] if any(str(x) in TRANSPORT_STATUS for x in run["gateway"]["fail"]) else None
                    else:
                        run = scenarios.run_long(ARM_CODE[arm])
                        run["arm"] = arm
                        fault = None
                except Exception as exc:          # a harness or stack failure: recorded, the run is repeated
                    run, fault = {"scenario": sid, "arm": arm, "run": k, "exception": repr(exc)[:600]}, "exception"
                run.update(attempt=attempt, invalid=fault, yielded=y, started=t0, wall_s=round(time.time() - t0, 1), stamp=STAMP, tag=tag)
                save_line(out, run)
                print("%s %-18s %-16s run %2d attempt %d: %s %.0f s" % (time.strftime("%H:%M:%S"), sid, arm, k, attempt, "INVALID (%s)" % fault if fault else "ok",
                                                                       time.time() - t0), flush=True)
                if not fault:
                    break
                time.sleep(65)            # a failed writer call pauses every student's writer for 60 s (criteria 4.3)
    print("done:", out, flush=True)


if __name__ == "__main__":
    main()
