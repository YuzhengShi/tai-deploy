"""deploy/cs6650/tai_credentials.sh: how TAi gets the course credentials (plan section 30). Run: python3 deploy/cs6650/test_tai_credentials.py

Two parts. The checks themselves (the python the script runs against Canvas, GitHub and Piazza) are imported out of the script and
run against a fake fetch and a fake piazza_api: what they report, that a failure says nothing of the secret, and that a redirect to
another host is refused. The host side of the script runs under bash against a fake home, with the checks replaced by a stub
(TAI_PROBE_CMD) and the values typed on stdin as the operator would at the hidden prompts. What matters there: a value is stored
exactly as typed (quotes, dollar signs, spaces) in the one format TAi's .env reader reads back, a service whose check fails keeps
what it had, and no value ever reaches the output.
"""
import contextlib
import http.server
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "tai_credentials.sh"


def posix(path) -> str:
    text = Path(path).as_posix()
    return "/" + text[0].lower() + text[2:] if os.name == "nt" and text[1:2] == ":" else text


def find_bash():
    if os.name != "nt":
        return shutil.which("bash")
    for root in filter(None, [os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"),
                              os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs"), "D:\\Program Files (x86)"]):
        candidate = Path(root) / "Git" / "bin" / "bash.exe"          # never System32's WSL launcher
        if candidate.exists():
            return str(candidate)
    return None


BASH = find_bash()


def read_env(text):
    """TAi's readEnvFile (src/env.ts): the first = splits, the value is trimmed, one pair of matching quotes comes off, nothing else."""
    out = {}
    for line in text.split("\n"):
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        key, value = t.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if value:
            out[key.strip()] = value
    return out


def load_probe(directory):
    text = SCRIPT.read_text(encoding="utf-8")
    source = re.search(r"cat > \"\$probe_py\" <<'PY'\n(.*?)\nPY\n", text, re.S).group(1)
    path = Path(directory) / "probe.py"
    path.write_text(source, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("tai_probe", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def routes_fetch(routes):
    calls = []

    def fetch(url, headers):
        calls.append((url, dict(headers)))
        for prefix, answer in routes.items():
            if url.startswith(prefix):
                return answer
        return 0, None, {}
    return fetch, calls


CANVAS = "https://canvas.example/api/v1"
CANVAS_ENV = {"CANVAS_BASE_URL": CANVAS, "CANVAS_COURSE_ID": "239676", "CANVAS_API_TOKEN": "TOKEN-CANVAS-1234567890"}
PIAZZA_ENV = {"PIAZZA_EMAIL": "ada@example.com", "PIAZZA_PASSWORD": "pw-SECRET-xyz", "PIAZZA_NETWORK_ID": "abc123def"}


class FakePiazza:
    """The part of piazza_api the check uses. Behaviour is set on the class by the tests."""
    login_error = None
    classes = [{"nid": "abc123def", "num": "CS6650"}]

    def user_login(self, email, password):
        if FakePiazza.login_error:
            raise FakePiazza.login_error(f"bad login for {email} with {password}")      # a library that quotes what it was given

    def get_user_classes(self):
        return FakePiazza.classes


def fake_piazza_module():
    module = type(sys)("piazza_api")
    module.Piazza = FakePiazza
    FakePiazza.login_error = None
    FakePiazza.classes = [{"nid": "abc123def", "num": "CS6650"}]
    return module


class ChecksTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.probe = load_probe(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def with_fetch(self, routes):
        fetch, calls = routes_fetch(routes)
        patcher = mock.patch.object(self.probe, "fetch", fetch)
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls

    def test_deepgram_says_whose_key_it_is_and_never_what_the_key_is(self):
        calls = self.with_fetch({"https://api.deepgram.com/v1/auth/token": (200, {"accessor_id": "x", "scopes": ["member"]}, {})})
        facts = {}
        verdict, message = self.probe.check_deepgram({"DEEPGRAM_API_KEY": "DG-SECRET-0123456789"}, facts)
        self.assertEqual(verdict, "ok")
        self.assertIn("member", message)
        self.assertNotIn("DG-SECRET-0123456789", message)
        self.assertEqual(facts["deepgram"], {"scopes": ["member"]})
        self.assertEqual(calls[0][1]["Authorization"], "Token DG-SECRET-0123456789")

    def test_deepgram_refusal_and_silence_are_failures_and_nothing_set_is_a_skip(self):
        self.with_fetch({"https://api.deepgram.com/": (401, None, {})})
        verdict, message = self.probe.check_deepgram({"DEEPGRAM_API_KEY": "DG-SECRET-0123456789"}, {})
        self.assertEqual(verdict, "fail")
        self.assertIn("401", message)
        self.assertNotIn("DG-SECRET-0123456789", message)
        self.with_fetch({})
        self.assertEqual(self.probe.check_deepgram({"DEEPGRAM_API_KEY": "DG-SECRET-0123456789"}, {})[0], "fail")
        self.assertEqual(self.probe.check_deepgram({}, {})[0], "skip")

    def test_deepseek_checks_the_balance_and_the_model_list_and_never_prints_the_key_or_the_amount(self):
        calls = self.with_fetch({
            "https://api.deepseek.com/user/balance": (200, {"is_available": True, "balance_infos": [{"currency": "USD", "total_balance": "5.00"}]}, {}),
            "https://api.deepseek.com/models": (200, {"object": "list", "data": [{"id": "deepseek-flash"}, {"id": "deepseek-v4-pro"}]}, {}),
        })
        facts = {}
        verdict, message = self.probe.check_deepseek({"DEEPSEEK_API_KEY": "sk-DEEPSEEK-0123456789"}, facts)
        self.assertEqual(verdict, "ok")
        self.assertIn("enough for calls", message)
        self.assertNotIn("sk-DEEPSEEK-0123456789", message)
        self.assertNotIn("5.00", message)
        self.assertEqual(facts["deepseek"], {"balanceAvailable": True, "models": ["deepseek-flash", "deepseek-v4-pro"]})
        self.assertEqual({u for u, _ in calls}, {"https://api.deepseek.com/user/balance", "https://api.deepseek.com/models"})     # both read-only
        self.assertTrue(all(h["Authorization"] == "Bearer sk-DEEPSEEK-0123456789" for _, h in calls))

    def test_deepseek_with_an_empty_balance_or_a_renamed_model_is_stored_with_a_warning_not_refused(self):
        self.with_fetch({
            "https://api.deepseek.com/user/balance": (200, {"is_available": False, "balance_infos": []}, {}),
            "https://api.deepseek.com/models": (200, {"data": [{"id": "deepseek-flash"}]}, {}),
        })
        verdict, message = self.probe.check_deepseek({"DEEPSEEK_API_KEY": "sk-DEEPSEEK-0123456789"}, {})
        self.assertEqual(verdict, "ok")                                                  # the key is fine: topping up is the account owner's step
        self.assertIn("EMPTY", message)
        self.assertIn("402", message)

        self.with_fetch({
            "https://api.deepseek.com/user/balance": (200, {"is_available": True}, {}),
            "https://api.deepseek.com/models": (200, {"data": [{"id": "deepseek-v9"}]}, {}),
        })
        verdict, message = self.probe.check_deepseek({"DEEPSEEK_API_KEY": "sk-DEEPSEEK-0123456789"}, {})
        self.assertEqual(verdict, "ok")
        self.assertIn("NOT in its model list", message)
        self.assertIn("deepseek-v9", message)

        self.with_fetch({"https://api.deepseek.com/user/balance": (200, {"is_available": True}, {}), "https://api.deepseek.com/models": (500, None, {})})
        verdict, message = self.probe.check_deepseek({"DEEPSEEK_API_KEY": "sk-DEEPSEEK-0123456789"}, {})
        self.assertEqual(verdict, "ok")
        self.assertIn("could not be read", message)

    def test_deepseek_refusal_and_silence_are_failures_and_nothing_set_is_a_skip(self):
        self.with_fetch({"https://api.deepseek.com/user/balance": (401, None, {})})
        verdict, message = self.probe.check_deepseek({"DEEPSEEK_API_KEY": "sk-DEEPSEEK-0123456789"}, {})
        self.assertEqual(verdict, "fail")
        self.assertIn("401", message)
        self.assertNotIn("sk-DEEPSEEK-0123456789", message)
        self.with_fetch({"https://api.deepseek.com/user/balance": (503, None, {})})
        self.assertEqual(self.probe.check_deepseek({"DEEPSEEK_API_KEY": "sk-DEEPSEEK-0123456789"}, {})[0], "fail")
        self.with_fetch({})
        self.assertEqual(self.probe.check_deepseek({"DEEPSEEK_API_KEY": "sk-DEEPSEEK-0123456789"}, {})[0], "fail")
        self.assertEqual(self.probe.check_deepseek({}, {})[0], "skip")

    def with_post(self, answer):
        calls = []

        def post(url, headers, body):
            calls.append((url, dict(headers), body))
            return answer

        patcher = mock.patch.object(self.probe, "post_json", post)
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls

    def test_zai_asks_the_model_one_tiny_question_and_never_prints_the_key(self):
        calls = self.with_post((200, {"choices": [{"message": {"content": "ok"}}], "usage": {"prompt_tokens": 12, "completion_tokens": 2}}, {}))
        facts = {}
        verdict, message = self.probe.check_zai({"ZAI_API_KEY": "zai-KEY-0123456789.abcdef"}, facts)
        self.assertEqual(verdict, "ok")
        self.assertNotIn("zai-KEY-0123456789", message)
        self.assertEqual(facts["zai"], {"model": "glm-5.3-flash", "endpoint": "https://api.z.ai/api/coding/paas/v4", "inputTokens": 12, "outputTokens": 2})
        self.assertEqual(len(calls), 1)
        url, headers, body = calls[0]
        self.assertEqual(url, "https://api.z.ai/api/coding/paas/v4/chat/completions")   # the endpoint the gateway calls: the GLM Coding Plan's OpenAI chat completions
        self.assertEqual(headers["Authorization"], "Bearer zai-KEY-0123456789.abcdef")
        self.assertEqual(body["model"], "glm-5.3-flash")
        self.assertEqual(body["thinking"], {"type": "disabled"})                          # as the gateway sends it: the check costs a handful of tokens
        self.assertLessEqual(body["max_tokens"], 64)                                      # a check, not a conversation

    def test_zai_refusal_a_wrong_model_and_silence_are_failures_a_rate_limit_is_not_and_nothing_set_is_a_skip(self):
        key = {"ZAI_API_KEY": "zai-KEY-0123456789.abcdef"}
        for status in (401, 403):
            self.with_post((status, None, {}))
            verdict, message = self.probe.check_zai(key, {})
            self.assertEqual(verdict, "fail")
            self.assertIn("refused", message)
            self.assertNotIn("zai-KEY", message)
        for status in (404, 500, 0):
            self.with_post((status, None, {}))
            verdict, message = self.probe.check_zai(key, {})
            self.assertEqual(verdict, "fail", status)
            self.assertNotIn("zai-KEY", message)
        self.with_post((429, None, {}))                                           # the key is fine: the quota or the rate limit answered
        verdict, message = self.probe.check_zai(key, {})
        self.assertEqual(verdict, "ok")
        self.assertIn("429", message)
        self.assertEqual(self.probe.check_zai({}, {})[0], "skip")

    def test_canvas_reports_who_the_token_belongs_to_and_its_role(self):
        calls = self.with_fetch({
            CANVAS + "/users/self/courses": (200, [{"id": 1, "enrollments": []}, {"id": 239676, "enrollments": [{"type": "ta"}, {"type": "student"}]}], {}),
            CANVAS + "/users/self": (200, {"id": 77, "name": "Ada Lovelace"}, {}),
            CANVAS + "/courses/239676": (200, {"name": "CS6650"}, {}),
        })
        facts = {}
        verdict, message = self.probe.check_canvas(CANVAS_ENV, facts)
        self.assertEqual(verdict, "ok")
        for part in ("Ada Lovelace", "77", "CS6650"):
            self.assertIn(part, message)
        self.assertEqual(facts["canvas"], {"userId": 77, "name": "Ada Lovelace", "course": "CS6650", "role": "student, ta"})
        self.assertTrue(all(headers["Authorization"] == "Bearer " + CANVAS_ENV["CANVAS_API_TOKEN"] for _, headers in calls))
        self.assertNotIn(CANVAS_ENV["CANVAS_API_TOKEN"], message)

    def test_canvas_failures_say_what_happened_and_nothing_of_the_token(self):
        self.with_fetch({CANVAS + "/users/self": (401, None, {})})
        verdict, message = self.probe.check_canvas(CANVAS_ENV, {})
        self.assertEqual(verdict, "fail")
        self.assertIn("401", message)
        self.assertNotIn(CANVAS_ENV["CANVAS_API_TOKEN"], message)

        self.with_fetch({CANVAS + "/users/self": (200, {"id": 1, "name": "x"}, {}), CANVAS + "/courses/239676": (404, None, {})})
        verdict, message = self.probe.check_canvas(CANVAS_ENV, {})
        self.assertEqual(verdict, "fail")
        self.assertIn("239676", message)
        self.assertIn("404", message)

        self.assertEqual(self.probe.check_canvas({}, {})[0], "skip")
        self.assertEqual(self.probe.check_canvas({"CANVAS_BASE_URL": CANVAS, "CANVAS_COURSE_ID": "1"}, {})[0], "fail")       # a token is missing

    def test_github_checks_each_token_against_its_own_host_and_shows_the_scopes(self):
        calls = self.with_fetch({
            "https://github.example/api/v3/user": (200, {"login": "ada-ghe"}, {"X-OAuth-Scopes": "read:org, repo"}),
            "https://api.github.com/user": (200, {"login": "ada"}, {}),
        })
        env = {"GITHUB_BASE_URL": "https://github.example/api/v3", "GITHUB_TOKEN": "ENT-TOKEN-1234567890", "GITHUB_TOKEN_PUBLIC": "PUB-TOKEN-1234567890"}
        facts = {}
        verdict, message = self.probe.check_github(env, facts)
        self.assertEqual(verdict, "ok")
        self.assertEqual(facts["github"]["enterprise"], {"login": "ada-ghe", "scopes": "read:org, repo"})
        self.assertEqual(facts["github"]["github.com"]["login"], "ada")
        sent = [(u, h["Authorization"]) for u, h in calls]
        self.assertIn(("https://github.example/api/v3/user", "Bearer ENT-TOKEN-1234567890"), sent)
        self.assertIn(("https://api.github.com/user", "Bearer PUB-TOKEN-1234567890"), sent)
        self.assertNotIn("TOKEN", message)

    def test_github_refuses_an_enterprise_address_the_tool_would_not_treat_as_enterprise(self):
        calls = self.with_fetch({})
        verdict, message = self.probe.check_github({"GITHUB_BASE_URL": "https://git.example/api/v3", "GITHUB_TOKEN": "ENT-TOKEN-1234567890"}, {})
        self.assertEqual(verdict, "fail")
        self.assertIn("git.example", message)
        self.assertIn("api.github.com", message)
        self.assertEqual(calls, [])                                                    # the token went nowhere

    def test_a_github_com_only_course_keeps_its_one_token_under_both_names_and_only_github_com_is_asked(self):
        calls = self.with_fetch({"https://api.github.com/user": (200, {"login": "ada"}, {"X-OAuth-Scopes": "repo"})})
        facts = {}
        verdict, message = self.probe.check_github({"GITHUB_TOKEN": "PUB-TOKEN-1234567890", "GITHUB_TOKEN_PUBLIC": "PUB-TOKEN-1234567890"}, facts)
        self.assertEqual(verdict, "ok")
        self.assertEqual(list(facts["github"]), ["github.com"])
        self.assertEqual([u for u, _ in calls], ["https://api.github.com/user"])
        self.assertEqual(self.probe.check_github({}, {})[0], "skip")

    def test_a_github_token_with_no_address_that_is_not_the_public_one_is_refused(self):
        calls = self.with_fetch({})
        verdict, message = self.probe.check_github({"GITHUB_TOKEN": "ENT-TOKEN-1234567890"}, {})
        self.assertEqual(verdict, "fail")
        self.assertIn("without an enterprise address", message)
        self.assertEqual(calls, [])                                                    # it went nowhere

    def test_piazza_logs_in_and_finds_the_class(self):
        with mock.patch.dict(sys.modules, {"piazza_api": fake_piazza_module()}):
            facts = {}
            verdict, message = self.probe.check_piazza(PIAZZA_ENV, facts)
        self.assertEqual(verdict, "ok")
        self.assertIn("CS6650", message)
        self.assertEqual(facts["piazza"], {"class": "CS6650"})

    def test_piazza_failures_never_repeat_what_the_library_says(self):
        with mock.patch.dict(sys.modules, {"piazza_api": fake_piazza_module()}):
            FakePiazza.login_error = ValueError
            verdict, message = self.probe.check_piazza(PIAZZA_ENV, {})
            self.assertEqual(verdict, "fail")
            self.assertIn("ValueError", message)
            self.assertIn("SSO", message)
            self.assertNotIn("pw-SECRET-xyz", message)
            self.assertNotIn("ada@example.com", message)

            FakePiazza.login_error = None
            FakePiazza.classes = [{"nid": "other", "num": "CS1"}]
            verdict, message = self.probe.check_piazza(PIAZZA_ENV, {})
            self.assertEqual(verdict, "fail")
            self.assertIn("abc123def", message)
            self.assertIn("1 class", message)

            self.assertEqual(self.probe.check_piazza({}, {})[0], "skip")
            self.assertEqual(self.probe.check_piazza({"PIAZZA_EMAIL": "a@b.c"}, {})[0], "fail")

    def test_main_prints_a_result_line_per_service_facts_and_no_secret(self):
        self.with_fetch({
            CANVAS + "/users/self/courses": (200, [], {}),
            CANVAS + "/users/self": (200, {"id": 77, "name": "Ada"}, {}),
            CANVAS + "/courses/239676": (200, {"name": "CS6650"}, {}),
        })
        cand = Path(self.tmp.name) / "cand.env"
        cand.write_text("".join(f'{k}="{v}"\n' for k, v in dict(CANVAS_ENV, **PIAZZA_ENV).items()), encoding="utf-8")
        captured = io.StringIO()
        with mock.patch.dict(sys.modules, {"piazza_api": fake_piazza_module()}), mock.patch.object(sys, "argv", ["probe", str(cand)]), contextlib.redirect_stdout(captured):
            self.probe.main()
        out = captured.getvalue()
        self.assertEqual(re.findall(r"^RESULT (\w+) (\w+)$", out, re.M), [("canvas", "ok"), ("github", "skip"), ("piazza", "ok"), ("deepgram", "skip"), ("deepseek", "skip"), ("zai", "skip"), ("smtp", "skip")])
        facts = json.loads(re.search(r"^FACTS (.*)$", out, re.M).group(1))
        self.assertEqual(facts["canvas"]["userId"], 77)
        self.assertEqual(facts["piazza"]["class"], "CS6650")
        for secret in (CANVAS_ENV["CANVAS_API_TOKEN"], PIAZZA_ENV["PIAZZA_PASSWORD"]):
            self.assertNotIn(secret, out)

    def test_a_redirect_to_another_host_is_refused_and_takes_no_authorization_along(self):
        seen = []

        class Thief(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(dict(self.headers))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        thief = http.server.HTTPServer(("127.0.0.1", 0), Thief)

        class Redirector(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", f"http://localhost:{thief.server_address[1]}/steal")        # same machine, another host name
                self.end_headers()

            def log_message(self, *args):
                pass

        front = http.server.HTTPServer(("127.0.0.1", 0), Redirector)
        for server in (thief, front):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            status, data, _ = self.probe.fetch(f"http://127.0.0.1:{front.server_address[1]}/x", {"Authorization": "Bearer SECRET-TOKEN"})
        finally:
            for server in (thief, front):
                server.shutdown()
        self.assertEqual((status, data), (302, None))
        self.assertEqual(seen, [])


STUB_PROBE = r'''
import json, sys
env = {}
for line in open(sys.argv[2], encoding="utf-8").read().split("\n"):
    t = line.strip()
    if t and not t.startswith("#") and "=" in t:
        k, v = t.split("=", 1)
        if len(v) >= 2 and v[0] == v[-1] == '"':
            v = v[1:-1]
        env[k] = v
facts = {}
def verdict(keys, bad):
    values = [env.get(k, "") for k in keys]
    if not any(values):
        return "skip"
    if not all(values) or any(bad(v) for v in values):
        return "fail"
    return "ok"
canvas = verdict(["CANVAS_BASE_URL", "CANVAS_COURSE_ID", "CANVAS_API_TOKEN"], lambda v: v.startswith("BAD"))
github = "skip" if not (env.get("GITHUB_TOKEN") or env.get("GITHUB_TOKEN_PUBLIC")) else ("fail" if any(v.startswith("BAD") for k, v in env.items() if k.startswith("GITHUB_TOKEN")) else "ok")
piazza = verdict(["PIAZZA_EMAIL", "PIAZZA_PASSWORD", "PIAZZA_NETWORK_ID"], lambda v: v == "wrong")
deepgram = verdict(["DEEPGRAM_API_KEY"], lambda v: v.startswith("BAD"))
deepseek = verdict(["DEEPSEEK_API_KEY"], lambda v: v.startswith("BAD"))
zai = verdict(["ZAI_API_KEY"], lambda v: v.startswith("BAD"))
smtp = verdict(["SMTP_PASSWORD"], lambda v: v.startswith("BAD"))
import os
json.dump({k: env.get(k) for k in ("TAI_SMTP_HOST", "TAI_SMTP_PORT", "TAI_SMTP_USER")}, open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "seen-smtp.json"), "w"))
if canvas == "ok":
    facts["canvas"] = {"userId": 77, "name": "Ada"}
if piazza == "ok":
    facts["piazza"] = {"class": "CS6650"}
for name, result in (("canvas", canvas), ("github", github), ("piazza", piazza), ("deepgram", deepgram), ("deepseek", deepseek), ("zai", zai), ("smtp", smtp)):
    print("  %-6s %s" % (name, result))
    print("RESULT %s %s" % (name, result))
print("FACTS " + json.dumps(facts))
'''

HOSTILE = "1~a$b\"c'd#e!f\\g`h$(id)${HOME}=x"            # every character a shell, a .env reader or pi's config resolver could take for syntax
CANVAS_LINES = ["", "", HOSTILE]                        # the defaults for the address and the course, then the token
GITHUB_NONE = ["", "", ""]                              # no enterprise token, no github.com token, no organisations
PIAZZA_NONE = ["", "", ""]


@unittest.skipIf(BASH is None, "needs Git Bash (or bash on Linux/macOS)")
class HostSideTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        self.home = tmp / "home"
        self.live = self.home / "tai-live"
        self.bin = tmp / "bin"
        self.home.mkdir()
        self.bin.mkdir()
        stub = tmp / "stub_probe.py"
        stub.write_text(STUB_PROBE, encoding="utf-8")
        (self.bin / "python3").write_text(f'#!/usr/bin/env bash\nexec "{posix(sys.executable)}" "$@"\n', encoding="utf-8", newline="\n")
        (self.bin / "docker").write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8", newline="\n")
        for name in ("python3", "docker"):
            os.chmod(self.bin / name, 0o755)
        self.env = dict(os.environ, HOME=posix(self.home), TAI_LIVE_DIR=posix(self.live), TAI_PROBE_CMD=f"python3 {posix(stub)}",
                        PATH=str(self.bin) + os.pathsep + os.environ["PATH"])

    def run_script(self, lines, *args):
        result = subprocess.run([BASH, posix(SCRIPT), "--on-host", *args], input="\n".join(lines) + "\n", capture_output=True, text=True, env=self.env, timeout=120)
        return result.returncode, result.stdout + result.stderr

    def stored(self):
        path = self.live / "credentials.env"
        return read_env(path.read_text(encoding="utf-8")) if path.exists() else {}

    def test_a_value_is_stored_exactly_as_typed_in_the_format_tais_reader_reads_back(self):
        password = '  p"a ss\'$x\\y`z  '
        code, out = self.run_script(CANVAS_LINES + GITHUB_NONE + ["ada@example.com", password, "https://piazza.com/class/abc123def"])
        self.assertEqual(code, 0, out)
        stored = self.stored()
        self.assertEqual(stored["CANVAS_API_TOKEN"], HOSTILE)
        self.assertEqual(stored["PIAZZA_PASSWORD"], password)                   # the spaces inside the quotes stay
        self.assertEqual(stored["PIAZZA_NETWORK_ID"], "abc123def")              # the id out of the pasted address
        self.assertEqual(stored["CANVAS_BASE_URL"], "https://northeastern.instructure.com/api/v1")
        self.assertEqual(stored["CANVAS_COURSE_ID"], "260797")
        for secret in (HOSTILE, password.strip()):
            self.assertNotIn(secret, out)
        text = (self.live / "credentials.env").read_text(encoding="utf-8")
        self.assertIn(f'CANVAS_API_TOKEN="{HOSTILE}"', text)
        if os.name != "nt":
            self.assertEqual((self.live / "credentials.env").stat().st_mode & 0o777, 0o600)

    def test_a_service_whose_check_fails_keeps_what_it_had(self):
        self.assertEqual(self.run_script(CANVAS_LINES + GITHUB_NONE + PIAZZA_NONE)[0], 0)
        before = self.stored()
        code, out = self.run_script(["", "", "BADtoken0123456789"] + GITHUB_NONE + PIAZZA_NONE)
        self.assertEqual(code, 1)
        self.assertIn("NOT stored", out)
        self.assertIn("canvas", out)
        self.assertEqual(self.stored(), before)
        self.assertNotIn("BADtoken0123456789", out)

    def test_only_the_asked_service_is_touched(self):
        self.assertEqual(self.run_script(CANVAS_LINES + GITHUB_NONE + ["ada@example.com", "pw0123456789", "abc123def"])[0], 0)
        code, out = self.run_script(["", "", "NEWTOKEN-0123456789"], "canvas")
        self.assertEqual(code, 0, out)
        stored = self.stored()
        self.assertEqual(stored["CANVAS_API_TOKEN"], "NEWTOKEN-0123456789")
        self.assertEqual(stored["PIAZZA_PASSWORD"], "pw0123456789")

    def test_a_secret_pasted_at_the_wrong_prompt_is_refused_unshown(self):
        pasted = "ghp_THISISATOKENPASTEDINTHEWRONGPLACE"
        code, out = self.run_script([pasted, "", "", HOSTILE] + GITHUB_NONE + PIAZZA_NONE)         # the address prompt gets the token, asks again
        self.assertEqual(code, 0, out)
        self.assertIn("does not look like", out)
        self.assertNotIn(pasted, out)
        self.assertEqual(self.stored()["CANVAS_BASE_URL"], "https://northeastern.instructure.com/api/v1")

    def test_the_address_is_normalised_to_end_in_api_v1(self):
        code, out = self.run_script(["https://canvas.example.edu/", "42", "TOKEN-0123456789"] + GITHUB_NONE + PIAZZA_NONE)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.stored()["CANVAS_BASE_URL"], "https://canvas.example.edu/api/v1")
        self.assertEqual(self.stored()["CANVAS_COURSE_ID"], "42")

    def test_github_asks_for_github_com_first_and_an_enterprise_address_only_with_an_enterprise_token(self):
        # the github.com token, then an enterprise token (empty here: no address is asked), then the organisations
        code, out = self.run_script(CANVAS_LINES + ["PUBTOKEN-0123456789", "", "cs6650-course"] + PIAZZA_NONE)
        self.assertEqual(code, 0, out)
        stored = self.stored()
        self.assertNotIn("GITHUB_BASE_URL", stored)
        self.assertEqual(stored["GITHUB_TOKEN_PUBLIC"], "PUBTOKEN-0123456789")
        # TAi's github_query tool does not run unless GITHUB_TOKEN is set, so a github.com-only course keeps its token under both names
        self.assertEqual(stored["GITHUB_TOKEN"], "PUBTOKEN-0123456789")
        self.assertEqual(stored["GITHUB_ALLOWED_ORGS"], "cs6650-course")
        self.assertNotIn("PUBTOKEN-0123456789", out)

        # a university with its own server adds an enterprise token: Enter keeps the github.com one, the address defaults to Khoury's
        code, out = self.run_script(["", "ENTTOKEN-0123456789", "", ""], "github")
        self.assertEqual(code, 0, out)
        stored = self.stored()
        self.assertEqual(stored["GITHUB_BASE_URL"], "https://github.khoury.northeastern.edu/api/v3")
        self.assertEqual(stored["GITHUB_TOKEN"], "ENTTOKEN-0123456789")
        self.assertEqual(stored["GITHUB_TOKEN_PUBLIC"], "PUBTOKEN-0123456789")

        # removing the github.com one leaves the enterprise one (a stored enterprise token is not the copy: it has an address)
        code, out = self.run_script(["-", "", "", ""], "github")
        self.assertEqual(code, 0, out)
        stored = self.stored()
        self.assertEqual(stored["GITHUB_TOKEN"], "ENTTOKEN-0123456789")
        self.assertNotIn("GITHUB_TOKEN_PUBLIC", stored)

    def test_running_the_github_step_again_does_not_mistake_the_copy_for_an_enterprise_token(self):
        self.assertEqual(self.run_script(CANVAS_LINES + ["PUBTOKEN-0123456789", "", ""] + PIAZZA_NONE)[0], 0)
        code, out = self.run_script(["", "", ""], "github")              # Enter everywhere: nothing changes, no address is asked
        self.assertEqual(code, 0, out)
        stored = self.stored()
        self.assertEqual((stored["GITHUB_TOKEN"], stored["GITHUB_TOKEN_PUBLIC"]), ("PUBTOKEN-0123456789", "PUBTOKEN-0123456789"))
        self.assertNotIn("GITHUB_BASE_URL", stored)

    def test_enter_reuses_what_the_weekly_loop_already_has_without_showing_it(self):
        loops = self.home / ".cs6650-loops"
        loops.mkdir()
        (loops / "secrets.env").write_text("PIAZZA_EMAIL=loop@example.com\nPIAZZA_PASSWORD=loop\\ pass\\$word\nCANVAS_TOKEN=LOOPTOKEN-0123456789\n", encoding="utf-8", newline="\n")
        code, out = self.run_script(["", "", ""] + GITHUB_NONE + ["", "", "abc123def"])
        self.assertEqual(code, 0, out)
        stored = self.stored()
        self.assertEqual(stored["CANVAS_API_TOKEN"], "LOOPTOKEN-0123456789")
        self.assertEqual(stored["PIAZZA_EMAIL"], "loop@example.com")
        self.assertEqual(stored["PIAZZA_PASSWORD"], "loop pass$word")
        self.assertNotIn("LOOPTOKEN-0123456789", out)
        self.assertNotIn("pass$word", out)

    def test_enter_reuses_the_deepgram_key_noras_voice_already_has_without_showing_it(self):
        world = self.home / "cs6650-world"
        world.mkdir()
        (world / ".env").write_text("DOMAIN=cs6650.example\nCEREBRAS_API_KEY=csk-NOT-THIS-ONE\nDEEPGRAM_API_KEY=NORA-DEEPGRAM-0123456789\n", encoding="utf-8", newline="\n")
        code, out = self.run_script(CANVAS_LINES + GITHUB_NONE + PIAZZA_NONE + [""])
        self.assertEqual(code, 0, out)
        self.assertEqual(self.stored()["DEEPGRAM_API_KEY"], "NORA-DEEPGRAM-0123456789")
        self.assertNotIn("NORA-DEEPGRAM-0123456789", out)
        self.assertNotIn("csk-NOT-THIS-ONE", (self.live / "credentials.env").read_text(encoding="utf-8"))

    def test_a_deepgram_key_is_typed_hidden_and_a_bad_one_keeps_the_old(self):
        code, out = self.run_script(CANVAS_LINES + GITHUB_NONE + PIAZZA_NONE + ["TYPED-DEEPGRAM-0123456789"])
        self.assertEqual(code, 0, out)
        self.assertEqual(self.stored()["DEEPGRAM_API_KEY"], "TYPED-DEEPGRAM-0123456789")
        self.assertNotIn("TYPED-DEEPGRAM-0123456789", out)
        code, out = self.run_script(["BADdeepgram0123456789"], "deepgram")
        self.assertEqual(code, 1)
        self.assertIn("NOT stored", out)
        self.assertIn("deepgram", out)
        self.assertNotIn("BADdeepgram0123456789", out)
        self.assertEqual(self.stored()["DEEPGRAM_API_KEY"], "TYPED-DEEPGRAM-0123456789")
        code, out = self.run_script(["-"], "deepgram")                    # a required-service prompt has no "-": it is read as a (too short) key
        self.assertEqual(self.stored()["DEEPGRAM_API_KEY"], "TYPED-DEEPGRAM-0123456789")

    def gateway_env(self):
        path = self.live / "gateway.env"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def test_deepseeks_key_goes_to_the_gateways_env_file_only_unquoted_and_the_other_lines_stay(self):
        self.live.mkdir(parents=True)
        (self.live / "gateway.env").write_text("TAI_QWEN_TPM_BUDGET=90000\n", encoding="utf-8", newline="\n")
        key = "sk-DEEPSEEK-0123456789abcdef"
        code, out = self.run_script([key], "deepseek")
        self.assertEqual(code, 0, out)
        # no quotes: docker's --env-file would keep them as part of the value, and DeepSeek would answer 401
        self.assertEqual(self.gateway_env(), f"TAI_QWEN_TPM_BUDGET=90000\nDEEPSEEK_API_KEY={key}\n")
        self.assertNotIn("DEEPSEEK", (self.live / "credentials.env").read_text(encoding="utf-8"))      # never where TAi's own .env is built from
        self.assertNotIn(key, out)
        self.assertIn("tai_live.sh gateway", out)                                                        # said, not done
        self.assertTrue((self.live / "gateway.env.bak-first").exists())
        if os.name != "nt":
            self.assertEqual((self.live / "gateway.env").stat().st_mode & 0o777, 0o600)

    def test_deepseeks_key_never_reaches_the_agents_env_and_a_gateway_env_that_is_not_there_is_made(self):
        (self.live / "tai").mkdir(parents=True)
        (self.live / "base.env").write_text("ASSISTANT_NAME=TAi\n", encoding="utf-8", newline="\n")
        key = "sk-DEEPSEEK-0123456789abcdef"
        code, out = self.run_script([key], "deepseek")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.gateway_env(), f"DEEPSEEK_API_KEY={key}\n")
        env_text = (self.live / "tai" / ".env").read_text(encoding="utf-8")
        self.assertIn("ASSISTANT_NAME=TAi", env_text)
        self.assertNotIn(key, env_text)
        self.assertNotIn("DEEPSEEK", env_text)

    def test_a_bad_deepseek_key_keeps_the_old_one_a_dash_removes_it_and_enter_keeps_it(self):
        self.live.mkdir(parents=True)
        (self.live / "gateway.env").write_text("TAI_QWEN_TPM_BUDGET=90000\n", encoding="utf-8", newline="\n")
        good = "sk-DEEPSEEK-0123456789abcdef"
        self.assertEqual(self.run_script([good], "deepseek")[0], 0)
        code, out = self.run_script(["BADdeepseek0123456789"], "deepseek")
        self.assertEqual(code, 1)
        self.assertIn("NOT stored", out)
        self.assertNotIn("BADdeepseek0123456789", out)
        self.assertEqual(self.gateway_env(), f"TAI_QWEN_TPM_BUDGET=90000\nDEEPSEEK_API_KEY={good}\n")
        code, out = self.run_script([""], "deepseek")                    # Enter keeps the stored one
        self.assertEqual(code, 0, out)
        self.assertEqual(self.gateway_env(), f"TAI_QWEN_TPM_BUDGET=90000\nDEEPSEEK_API_KEY={good}\n")
        code, out = self.run_script(["-"], "deepseek")                   # "-" removes it
        self.assertEqual(code, 0, out)
        self.assertEqual(self.gateway_env(), "TAI_QWEN_TPM_BUDGET=90000\n")

    ZAI_KEY = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp"       # what z.ai's keys look like: an id, a dot and a secret
    DEEPSEEK_LINE = "DEEPSEEK_API_KEY=sk-DEEPSEEK-0123456789abcdef\n"

    def test_zais_key_goes_to_the_gateways_env_file_beside_deepseeks_unquoted_and_never_to_the_agents_env(self):
        (self.live / "tai").mkdir(parents=True)
        (self.live / "base.env").write_text("ASSISTANT_NAME=TAi\n", encoding="utf-8", newline="\n")
        (self.live / "gateway.env").write_text(self.DEEPSEEK_LINE, encoding="utf-8", newline="\n")
        code, out = self.run_script([self.ZAI_KEY], "zai")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.gateway_env(), f"{self.DEEPSEEK_LINE}ZAI_API_KEY={self.ZAI_KEY}\n")     # no quotes: docker's --env-file would keep them
        self.assertNotIn(self.ZAI_KEY, out)
        self.assertIn("z.ai's key stored", out)
        self.assertIn("tai_live.sh gateway", out)                                                      # said, not done
        env_text = (self.live / "tai" / ".env").read_text(encoding="utf-8")
        self.assertNotIn(self.ZAI_KEY, env_text)
        self.assertNotIn("ZAI", env_text)
        self.assertNotIn("ZAI", (self.live / "credentials.env").read_text(encoding="utf-8"))
        self.assertNotIn("DeepSeek's key", out)                                                         # only the key that changed is spoken of

    def test_a_bad_zai_key_keeps_the_old_one_enter_keeps_it_a_dash_removes_it_and_deepseeks_line_stays(self):
        self.live.mkdir(parents=True)
        (self.live / "gateway.env").write_text(self.DEEPSEEK_LINE, encoding="utf-8", newline="\n")
        self.assertEqual(self.run_script([self.ZAI_KEY], "zai")[0], 0)
        code, out = self.run_script(["BADzai0123456789"], "zai")
        self.assertEqual(code, 1)
        self.assertIn("NOT stored", out)
        self.assertNotIn("BADzai0123456789", out)
        self.assertEqual(self.gateway_env(), f"{self.DEEPSEEK_LINE}ZAI_API_KEY={self.ZAI_KEY}\n")
        code, out = self.run_script([""], "zai")                          # Enter keeps the stored one
        self.assertEqual(code, 0, out)
        self.assertEqual(self.gateway_env(), f"{self.DEEPSEEK_LINE}ZAI_API_KEY={self.ZAI_KEY}\n")
        code, out = self.run_script(["-"], "zai")                         # "-" removes it
        self.assertEqual(code, 0, out)
        self.assertEqual(self.gateway_env(), self.DEEPSEEK_LINE)

    def test_zai_is_not_in_the_run_of_all_the_services_and_show_lists_its_key_by_name(self):
        self.live.mkdir(parents=True)
        self.assertEqual(self.run_script([self.ZAI_KEY], "zai")[0], 0)
        code, out = self.run_script([], "--show")
        self.assertEqual(code, 0)
        self.assertRegex(out, r"ZAI_API_KEY\s+set")
        self.assertNotIn(self.ZAI_KEY, out)

    def test_a_key_somebody_wrote_into_the_gateway_env_with_quotes_is_rewritten_without_them(self):
        self.live.mkdir(parents=True)
        (self.live / "gateway.env").write_text('DEEPSEEK_API_KEY="sk-DEEPSEEK-0123456789abcdef"\n', encoding="utf-8", newline="\n")
        code, out = self.run_script(["sk-DEEPSEEK-FRESHKEY0123456789"], "deepseek")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.gateway_env(), "DEEPSEEK_API_KEY=sk-DEEPSEEK-FRESHKEY0123456789\n")

    def test_show_lists_deepseeks_key_by_name_and_check_re_checks_it_without_changing_anything(self):
        self.live.mkdir(parents=True)
        self.assertEqual(self.run_script(["sk-DEEPSEEK-0123456789abcdef"], "deepseek")[0], 0)
        code, out = self.run_script([], "--show")
        self.assertEqual(code, 0)
        self.assertRegex(out, r"DEEPSEEK_API_KEY\s+set")
        self.assertNotIn("sk-DEEPSEEK-0123456789abcdef", out)
        before = self.gateway_env()
        code, out = self.run_script([], "--check")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.gateway_env(), before)
        (self.live / "gateway.env").write_text("DEEPSEEK_API_KEY=BADrevoked0123456789\n", encoding="utf-8", newline="\n")
        code, out = self.run_script([], "--check")                       # the key was revoked since: reported, not repaired
        self.assertEqual(code, 1)
        self.assertIn("do NOT check out", out)
        self.assertEqual(self.gateway_env(), "DEEPSEEK_API_KEY=BADrevoked0123456789\n")

    def test_what_the_check_found_is_kept_for_the_allowlist_and_show_lists_names_only(self):
        self.assertEqual(self.run_script(CANVAS_LINES + GITHUB_NONE + ["ada@example.com", "pw0123456789", "abc123def"])[0], 0)
        facts = json.loads((self.live / "owner-facts.json").read_text(encoding="utf-8"))
        self.assertEqual(facts["canvas"]["userId"], 77)
        self.assertEqual(facts["piazza"]["class"], "CS6650")
        code, out = self.run_script([], "--show")
        self.assertEqual(code, 0)
        self.assertRegex(out, r"CANVAS_API_TOKEN\s+set")
        self.assertRegex(out, r"GITHUB_TOKEN\s+-")
        self.assertNotIn(HOSTILE, out)
        self.assertNotIn("pw0123456789", out)

    def test_the_live_env_is_built_from_the_base_and_the_credentials_once_the_tree_exists(self):
        (self.live / "tai").mkdir(parents=True)
        (self.live / "base.env").write_text("ASSISTANT_NAME=TAi\nANTHROPIC_BASE_URL=http://tai-live-litellm:4000\n", encoding="utf-8", newline="\n")
        code, out = self.run_script(CANVAS_LINES + GITHUB_NONE + PIAZZA_NONE)
        self.assertEqual(code, 0, out)
        env = read_env((self.live / "tai" / ".env").read_text(encoding="utf-8"))
        self.assertEqual(env["ASSISTANT_NAME"], "TAi")
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "http://tai-live-litellm:4000")
        self.assertEqual(env["CANVAS_API_TOKEN"], HOSTILE)
        self.assertNotIn(HOSTILE, out)

    def test_check_asks_nothing_changes_nothing_but_the_facts_and_fails_when_a_stored_value_no_longer_checks_out(self):
        self.assertEqual(self.run_script(CANVAS_LINES + GITHUB_NONE + ["ada@example.com", "pw0123456789", "abc123def"])[0], 0)
        before = (self.live / "credentials.env").read_text(encoding="utf-8")
        (self.live / "owner-facts.json").unlink()
        code, out = self.run_script([], "--check")                       # nothing is typed: stdin is empty
        self.assertEqual(code, 0, out)
        self.assertIn("check out", out)
        self.assertEqual((self.live / "credentials.env").read_text(encoding="utf-8"), before)
        self.assertEqual(json.loads((self.live / "owner-facts.json").read_text(encoding="utf-8"))["canvas"]["userId"], 77)
        self.assertNotIn(HOSTILE, out)
        # a token that has since been revoked: the stub fails anything that starts with BAD
        (self.live / "credentials.env").write_text(before.replace(HOSTILE, "BADtoken0123456789"), encoding="utf-8")
        broken = (self.live / "credentials.env").read_text(encoding="utf-8")
        code, out = self.run_script([], "--check")
        self.assertEqual(code, 1)
        self.assertIn("do NOT check out", out)
        self.assertEqual((self.live / "credentials.env").read_text(encoding="utf-8"), broken)    # reported, not "repaired"

    def test_the_first_file_is_kept_once_and_checks_that_cannot_run_change_nothing(self):
        self.assertEqual(self.run_script(CANVAS_LINES + GITHUB_NONE + PIAZZA_NONE)[0], 0)
        self.assertEqual(self.run_script(["", "", "SECONDTOKEN-0123456789"] + GITHUB_NONE + PIAZZA_NONE)[0], 0)
        backup = self.live / "credentials.env.bak-first"
        self.assertTrue(backup.exists())
        self.assertEqual(read_env(backup.read_text(encoding="utf-8"))["CANVAS_API_TOKEN"], HOSTILE)
        self.env["TAI_PROBE_CMD"] = "no-such-command-anywhere"
        code, out = self.run_script(["", "", "THIRDTOKEN-0123456789"] + GITHUB_NONE + PIAZZA_NONE)
        self.assertEqual(code, 1)
        self.assertIn("could not run", out)
        self.assertEqual(self.stored()["CANVAS_API_TOKEN"], "SECONDTOKEN-0123456789")
        self.assertNotIn("THIRDTOKEN-0123456789", out)


def fake_smtplib(starttls=True, login_error=None, connect_error=None):
    """The part of smtplib the check uses: it records what was done to it (never the password) and fails as set."""
    module = type(sys)("smtplib")
    module.calls = []

    class SMTPAuthenticationError(Exception):
        pass

    class SMTPException(Exception):
        pass

    class Base:
        def __init__(self, host, port, timeout=None, context=None):
            if connect_error:
                raise connect_error
            module.calls.append(("connect", type(self).__name__, host, port, timeout, context is not None))

        def ehlo(self):
            module.calls.append(("ehlo",))

        def has_extn(self, name):
            return starttls and name == "starttls"

        def starttls(self, context=None):
            module.calls.append(("starttls", context.verify_mode, context.check_hostname))

        def login(self, user, password):
            module.calls.append(("login", user))
            if login_error == "refused":
                raise SMTPAuthenticationError(535, b"bad credentials for S3CRET-PW")
            if login_error == "other":
                raise OSError("connection reset while sending S3CRET-PW")

        def quit(self):
            module.calls.append(("quit",))

        def close(self):
            module.calls.append(("close",))

    class SMTP(Base):
        pass

    class SMTP_SSL(Base):
        pass

    module.SMTPAuthenticationError = SMTPAuthenticationError
    module.SMTPException = SMTPException
    module.SMTP = SMTP
    module.SMTP_SSL = SMTP_SSL
    return module


class SmtpCheckTest(unittest.TestCase):
    """check_smtp, the python the script runs against the mail server: a login and nothing more, always encrypted, and what it says never holds the password."""
    PW = "S3CRET-PW"
    ENV = {"SMTP_PASSWORD": PW, "TAI_SMTP_HOST": "smtp.school.example", "TAI_SMTP_USER": "tai-login"}

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.probe = load_probe(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def check(self, env, **behaviour):
        fake = fake_smtplib(**behaviour)
        facts = {}
        with mock.patch.dict(sys.modules, {"smtplib": fake}):
            verdict, message = self.probe.check_smtp(env, facts)
        self.assertNotIn(self.PW, message)
        return verdict, message, fake.calls, facts

    def test_nothing_set_is_a_skip_and_a_password_without_a_server_is_a_failure_that_says_what_to_set(self):
        self.assertEqual(self.check({})[0], "skip")
        verdict, message, calls, _ = self.check({"SMTP_PASSWORD": self.PW})
        self.assertEqual((verdict, calls), ("fail", []))
        self.assertIn("TAI_SMTP_HOST", message)
        self.assertEqual(self.check({"SMTP_PASSWORD": self.PW, "TAI_SMTP_HOST": "smtp.school.example"})[0], "fail")      # no user
        self.assertEqual(self.check(dict(self.ENV, TAI_SMTP_PORT="smtp"))[0], "fail")

    def test_port_587_connects_insists_on_starttls_with_certificates_checked_and_logs_in_without_sending_mail(self):
        verdict, message, calls, facts = self.check(self.ENV)
        self.assertEqual(verdict, "ok")
        self.assertIn("no mail was sent", message)
        self.assertEqual([c[0] for c in calls], ["connect", "ehlo", "starttls", "ehlo", "login", "quit"])
        self.assertEqual(calls[0][1:4], ("SMTP", "smtp.school.example", 587))
        self.assertEqual(calls[2][1:], (__import__("ssl").CERT_REQUIRED, True))               # the certificate and the name are checked
        self.assertEqual(calls[4], ("login", "tai-login"))
        self.assertEqual(facts, {"smtp": {"login": "ok", "port": 587}})

    def test_port_465_is_tls_from_the_first_byte(self):
        verdict, _, calls, _ = self.check(dict(self.ENV, TAI_SMTP_PORT="465"))
        self.assertEqual(verdict, "ok")
        self.assertEqual(calls[0][1:4], ("SMTP_SSL", "smtp.school.example", 465))
        self.assertNotIn("starttls", [c[0] for c in calls])

    def test_a_server_without_starttls_is_refused_and_no_login_is_sent(self):
        verdict, message, calls, _ = self.check(self.ENV, starttls=False)
        self.assertEqual(verdict, "fail")
        self.assertIn("STARTTLS", message)
        self.assertNotIn("login", [c[0] for c in calls])

    def test_a_refused_login_and_a_broken_connection_are_failures_that_name_nothing_the_server_said(self):
        verdict, message, calls, _ = self.check(self.ENV, login_error="refused")
        self.assertEqual((verdict, message), ("fail", "the mail server refused the login"))
        self.assertIn(("quit",), calls)
        verdict, message, _, _ = self.check(self.ENV, login_error="other")
        self.assertEqual((verdict, message), ("fail", "could not log in to the mail server (OSError)"))
        verdict, message, _, _ = self.check(self.ENV, connect_error=ConnectionRefusedError("refused by smtp.school.example for S3CRET-PW"))
        self.assertEqual((verdict, message), ("fail", "could not log in to the mail server (ConnectionRefusedError)"))


@unittest.skipIf(BASH is None, "needs Git Bash (or bash on Linux/macOS)")
class SmtpHostSideTest(unittest.TestCase):
    """`tai_credentials.sh smtp` under bash against a fake home, with the check replaced by a stub: the password is typed hidden, stored as typed in the one
    format TAi's reader reads, the server's address and login (not secrets) come from orch.env for the check and are not stored with the password,
    a failed check keeps the old one, and it is only asked for by name."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        self.home = tmp / "home"
        self.live = self.home / "tai-live"
        self.bin = tmp / "bin"
        self.live.mkdir(parents=True)
        self.bin.mkdir()
        self.stub = tmp / "stub_probe.py"
        self.stub.write_text(STUB_PROBE, encoding="utf-8")
        (self.bin / "python3").write_text(f'#!/usr/bin/env bash\nexec "{posix(sys.executable)}" "$@"\n', encoding="utf-8", newline="\n")
        (self.bin / "docker").write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8", newline="\n")
        for name in ("python3", "docker"):
            os.chmod(self.bin / name, 0o755)
        (self.live / "orch.env").write_text("TAI_SMTP_HOST=smtp.school.example\nTAI_SMTP_PORT=587\nTAI_SMTP_USER=tai-login\nTAI_NOTIFY_EMAIL=1\n", encoding="utf-8", newline="\n")
        self.env = dict(os.environ, HOME=posix(self.home), TAI_LIVE_DIR=posix(self.live), TAI_PROBE_CMD=f"python3 {posix(self.stub)}",
                        PATH=str(self.bin) + os.pathsep + os.environ["PATH"])

    def run_script(self, lines, *args):
        result = subprocess.run([BASH, posix(SCRIPT), "--on-host", *args], input="\n".join(lines) + "\n", capture_output=True, text=True, env=self.env, timeout=120)
        return result.returncode, result.stdout + result.stderr

    def stored(self):
        path = self.live / "credentials.env"
        return read_env(path.read_text(encoding="utf-8")) if path.exists() else {}

    def test_the_password_is_stored_exactly_as_typed_and_never_shown_and_the_check_is_told_the_server(self):
        password = '  p"a ss\'$x\\y`z${HOME}  '
        code, out = self.run_script([password], "smtp")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.stored()["SMTP_PASSWORD"], password)
        self.assertNotIn(password.strip(), out)
        seen = json.loads((Path(self.tmp.name) / "seen-smtp.json").read_text(encoding="utf-8"))
        self.assertEqual(seen, {"TAI_SMTP_HOST": "smtp.school.example", "TAI_SMTP_PORT": "587", "TAI_SMTP_USER": "tai-login"})
        text = (self.live / "credentials.env").read_text(encoding="utf-8")
        for key in ("TAI_SMTP_HOST", "TAI_SMTP_PORT", "TAI_SMTP_USER"):
            self.assertNotIn(key, text)                       # what is not secret is orch.env's, and stays there
        self.assertNotIn("SMTP_PASSWORD", (self.live / "orch.env").read_text(encoding="utf-8"))
        if os.name != "nt":
            self.assertEqual((self.live / "credentials.env").stat().st_mode & 0o777, 0o600)

    def test_a_password_the_check_refuses_is_not_stored_and_the_old_one_stays(self):
        self.assertEqual(self.run_script(["old-password-1"], "smtp")[0], 0)
        code, out = self.run_script(["BADnew-password"], "smtp")
        self.assertNotEqual(code, 0)
        self.assertIn("smtp", out)
        self.assertNotIn("BADnew-password", out)
        self.assertEqual(self.stored()["SMTP_PASSWORD"], "old-password-1")

    def test_enter_keeps_the_stored_password_and_a_control_character_is_refused_unshown(self):
        self.assertEqual(self.run_script(["keep-me-please"], "smtp")[0], 0)
        self.assertEqual(self.run_script([""], "smtp")[0], 0)
        self.assertEqual(self.stored()["SMTP_PASSWORD"], "keep-me-please")
        code, out = self.run_script(["bad\x07bell", "good-one-now"], "smtp")
        self.assertEqual(code, 0, out)
        self.assertIn("does not look like a valid", out)
        self.assertNotIn("bad\x07bell", out)
        self.assertEqual(self.stored()["SMTP_PASSWORD"], "good-one-now")

    def test_it_is_asked_for_by_name_only_and_show_lists_it_by_name_without_the_value(self):
        code, out = self.run_script([""] * 24)
        self.assertNotIn("SMTP password", out)                # the run of all the services does not ask: e-mail is optional
        self.assertEqual(self.run_script(["a-password-1234"], "smtp")[0], 0)
        code, out = self.run_script([], "--show")
        self.assertEqual(code, 0, out)
        self.assertRegex(out, r"SMTP_PASSWORD\s+set")
        self.assertNotIn("a-password-1234", out)

    def test_only_the_asked_service_is_touched(self):
        self.assertEqual(self.run_script(["twelve-chars"], "smtp")[0], 0)
        self.assertEqual(set(self.stored()), {"SMTP_PASSWORD"})


if __name__ == "__main__":
    unittest.main()
