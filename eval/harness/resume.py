"""Item 2b: does TAi's resume carry a conversation across turns, containers, restarts and its own 10-query cap?

The scripted model reports what it was shown on every request (message count, MARK-xxx markers seen in earlier turns, whether the
persona is in the system prompt), so "the student's earlier turn is replayed" is read off the request, not inferred from a model's
reply. Cases:
  RS1  a follow-up while the container is warm            (same container, next query: resume=<session>, resumeAt=<last uuid>)
  RS2  a message after the container has exited           (new container, resume=<session from the DB>)
  RS3  eight messages in one warm container, cap of 4    (the runner retires the session after TAI_MAX_TURNS_PER_SESSION answers: the next message
                                                           starts a fresh session; as shipped, MAX_QUERIES_PER_SESSION = 10 never fired)
  RS4  a message after the orchestrator restarted         (state comes back from SQLite)
  RS5  what the student sees when the model API fails     (400 prompt too long, 500, 529, 429): plain words, soon, and whether the session survives
"""
import re
import sys
import time

import tai
from tai import Chat, write_script

PAT = re.compile(r"HISTORY n_messages=(\d+) real_user_turns=(\d+) earlier_markers=(\S+) persona_in_system=(\w+)")


def parse(reply):
    m = PAT.search(reply.text or "")
    return (int(m.group(1)), int(m.group(2)), m.group(3), m.group(4) == "True") if m else None


def wait_exit(folder, timeout=90):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if not [c for c in tai.containers() if "nanoclaw-%s-" % folder in c]:
            return True
        time.sleep(1)
    return False


# fresh folders for every run: a reused one carries the session, the memories and the markers of earlier runs and quietly breaks a comparison
STAMP = time.strftime("%m%d%H%M")
F1, F3 = "rs1-" + STAMP, "rs3-" + STAMP
results = []


def rec(case, what, expected, observed, ok):
    results.append(dict(case=case, what=what, expected=expected, observed=observed, verdict="OK" if ok else "NOT AS EXPECTED"))
    print("%-5s %-8s %s | expected %s | observed %s" % (case, "OK" if ok else "DIFFERS", what, expected, observed))


def rs1_rs2_rs3_rs4(which):
    probe = write_script("probe", [], {"history": True})
    c = Chat(F1, name=F1)
    if "rs1" in which or "rs2" in which:
        r1 = c.ask("first MARK-alpha %s" % probe, timeout=180)
        s1 = tai.sessions().get(F1)
        r2 = c.ask("second MARK-beta %s" % probe, timeout=120)
        s2 = tai.sessions().get(F1)
        p1, p2 = parse(r1), parse(r2)
        rec("RS1a", "first message of a chat", "n_messages=1, no earlier markers, persona present", p1, bool(p1) and p1[0] == 1 and p1[2] == "none" and p1[3])
        rec("RS1b", "follow-up in the warm container", "earlier turn replayed (MARK-alpha, n_messages 3)", p2, bool(p2) and p2[0] == 3 and "MARK-alpha" in p2[2])
        print("      session id after msg 1: %s, after msg 2: %s (same: %s)" % (s1, s2, s1 == s2))
        gone = wait_exit(F1)
        r3 = c.ask("third MARK-gamma %s" % probe, timeout=180)
        p3 = parse(r3)
        s3 = tai.sessions().get(F1)
        rec("RS2", "message after the first container exited (new container, resume from the DB)", "alpha+beta replayed, n_messages 5",
            (p3, "container exited: %s" % gone), bool(p3) and p3[0] == 5 and "MARK-alpha" in p3[2] and "MARK-beta" in p3[2])
        print("      session id after the new container: %s (same as before: %s); cold reply took %.1f s" % (s3, s3 == s2, r3.seconds))
    if "rs4" in which:
        wait_exit(F1)
        tai.sh("bash %s/eval/host/remote/stack.sh orch restart" % tai.T, timeout=120)
        r4 = c.ask("fourth MARK-delta %s" % probe, timeout=180)
        p4 = parse(r4)
        rec("RS4", "message after the orchestrator restarted", "alpha, beta, gamma replayed (needs rs1+rs2 first)", p4,
            bool(p4) and all(k in p4[2] for k in ("MARK-alpha", "MARK-beta", "MARK-gamma")))
    if "rs3" in which:
        cap = 4
        tai.env_set("TAI_MAX_TURNS_PER_SESSION", cap)
        c3 = Chat(F3, name=F3)
        seen, ids = [], []
        for k in range(1, cap + 5):
            r = c3.ask("m%d MARK-m%d %s" % (k, k, probe), timeout=180, quiet=1.5)
            p = parse(r)
            seen.append((k, p[0] if p else None, len(p[2].split(",")) if p and p[2] != "none" else 0))
            time.sleep(1)
            ids.append(tai.sessions().get(F3))
        tai.env_set("TAI_MAX_TURNS_PER_SESSION", None)
        print("      (message number, n_messages, earlier markers) per message:", seen)
        print("      session id after each message:", [i[:8] if i else None for i in ids])
        reset_at = next((k for k, n, _m in seen if k > 1 and n == 1), None)
        # The answer that reaches the cap retires the session: pi tells the host at once (the id in the database is empty after message
        # `cap`), Claude Code when the next message arrives (the id is still the old one). Either way message cap+1 opens a new session.
        before, after = ids[:cap - 1], ids[cap:cap + 3]
        rec("RS3", "%d messages in one warm container, TAI_MAX_TURNS_PER_SESSION=%d" % (cap + 4, cap),
            "history grows until the cap, a fresh session at message %d (n_messages 1, a new id in the database) and that message is answered" % (cap + 1),
            "fresh session at message %s; ids: the first %d messages one id: %s, messages %d-%d a new one, stable: %s (id after message %d: %s)" % (
                reset_at, cap - 1, len(set(before)) == 1, cap + 1, cap + 3, len(set(after)) == 1 and after[0] != before[0], cap, "cleared" if ids[cap - 1] is None else "kept"),
            reset_at == cap + 1 and len(set(before)) == 1 and len(set(after)) == 1 and after[0] is not None and after[0] != before[0])
        summary = tai.get(F3, "competency/interaction-summary.md") or ""
        ours = [l for l in summary.splitlines() if l.startswith("- ")]
        rec("RS3b", "the runner's interaction summary after %d answers" % (cap + 4), "one line per answer, in competency/interaction-summary.md, with what the student said",
            "%d lines; first: %r" % (len(ours), (ours[0] if ours else "")[:110]), len(ours) == cap + 4 and "MARK-m1" in (ours[0] if ours else ""))


def rs5(budget=420):
    import threading
    cases = [("err400", {"status": 400, "type": "invalid_request_error", "message": "prompt is too long: 250000 tokens > 200000 maximum"}),
             ("err500", {"status": 500, "type": "api_error", "message": "Internal server error"}),
             ("err529", {"status": 529, "type": "overloaded_error", "message": "Overloaded"}),
             ("err429", {"status": 429, "type": "rate_limit_error", "message": "Tokens per minute limit exceeded"})]
    for name, err in cases:
        write_script(name, [{"error": err}])
    probe = write_script("probe", [], {"history": True})
    out, session = {}, {}

    def one(name):
        folder = "rs5%s-%s" % (name[3:], STAMP)
        ch = Chat(folder, name=name)
        ch.ask("hello %s" % probe, timeout=180)           # a first answer, so the chat has a session to keep or to clear
        session[name] = tai.sessions().get(folder)
        ch.send("please MOCK:%s" % name)
        out[name] = ch.wait(timeout=budget, quiet=2)

    ts = [threading.Thread(target=one, args=(n,)) for n, _e in cases]
    [t.start() for t in ts]
    [t.join() for t in ts]
    for name, _e in cases:
        r = out[name]
        folder = "rs5%s-%s" % (name[3:], STAMP)
        after = tai.sessions().get(folder)
        overflow = name == "err400"
        words = "cleared my context" if overflow else "give me a minute"
        rec("RS5", "model API answers %s" % name,
            "a plain-words answer within 60 s (%r), the session %s" % (words, "cleared (the context overflowed)" if overflow else "kept"),
            "after %.0f s: %r; session before %s, after %s" % (r.seconds, (r.text or "(nothing)")[:140], (session[name] or "-")[:8], (after or "-")[:8]),
            bool(r.text) and r.seconds < 60 and words in r.text and "API Error" not in r.text and "Prompt is too long" not in r.text
            and ((after is None) if overflow else (after == session[name] and after is not None)))
    tai.sh("docker ps -aq --filter name=nanoclaw-rs5 | xargs -r docker rm -f")


def main():
    which = [a.lower() for a in sys.argv[1:]] or ["rs1", "rs2", "rs3", "rs4", "rs5"]
    print(tai.orch_env(IDLE_TIMEOUT=15000, LOG_LEVEL="debug", MAX_CONCURRENT_CONTAINERS=5, **tai.EVAL_IMAGE))
    tai.backend("mock")
    rs1_rs2_rs3_rs4(which)
    if "rs5" in which:
        rs5()
    print("saved:", tai.save("resume", results))


if __name__ == "__main__":
    main()
