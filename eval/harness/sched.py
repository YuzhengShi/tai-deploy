"""Item 3: TAi's own scheduling, measured through the real orchestrator with a scripted model.

TAi runs one agent container per ACTIVE student (not per message): the container answers, then stays warm for IDLE_TIMEOUT
(30 min by default) so follow-ups are piped in over stdin, and the orchestrator allows MAX_CONCURRENT_CONTAINERS (5) at once.
  SC1  cold start versus warm follow-up latency, and where the cold start goes (docker + tsc + node, Claude Code + MCP, the model)
  SC2  eight students at once: the cap, what the 6th-8th wait for, memory per container (docker stats)
  SC3  a message that arrives while the container is busy (piped into the running query)
  SC4  a container killed mid-answer (retry, cursor rollback, what the student sees)
  SC5  containers stuck on rate limits (429 forever): do they hold their slots and starve others?
"""
import re
import sys
import threading
import time

import tai
from tai import Chat, write_script

results = []


def rec(case, what, observed):
    results.append(dict(case=case, what=what, observed=observed))
    print("%-4s %s\n       %s" % (case, what, observed))


TS = re.compile(r"^\[(\d\d):(\d\d):(\d\d)\.(\d\d\d)\]")


def secs(line):
    m = TS.match(line)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000 if m else None


def wait_exit(folder, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if not [c for c in tai.containers() if "nanoclaw-%s-" % folder in c]:
            return True
        time.sleep(1)
    return False


def phases(folder, since_len):
    """Milestones of the latest cold start of a folder from the orchestrator's debug log (seconds from the spawn)."""
    lines = tai.orchestrator_log()[since_len:]
    marks = {}
    for i, line in enumerate(lines):
        t = secs(line)
        if t is None:
            continue
        ctx = " ".join(lines[i:i + 4])
        if "Spawning container agent" in line and folder in ctx:
            marks.setdefault("spawn", t)
        elif "Received input for group: " + folder in line or ("Received input for group" in line and folder in ctx):
            marks.setdefault("runner", t)
        elif "Session initialized" in line:
            marks.setdefault("init", t)
        elif "Agent output" in line and folder in ctx:
            marks.setdefault("answer", t)
    if "spawn" not in marks:
        return {}
    base = marks["spawn"]
    return {k: round(v - base, 2) for k, v in marks.items()}


def sc1():
    c = Chat("sc1", name="sc1")
    probe = write_script("probe", [], {"history": True})
    cold, warm, breakdown = [], [], []
    for cycle in range(3):
        n0 = len(tai.orchestrator_log())
        r = c.ask("cold %d %s" % (cycle, probe), timeout=180, quiet=1.0)
        cold.append(round(r.seconds, 1))
        breakdown.append(phases("sc1", n0))
        r = c.ask("warm %d %s" % (cycle, probe), timeout=120, quiet=1.0)
        warm.append(round(r.seconds, 1))
        wait_exit("sc1")
    rec("SC1", "latency from send to the first reply, scripted model (no model time)", "cold start %s s; warm follow-up %s s" % (cold, warm))
    rec("SC1", "where a cold start goes (seconds after the container was spawned: runner started / Claude Code initialised / answered)",
        str(breakdown))


def sc2():
    sleeper = write_script("sleep25", [], {"text": "slept", "sleep": 25})
    names = ["sc2%s" % ch for ch in "abcdefgh"]
    chats = [Chat(n, name=n) for n in names]
    peak, samples, stop = [0], [], threading.Event()

    def sampler():
        t0 = time.time()
        last_stats = 0
        while not stop.is_set():
            cs = tai.containers()
            peak[0] = max(peak[0], len(cs))
            if time.time() - last_stats > 3 and cs:
                last_stats = time.time()
                out = tai.sh("docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' %s" % " ".join(cs), timeout=30)
                samples.append((round(time.time() - t0, 1), len(cs), out))
            time.sleep(0.5)

    th = threading.Thread(target=sampler)
    th.start()
    t0 = time.time()
    got = {}

    def go(ch):
        ch.send("sleep please %s" % sleeper)
        r = ch.wait(timeout=420, quiet=1.0)
        got[ch.folder] = round(time.time() - t0, 1) if not r.timed_out else None

    ts = [threading.Thread(target=go, args=(ch,)) for ch in chats]
    [t.start() for t in ts]
    [t.join() for t in ts]
    stop.set()
    th.join()
    order = sorted(got.items(), key=lambda kv: (kv[1] is None, kv[1]))
    rec("SC2", "eight students send a 25 s task at once; cap 5, IDLE_TIMEOUT 20 s", "max containers at once: %d; reply times in order: %s" % (peak[0], order))
    mems = []
    for _t, _n, out in samples:
        for line in out.splitlines():
            m = re.search(r"(\S+) ([\d.]+)(MiB|GiB) / ", line)
            if m:
                mems.append(float(m.group(2)) * (1024 if m.group(3) == "GiB" else 1))
    rec("SC2", "memory of the agent containers sampled while they ran (docker stats)",
        "n=%d samples, median %.0f MiB, max %.0f MiB per container (limit 2 GiB each)" % (len(mems), sorted(mems)[len(mems) // 2] if mems else 0, max(mems) if mems else 0))
    rec("SC2", "one docker stats sample with the most containers", max(samples, key=lambda s: s[1])[2].replace("\n", " | ") if samples else "none")


def sc3():
    c = Chat("sc3", name="sc3")
    slow = write_script("sleep20", [], {"text": "slow answer", "sleep": 20})
    probe = write_script("probe", [], {"history": True})
    n0 = len(tai.orchestrator_log())
    t0 = time.time()
    c.send("A MARK-A %s" % slow)
    while time.time() - t0 < 60 and not [n for n in tai.containers() if "nanoclaw-sc3-" in n]:
        time.sleep(0.5)
    time.sleep(14)                       # the container is up and the scripted model is holding A's request: send B now
    t_b = time.time() - t0
    c.send("B MARK-B %s" % probe)
    first = c.wait(timeout=150, quiet=1.0)
    t_first = time.time() - t0
    second = c.wait(timeout=150, quiet=1.0)
    t_second = time.time() - t0
    log = [l for l in tai.orchestrator_log()[n0:] if "Piped messages" in l or "Starting container" in l or "Piping stdin" in l]
    rec("SC3", "B is sent %.0f s after A, while A's 20 s model call is in flight" % t_b,
        "reply 1 at %.0f s: %r; reply 2 at %.0f s: %r; orchestrator: %s" % (t_first, first.text[:60], t_second, second.text[:110], [l[:100] for l in log[-5:]]))


def sc4():
    c = Chat("sc4", name="sc4")
    slow = write_script("sleep30", [], {"text": "finally answered", "sleep": 30})
    c.send("kill me %s" % slow)
    t0 = time.time()
    victim = None
    while time.time() - t0 < 40 and not victim:
        victim = next((n for n in tai.containers() if "nanoclaw-sc4-" in n), None)
        time.sleep(0.5)
    time.sleep(6)
    killed_at = time.time() - t0
    tai.sh("docker kill %s" % victim)
    timeline = []
    seen = 0
    while time.time() - t0 < 140:
        res = tai.http("GET", "/api/outbox?jid=%s&after=%d&wait=3" % (c.jid, c.seq), timeout=20)
        for e in res["entries"]:
            c.seq = max(c.seq, e["seq"])
            if e["kind"] == "text":
                timeline.append((round(time.time() - t0, 1), e["text"][:90]))
        if any("finally answered" in t for _s, t in timeline):
            break
    rec("SC4", "container killed 6 s into a 30 s answer", "killed at %.0f s; what the student received: %s" % (killed_at, timeline or "nothing"))


def sc5():
    print(tai.orch_env(IDLE_TIMEOUT=20000, LOG_LEVEL="debug", MAX_CONCURRENT_CONTAINERS=2))
    tai.backend("mock")
    stuck = write_script("err429", [{"error": {"status": 429, "type": "rate_limit_error", "message": "Tokens per minute limit exceeded"}}])
    probe = write_script("probe", [], {"history": True})
    a, b, c = Chat("sc5a", name="a"), Chat("sc5b", name="b"), Chat("sc5c", name="c")
    t0 = time.time()
    a.send("x %s" % stuck)
    b.send("x %s" % stuck)
    time.sleep(8)
    c.send("a normal question %s" % probe)
    r = c.wait(timeout=170, quiet=1.0)
    alive = [n for n in tai.containers()]
    rec("SC5", "two containers retrying 429s, cap 2, then a third student asks a normal question",
        "third student's reply after %.0f s: %r; timed out: %s; containers running at that point: %s" % (
            time.time() - t0, r.text[:80], r.timed_out, [n.rsplit("-", 1)[0] for n in alive]))
    texts = [(n, tai.http("GET", "/api/outbox?jid=web:%s&after=0" % n)["entries"]) for n in ("sc5a", "sc5b")]
    rec("SC5", "what the two stuck students were told meanwhile", str([(n, [e.get("text", "")[:60] for e in es if e["kind"] == "text"]) for n, es in texts]))
    tai.sh("docker ps -aq --filter name=nanoclaw-sc5 | xargs -r docker rm -f")


def sc6():
    print(tai.orch_env(IDLE_TIMEOUT=5000, CONTAINER_TIMEOUT=10000, LOG_LEVEL="debug", MAX_CONCURRENT_CONTAINERS=5))
    tai.backend("mock")
    hang = write_script("sleep300", [], {"text": "never", "sleep": 300})
    c = Chat("sc6", name="sc6")
    n0 = len(tai.orchestrator_log())
    t0 = time.time()
    c.send("this call never returns %s" % hang)
    timeline = []
    while time.time() - t0 < 200:
        res = tai.http("GET", "/api/outbox?jid=%s&after=%d&wait=3" % (c.jid, c.seq), timeout=20)
        for e in res["entries"]:
            c.seq = max(c.seq, e["seq"])
            if e["kind"] == "text":
                timeline.append((round(time.time() - t0, 1), e["text"][:80]))
    starts = [l[:60] for l in tai.orchestrator_log()[n0:] if "Starting container for group" in l]
    stops = [l[:110] for l in tai.orchestrator_log()[n0:] if "timed out" in l.lower() or "stopping gracefully" in l.lower()]
    rec("SC6", "a model call that never returns (CONTAINER_TIMEOUT 10 s, IDLE 5 s: hard timeout = max(10 s, idle + 30 s) = 35 s)",
        "student received: %s; containers started: %d; timeout log lines: %s" % (timeline or "nothing", len(starts), stops[:4]))
    tai.sh("docker ps -aq --filter name=nanoclaw-sc6 | xargs -r docker rm -f")


def main():
    which = [a for a in sys.argv[1:] if not a.startswith("--")] or ["sc1", "sc2", "sc3", "sc4", "sc5", "sc6"]
    # --precompiled: the image built from the repository's Dockerfile without a cache (tai-agent:clean), running the dist baked into it
    # (no tsc at container start). Without it: the evaluation image, which compiles the mounted agent-runner source at every start.
    precompiled = "--precompiled" in sys.argv
    image = dict(TAI_COMPILE_ON_START=0, CONTAINER_IMAGE="tai-agent:clean") if precompiled else tai.EVAL_IMAGE
    print(tai.orch_env(IDLE_TIMEOUT=10000, LOG_LEVEL="debug", MAX_CONCURRENT_CONTAINERS=5, **image))
    tai.backend("mock")
    if "sc1" in which:
        sc1()
    if "sc2" in which:
        print(tai.orch_env(IDLE_TIMEOUT=20000, LOG_LEVEL="debug", MAX_CONCURRENT_CONTAINERS=5))
        sc2()
    if "sc3" in which:
        print(tai.orch_env(IDLE_TIMEOUT=30000, LOG_LEVEL="debug", MAX_CONCURRENT_CONTAINERS=5))
        sc3()
    if "sc4" in which:
        sc4()
    if "sc5" in which:
        sc5()
    if "sc6" in which:
        sc6()
    print("saved:", tai.save("sched-precompiled" if precompiled else "sched", results))


if __name__ == "__main__":
    main()
