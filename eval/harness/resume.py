"""Item 2b: does TAi's resume carry a conversation across turns, containers, restarts and its own 10-query cap?

The scripted model reports what it was shown on every request (message count, MARK-xxx markers seen in earlier turns, whether the
persona is in the system prompt), so "the student's earlier turn is replayed" is read off the request, not inferred from a model's
reply. Cases:
  RS1  a follow-up while the container is warm            (same container, next query: resume=<session>, resumeAt=<last uuid>)
  RS2  a message after the container has exited           (new container, resume=<session from the DB>)
  RS3  twelve messages in one warm container              (TAi starts a fresh session on its 11th query: MAX_QUERIES_PER_SESSION)
  RS4  a message after the orchestrator restarted         (state comes back from SQLite)
  RS5  what the student sees when the model API fails     (400 prompt too long, 500, 529, 429), and how long the container is stuck
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


results = []


def rec(case, what, expected, observed, ok):
    results.append(dict(case=case, what=what, expected=expected, observed=observed, verdict="OK" if ok else "NOT AS EXPECTED"))
    print("%-5s %-8s %s | expected %s | observed %s" % (case, "OK" if ok else "DIFFERS", what, expected, observed))


def rs1_rs2_rs3_rs4(which):
    probe = write_script("probe", [], {"history": True})
    c = Chat("rs1", name="rs1")
    if "rs1" in which or "rs2" in which:
        r1 = c.ask("first MARK-alpha %s" % probe, timeout=180)
        s1 = tai.sessions().get("rs1")
        r2 = c.ask("second MARK-beta %s" % probe, timeout=120)
        s2 = tai.sessions().get("rs1")
        p1, p2 = parse(r1), parse(r2)
        rec("RS1a", "first message of a chat", "n_messages=1, no earlier markers, persona present", p1, bool(p1) and p1[0] == 1 and p1[2] == "none" and p1[3])
        rec("RS1b", "follow-up in the warm container", "earlier turn replayed (MARK-alpha, n_messages 3)", p2, bool(p2) and p2[0] == 3 and "MARK-alpha" in p2[2])
        print("      session id after msg 1: %s, after msg 2: %s (same: %s)" % (s1, s2, s1 == s2))
        gone = wait_exit("rs1")
        r3 = c.ask("third MARK-gamma %s" % probe, timeout=180)
        p3 = parse(r3)
        s3 = tai.sessions().get("rs1")
        rec("RS2", "message after the first container exited (new container, resume from the DB)", "alpha+beta replayed, n_messages 5",
            (p3, "container exited: %s" % gone), bool(p3) and p3[0] == 5 and "MARK-alpha" in p3[2] and "MARK-beta" in p3[2])
        print("      session id after the new container: %s (same as before: %s); cold reply took %.1f s" % (s3, s3 == s2, r3.seconds))
    if "rs4" in which:
        wait_exit("rs1")
        tai.sh("bash %s/eval/host/remote/stack.sh orch restart" % tai.T, timeout=120)
        r4 = c.ask("fourth MARK-delta %s" % probe, timeout=180)
        p4 = parse(r4)
        rec("RS4", "message after the orchestrator restarted", "alpha, beta, gamma replayed (needs rs1+rs2 first)", p4,
            bool(p4) and all(k in p4[2] for k in ("MARK-alpha", "MARK-beta", "MARK-gamma")))
    if "rs3" in which:
        c3 = Chat("rs3", name="rs3")
        seen = []
        for k in range(1, 13):
            r = c3.ask("m%d MARK-m%d %s" % (k, k, probe), timeout=180, quiet=1.5)
            p = parse(r)
            seen.append((k, p[0] if p else None, len(p[2].split(",")) if p and p[2] != "none" else 0))
        print("      (message number, n_messages, earlier markers) per message:", seen)
        reset_at = next((k for k, n, _m in seen if k > 1 and n == 1), None)
        rec("RS3", "twelve messages in one warm container", "history grows until TAi's 10-query cap, then a fresh session at message 11",
            "fresh session at message %s" % reset_at, reset_at == 11)


def rs5(budget=420):
    import threading
    cases = [("err400", {"status": 400, "type": "invalid_request_error", "message": "prompt is too long: 250000 tokens > 200000 maximum"}),
             ("err500", {"status": 500, "type": "api_error", "message": "Internal server error"}),
             ("err529", {"status": 529, "type": "overloaded_error", "message": "Overloaded"}),
             ("err429", {"status": 429, "type": "rate_limit_error", "message": "Tokens per minute limit exceeded"})]
    for name, err in cases:
        write_script(name, [{"error": err}])
    out = {}

    def one(name):
        ch = Chat("rs5" + name[3:], name=name)
        ch.send("please MOCK:%s" % name)
        out[name] = ch.wait(timeout=budget, quiet=2)

    ts = [threading.Thread(target=one, args=(n,)) for n, _e in cases]
    [t.start() for t in ts]
    [t.join() for t in ts]
    for name, _e in cases:
        r = out[name]
        stuck = [c for c in tai.containers() if "nanoclaw-rs5%s-" % name[3:] in c]
        rec("RS5", "model API answers %s" % name, "a human-readable apology, soon, and the slot freed",
            "after %.0f s: %r; container still running: %s" % (r.seconds, (r.text or "(nothing)")[:140], bool(stuck)),
            bool(r.text) and r.seconds < 60 and "API Error" not in r.text and "Prompt is too long" not in r.text and not stuck)
    tai.sh("docker ps -aq --filter name=nanoclaw-rs5 | xargs -r docker rm -f")


def main():
    which = [a.lower() for a in sys.argv[1:]] or ["rs1", "rs2", "rs3", "rs4", "rs5"]
    print(tai.orch_env(IDLE_TIMEOUT=15000, LOG_LEVEL="debug", MAX_CONCURRENT_CONTAINERS=5))
    tai.backend("mock")
    rs1_rs2_rs3_rs4(which)
    if "rs5" in which:
        rs5()
    print("saved:", tai.save("resume", results))


if __name__ == "__main__":
    main()
