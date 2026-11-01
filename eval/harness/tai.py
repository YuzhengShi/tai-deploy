"""Client for the evaluation stack on the box (stdlib only; runs ON the box, next to the orchestrator).

It drives TAi through the web channel exactly as a student's browser would (register a chat, send a message, long-poll the outbox),
and reads the evidence the stack leaves: the scripted model's request log, the Canvas/GitHub stand-ins' request log, the gateway's
upstream log, the group folders on disk, TAi's SQLite store and `docker ps`.
"""
import json
import os
import re
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

E = os.path.expanduser("~/tai-eval")
T = E + "/tai"
LOGS = E + "/logs"
SCRIPTS = E + "/mockscripts"
RESULTS = E + "/results"
API = "http://127.0.0.1:8099"
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def http(method, path, body=None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError("%s %s -> %d %s" % (method, path, e.code, e.read().decode()[:200]))


def http_patient(method, path, body=None, timeout=90, tries=3):
    """http() for requests that can be repeated (register, outbox): the orchestrator's disk is sometimes busy (a docker build runs on
    the same box) and a stalled read must not end a harness run that has minutes of budget left."""
    for attempt in range(tries):
        try:
            return http(method, path, body, timeout=timeout)
        except (TimeoutError, ConnectionError, urllib.error.URLError):
            if attempt == tries - 1:
                raise
            time.sleep(2)


class Reply:
    def __init__(self, entries, seconds, timed_out):
        self.entries = entries
        self.seconds = seconds
        self.timed_out = timed_out
        self.texts = [e["text"] for e in entries if e["kind"] == "text"]
        self.text = "\n".join(self.texts)

    def __repr__(self):
        return "Reply(%.1fs, %d text(s)%s: %r)" % (self.seconds, len(self.texts), ", TIMED OUT" if self.timed_out else "", self.text[:160])


class Chat:
    """One student's chat. folder is the group folder under groups/ (and the key of its identity binding)."""

    def __init__(self, folder, name=None, canvas=None, github=None, register=True):
        self.folder = folder
        self.jid = "web:" + folder
        self.name = name or folder
        if register:
            http_patient("POST", "/api/register", {"jid": self.jid, "name": self.name, "folder": folder,
                                                   "canvasUserId": canvas, "githubUsername": github})
        self.seq = http_patient("GET", "/api/outbox?after=0")["last"]

    def send(self, text):
        return http("POST", "/api/message", {"jid": self.jid, "sender": self.folder, "name": self.name, "text": text}, timeout=180)

    def wait(self, timeout=120, quiet=2.5):
        """Collect the outbox of this chat until something was said and it has been quiet for `quiet` seconds."""
        t0 = time.time()
        got, last_activity, said = [], None, False
        while time.time() - t0 < timeout:
            try:
                res = http("GET", "/api/outbox?jid=%s&after=%d&wait=3" % (self.jid, self.seq), timeout=60)
            except (TimeoutError, ConnectionError, urllib.error.URLError):
                continue                      # the orchestrator was busy: ask again until the overall budget is spent
            if res["last"] < self.seq:        # the orchestrator restarted: its outbox numbering began again at 1
                self.seq = 0
                continue
            for e in res["entries"]:
                got.append(e)
                self.seq = max(self.seq, e["seq"])
                last_activity = time.time()
                if e["kind"] == "text":
                    said = True
            if said and last_activity and time.time() - last_activity >= quiet:
                return Reply(got, time.time() - t0, False)
        return Reply(got, time.time() - t0, True)

    def ask(self, text, timeout=120, quiet=2.5):
        t0 = time.time()
        self.send(text)
        reply = self.wait(timeout, quiet)
        reply.seconds = time.time() - t0
        return reply


def write_script(name, steps, final=None):
    """Install a script for the scripted model (eval/mock_llm.py). Returns the directive to put in a message."""
    os.makedirs(SCRIPTS, exist_ok=True)
    with open("%s/%s.json" % (SCRIPTS, name), "w") as f:
        json.dump({"steps": steps, "final": final or {"echo": "all"}}, f)
    return "MOCK:" + name


def bash(command, **kw):
    return dict(tool="Bash", input={"command": command, "description": "scripted"}, **kw)


def read_jsonl(path, since=0.0):
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("ts", 0) >= since:
                    out.append(row)
    except FileNotFoundError:
        pass
    return out


def mock_log(since=0.0):
    return read_jsonl(LOGS + "/mockllm.jsonl", since)


def services_log(since=0.0):
    return read_jsonl(LOGS + "/mocks.jsonl", since)


def gateway_log(since=0.0):
    return read_jsonl(LOGS + "/gateway.jsonl", since)


def orchestrator_log(tail=None):
    try:
        with open(LOGS + "/orchestrator.log", encoding="utf-8", errors="replace") as f:
            lines = [ANSI.sub("", l.rstrip("\n")) for l in f]
    except FileNotFoundError:
        return []
    return lines[-tail:] if tail else lines


def sh(cmd, timeout=120):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    return (r.stdout + r.stderr).strip()


def containers():
    """Names of the agent containers running now."""
    out = sh("docker ps --format '{{.Names}}' --filter name=nanoclaw-")
    return [n for n in out.splitlines() if n.strip()]


def group_path(folder, *parts):
    return os.path.join(T, "groups", folder, *parts)


def put(folder, rel, content=""):
    """Create a file in a group's folder (the container sees it under /workspace/group)."""
    path = group_path(folder, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)
    return path


def get(folder, rel):
    try:
        with open(group_path(folder, rel), encoding="utf-8", errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return None


def transcripts(folder):
    """The Claude Code session files of a group, newest first: Claude Code writes them under $HOME/.claude/projects/<cwd>/ and TAi
    mounts that as data/sessions/<folder>/.claude."""
    base = "%s/data/sessions/%s/.claude/projects" % (T, folder)
    found = []
    for root, _dirs, files in os.walk(base):
        for name in files:
            if name.endswith(".jsonl"):
                path = os.path.join(root, name)
                found.append((os.path.getmtime(path), path))
    return [p for _t, p in sorted(found, reverse=True)]


def session_rows(folder):
    """Every row of every Claude Code session file of a group, oldest first. Resuming may write a new session file that repeats the
    old rows, so rows are deduplicated by their uuid."""
    rows, seen = [], set()
    for path in transcripts(folder):
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                key = row.get("uuid") or (path, len(rows))
                if key in seen:
                    continue
                seen.add(key)
                rows.append(row)
    rows.sort(key=lambda r: r.get("timestamp") or "")
    return rows


def tool_events(folder):
    """The tool calls of a group in order: [{name, input, result, error}] (result is the full text the tool returned to the model,
    which is the ground truth for what a guard let through)."""
    calls, order = {}, []
    for row in session_rows(folder):
        content = (row.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use" and block.get("id") not in calls:
                calls[block["id"]] = {"name": block["name"], "input": block.get("input", {}), "result": None, "error": False}
                order.append(block["id"])
            elif block.get("type") == "tool_result" and block.get("tool_use_id") in calls:
                body = block.get("content", "")
                if isinstance(body, list):
                    body = "\n".join(b.get("text", "") for b in body if isinstance(b, dict))
                calls[block["tool_use_id"]]["result"] = str(body)
                calls[block["tool_use_id"]]["error"] = bool(block.get("is_error"))
    return [calls[i] for i in order]


def sessions():
    con = sqlite3.connect(T + "/store/messages.db")
    try:
        return dict(con.execute("SELECT group_folder, session_id FROM sessions").fetchall())
    finally:
        con.close()


# What the first orch_env call of a harness script passes unless it measures the image built from the Dockerfile (sched.py --precompiled):
# containers compile the mounted agent-runner source at start, so a variant swap or a hook change is what runs.
EVAL_IMAGE = dict(TAI_COMPILE_ON_START=1, CONTAINER_IMAGE="tai-agent:eval")


def orch_env(**kv):
    """Set values in orch.env (read when the orchestrator starts) and restart the orchestrator."""
    path = E + "/orch.env"
    cur = {}
    with open(path) as f:
        for line in f:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                cur[k] = v
    cur.update({k: str(v) for k, v in kv.items()})
    with open(path, "w") as f:
        f.write("".join("%s=%s\n" % kv for kv in cur.items()))
    return sh("bash %s/eval/host/remote/stack.sh orch restart" % T, timeout=90)


def backend(name):
    return sh("bash %s/eval/host/remote/stack.sh backend %s" % (T, name))


def env_set(key, value=None):
    """Set (or, with value None, remove) one line of TAi's .env, which the orchestrator reads at every container spawn
    (call it after backend(), which writes the whole file)."""
    path = T + "/.env"
    with open(path) as f:
        lines = [l for l in f.read().splitlines() if not l.startswith(key + "=")]
    if value is not None:
        lines.append("%s=%s" % (key, value))
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


# What a result file must never hold: the gateway key (sk-/csk-), GitHub tokens (ghp_/gho_/ghs_/github_pat_), a Canvas token
# (<id>~<64 chars>) and an Authorization header value.
SECRET = re.compile(r"(?:sk-|csk-|ghp_|gho_|ghs_|ghu_|github_pat_)[A-Za-z0-9_-]{16,}|\b\d{1,6}~[A-Za-z0-9]{32,}|(?<=Bearer )[A-Za-z0-9._~+/-]{16,}")


def mask(text):
    """Credentials that could appear in a tool result when a guard fails (they live in the container's environment)."""
    return SECRET.sub("REDACTED", text or "")


def save(name, obj):
    os.makedirs(RESULTS, exist_ok=True)
    path = "%s/%s-%s.json" % (RESULTS, name, time.strftime("%Y%m%d-%H%M%S"))
    with open(path, "w") as f:
        f.write(mask(json.dumps(obj, indent=1, default=str)))
    return path
