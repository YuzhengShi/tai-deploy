"""deploy/cs6650/tai_live.sh, the parts that act on the live data: removing the chats the smoke tests made, and the backups.
Run: python deploy/cs6650/test_tai_live.py

The host side of the script runs under bash against a fake home (TAI_LIVE_DIR) with a real SQLite database of the shape TAi keeps, and
stand-ins for sudo, systemctl and curl on the PATH. What matters: only the smoke chats go (never a student's), nothing changes without
--yes, a copy of the database is kept before anything is deleted, and a backup holds the records and never a secret.
"""
import http.server
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "tai_live.sh"


def posix(path) -> str:
    text = Path(path).as_posix()
    return "/" + text[0].lower() + text[2:] if os.name == "nt" and text[1:2] == ":" else text


def find_bash():
    if os.name != "nt":
        return shutil.which("bash")
    for root in filter(None, [os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"),
                              os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs"), "D:\\Program Files (x86)"]):
        candidate = Path(root) / "Git" / "bin" / "bash.exe"
        if candidate.exists():
            return str(candidate)
    return None


BASH = find_bash()
STUDENT = "s_" + "ab12" * 5
SCHEMA = """
create table chats (jid text primary key, name text);
create table messages (id text, chat_jid text, content text);
create table registered_groups (jid text primary key, name text, folder text, github_username text);
create table sessions (group_folder text primary key, session_id text);
create table memories (id text, student_folder text, text text);
create table scheduled_tasks (id text, group_folder text, chat_jid text, prompt text);
create table task_run_logs (id integer, task_id text, result text);
create table router_state (key text primary key, value text);
"""


@unittest.skipIf(BASH is None, "needs Git Bash (or bash on Linux/macOS)")
class LiveScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        self.home = tmp / "home"
        self.live = self.home / "tai-live"
        self.tree = self.live / "tai"
        self.bin = tmp / "bin"
        for d in (self.home, self.bin, self.tree / "store", self.live / "run"):
            d.mkdir(parents=True, exist_ok=True)
        self.db = self.tree / "store" / "messages.db"
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        for folder in ("smoke-owner-01", "smoke-chat-02", STUDENT):
            jid = "web:" + folder
            con.execute("insert into chats values (?, ?)", (jid, folder))
            con.execute("insert into messages values (?, ?, ?)", ("m-" + folder, jid, "hello"))
            con.execute("insert into registered_groups values (?, ?, ?, ?)", (jid, folder, folder, None))
            con.execute("insert into sessions values (?, ?)", (folder, "sess-" + folder))
            con.execute("insert into memories values (?, ?, ?)", ("mem-" + folder, folder, "likes short answers"))
            con.execute("insert into scheduled_tasks values (?, ?, ?, ?)", ("task-" + folder, folder, jid, "patrol"))
            con.execute("insert into task_run_logs values (1, ?, 'ok')", ("task-" + folder,))
            folder_dir = self.tree / "groups" / folder
            (folder_dir / "logs").mkdir(parents=True)
            (folder_dir / "COMPETENCY.md").write_text("# " + folder, encoding="utf-8")
            (folder_dir / "logs" / "run.log").write_text("log", encoding="utf-8")
            (self.tree / "data" / "sessions" / folder).mkdir(parents=True)
            (self.tree / "data" / "sessions" / folder / "s.jsonl").write_text("{}", encoding="utf-8")
        con.execute("insert into router_state values ('last_agent_timestamp', ?)",
                    ('{"web:smoke-owner-01": "t1", "web:%s": "t2"}' % STUDENT,))
        con.commit()
        con.close()
        (self.tree / "store" / "portal").mkdir()
        (self.tree / "store" / "portal" / f"{STUDENT}.jsonl").write_text('{"n":1}\n', encoding="utf-8")
        (self.live / "users.json").write_text('{"users": []}', encoding="utf-8")
        for secret in ("secrets.env", "portal-secret", "credentials.env", "voice-secret"):
            (self.live / secret).write_text("SECRET-DO-NOT-BACK-UP\n", encoding="utf-8")
        (self.tree / ".env").write_text("SECRET-DO-NOT-BACK-UP\n", encoding="utf-8")
        calls = tmp / "sudo-calls.txt"
        self.calls = calls
        (self.bin / "python3").write_text(f'#!/usr/bin/env bash\nexec "{posix(sys.executable)}" "$@"\n', encoding="utf-8", newline="\n")
        (self.bin / "sudo").write_text(f'#!/usr/bin/env bash\necho "$@" >> "{posix(calls)}"\nexit 0\n', encoding="utf-8", newline="\n")
        # the script puts $L/node/bin first on its PATH: the one place a stand-in beats the curl that ships with Git for Windows
        (self.live / "node" / "bin").mkdir(parents=True)
        (self.live / "node" / "bin" / "curl").write_text('#!/usr/bin/env bash\necho \'{"ok":true}\'\n', encoding="utf-8", newline="\n")
        os.chmod(self.live / "node" / "bin" / "curl", 0o755)
        for name in ("python3", "sudo"):
            os.chmod(self.bin / name, 0o755)
        self.env = dict(os.environ, HOME=posix(self.home), TAI_LIVE_DIR=posix(self.live), PATH=str(self.bin) + os.pathsep + os.environ["PATH"])

    def run_script(self, *args):
        try:
            result = subprocess.run([BASH, posix(SCRIPT), "--on-host", *args], capture_output=True, text=True, env=self.env, timeout=60)
        except subprocess.TimeoutExpired as err:
            self.fail("the script hung: " + str(err.stdout or b"") + str(err.stderr or b""))
        return result.returncode, result.stdout + result.stderr

    def rows(self, table, column):
        con = sqlite3.connect(self.db)
        try:
            return sorted(r[0] for r in con.execute(f"select {column} from {table}"))
        finally:
            con.close()

    def test_without_yes_it_says_what_would_go_and_changes_nothing(self):
        code, out = self.run_script("smoke", "clean")
        self.assertEqual(code, 0, out)
        self.assertIn("2 smoke chat(s)", out)
        self.assertIn("smoke-chat-02", out)
        self.assertIn("nothing was changed", out)
        self.assertEqual(len(self.rows("registered_groups", "folder")), 3)
        self.assertTrue((self.tree / "groups" / "smoke-owner-01").exists())
        self.assertEqual(list(self.tree.glob("store/messages.db.bak-*")), [])
        self.assertFalse(self.calls.exists())                                          # the service was not touched

    def test_with_yes_the_smoke_chats_go_everywhere_and_no_student_does(self):
        code, out = self.run_script("smoke", "clean", "--yes")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.rows("registered_groups", "folder"), [STUDENT])
        for table, column in (("chats", "jid"), ("messages", "chat_jid"), ("sessions", "group_folder"), ("memories", "student_folder"),
                              ("scheduled_tasks", "group_folder")):
            self.assertEqual(self.rows(table, column), [STUDENT] if column != "jid" and column != "chat_jid" else ["web:" + STUDENT], table)
        self.assertEqual(len(self.rows("task_run_logs", "task_id")), 1)
        self.assertEqual(self.rows("task_run_logs", "task_id"), ["task-" + STUDENT])
        self.assertFalse((self.tree / "groups" / "smoke-owner-01").exists())
        self.assertFalse((self.tree / "data" / "sessions" / "smoke-chat-02").exists())
        self.assertTrue((self.tree / "groups" / STUDENT / "COMPETENCY.md").exists())          # the student's record is where it was
        self.assertTrue((self.tree / "data" / "sessions" / STUDENT / "s.jsonl").exists())
        con = sqlite3.connect(self.db)
        state = con.execute("select value from router_state").fetchone()[0]
        con.close()
        self.assertNotIn("smoke", state)
        self.assertIn(STUDENT, state)
        self.assertEqual(len(list(self.tree.glob("store/messages.db.bak-*"))), 1)               # the copy made before
        self.assertIn("stop", self.calls.read_text(encoding="utf-8"))
        self.assertIn("start", self.calls.read_text(encoding="utf-8"))

    def test_a_backup_holds_the_records_and_no_secret(self):
        code, out = self.run_script("backup", "now")
        self.assertEqual(code, 0, out)
        files = sorted((self.live / "backups").glob("tai-*.tgz"))
        self.assertEqual(len(files), 1)
        with tarfile.open(files[0]) as tar:
            names = tar.getnames()
            for want in (f"./store/portal/{STUDENT}.jsonl", f"./groups/{STUDENT}/COMPETENCY.md", f"./data/sessions/{STUDENT}/s.jsonl", "./store/messages.db", "./users.json"):
                self.assertIn(want, names)
            self.assertFalse([n for n in names if n.endswith(".log") or "/logs" in n], "logs are not records")
            for member in tar.getmembers():
                if member.isfile():
                    self.assertNotIn(b"SECRET-DO-NOT-BACK-UP", tar.extractfile(member).read(), member.name)
            self.assertFalse([n for n in names if n.endswith((".env", "portal-secret", "voice-secret"))])
        # the database inside is a real, readable one
        with tempfile.TemporaryDirectory() as extract, tarfile.open(files[0]) as tar:
            tar.extract("./store/messages.db", extract)
            con = sqlite3.connect(Path(extract) / "store" / "messages.db")
            self.assertEqual(con.execute("select count(*) from registered_groups").fetchone()[0], 3)
            con.close()
        if os.name != "nt":
            self.assertEqual(files[0].stat().st_mode & 0o777, 0o600)

    def test_a_backup_leaves_out_the_prepared_documents_and_keeps_everything_else_of_the_portal_directory(self):
        # store/portal/docs holds the page images of students' documents (up to 60 MB each): made again from groups/<folder>/uploads, so not a record
        doc = self.tree / "store" / "portal" / "docs" / STUDENT / ("ab" * 16)
        doc.mkdir(parents=True)
        (doc / "meta.json").write_text("{}", encoding="utf-8")
        (doc / "p001.png").write_bytes(b"\x89PNG" + b"x" * 5000)
        (self.tree / "store" / "portal" / "main.jsonl").write_text('{"n":1}\n', encoding="utf-8")
        (self.tree / "store" / "portal" / "settings").mkdir()
        (self.tree / "store" / "portal" / "settings" / "prefs.json").write_text("{}", encoding="utf-8")
        (self.tree / "store" / "portal" / ".hidden").write_text("kept", encoding="utf-8")
        (self.tree / "store" / "course-docs" / ("cd" * 16)).mkdir(parents=True)
        (self.tree / "store" / "course-docs" / ("cd" * 16) / "p001.png").write_bytes(b"\x89PNG")
        code, out = self.run_script("backup", "now")
        self.assertEqual(code, 0, out)
        with tarfile.open(sorted((self.live / "backups").glob("tai-*.tgz"))[0]) as tar:
            names = tar.getnames()
        for want in (f"./store/portal/{STUDENT}.jsonl", "./store/portal/main.jsonl", "./store/portal/settings/prefs.json", "./store/portal/.hidden"):
            self.assertIn(want, names)
        self.assertEqual([n for n in names if "/docs" in n or n.endswith(".png") or ("ab" * 16) in n], [], "prepared documents are not in a backup")
        self.assertFalse([n for n in names if "course-docs" in n], "nor is the course library (it is made from the course's own files)")
        self.assertTrue((doc / "p001.png").exists(), "and the live files are untouched")

    def test_only_the_newest_fourteen_backups_stay(self):
        folder = self.live / "backups"
        folder.mkdir()
        for i in range(16):
            (folder / f"tai-2026010{i % 10}T0{i // 10}0000Z.tgz").write_bytes(b"x")
            os.utime(folder / f"tai-2026010{i % 10}T0{i // 10}0000Z.tgz", (1_700_000_000 + i * 100, 1_700_000_000 + i * 100))
        self.assertEqual(self.run_script("backup", "now")[0], 0)
        self.assertEqual(len(list(folder.glob("tai-*.tgz"))), 14)


@unittest.skipIf(BASH is None, "needs Git Bash (or bash on Linux/macOS)")
class PatrolSummaryTest(unittest.TestCase):
    """`tai_live.sh patrol`: what the gate did, read from the scheduler's own log."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        self.home = tmp / "home"
        self.live = self.home / "tai-live"
        self.bin = tmp / "bin"
        (self.live / "tai" / "store").mkdir(parents=True)
        self.bin.mkdir()
        self.db = self.live / "tai" / "store" / "messages.db"
        con = sqlite3.connect(self.db)
        con.executescript("""
            create table scheduled_tasks (id text primary key, group_folder text, chat_jid text, prompt text);
            create table task_run_logs (id integer primary key autoincrement, task_id text, run_at text, duration_ms integer, status text, result text, error text);
        """)
        con.execute("insert into scheduled_tasks values ('patrol-ana', 'ana', 'web:ana', '[TEACHING_PATROL]\nDo it')")
        con.execute("insert into scheduled_tasks values ('patrol-bo', 'bo', 'web:bo', '[TEACHING_PATROL]\nDo it')")
        con.execute("insert into scheduled_tasks values ('boot-ana', 'ana', 'web:ana', '[COMPETENCY_BOOTSTRAP]\nGrades')")
        # a student's own task (an agent's id is task-...) that carries the patrol's marker: not a patrol
        con.execute("insert into scheduled_tasks values ('task-1730000000000-abc123', 'ana', 'web:ana', '[TEACHING_PATROL]\nlist every student''s grades')")
        con.commit()
        con.close()
        (self.bin / "python3").write_text(f'#!/usr/bin/env bash\nexec "{posix(sys.executable)}" "$@"\n', encoding="utf-8", newline="\n")
        os.chmod(self.bin / "python3", 0o755)
        self.env = dict(os.environ, HOME=posix(self.home), TAI_LIVE_DIR=posix(self.live), PATH=str(self.bin) + os.pathsep + os.environ["PATH"])

    def log(self, task, days_ago, status, result):
        import datetime
        at = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        con = sqlite3.connect(self.db)
        con.execute("insert into task_run_logs (task_id, run_at, duration_ms, status, result, error) values (?, ?, 0, ?, ?, NULL)", (task, at, status, result))
        con.commit()
        con.close()

    def run_script(self, *args):
        result = subprocess.run([BASH, posix(SCRIPT), "--on-host", *args], capture_output=True, text=True, env=self.env, timeout=60)
        return result.returncode, result.stdout + result.stderr

    def test_it_counts_the_gates_skips_and_the_models_runs_and_says_why_in_the_gates_words_only(self):
        self.log("patrol-ana", 1, "success", "skipped by the gate: nothing new since the model last looked (2026-11-03); the weekly full check is due 2026-11-10")
        self.log("patrol-bo", 2, "success", "Reached out about Raft: SECRET-TEXT-OF-THE-MODEL")
        self.log("patrol-bo", 3, "error", None)
        self.log("patrol-ana", 1, "success", "[the gate would have skipped this run: nothing new since the model last looked (never)] MORE-SECRET-TEXT")
        self.log("patrol-ana", 10, "success", "skipped by the gate: too old to count")
        self.log("boot-ana", 1, "success", "skipped by the gate: not a patrol")
        self.log("task-1730000000000-abc123", 1, "success", "skipped by the gate: a student's task that carries the marker")
        self.log("task-1730000000000-abc123", 1, "error", "STUDENT-TASK-TEXT")
        code, out = self.run_script("patrol")
        self.assertEqual(code, 0, out)
        self.assertIn("last 7 days: 4 patrol runs: 3 by the model (1 failed), 1 skipped by the gate; in shadow mode the gate would have skipped 1 of the model's runs", out)
        self.assertIn("nothing new since the model last looked (2026-11-03)", out)
        self.assertNotIn("SECRET-TEXT", out)                                  # what a model wrote about a student is not shown
        self.assertNotIn("too old to count", out)
        self.assertNotIn("not a patrol", out)
        self.assertNotIn("carries the marker", out)                           # a student's task with the patrol's marker is not counted, and its failure is not one of the patrol's
        self.assertNotIn("STUDENT-TASK-TEXT", out)
        code, out = self.run_script("patrol", "30")
        self.assertIn("5 patrol runs", out)

    def test_a_week_with_no_patrol_runs_and_a_bad_argument(self):
        code, out = self.run_script("patrol")
        self.assertEqual(code, 0, out)
        self.assertIn("0 patrol runs: 0 by the model (0 failed), 0 skipped by the gate", out)
        code, out = self.run_script("patrol", "soon")
        self.assertNotEqual(code, 0)
        self.assertIn("tai_live.sh patrol [DAYS]", out)

    def test_an_unreadable_database_is_said_not_crashed_on(self):
        self.db.unlink()
        code, out = self.run_script("patrol")
        self.assertIn("no data", out)


class FakeGateway(http.server.BaseHTTPRequestHandler):
    """The part of the gateway the model checks use. How each model behaves is set on the class by the tests:
    ok, 402 (the provider wants money), down (HTTP 500), unknown_model (a gateway created from an older config: no such alias), words_only (never calls a
    tool), rejects_second (answers 400 to the request that carries a tool result), needs_reasoning (like DeepSeek in thinking mode: its first answer carries
    reasoning_content, and the next request must send it back)."""
    behaviour = {}
    seen = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        roles = [m["role"] for m in body["messages"]]
        how = FakeGateway.behaviour.get(body["model"], "ok")
        FakeGateway.seen.append((body["model"], roles, bool(body.get("tools")), self.headers.get("authorization")))
        if how == "402":
            return self.reply(402, {"error": {"message": "payment required"}})
        if how == "unknown_model":
            return self.reply(400, {"error": {"message": "Invalid model name passed in model=" + body["model"]}})
        if how == "down":
            return self.reply(500, {"error": {"message": "upstream down"}})
        words = {"choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}]}
        if not body.get("tools"):
            return self.reply(200, words)
        if "tool" in roles:                                                       # the request that carries a tool result
            if how == "rejects_second":
                return self.reply(400, {"error": {"message": "invalid request"}})
            if how == "needs_reasoning" and not any(m.get("reasoning_content") for m in body["messages"] if m["role"] == "assistant"):
                return self.reply(400, {"error": {"message": "The reasoning_content in the thinking mode must be passed back to the API."}})
            return self.reply(200, words)
        if how == "words_only":
            return self.reply(200, words)
        message = {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "echo", "arguments": "{\"text\":\"hello\"}"}}]}
        if how == "needs_reasoning":
            message["reasoning_content"] = "I should call the tool."
        return self.reply(200, {"choices": [{"index": 0, "message": message, "finish_reason": "tool_calls"}]})

    def reply(self, code, payload):
        out = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


DOCKER_STUB = r'''#!/usr/bin/env bash
echo "$@" >> "$HOME/docker-calls.txt"
if [ "$1" = exec ]; then
  case "$*" in *"test -n"*) [ -f "$HOME/gateway-has-key" ] && exit 0; exit 1 ;; esac
fi
exit 0
'''


@unittest.skipIf(BASH is None, "needs Git Bash (or bash on Linux/macOS)")
class ModelsTest(unittest.TestCase):
    """`tai_live.sh models` (a tiny answer and a tool round trip through the gateway), `model` (which model the chats and the scheduled tasks use) and what a
    deploy keeps of that, against a fake gateway on a loopback port and a stand-in docker."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        self.home = tmp / "home"
        self.live = self.home / "tai-live"
        self.tree = self.live / "tai"
        self.bin = tmp / "bin"
        for d in (self.home / "cs6650-world", self.bin, self.tree, self.live / "node" / "bin", self.live / "run"):
            d.mkdir(parents=True, exist_ok=True)
        (self.home / "cs6650-world" / ".env").write_text("DOMAIN=cs6650.example\nCEREBRAS_API_KEY=csk-not-real\n", encoding="utf-8", newline="\n")
        (self.live / "secrets.env").write_text("LITELLM_MASTER_KEY=sk-test-gateway-key\n", encoding="utf-8", newline="\n")
        (self.live / "voice-secret").write_text("vs\n", encoding="utf-8", newline="\n")
        (self.live / "orch.env").write_text("TAI_VOICE_LLM_KEY=sk-test-gateway-key\nTAI_VOICE_MODEL=qwen\nCONTAINER_PREFIX=tailive\n", encoding="utf-8", newline="\n")
        self.set_models("gpt-oss", "gpt-oss")
        (self.bin / "docker").write_text(DOCKER_STUB, encoding="utf-8", newline="\n")
        (self.bin / "python3").write_text(f'#!/usr/bin/env bash\nexec "{posix(sys.executable)}" "$@"\n', encoding="utf-8", newline="\n")
        (self.live / "node" / "bin" / "node").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8", newline="\n")
        for path in (self.bin / "docker", self.bin / "python3", self.live / "node" / "bin" / "node"):
            os.chmod(path, 0o755)
        FakeGateway.behaviour = {}
        FakeGateway.seen = []
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeGateway)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.env = dict(os.environ, HOME=posix(self.home), TAI_LIVE_DIR=posix(self.live), TAI_LIVE_GATEWAY_PORT=str(self.server.server_address[1]),
                        PATH=str(self.bin) + os.pathsep + os.environ["PATH"])

    def set_models(self, chats, background):
        (self.live / "base.env").write_text(
            f"ANTHROPIC_MODEL={chats}\nANTHROPIC_MODEL_LIGHT={background}\nANTHROPIC_DEFAULT_SONNET_MODEL={chats}\n", encoding="utf-8", newline="\n")

    def run_script(self, *args):
        try:
            result = subprocess.run([BASH, posix(SCRIPT), "--on-host", *args], capture_output=True, text=True, env=self.env, timeout=90)
        except subprocess.TimeoutExpired as err:
            self.fail("the script hung: " + str(err.stdout or b"") + str(err.stderr or b""))
        return result.returncode, result.stdout + result.stderr

    def base(self):
        out = {}
        for line in (self.live / "base.env").read_text(encoding="utf-8").split("\n"):
            if "=" in line:
                key, value = line.split("=", 1)
                out[key] = value
        return out

    def store_deepseek_key(self, running=True):
        (self.live / "gateway.env").write_text("TAI_QWEN_TPM_BUDGET=90000\nDEEPSEEK_API_KEY=sk-DEEPSEEK-0123456789abcdef\n", encoding="utf-8", newline="\n")
        if running:
            (self.home / "gateway-has-key").write_text("", encoding="utf-8")

    # ---- the check: a tiny answer and a tool round trip

    def test_a_model_that_answers_and_survives_a_tool_round_trip_is_reported_with_its_seconds(self):
        code, out = self.run_script("models", "qwen", "deepseek")
        self.assertEqual(code, 0, out)
        for name in ("qwen", "deepseek"):
            self.assertRegex(out, rf"model {name}: answers \([0-9.]+ s\); tool round trip ok")
        roles = [(m, r, t) for m, r, t, _ in FakeGateway.seen]
        self.assertIn(("deepseek", ["user", "assistant", "tool"], True), roles)                  # the second request really carried a tool result
        self.assertTrue(all(auth == "Bearer sk-test-gateway-key" for *_, auth in FakeGateway.seen))

    def test_a_model_that_fails_only_the_request_after_a_tool_call_fails_the_check(self):
        FakeGateway.behaviour = {"deepseek": "rejects_second"}
        code, out = self.run_script("models", "qwen", "deepseek")
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r"model qwen: answers .*tool round trip ok")
        self.assertRegex(out, r"model deepseek: answers .*, but tool round trip FAILED on the second request \(HTTP 400\)")

    def test_reasoning_content_of_a_thinking_model_is_sent_back_the_way_a_correct_client_does(self):
        FakeGateway.behaviour = {"deepseek": "needs_reasoning"}
        code, out = self.run_script("models", "deepseek")
        self.assertEqual(code, 0, out)
        self.assertIn("tool round trip ok", out)

    def test_a_model_that_answers_in_words_is_not_failed_for_it(self):
        FakeGateway.behaviour = {"qwen": "words_only"}
        code, out = self.run_script("models", "qwen")
        self.assertEqual(code, 0, out)
        self.assertIn("not tried", out)

    def test_payment_required_and_an_outage_are_told_apart_and_both_fail(self):
        FakeGateway.behaviour = {"qwen": "402", "gpt-oss": "down"}
        code, out = self.run_script("models", "qwen", "gpt-oss", "deepseek")
        self.assertEqual(code, 1, out)
        self.assertIn("model qwen: the provider says PAYMENT REQUIRED", out)
        self.assertIn("model gpt-oss: NOT answering (HTTP 500)", out)
        self.assertRegex(out, r"model deepseek: answers")                                       # the others are still tried

    def test_without_names_it_tries_the_voice_model_the_chats_and_the_scheduled_tasks_once_each(self):
        self.set_models("gpt-oss", "deepseek")
        code, out = self.run_script("models")
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(set(m for m, *_ in FakeGateway.seen)), ["deepseek", "gpt-oss", "qwen"])
        self.assertEqual(len(re.findall(r"^model ", out, re.M)), 3)

    # ---- which model the chats and the scheduled tasks use

    def test_deepseek_is_refused_until_its_key_is_stored_and_the_running_gateway_has_it(self):
        code, out = self.run_script("model", "deepseek")
        self.assertNotEqual(code, 0)
        self.assertIn("no DeepSeek key is stored", out)
        self.assertEqual(self.base()["ANTHROPIC_DEFAULT_SONNET_MODEL"], "gpt-oss")
        self.store_deepseek_key(running=False)
        code, out = self.run_script("model", "deepseek", "--background")
        self.assertNotEqual(code, 0)
        self.assertIn("running gateway does not have the key yet", out)
        self.assertIn("tai_live.sh gateway", out)
        self.assertEqual(self.base()["ANTHROPIC_MODEL_LIGHT"], "gpt-oss")                       # nothing changed
        (self.home / "gateway-has-key").write_text("", encoding="utf-8")
        code, out = self.run_script("model", "deepseek")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.base()["ANTHROPIC_DEFAULT_SONNET_MODEL"], self.base()["ANTHROPIC_MODEL_LIGHT"]), ("deepseek", "deepseek"))

    def test_having_the_key_is_not_enough_the_running_gateway_must_really_answer_for_deepseek(self):
        self.store_deepseek_key()                                                               # the key is stored and the running gateway has the variable
        for behaviour, expect in (("unknown_model", "Invalid model name"), ("402", "PAYMENT REQUIRED"), ("rejects_second", "FAILED on the second request"), ("down", "NOT answering")):
            FakeGateway.behaviour = {"deepseek": behaviour}
            for args in (("model", "deepseek"), ("model", "deepseek", "--background")):
                code, out = self.run_script(*args)
                self.assertNotEqual(code, 0, (behaviour, args, out))
                self.assertIn(expect, out, (behaviour, args))
                self.assertIn("deepseek does not work through the running gateway", out)
                self.assertEqual((self.base()["ANTHROPIC_DEFAULT_SONNET_MODEL"], self.base()["ANTHROPIC_MODEL_LIGHT"]), ("gpt-oss", "gpt-oss"), (behaviour, args))   # nothing changed
        FakeGateway.behaviour = {"deepseek": "words_only"}                                      # it answered but never showed it can call a tool: not enough either
        code, out = self.run_script("model", "deepseek")
        self.assertNotEqual(code, 0, out)
        self.assertIn("no tool round trip could be shown", out)
        self.assertEqual(self.base()["ANTHROPIC_DEFAULT_SONNET_MODEL"], "gpt-oss")
        FakeGateway.behaviour = {}
        self.assertEqual(self.run_script("model", "deepseek")[0], 0)                            # and with a working one the switch goes through
        self.assertEqual(self.base()["ANTHROPIC_DEFAULT_SONNET_MODEL"], "deepseek")

    def test_a_background_model_is_set_apart_from_the_chats_and_a_plain_model_sets_both(self):
        self.store_deepseek_key()
        code, out = self.run_script("model", "deepseek", "--background")
        self.assertEqual(code, 0, out)
        self.assertIn("the chats stay on gpt-oss", out)
        base = self.base()
        self.assertEqual((base["ANTHROPIC_DEFAULT_SONNET_MODEL"], base["ANTHROPIC_MODEL"], base["ANTHROPIC_MODEL_LIGHT"]), ("gpt-oss", "gpt-oss", "deepseek"))
        self.assertIn("ANTHROPIC_MODEL_LIGHT=deepseek", (self.tree / ".env").read_text(encoding="utf-8"))
        code, out = self.run_script("model", "qwen")                                           # one model for everything again
        self.assertEqual(code, 0, out)
        base = self.base()
        self.assertEqual((base["ANTHROPIC_DEFAULT_SONNET_MODEL"], base["ANTHROPIC_MODEL_LIGHT"]), ("qwen", "qwen"))

    def test_names_and_flags_it_does_not_know_are_refused_and_change_nothing(self):
        for args in (("model", "gpt-4"), ("model",), ("model", "qwen", "--everywhere")):
            code, out = self.run_script(*args)
            self.assertNotEqual(code, 0, args)
            self.assertIn("tai_live.sh model gpt-oss|qwen|deepseek [--background]", out)
        self.assertEqual(self.base()["ANTHROPIC_DEFAULT_SONNET_MODEL"], "gpt-oss")

    def test_a_deploys_preparation_keeps_both_models_and_gives_the_gateway_the_key_through_its_env_file_only(self):
        self.store_deepseek_key()
        self.set_models("qwen", "deepseek")
        code, out = self.run_script("gateway")                                                 # prepare, then the gateway: what every deploy that changes the gateway does
        self.assertEqual(code, 0, out)
        base = self.base()
        self.assertEqual((base["ANTHROPIC_DEFAULT_SONNET_MODEL"], base["ANTHROPIC_MODEL"], base["ANTHROPIC_MODEL_LIGHT"]), ("qwen", "qwen", "deepseek"))
        runs = [line for line in (self.home / "docker-calls.txt").read_text(encoding="utf-8").split("\n") if line.startswith("run ")]
        self.assertEqual(len(runs), 1, runs)
        self.assertIn("--env-file", runs[0])
        self.assertIn("gateway.env", runs[0])
        self.assertNotIn("sk-DEEPSEEK-0123456789abcdef", runs[0])                              # the key is never on a command line
        self.assertNotIn("DEEPSEEK", (self.tree / ".env").read_text(encoding="utf-8"))          # nor in the agents' env

    def test_a_deploy_on_a_host_that_never_had_a_background_model_gives_the_chats_model_to_both(self):
        (self.live / "base.env").write_text("ANTHROPIC_MODEL=qwen\nANTHROPIC_DEFAULT_SONNET_MODEL=qwen\n", encoding="utf-8", newline="\n")
        code, out = self.run_script("gateway")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.base()["ANTHROPIC_DEFAULT_SONNET_MODEL"], self.base()["ANTHROPIC_MODEL_LIGHT"]), ("qwen", "qwen"))


@unittest.skipIf(BASH is None or shutil.which("node") is None, "needs Git Bash (or bash) and Node")
class NotifyTest(unittest.TestCase):
    """`tai_live.sh notify status|vapid`: the VAPID key pair made on the host, and the counts of what is subscribed. Nothing it prints may be a private key,
    an endpoint or a student's folder; an existing key is never replaced without --force."""

    PRIVATE = re.compile(r"^[A-Za-z0-9_-]{43}$")
    PUBLIC = re.compile(r"^[A-Za-z0-9_-]{87}$")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        self.home = tmp / "home"
        self.live = self.home / "tai-live"
        self.tree = self.live / "tai"
        self.bin = tmp / "bin"
        self.portal = self.tree / "store" / "portal"
        for d in (self.home, self.bin, self.portal, self.live / "node" / "bin"):
            d.mkdir(parents=True, exist_ok=True)
        (self.live / "orch.env").write_text("CONTAINER_PREFIX=tailive\nTAI_VOICE=1\n", encoding="utf-8", newline="\n")
        (self.bin / "python3").write_text(f'#!/usr/bin/env bash\nexec "{posix(sys.executable)}" "$@"\n', encoding="utf-8", newline="\n")
        # the host's own Node sits first on the script's PATH ($L/node/bin): here it is this PC's
        (self.live / "node" / "bin" / "node").write_text(f'#!/usr/bin/env bash\nexec "{posix(shutil.which("node"))}" "$@"\n', encoding="utf-8", newline="\n")
        for path in (self.bin / "python3", self.live / "node" / "bin" / "node"):
            os.chmod(path, 0o755)
        self.env = dict(os.environ, HOME=posix(self.home), TAI_LIVE_DIR=posix(self.live), PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.key_file = self.live / "vapid.key"

    def run_script(self, *args):
        result = subprocess.run([BASH, posix(SCRIPT), "--on-host", *args], capture_output=True, text=True, env=self.env, timeout=60)
        return result.returncode, result.stdout, result.stderr

    def orch(self):
        return (self.live / "orch.env").read_text(encoding="utf-8")

    def public_of(self, private):
        """The public key by an independent route: Node's ECDH on the scalar the file holds."""
        # (through the environment: a key that begins with "-" would be taken for an option of node)
        code = "const c=require('node:crypto');const e=c.createECDH('prime256v1');e.setPrivateKey(Buffer.from(process.env.TEST_KEY,'base64url'));console.log(e.getPublicKey().toString('base64url'))"
        return subprocess.run([shutil.which("node"), "-e", code], capture_output=True, text=True, timeout=30, env=dict(os.environ, TEST_KEY=private)).stdout.strip()

    def prefs(self, folder, doc):
        (self.portal / f"{folder}.prefs.json").write_text(doc if isinstance(doc, str) else json.dumps(doc), encoding="utf-8")

    # ---- status

    def test_status_of_a_host_that_has_never_heard_of_it_says_off_no_key_and_no_one(self):
        code, out, err = self.run_script("notify", "status")
        self.assertEqual(code, 0, out + err)
        self.assertIn("notify:        off (TAI_NOTIFY)", out)
        self.assertIn("none named", out)
        self.assertIn("subscriptions: 0 browser(s) of 0 student(s); e-mail on for 0; 0 preference file(s), 0 with a time zone", out)

    def test_status_counts_browsers_and_students_and_names_none_of_them(self):
        a, b, c, d = ("s_" + ch * 20 for ch in "abcd")
        sub = lambda n: {"endpoint": f"https://fcm.googleapis.com/fcm/send/SECRET-ENDPOINT-{n}", "keys": {"p256dh": f"SECRET-P256DH-{n}", "auth": f"SECRET-AUTH-{n}"}}
        self.prefs(a, {"tz": "America/Vancouver", "voiceSpeed": 1.1, "notify": {"push": [sub(1), sub(2)], "email": {"enabled": True}}})
        self.prefs(b, {"notify": {"push": [sub(3)], "email": {"enabled": False}}})
        self.prefs(c, {"tz": "Asia/Tokyo", "notify": {"push": []}})
        self.prefs(d, "{ this is not json")
        (self.live / "orch.env").write_text("TAI_NOTIFY=1\n", encoding="utf-8", newline="\n")
        code, out, err = self.run_script("notify", "status")
        self.assertEqual(code, 0, out + err)
        self.assertIn("notify:        on (TAI_NOTIFY)", out)
        self.assertIn("subscriptions: 3 browser(s) of 2 student(s); e-mail on for 1; 4 preference file(s), 2 with a time zone", out)
        for secret in ("SECRET", "fcm.googleapis.com", a, b, c, d):
            self.assertNotIn(secret, out + err)

    def test_status_says_when_the_file_named_is_missing_and_when_it_is_there(self):
        (self.live / "orch.env").write_text(f"TAI_VAPID_KEY_FILE={posix(self.key_file)}\n", encoding="utf-8", newline="\n")
        self.assertIn("missing or empty", self.run_script("notify", "status")[1])
        self.assertEqual(self.run_script("notify", "vapid")[0], 0)
        out = self.run_script("notify", "status")[1]
        self.assertIn("present", out)
        self.assertNotIn(self.key_file.read_text().strip(), out)

    # ---- vapid

    def test_vapid_makes_the_pair_on_the_host_prints_only_the_public_key_and_names_the_file_in_the_environment(self):
        code, out, err = self.run_script("notify", "vapid")
        self.assertEqual(code, 0, out + err)
        private = self.key_file.read_text(encoding="utf-8").strip()
        self.assertRegex(private, self.PRIVATE)
        public = out.strip().splitlines()[-1]
        self.assertRegex(public, self.PUBLIC)
        self.assertEqual(public, self.public_of(private))                     # the one is the other's public half
        self.assertNotIn(private, out + err)                                  # the private key is never printed
        self.assertIn(f"TAI_VAPID_KEY_FILE={posix(self.key_file)}", self.orch())
        self.assertNotIn(private, self.orch())                                # nor put in the environment file
        self.assertIn("TAI_VOICE=1", self.orch())                             # what was there stays
        if os.name != "nt":
            self.assertEqual(self.key_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(out.strip().splitlines()), 1, "stdout holds the public key and nothing else")

    def test_vapid_leaves_an_existing_key_alone_and_says_the_same_public_key_again(self):
        first = self.run_script("notify", "vapid")
        before = self.key_file.read_text(encoding="utf-8")
        code, out, err = self.run_script("notify", "vapid")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(self.key_file.read_text(encoding="utf-8"), before)
        self.assertIn("left as it is", err)
        self.assertEqual(out.strip(), first[1].strip())
        self.assertEqual(list((self.live).glob("vapid.key.previous")), [])

    def test_vapid_replaces_a_key_only_with_force_keeps_the_old_one_and_drops_a_public_key_that_no_longer_fits(self):
        self.run_script("notify", "vapid")
        old = self.key_file.read_text(encoding="utf-8")
        with open(self.live / "orch.env", "a", encoding="utf-8", newline="\n") as handle:
            handle.write("VAPID_PUBLIC_KEY=old-public-key\n")
        code, out, err = self.run_script("notify", "vapid", "--force")
        self.assertEqual(code, 0, out + err)
        new = self.key_file.read_text(encoding="utf-8")
        self.assertNotEqual(new, old)
        self.assertRegex(new.strip(), self.PRIVATE)
        self.assertEqual((self.live / "vapid.key.previous").read_text(encoding="utf-8"), old)
        self.assertNotIn("VAPID_PUBLIC_KEY", self.orch())
        self.assertEqual(out.strip(), self.public_of(new.strip()))
        self.assertNotIn(new.strip(), out + err)
        self.assertNotIn(old.strip(), out + err)

    def test_vapid_writes_where_the_environment_names_it(self):
        custom = self.live / "keys" / "push.key"
        custom.parent.mkdir()
        (self.live / "orch.env").write_text(f"TAI_VAPID_KEY_FILE={posix(custom)}\n", encoding="utf-8", newline="\n")
        code, out, err = self.run_script("notify", "vapid")
        self.assertEqual(code, 0, out + err)
        self.assertRegex(custom.read_text(encoding="utf-8").strip(), self.PRIVATE)
        self.assertFalse(self.key_file.exists())
        self.assertEqual(self.orch().count("TAI_VAPID_KEY_FILE="), 1)

    def test_vapid_does_not_replace_a_file_it_cannot_read_as_a_key_without_force(self):
        self.key_file.write_text("this is not a key\n", encoding="utf-8")
        code, out, err = self.run_script("notify", "vapid")
        self.assertNotEqual(code, 0)
        self.assertIn("nothing was changed", err)
        self.assertEqual(self.key_file.read_text(encoding="utf-8"), "this is not a key\n")

    def test_a_pem_key_that_is_already_there_is_read_for_its_public_half(self):
        code = "const c=require('node:crypto');const k=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey;process.stdout.write(k.export({type:'pkcs8',format:'pem'}))"
        self.key_file.write_text(subprocess.run([shutil.which("node"), "-e", code], capture_output=True, text=True, timeout=30).stdout, encoding="utf-8")
        code, out, err = self.run_script("notify", "vapid")
        self.assertEqual(code, 0, out + err)
        self.assertRegex(out.strip(), self.PUBLIC)
        self.assertIn("BEGIN PRIVATE KEY", self.key_file.read_text(encoding="utf-8"))

    def test_status_says_whether_email_is_on_and_configured_and_names_only_what_is_missing(self):
        out = self.run_script("notify", "status")[1]
        self.assertIn("email:         off (TAI_NOTIFY_EMAIL); NOT configured, missing: TAI_SMTP_HOST TAI_NOTIFY_FROM", out)
        secret = "SMTP-PASSWORD-SECRET-9"
        (self.live / "orch.env").write_text("TAI_NOTIFY_EMAIL=1\nTAI_SMTP_HOST=smtp.school.example\nTAI_SMTP_USER=tai-login\nTAI_NOTIFY_FROM=tai@school.example\n", encoding="utf-8", newline="\n")
        out = self.run_script("notify", "status")[1]
        self.assertIn("email:         on (TAI_NOTIFY_EMAIL); NOT configured, missing: SMTP_PASSWORD (tai_credentials.sh smtp)", out)
        (self.live / "credentials.env").write_text(f'SMTP_PASSWORD="{secret}"\n', encoding="utf-8", newline="\n")
        code, out, err = self.run_script("notify", "status")
        self.assertEqual(code, 0, out + err)
        self.assertIn("email:         on (TAI_NOTIFY_EMAIL); configured (server, from address, login and password)", out)
        for private in (secret, "smtp.school.example", "tai-login", "tai@school.example"):
            self.assertNotIn(private, out + err)                  # yes or no, never a value
        # a relay with no login needs no password; and switched off is said, even when everything is there
        (self.live / "orch.env").write_text("TAI_NOTIFY_EMAIL=0\nTAI_SMTP_HOST=smtp.school.example\nTAI_NOTIFY_FROM=tai@school.example\n", encoding="utf-8", newline="\n")
        self.assertIn("email:         off (TAI_NOTIFY_EMAIL); configured (server, from address)", self.run_script("notify", "status")[1])

    def test_the_other_commands_still_take_notify_as_a_setting_and_refuse_a_bad_argument(self):
        code, out, err = self.run_script("set", "TAI_NOTIFY=1")
        self.assertEqual(code, 0, out + err)
        self.assertIn("TAI_NOTIFY=1", self.orch())
        self.assertIn("notify:        on", self.run_script("notify", "status")[1])
        code, out, err = self.run_script("notify", "frobnicate")
        self.assertNotEqual(code, 0)
        self.assertIn("tai_live.sh notify status|vapid [--force]", out + err)
        self.assertNotEqual(self.run_script("notify", "vapid", "--now")[0], 0)


SANDBOX_DOCKER_STUB = r'''#!/usr/bin/env bash
echo "$@" >> "$HOME/docker-calls.txt"
case "$1" in
  image)
    [ -f "$HOME/image-present" ] || exit 1
    case "$*" in
      *"{{.Created}}"*) echo "2026-11-06T22:00:00.123456789Z" ;;
    esac
    exit 0 ;;
  images) echo 1.59GB; exit 0 ;;
  info) [ ! -f "$HOME/runtimes" ] || cat "$HOME/runtimes"; exit 0 ;;
  ps) [ ! -f "$HOME/running" ] || cat "$HOME/running"; exit 0 ;;
  build) if [ -f "$HOME/build-fails" ]; then cat "$HOME/build-fails"; exit 1; fi; exit 0 ;;
  run)
    for a in "$@"; do case "$a" in *:/in:ro) cat "${a%%:/in:ro}/files/go.mod" >> "$HOME/warm-gomod-seen" ;; esac; done
    [ ! -f "$HOME/run-fails" ] || exit 1
    echo "go: downloading github.com/example/mod v1.0.0"; exit 0 ;;
esac
exit 0
'''


@unittest.skipIf(BASH is None, "needs Git Bash (or bash on Linux/macOS)")
class SandboxCommandsTest(unittest.TestCase):
    """`tai_live.sh sandbox build|warm|status|smoke`: the operator's side of running a student's Go code, against a stand-in docker."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        self.home = tmp / "home"
        self.live = self.home / "tai-live"
        self.tree = self.live / "tai"
        self.bin = tmp / "bin"
        self.sandbox = self.tree / "data" / "sandbox"
        for d in (self.home, self.bin, self.tree / "store", self.live / "node" / "bin", self.live / "logs"):
            d.mkdir(parents=True, exist_ok=True)
        (self.bin / "docker").write_text(SANDBOX_DOCKER_STUB, encoding="utf-8", newline="\n")
        (self.bin / "python3").write_text(f'#!/usr/bin/env bash\nexec "{posix(sys.executable)}" "$@"\n', encoding="utf-8", newline="\n")
        (self.live / "node" / "bin" / "node").write_text('#!/usr/bin/env bash\necho "$PWD $*" >> "$HOME/node-calls.txt"\nexit ${NODE_EXIT:-0}\n', encoding="utf-8", newline="\n")
        for path in (self.bin / "docker", self.bin / "python3", self.live / "node" / "bin" / "node"):
            os.chmod(path, 0o755)
        self.env = dict(os.environ, HOME=posix(self.home), TAI_LIVE_DIR=posix(self.live), PATH=str(self.bin) + os.pathsep + os.environ["PATH"])

    def run_script(self, *args, env=None):
        try:
            result = subprocess.run([BASH, posix(SCRIPT), "--on-host", "sandbox", *args], capture_output=True, text=True, env=dict(self.env, **(env or {})), timeout=60)
        except subprocess.TimeoutExpired as err:
            self.fail("the script hung: " + str(err.stdout or b"") + str(err.stderr or b""))
        return result.returncode, result.stdout + result.stderr

    def flag(self, name, text=""):
        (self.home / name).write_text(text, encoding="utf-8", newline="\n")

    def docker_calls(self):
        path = self.home / "docker-calls.txt"
        return path.read_text(encoding="utf-8").splitlines() if path.exists() else []

    def context(self, with_warm=True):
        ctx = self.live / "sandbox-build"
        (ctx / "warm").mkdir(parents=True, exist_ok=True)
        (ctx / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8", newline="\n")
        if with_warm:
            for group, requirement in (("web", "github.com/google/uuid v1.6.0"), ("kafka", "github.com/segmentio/kafka-go v0.4.51")):
                (ctx / "warm" / group).mkdir(parents=True, exist_ok=True)
                (ctx / "warm" / group / "go.mod").write_text(f"module warm{group}\n\ngo 1.27\n\nrequire {requirement}\n", encoding="utf-8", newline="\n")
        return ctx

    # ---- status

    def test_status_without_the_image_says_running_code_is_off(self):
        code, out = self.run_script("status")
        self.assertEqual(code, 0, out)
        self.assertIn("NOT built", out)
        self.assertIn("running code is off", out)

    def test_status_says_the_image_the_cache_the_containers_the_directories_and_the_runs_of_the_last_hour(self):
        self.flag("image-present")
        self.flag("running", "tai-sandbox-0123456789ab\ntai-sandbox-aaaaaaaaaaaa\n")
        (self.sandbox / "gomodcache").mkdir(parents=True)
        (self.sandbox / "gomodcache" / "blob").write_bytes(b"x" * (3 * 1024 * 1024))
        (self.sandbox / "run-0123456789abcdef").mkdir()
        (self.sandbox / "other").mkdir()
        import time
        now = int(time.time() * 1000)
        con = sqlite3.connect(self.tree / "store" / "messages.db")
        con.execute("create table sandbox_runs (student_folder text not null, started_at integer not null)")
        for folder, ago_h in (("ana", 0.1), ("bo", 0.5), ("ana", 0.9), ("ana", 5), ("cy", 30)):
            con.execute("insert into sandbox_runs values (?, ?)", (folder, now - int(ago_h * 3600 * 1000)))
        con.commit()
        con.close()
        code, out = self.run_script("status")
        self.assertEqual(code, 0, out)
        self.assertIn("tai-go-sandbox:live present, 1.59GB, built 2026-11-06T22:00:00", out)
        self.assertIn("module cache: 3 MB", out)
        self.assertIn("2 sandbox container(s) running", out)
        self.assertIn("run dirs:     1 left", out)
        self.assertIn("runs:         3 in the last hour (2 student(s)), 4 in the last day", out)
        self.assertNotIn("ana", out)                                                    # counts only: no student's name

    def test_status_says_the_runtime_of_the_service_and_whether_docker_knows_it(self):
        self.flag("image-present")
        self.assertIn("runtime:      Docker's default (runc; TAI_SANDBOX_RUNTIME is not set)", self.run_script("status")[1])
        (self.live / "orch.env").write_text("TZ=America/Los_Angeles\nTAI_SANDBOX_RUNTIME=runsc\n", encoding="utf-8", newline="\n")
        self.flag("runtimes", "io.containerd.runc.v2 runc runsc \n")
        code, out = self.run_script("status")
        self.assertEqual(code, 0, out)
        self.assertIn("runtime:      runsc (TAI_SANDBOX_RUNTIME; Docker knows it)", out)
        self.flag("runtimes", "io.containerd.runc.v2 runc \n")
        self.assertIn("runtime:      runsc (TAI_SANDBOX_RUNTIME) but Docker does NOT know it: running code is off", self.run_script("status")[1])
        (self.live / "orch.env").write_text("TAI_SANDBOX_RUNTIME=gvisor\n", encoding="utf-8", newline="\n")
        self.assertIn("TAI_SANDBOX_RUNTIME=gvisor is not runc or runsc: running code is off", self.run_script("status")[1])

    def test_status_says_so_when_the_table_is_not_there_yet_or_the_database_cannot_be_read(self):
        sqlite3.connect(self.tree / "store" / "messages.db").close()
        self.assertIn("n/a (no sandbox_runs table yet", self.run_script("status")[1])
        (self.tree / "store" / "messages.db").unlink()
        self.assertIn("no data", self.run_script("status")[1])

    # ---- build

    def test_build_without_the_shipped_context_says_where_it_comes_from(self):
        code, out = self.run_script("build")
        self.assertNotEqual(code, 0)
        self.assertIn("run this from the PC", out)
        self.assertEqual(self.docker_calls(), [])

    def test_build_makes_the_image_with_at_most_two_cpus_and_names_a_mirror_only_when_asked(self):
        ctx = self.context()
        code, out = self.run_script("build")
        self.assertEqual(code, 0, out)
        calls = [c for c in self.docker_calls() if c.startswith("build ")]
        self.assertEqual(len(calls), 1, calls)
        self.assertIn("--cpu-quota=200000", calls[0])
        self.assertIn("--cpu-period=100000", calls[0])
        self.assertIn("--memory=3g --memory-swap=3g", calls[0])
        self.assertIn("-t tai-go-sandbox:live", calls[0])
        self.assertTrue(calls[0].endswith(posix(ctx)), calls[0])
        self.assertNotIn("GO_IMAGE", calls[0])
        code, out = self.run_script("build", "--base", "mirror.gcr.io/library/golang:1.27.3-bookworm")
        self.assertEqual(code, 0, out)
        self.assertIn("--build-arg GO_IMAGE=mirror.gcr.io/library/golang:1.27.3-bookworm", [c for c in self.docker_calls() if c.startswith("build ")][-1])

    def test_build_refuses_what_is_not_an_image_name_and_what_it_does_not_know(self):
        self.context()
        for args in (("--base", "a b"), ("--base", "x;rm -rf /"), ("--base", "$(id)"), ("--base",), ("--frobnicate",)):
            code, out = self.run_script("build", *args)
            self.assertNotEqual(code, 0, args)
        self.assertEqual([c for c in self.docker_calls() if c.startswith("build ")], [])

    def test_a_build_that_hits_the_pull_limit_says_what_to_do_about_it(self):
        self.context()
        self.flag("build-fails", "toomanyrequests: You have reached your unauthenticated pull rate limit.\n")
        code, out = self.run_script("build")
        self.assertNotEqual(code, 0)
        self.assertIn("pull limit", out)
        self.assertIn("sandbox build --base mirror.gcr.io/library/golang", out)
        self.assertIn("did not build", out)

    # ---- warm

    def test_warm_needs_the_image_and_the_list(self):
        self.context()
        code, out = self.run_script("warm")
        self.assertNotEqual(code, 0)
        self.assertIn("no tai-go-sandbox:live yet", out)
        self.flag("image-present")
        shutil.rmtree(self.live / "sandbox-build" / "warm")
        self.context(with_warm=False)
        code, out = self.run_script("warm")
        self.assertNotEqual(code, 0)
        self.assertIn("no warm list", out)

    def test_warm_downloads_through_a_hardened_container_that_runs_only_the_modules_script_and_cleans_up(self):
        self.flag("image-present")
        self.context()
        code, out = self.run_script("warm")
        self.assertEqual(code, 0, out)
        run = [c for c in self.docker_calls() if c.startswith("run ")]
        self.assertEqual(len(run), 2, run)                                             # one download for each module of the warm list
        for line in run:
            self.check_warm_container(line)
        seen = (self.home / "warm-gomod-seen").read_text(encoding="utf-8")
        warm = self.live / "sandbox-build" / "warm"
        self.assertEqual(seen, (warm / "kafka" / "go.mod").read_text(encoding="utf-8") + (warm / "web" / "go.mod").read_text(encoding="utf-8"))
        self.assertTrue((self.sandbox / "gomodcache").is_dir())
        self.assertEqual(list(self.live.glob(".sandbox-warm.*")), [])                  # the temporary directories are gone
        self.assertIn("module cache:", out)
        self.assertIn("2 module(s) of the warm list", out)

    def check_warm_container(self, line):
        for flag in ("--cap-drop ALL", "--security-opt no-new-privileges", "--read-only", "--pids-limit 128", "--cpus 1", "--memory 1g", "--ulimit core=0", "--label tai-sandbox=1",
                     "--name tai-sandbox-warm-", ":/in:ro", f"{posix(self.sandbox / 'gomodcache')}:/gomodcache:rw", "GOPROXY=https://proxy.golang.org", "GOSUMDB=sum.golang.org",
                     "GOTOOLCHAIN=local", "-modcacherw", "tai-go-sandbox:live /usr/local/bin/sandbox-modules 600 -"):
            self.assertIn(flag, line)
        for bad in ("--privileged", "--network none", "docker.sock", "--cap-add", "--device", "/home", ":/etc"):
            self.assertNotIn(bad, line.replace(posix(self.home), "HOME"))

    def test_a_download_that_fails_says_so_and_leaves_nothing_behind(self):
        self.flag("image-present")
        self.flag("run-fails")
        self.context()
        code, out = self.run_script("warm")
        self.assertNotEqual(code, 0)
        self.assertIn("the download of kafka failed", out)
        self.assertEqual(list(self.live.glob(".sandbox-warm.*")), [])

    # ---- smoke

    def test_smoke_needs_a_build_that_has_it_and_the_image(self):
        code, out = self.run_script("smoke")
        self.assertNotEqual(code, 0)
        self.assertIn("deploy first", out)
        (self.tree / "dist" / "sandbox").mkdir(parents=True)
        (self.tree / "dist" / "sandbox" / "smoke.js").write_text("", encoding="utf-8")
        code, out = self.run_script("smoke")
        self.assertNotEqual(code, 0)
        self.assertIn("no tai-go-sandbox:live yet", out)

    def test_smoke_runs_the_compiled_checks_from_the_tree_with_the_arguments_and_returns_their_exit_code(self):
        (self.tree / "dist" / "sandbox").mkdir(parents=True)
        (self.tree / "dist" / "sandbox" / "smoke.js").write_text("", encoding="utf-8")
        self.flag("image-present")
        code, out = self.run_script("smoke", "--only", "hello")
        self.assertEqual(code, 0, out)
        seen = (self.home / "node-calls.txt").read_text(encoding="utf-8").strip()
        self.assertTrue(seen.endswith("dist/sandbox/smoke.js --only hello"), seen)
        self.assertTrue(seen.startswith(posix(self.tree)), seen)
        self.assertEqual(self.run_script("smoke", env={"NODE_EXIT": "1"})[0], 1)

    def test_smoke_runs_on_the_services_runtime_unless_it_is_told_another(self):
        (self.tree / "dist" / "sandbox").mkdir(parents=True)
        (self.tree / "dist" / "sandbox" / "smoke.js").write_text("", encoding="utf-8")
        self.flag("image-present")
        (self.live / "orch.env").write_text("TAI_SANDBOX_RUNTIME=runsc\n", encoding="utf-8", newline="\n")
        code, out = self.run_script("smoke", "--only", "hello")
        self.assertEqual(code, 0, out)
        self.assertIn("the service's runtime: runsc", out)
        code, out = self.run_script("smoke", "--runtime", "runc")
        self.assertEqual(code, 0, out)
        calls = (self.home / "node-calls.txt").read_text(encoding="utf-8").strip().splitlines()
        self.assertTrue(calls[0].endswith("dist/sandbox/smoke.js --only hello --runtime runsc"), calls[0])
        self.assertTrue(calls[1].endswith("dist/sandbox/smoke.js --runtime runc"), calls[1])          # the caller's, not a second one

    def test_an_unknown_sandbox_command_says_what_there_is(self):
        code, out = self.run_script("frobnicate")
        self.assertNotEqual(code, 0)
        self.assertIn("tai_live.sh sandbox build [--base IMAGE] | warm | status | smoke [--only TEXT] [--runtime runc|runsc]", out)


@unittest.skipIf(BASH is None, "needs Git Bash (or bash on Linux/macOS)")
class DocCommandsTest(unittest.TestCase):
    """`tai_live.sh doc build|status|smoke`: the operator's side of the document viewer's renderer, against a stand-in docker."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        self.home = tmp / "home"
        self.live = self.home / "tai-live"
        self.tree = self.live / "tai"
        self.bin = tmp / "bin"
        self.docs_dir = self.tree / "data" / "docs"
        self.store = self.tree / "store" / "portal" / "docs"
        for d in (self.home, self.bin, self.tree / "store", self.live / "node" / "bin", self.live / "logs"):
            d.mkdir(parents=True, exist_ok=True)
        (self.bin / "docker").write_text(SANDBOX_DOCKER_STUB, encoding="utf-8", newline="\n")
        (self.live / "node" / "bin" / "node").write_text('#!/usr/bin/env bash\necho "$PWD $*" >> "$HOME/node-calls.txt"\nexit ${NODE_EXIT:-0}\n', encoding="utf-8", newline="\n")
        for path in (self.bin / "docker", self.live / "node" / "bin" / "node"):
            os.chmod(path, 0o755)
        self.env = dict(os.environ, HOME=posix(self.home), TAI_LIVE_DIR=posix(self.live), PATH=str(self.bin) + os.pathsep + os.environ["PATH"])

    def run_script(self, *args, env=None):
        try:
            result = subprocess.run([BASH, posix(SCRIPT), "--on-host", "doc", *args], capture_output=True, text=True, env=dict(self.env, **(env or {})), timeout=60)
        except subprocess.TimeoutExpired as err:
            self.fail("the script hung: " + str(err.stdout or b"") + str(err.stderr or b""))
        return result.returncode, result.stdout + result.stderr

    def flag(self, name, text=""):
        (self.home / name).write_text(text, encoding="utf-8", newline="\n")

    def docker_calls(self):
        path = self.home / "docker-calls.txt"
        return path.read_text(encoding="utf-8").splitlines() if path.exists() else []

    def context(self):
        ctx = self.live / "doc-build"
        ctx.mkdir(parents=True, exist_ok=True)
        (ctx / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8", newline="\n")
        return ctx

    def keep(self, student, doc_id, size=1024):
        folder = self.store / student / doc_id
        folder.mkdir(parents=True)
        (folder / "p001.png").write_bytes(b"x" * size)

    # ---- status

    def test_status_without_the_image_says_opening_documents_is_off(self):
        code, out = self.run_script("status")
        self.assertEqual(code, 0, out)
        self.assertIn("NOT built", out)
        self.assertIn("opening documents is off", out)
        self.assertIn("0 prepared document(s) of 0 student(s)", out)

    def test_status_says_the_image_the_documents_kept_the_containers_left_and_the_directories_and_never_names_a_student_or_a_document(self):
        self.flag("image-present")
        self.flag("running", "tai-doc-0123456789ab\ntai-doc-aaaaaaaaaaaa\n")
        self.keep("s_" + "a1" * 10, "0" * 31 + "1", 2 * 1024 * 1024)
        self.keep("s_" + "a1" * 10, "0" * 31 + "2", 1024 * 1024)
        self.keep("s_" + "b2" * 10, "0" * 31 + "3", 1024 * 1024)
        (self.store / ("s_" + "b2" * 10) / ".tmp-half").mkdir()          # a half made one is not a document
        (self.store / ("s_" + "b2" * 10) / "notes").mkdir()
        (self.tree / "store" / "course-docs" / ("cd" * 16)).mkdir(parents=True)
        (self.docs_dir / "run-0123456789abcdef").mkdir(parents=True)
        (self.docs_dir / "other").mkdir()
        code, out = self.run_script("status")
        self.assertEqual(code, 0, out)
        self.assertIn("tai-doc:live present, 1.59GB, built 2026-11-06T22:00:00", out)
        self.assertRegex(out, r"3 prepared document\(s\) of 2 student\(s\), [45] MB")        # (du counts the blocks of the directories too)
        self.assertIn("kept 30 days after the last open, at most 8 documents and 60 MB a student; the backup leaves them out", out)
        self.assertIn("course docs:  1 in", out)
        self.assertIn("2 renderer container(s) running or left", out)
        self.assertIn("run dirs:     1 left", out)
        for private in ("a1a1", "b2b2", "0" * 31):
            self.assertNotIn(private, out)

    # ---- build

    def test_build_without_the_shipped_context_says_where_it_comes_from(self):
        code, out = self.run_script("build")
        self.assertNotEqual(code, 0)
        self.assertIn("run this from the PC", out)
        self.assertEqual(self.docker_calls(), [])

    def test_build_makes_the_image_with_at_most_two_cpus_and_3_gb_and_names_another_base_only_when_asked(self):
        ctx = self.context()
        code, out = self.run_script("build")
        self.assertEqual(code, 0, out)
        calls = [c for c in self.docker_calls() if c.startswith("build ")]
        self.assertEqual(len(calls), 1, calls)
        self.assertIn("--cpu-quota=200000", calls[0])
        self.assertIn("--cpu-period=100000", calls[0])
        self.assertIn("--memory=3g --memory-swap=3g", calls[0])
        self.assertIn("-t tai-doc:live", calls[0])
        self.assertTrue(calls[0].endswith(posix(ctx)), calls[0])
        self.assertNotIn("BASE_IMAGE", calls[0])
        self.assertIn("built tai-doc:live", out)
        code, out = self.run_script("build", "--base", "mirror.gcr.io/library/python:3.12-slim")
        self.assertEqual(code, 0, out)
        self.assertIn("--build-arg BASE_IMAGE=mirror.gcr.io/library/python:3.12-slim", [c for c in self.docker_calls() if c.startswith("build ")][-1])

    def test_build_refuses_what_is_not_an_image_name_and_what_it_does_not_know(self):
        self.context()
        for args in (("--base", "a b"), ("--base", "x;rm -rf /"), ("--base", "$(id)"), ("--base",), ("--frobnicate",)):
            code, out = self.run_script("build", *args)
            self.assertNotEqual(code, 0, args)
        self.assertEqual([c for c in self.docker_calls() if c.startswith("build ")], [])

    def test_a_build_that_hits_the_pull_limit_says_what_to_do_about_it(self):
        self.context()
        self.flag("build-fails", "toomanyrequests: You have reached your unauthenticated pull rate limit.\n")
        code, out = self.run_script("build")
        self.assertNotEqual(code, 0)
        self.assertIn("pull limit", out)
        self.assertIn("doc build --base mirror.gcr.io/library/python", out)
        self.assertIn("did not build", out)

    # ---- smoke

    def test_smoke_needs_a_build_that_has_it_and_the_image(self):
        code, out = self.run_script("smoke")
        self.assertNotEqual(code, 0)
        self.assertIn("deploy first", out)
        (self.tree / "dist" / "docs").mkdir(parents=True)
        (self.tree / "dist" / "docs" / "smoke.js").write_text("", encoding="utf-8")
        code, out = self.run_script("smoke")
        self.assertNotEqual(code, 0)
        self.assertIn("no tai-doc:live yet", out)

    def test_smoke_runs_the_compiled_checks_from_the_tree_with_the_arguments_and_returns_their_exit_code(self):
        (self.tree / "dist" / "docs").mkdir(parents=True)
        (self.tree / "dist" / "docs" / "smoke.js").write_text("", encoding="utf-8")
        self.flag("image-present")
        code, out = self.run_script("smoke", "--only", "ten pages")
        self.assertEqual(code, 0, out)
        seen = (self.home / "node-calls.txt").read_text(encoding="utf-8").strip()
        self.assertTrue(seen.endswith("dist/docs/smoke.js --only ten pages"), seen)
        self.assertTrue(seen.startswith(posix(self.tree)), seen)
        self.assertEqual(self.run_script("smoke", env={"NODE_EXIT": "1"})[0], 1)

    def test_an_unknown_doc_command_says_what_there_is(self):
        code, out = self.run_script("frobnicate")
        self.assertNotEqual(code, 0)
        self.assertIn("tai_live.sh doc build [--base IMAGE] | status | smoke", out)


NODE_RECORDER = r'''#!/usr/bin/env bash
echo "$PWD $*" >> "$HOME/node-calls.txt"
{ echo "CANVAS_API_TOKEN=${CANVAS_API_TOKEN:-}"; echo "CANVAS_BASE_URL=${CANVAS_BASE_URL:-}"; echo "CANVAS_COURSE_ID=${CANVAS_COURSE_ID:-}"; } > "$HOME/node-env.txt"
[ -z "${SHIPPED_LOG:-}" ] || find "${TAI_LIVE_DIR}/course-in" -type f 2>/dev/null | sed "s#^${TAI_LIVE_DIR}/course-in/##" | sort >> "$SHIPPED_LOG"
[ -z "${NODE_SAYS:-}" ] || echo "$NODE_SAYS"
exit ${NODE_EXIT:-0}
'''

# a stand-in for ssh that runs the command it is given here, with the fake home, so that the PC side and the host side of a command run together
SSH_HERE = r'''#!/usr/bin/env bash
echo "ssh $*" >> "$HOME/ssh-calls.txt"
cmd="${@: -1}"
exec bash -c "$cmd"
'''


@unittest.skipIf(BASH is None, "needs Git Bash (or bash on Linux/macOS)")
class CourseDocsCommandsTest(unittest.TestCase):
    """`tai_live.sh course-docs add|list|remove|canvas`: the operator's side of the course library, against a stand-in node, docker and ssh."""

    TOKEN = "canvas-token-1234567890-SECRET"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        self.home = tmp / "home"
        self.live = self.home / "tai-live"
        self.tree = self.live / "tai"
        self.bin = tmp / "bin"
        for d in (self.home, self.bin, self.tree / "store", self.live / "node" / "bin", self.live / "logs"):
            d.mkdir(parents=True, exist_ok=True)
        (self.bin / "docker").write_text(SANDBOX_DOCKER_STUB, encoding="utf-8", newline="\n")
        (self.bin / "ssh").write_text(SSH_HERE, encoding="utf-8", newline="\n")
        (self.live / "node" / "bin" / "node").write_text(NODE_RECORDER, encoding="utf-8", newline="\n")
        for path in (self.bin / "docker", self.bin / "ssh", self.live / "node" / "bin" / "node"):
            os.chmod(path, 0o755)
        (self.live / "credentials.env").write_text(
            'CANVAS_BASE_URL="https://canvas.example.edu/api/v1"\nCANVAS_COURSE_ID="260797"\nCANVAS_API_TOKEN="%s"\nGITHUB_TOKEN="another-secret-token"\n' % self.TOKEN, encoding="utf-8", newline="\n")
        self.env = dict(os.environ, HOME=posix(self.home), TAI_LIVE_DIR=posix(self.live), PATH=str(self.bin) + os.pathsep + os.environ["PATH"], TAI_LIVE_HOST="ubuntu@nowhere.example")

    def built(self):
        (self.tree / "dist" / "docs").mkdir(parents=True, exist_ok=True)
        (self.tree / "dist" / "docs" / "course-docs.js").write_text("", encoding="utf-8")

    def flag(self, name, text=""):
        (self.home / name).write_text(text, encoding="utf-8", newline="\n")

    def on_host(self, *args, env=None):
        try:
            result = subprocess.run([BASH, posix(SCRIPT), "--on-host", "course-docs", *args], capture_output=True, text=True, env=dict(self.env, **(env or {})), timeout=60)
        except subprocess.TimeoutExpired as err:
            self.fail("the script hung: " + str(err.stdout or b"") + str(err.stderr or b""))
        return result.returncode, result.stdout + result.stderr

    def from_pc(self, *args, env=None):
        # (the stand-in ssh is put first on the PATH INSIDE bash: a Windows checkout of Git Bash has its own /usr/bin/ssh ahead of what a parent process passes in)
        launcher = 'export PATH="$1:$PATH"; shift; exec bash "$@"'
        try:
            result = subprocess.run([BASH, "-c", launcher, "x", posix(self.bin), posix(SCRIPT), "course-docs", *args], capture_output=True, text=True, env=dict(self.env, **(env or {})), timeout=90)
        except subprocess.TimeoutExpired as err:
            self.fail("the script hung: " + str(err.stdout or b"") + str(err.stderr or b""))
        return result.returncode, result.stdout + result.stderr

    def node_calls(self):
        path = self.home / "node-calls.txt"
        return path.read_text(encoding="utf-8").splitlines() if path.exists() else []

    def ssh_calls(self):
        path = self.home / "ssh-calls.txt"
        return path.read_text(encoding="utf-8").splitlines() if path.exists() else []

    # ---- list, remove

    def test_without_a_build_that_has_the_command_every_subcommand_says_deploy_first_and_runs_nothing(self):
        for args in (("list",), ("remove", "abcdef"), ("rename", "abcdef", "--title", "x"), ("canvas",)):
            code, out = self.on_host(*args)
            self.assertNotEqual(code, 0, args)
            self.assertIn("deploy first", out, args)
        self.assertEqual(self.node_calls(), [])

    def test_list_and_remove_run_the_compiled_command_from_the_tree_with_the_store_and_the_operators_own_run_directory(self):
        self.built()
        code, out = self.on_host("list", env={"NODE_SAYS": "library: 2 deck(s)"})
        self.assertEqual(code, 0, out)
        self.assertIn("library: 2 deck(s)", out)
        code, out = self.on_host("remove", "0123456789ab")
        self.assertEqual(code, 0, out)
        calls = self.node_calls()
        self.assertEqual(len(calls), 2, calls)
        self.assertTrue(calls[0].startswith(posix(self.tree)), calls[0])
        self.assertTrue(calls[0].endswith(f"dist/docs/course-docs.js list --store {posix(self.tree)}/store --data {posix(self.tree)}/data/docs-operator"), calls[0])
        self.assertTrue(calls[1].endswith(f"dist/docs/course-docs.js remove 0123456789ab --store {posix(self.tree)}/store --data {posix(self.tree)}/data/docs-operator"), calls[1])
        self.assertEqual(self.on_host("list", env={"NODE_EXIT": "1"})[0], 1)  # the command's own exit code is the script's

    def test_rename_runs_the_compiled_command_with_its_arguments_as_they_were_given(self):
        self.built()
        code, out = self.on_host("rename", "0123456789ab", "--title", "Day 5 - APIs and Load Balancers", "--week", "5")
        self.assertEqual(code, 0, out)
        calls = self.node_calls()
        self.assertEqual(len(calls), 1, calls)
        self.assertTrue(calls[0].endswith(f"dist/docs/course-docs.js rename 0123456789ab --title Day 5 - APIs and Load Balancers --week 5 --store {posix(self.tree)}/store --data {posix(self.tree)}/data/docs-operator"), calls[0])
        self.assertEqual(self.on_host("rename", "0123456789ab", "--week", "none", env={"NODE_EXIT": "1"})[0], 1)  # the command's own exit code is the script's

    def test_rename_from_the_pc_passes_a_title_on_as_one_word_of_data_and_runs_nothing_it_says(self):
        self.built()
        marker = Path(self.tmp.name) / "marker"
        marker2 = Path(self.tmp.name) / "marker2"
        title = "Raft; touch " + posix(marker) + " $(touch " + posix(marker2) + ") 'q' (x)"
        code, out = self.from_pc("rename", "0123456789ab", "--title", title)
        self.assertEqual(code, 0, out)
        self.assertFalse(marker.exists() or marker2.exists(), "the title was run as a command")
        calls = self.node_calls()
        self.assertEqual(len(calls), 1, calls)
        self.assertIn("rename 0123456789ab --title " + title + " --store ", calls[0])

    def test_an_unknown_subcommand_says_what_there_is(self):
        for args in ((), ("frobnicate",)):
            code, out = self.on_host(*args)
            self.assertNotEqual(code, 0)
            self.assertIn("tai_live.sh course-docs add <file-or-directory> [--title T] [--week N] | list | remove <id> | rename <id> [--title T] [--week N|none] | canvas [--course ID] [--yes] [--allow-host HOST]", out)

    # ---- add

    def test_add_needs_the_shipped_files_the_build_and_the_image_and_says_where_each_comes_from(self):
        code, out = self.on_host("add")
        self.assertNotEqual(code, 0)
        self.assertIn("run this from the PC", out)
        (self.live / "course-in").mkdir()
        code, out = self.on_host("add")
        self.assertIn("deploy first", out)
        self.assertFalse((self.live / "course-in").exists())  # what was shipped is not left lying around
        (self.live / "course-in").mkdir()
        self.built()
        code, out = self.on_host("add")
        self.assertIn("no tai-doc:live yet", out)
        self.assertFalse((self.live / "course-in").exists())
        self.assertEqual(self.node_calls(), [])

    def test_add_runs_the_command_on_the_shipped_directory_with_the_arguments_and_removes_the_files_even_when_it_fails(self):
        self.built()
        self.flag("image-present")
        (self.live / "course-in").mkdir()
        (self.live / "course-in" / "deck.pptx").write_bytes(b"x")
        code, out = self.on_host("add", "--title", "Raft, the deck", "--week", "5")
        self.assertEqual(code, 0, out)
        self.assertIn("every student will see what is added", out)
        self.assertIn("nothing that solves a graded assignment", out)
        call = self.node_calls()[0]
        self.assertTrue(call.endswith(f"dist/docs/course-docs.js add --dir {posix(self.live)}/course-in --title Raft, the deck --week 5 --store {posix(self.tree)}/store --data {posix(self.tree)}/data/docs-operator"), call)
        self.assertFalse((self.live / "course-in").exists())
        (self.live / "course-in").mkdir()
        self.assertEqual(self.on_host("add", env={"NODE_EXIT": "1"})[0], 1)
        self.assertFalse((self.live / "course-in").exists())

    def test_from_the_pc_a_directory_is_shipped_with_the_decks_in_it_and_nothing_else_and_the_host_adds_and_clears_them(self):
        self.built()
        self.flag("image-present")
        decks = Path(self.tmp.name) / "decks"
        (decks / "week5").mkdir(parents=True)
        (decks / ".git").mkdir()
        for name in ("Week 5 Raft.pptx", "syllabus.PDF", "week5/notes.docx", "week5/sheet.xlsx", "notes.txt", "old.ppt", ".hidden.pdf", ".git/x.pdf"):
            (decks / name).write_bytes(b"x")
        (decks / "huge.pdf").write_bytes(b"x" * (21 * 1024 * 1024))
        shipped = self.home / "shipped.txt"
        code, out = self.from_pc("add", str(decks), "--week", "5", env={"SHIPPED_LOG": posix(shipped)})
        self.assertEqual(code, 0, out)
        self.assertEqual(shipped.read_text(encoding="utf-8").split("\n")[:-1], ["Week 5 Raft.pptx", "syllabus.PDF", "week5/notes.docx", "week5/sheet.xlsx"])
        call = self.node_calls()[0]
        # the host is told the command and its flags and nothing of this machine: the path is a place here, and the host adds what was shipped
        self.assertTrue(call.endswith(f"dist/docs/course-docs.js add --dir {posix(self.live)}/course-in --week 5 --store {posix(self.tree)}/store --data {posix(self.tree)}/data/docs-operator"), call)
        self.assertNotIn("decks", call)
        self.assertFalse((self.live / "course-in").exists())
        self.assertEqual(len([c for c in self.ssh_calls() if "tar -xzf" in c]), 1)

    def test_from_the_pc_a_single_file_is_shipped_by_itself(self):
        self.built()
        self.flag("image-present")
        deck = Path(self.tmp.name) / "Week 7 Paxos.pptx"
        deck.write_bytes(b"x")
        shipped = self.home / "shipped.txt"
        code, out = self.from_pc("add", str(deck), "--title", "Paxos", env={"SHIPPED_LOG": posix(shipped)})
        self.assertEqual(code, 0, out)
        self.assertEqual(shipped.read_text(encoding="utf-8").split("\n")[:-1], ["Week 7 Paxos.pptx"])
        call = self.node_calls()[0]
        self.assertTrue(call.endswith(f"dist/docs/course-docs.js add --dir {posix(self.live)}/course-in --title Paxos --store {posix(self.tree)}/store --data {posix(self.tree)}/data/docs-operator"), call)
        self.assertNotIn("Week 7", call)
        # the flags may come before the path, and a title with a comma in it is one argument
        code, out = self.from_pc("add", "--week", "7", "--title", "Paxos, the deck", str(deck))
        self.assertEqual(code, 0, out)
        self.assertTrue(self.node_calls()[1].endswith(f"course-in --week 7 --title Paxos, the deck --store {posix(self.tree)}/store --data {posix(self.tree)}/data/docs-operator"), self.node_calls()[1])

    def test_from_the_pc_it_refuses_what_it_cannot_ship_before_anything_leaves(self):
        empty = Path(self.tmp.name) / "empty"
        empty.mkdir()
        (empty / "readme.txt").write_text("x", encoding="utf-8")
        text = Path(self.tmp.name) / "notes.txt"
        text.write_text("x", encoding="utf-8")
        big = Path(self.tmp.name) / "big.pdf"
        big.write_bytes(b"x" * (21 * 1024 * 1024))
        for args, code_wanted, words in (
            (("add",), 2, "course-docs add <file-or-directory>"),
            (("add", str(Path(self.tmp.name) / "nope")), 2, "no such file or directory"),
            (("add", str(empty), str(empty)), 2, "takes ONE file or directory"),
            (("add", str(text)), 2, "not a PDF, PPTX, DOCX or XLSX file"),
            (("add", str(big)), 1, "over 20 MB"),
            (("add", str(empty)), 1, "no PDF, PPTX, DOCX or XLSX file of at most 20 MB"),
        ):
            code, out = self.from_pc(*args)
            self.assertEqual(code, code_wanted, (args, out))
            self.assertIn(words, out)
        self.assertEqual(self.ssh_calls(), [])
        self.assertEqual(self.node_calls(), [])

    # ---- canvas

    def test_canvas_hands_the_token_and_the_address_over_in_the_environment_only_and_never_prints_a_secret(self):
        self.built()
        code, out = self.on_host("canvas", env={"NODE_SAYS": "Canvas course 260797: 3 file(s)"})
        self.assertEqual(code, 0, out)
        env = (self.home / "node-env.txt").read_text(encoding="utf-8")
        self.assertIn(f"CANVAS_API_TOKEN={self.TOKEN}", env)
        self.assertIn("CANVAS_BASE_URL=https://canvas.example.edu/api/v1", env)
        self.assertIn("CANVAS_COURSE_ID=260797", env)
        self.assertNotIn("GITHUB", env)
        call = self.node_calls()[0]
        self.assertTrue(call.endswith(f"dist/docs/course-docs.js canvas --store {posix(self.tree)}/store --data {posix(self.tree)}/data/docs-operator"), call)
        for secret in (self.TOKEN, "another-secret-token"):
            self.assertNotIn(secret, out)
            self.assertNotIn(secret, call)
            for log in (self.live / "logs").glob("*"):
                self.assertNotIn(secret, log.read_text(encoding="utf-8", errors="replace"))

    def test_canvas_passes_the_course_and_the_flags_on_and_a_download_needs_the_image(self):
        self.built()
        code, out = self.on_host("canvas", "--course", "12345")
        self.assertEqual(code, 0, out)
        self.assertIn("canvas --course 12345 --store", self.node_calls()[0])
        code, out = self.on_host("canvas", "--yes")
        self.assertNotEqual(code, 0)
        self.assertIn("no tai-doc:live yet", out)
        self.assertEqual(len(self.node_calls()), 1)  # the listing alone needs no image: a download does
        self.flag("image-present")
        code, out = self.on_host("canvas", "--yes", "--allow-host", "files.school.example")
        self.assertEqual(code, 0, out)
        self.assertIn("canvas --yes --allow-host files.school.example --store", self.node_calls()[1])

    def test_canvas_says_what_is_missing_when_no_credentials_are_stored_and_runs_nothing(self):
        self.built()
        (self.live / "credentials.env").write_text('CANVAS_COURSE_ID="260797"\n', encoding="utf-8")
        code, out = self.on_host("canvas")
        self.assertNotEqual(code, 0)
        self.assertIn("no Canvas address or token is stored on this host: tai_credentials.sh canvas", out)
        (self.live / "credentials.env").unlink()
        code, out = self.on_host("canvas")
        self.assertNotEqual(code, 0)
        self.assertIn("run tai_credentials.sh first", out)
        self.assertEqual(self.node_calls(), [])

    def test_doc_status_counts_the_library_by_its_decks_and_the_operators_own_containers(self):
        self.flag("image-present")
        self.flag("running", "tai-doc-0123456789ab\n")
        (self.tree / "store" / "course-docs" / ("cd" * 16)).mkdir(parents=True)
        (self.tree / "store" / "course-docs" / ".tmp-half").mkdir()
        (self.tree / "store" / "course-docs" / ".lock").mkdir()
        try:
            result = subprocess.run([BASH, posix(SCRIPT), "--on-host", "doc", "status"], capture_output=True, text=True, env=self.env, timeout=60)
        except subprocess.TimeoutExpired as err:
            self.fail(str(err))
        out = result.stdout + result.stderr
        self.assertIn("course docs:  1 in", out)
        self.assertIn("tai_live.sh course-docs list", out)
        self.assertIn("of the operator's", out)


if __name__ == "__main__":
    unittest.main()
