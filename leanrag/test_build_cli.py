"""leanrag/build.py, the command the operator runs: the gates before anything is sent, the dry run, and a whole build through the REAL client code with a fake HTTP layer.
What is pinned: without a key, or without a yes, nothing is sent (the HTTP layer is made to fail the test if it is touched); a dry run sends nothing and makes a graph that is never
published; a real run records the model the API named and the tokens, and no file it writes holds the key.
Run: python leanrag/test_build_cli.py   (needs numpy and scikit-learn for the graph step, which the agent image has)
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.dont_write_bytecode = True

from leanrag import build  # noqa: E402
from leanrag import corpus as cp  # noqa: E402
from leanrag import graph_extract as ge  # noqa: E402
from leanrag import llm  # noqa: E402

try:
    import numpy  # noqa: F401
    import sklearn  # noqa: F401
    HAVE_ML = True
except ImportError:
    HAVE_ML = False

KEY = "sk-cli-test-0123456789-NEVER-WRITE-ME"
SLIDE = "Circuit breaker pattern in services\n- a circuit breaker stops calls to a failing service\n- the breaker opens after errors\n- retries wait for a while\n" + "filler words here " * 3


def pages(tmp: Path) -> Path:
    (tmp / "materials-fall2026").mkdir(parents=True)
    (tmp / "materials-fall2026" / "A.pdf").write_bytes(b"%PDF")
    (tmp / "materials-fall2026" / "B.pdf").write_bytes(b"%PDF")
    weeks = {"w1": {"n": 1, "start": "2026-09-07", "released": True, "items": [{"kind": "slides", "title": "Deck Alpha.pdf", "file": "A.pdf"}, {"kind": "slides", "title": "Deck Beta.pdf", "file": "B.pdf"}]}}
    (tmp / "weeks.json").write_text(json.dumps({"weeks": weeks}), encoding="utf-8")
    return tmp


def fake_reader(path):
    return [f"{n}\n" + SLIDE.replace("services", f"services {Path(path).stem}{n}") for n in range(1, 9)]


class FakeApi:
    """A stand-in for urlopen that answers like the chat API: extraction prompts get entities made from the unit's text, naming prompts get a name."""
    def __init__(self):
        self.requests = []
        self.urls = []

    def __call__(self, request, timeout=None):
        body = json.loads(request.data)
        self.requests.append(body)
        self.urls.append(request.full_url)
        system, user = body["messages"][0]["content"], body["messages"][1]["content"]
        if "extract-graph" in system:
            text = ge.HeuristicClient._extract(user)
        elif "name-cluster" in system:
            text = json.dumps({"name": "Resilience group", "description": "About failing services."})
        else:
            text = json.dumps({"relation": "ENABLES"})
        payload = json.dumps({"model": "DeepSeek-V4.1-Flash-1017", "choices": [{"message": {"content": text}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 300, "completion_tokens": 80}}).encode()

        class R:
            def read(self_inner):
                return payload

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *a):
                return False
        return R()


def run(argv, env=None, tty=False):
    """Run build.main with a pages reader that needs no PDF; returns (exit code, what it printed)."""
    real_load = cp.load_corpus
    out = io.StringIO()
    saved_env = dict(os.environ)
    for provider in llm.PROVIDERS.values():
        for name in provider.key_variables:
            os.environ.pop(name, None)
    os.environ.update(env or {})
    build.load_corpus = lambda d, now=None: real_load(d, now, pages_reader=fake_reader)
    saved_tty = sys.stdin
    try:
        class Stdin:
            def isatty(self_inner):
                return tty
        sys.stdin = Stdin()
        with contextlib.redirect_stdout(out):
            code = build.main(argv)
    finally:
        sys.stdin = saved_tty
        build.load_corpus = real_load
        os.environ.clear()
        os.environ.update(saved_env)
    return code, out.getvalue()


class Gates(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.pages = pages(self.root / "pages")
        self.out = str(self.root / "out")
        self.saved_open = urllib.request.urlopen
        urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(AssertionError("something was sent"))

    def tearDown(self):
        urllib.request.urlopen = self.saved_open
        self.tmp.cleanup()

    def test_without_a_key_and_not_at_a_terminal_nothing_is_sent(self):
        code, text = run(["--pages-dir", str(self.pages), "--out", self.out, "--now", "2026-11-11T12:00:00Z"])
        self.assertEqual(code, 2)
        self.assertIn("no API key", text)

    def test_with_a_key_but_without_a_yes_and_not_at_a_terminal_nothing_is_sent(self):
        code, text = run(["--pages-dir", str(self.pages), "--out", self.out], env={"DEEPSEEK_API_KEY": KEY})
        self.assertEqual(code, 2)
        self.assertIn("nothing was sent", text)
        self.assertNotIn(KEY, text)

    def test_the_size_and_the_limits_are_printed_before_anything_is_asked(self):
        code, text = run(["--pages-dir", str(self.pages), "--out", self.out, "--price-in", "0.30", "--price-out", "1.20"], env={"DEEPSEEK_API_KEY": KEY})
        self.assertIn("estimate: about", text)
        self.assertRegex(text, r"cost US\$\d+\.\d\d")
        self.assertIn("hard limits for this run: 400 requests, 600,000 input, 170,000 output tokens", text)

    def test_the_probe_makes_exactly_one_call_and_says_which_model_answered(self):
        api = FakeApi()
        saved = build.ChatClient
        build.ChatClient = lambda key, **kw: llm.ChatClient(key, opener=api, sleep=lambda s: None, **kw)
        try:
            code, text = run(["--pages-dir", str(self.pages), "--out", self.out, "--probe"], env={"DEEPSEEK_API_KEY": KEY})
        finally:
            build.ChatClient = saved
        self.assertEqual(code, 0, text)
        self.assertEqual(len(api.requests), 1)
        self.assertIn("model that answered 'DeepSeek-V4.1-Flash-1017'", text)
        self.assertIn("parsed", text)
        self.assertNotIn(KEY, text)

    def test_a_first_request_that_fails_stops_the_run_after_that_one_request(self):
        class Broken(FakeApi):
            def __call__(self, request, timeout=None):
                self.requests.append(json.loads(request.data))
                import io as _io
                raise urllib.error.HTTPError("https://api.deepseek.com/chat/completions", 400, "bad", {}, _io.BytesIO(json.dumps({"error": {"message": "model not found"}}).encode()))
        api = Broken()
        saved = build.ChatClient
        build.ChatClient = lambda key, **kw: llm.ChatClient(key, opener=api, sleep=lambda s: None, **kw)
        try:
            code, text = run(["--pages-dir", str(self.pages), "--out", self.out, "--yes", "--workers", "4"], env={"DEEPSEEK_API_KEY": KEY})
        finally:
            build.ChatClient = saved
        self.assertEqual(code, 3, text)
        self.assertEqual(len(api.requests), 1)
        self.assertIn("the first request did not give a usable answer", text)
        self.assertIn("model not found", text)
        self.assertNotIn(KEY, text)

    def test_the_zai_provider_reads_its_own_variable_only_so_another_providers_key_is_never_sent_to_it(self):
        code, text = run(["--pages-dir", str(self.pages), "--out", self.out, "--provider", "zai", "--yes"], env={"DEEPSEEK_API_KEY": KEY})
        self.assertEqual(code, 2)
        self.assertIn("no API key", text)
        self.assertIn("ZAI_API_KEY", text)                      # it says which variable it wants
        self.assertNotIn(KEY, text)

    def test_the_zai_run_says_the_plan_is_shared_and_prices_nothing_per_token(self):
        code, text = run(["--pages-dir", str(self.pages), "--out", self.out, "--provider", "zai"], env={"ZAI_API_KEY": KEY})
        self.assertEqual(code, 2)                               # not at a terminal and no --yes
        self.assertIn("note: the z.ai GLM Coding Plan", text)
        self.assertIn("quiet hour", text)
        self.assertIn("cost none per token: it uses the coding plan's quota", text)
        self.assertIn("at https://api.z.ai/api/coding/paas/v4", text)
        self.assertNotIn(KEY, text)

    def test_an_offline_run_with_nothing_in_the_cache_stops_before_asking_for_anything(self):
        code, text = run(["--pages-dir", str(self.pages), "--out", self.out, "--offline"])
        self.assertEqual(code, 3)
        self.assertIn("--offline", text)
        self.assertIn("are not in the cache", text)
        self.assertNotIn("no API key", text)                    # it never looked for a key

    def test_offline_and_probe_do_not_go_together(self):
        code, text = run(["--pages-dir", str(self.pages), "--out", self.out, "--offline", "--probe"])
        self.assertEqual(code, 2, text)
        self.assertIn("--probe sends a request", text)

    def test_a_console_that_cannot_show_a_character_does_not_stop_the_run(self):
        weeks = {"w1": {"n": 1, "start": "2026-09-07", "released": True, "items": [{"kind": "slides", "file": "A.pdf"}, {"kind": "slides", "file": "Missing • deck.pdf"}]}}
        (self.pages / "weeks.json").write_text(json.dumps({"weeks": weeks}), encoding="utf-8")
        real_load, out = cp.load_corpus, io.TextIOWrapper(io.BytesIO(), encoding="gbk", errors="strict")
        build.load_corpus = lambda d, now=None: real_load(d, now, pages_reader=fake_reader)
        try:
            with contextlib.redirect_stdout(out):
                code = build.main(["--pages-dir", str(self.pages), "--out", self.out, "--dry-run", "--slice", "alpha-no-match"])
        finally:
            build.load_corpus = real_load
        out.flush()
        self.assertEqual(code, 2)                                   # the slice matched nothing, and that was said
        out.buffer.seek(0)
        self.assertIn("Missing ? deck.pdf", out.buffer.read().decode("gbk"))      # the bullet became a ?

    def test_an_unmatched_slice_stops_without_asking_for_anything(self):
        code, text = run(["--pages-dir", str(self.pages), "--out", self.out, "--dry-run", "--slice", "Gamma"])
        self.assertEqual(code, 2)
        self.assertIn("nothing to extract", text)


class PublishABuild(unittest.TestCase):
    """--publish-build copies a finished build as it is: the graph that was looked at is the graph that is published. It reads no corpus and needs no key."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "out"
        self.saved_open = urllib.request.urlopen
        urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(AssertionError("something was sent"))

    def tearDown(self):
        urllib.request.urlopen = self.saved_open
        self.tmp.cleanup()

    def make(self, name, **manifest):
        d = self.out / "builds" / name
        d.mkdir(parents=True)
        base = {"format": 1, "synthetic": False, "extraction": {"complete": True}, "tag": name}
        base.update(manifest)
        (d / "manifest.json").write_text(json.dumps(base), encoding="utf-8")
        (d / "graph.json").write_text("{}", encoding="utf-8")
        return d

    def go(self, which):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = build.main(["--out", str(self.out), "--publish-build", which])          # no --pages-dir: it is not needed
        return code, out.getvalue()

    def test_a_finished_build_is_published_by_name_or_by_path_without_a_corpus_or_a_key(self):
        d = self.make("20261112T010000Z-abcd1234", slice="")
        code, text = self.go(d.name)
        self.assertEqual(code, 0, text)
        self.assertEqual(json.loads((self.out / "current" / "manifest.json").read_text())["tag"], d.name)
        self.make("second")
        self.assertEqual(self.go(str(self.out / "builds" / "second"))[0], 0)
        self.assertEqual(json.loads((self.out / "current" / "manifest.json").read_text())["tag"], "second")
        self.assertEqual(json.loads((self.out / "previous" / "manifest.json").read_text())["tag"], d.name)

    def test_a_slice_a_dry_run_and_a_partial_build_are_never_published(self):
        for name, extra, word in (("x-slice", {}, "slice"), ("y", {"slice": "Day 4"}, "slice"), ("z", {"synthetic": True}, "synthetic"), ("w", {"extraction": {"complete": False}}, "not complete")):
            self.make(name, **extra)
            code, text = self.go(name)
            self.assertEqual(code, 2, (name, text))
            self.assertIn(word, text)
        self.assertFalse((self.out / "current").exists())

    def test_a_name_that_is_not_a_build_stops_and_says_where_builds_are(self):
        code, text = self.go("nope")
        self.assertEqual(code, 2)
        self.assertIn("no build at", text)


@unittest.skipUnless(HAVE_ML, "numpy and scikit-learn are not installed here (the agent image has them)")
class Builds(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.pages = pages(self.root / "pages")
        self.out = self.root / "out"

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_dry_run_sends_nothing_makes_a_synthetic_graph_and_never_publishes_it(self):
        saved = urllib.request.urlopen
        urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(AssertionError("something was sent"))
        try:
            code, text = run(["--pages-dir", str(self.pages), "--out", str(self.out), "--dry-run", "--publish"])
        finally:
            urllib.request.urlopen = saved
        self.assertEqual(code, 0, text)
        built = next((self.out / "dry-run").iterdir())
        manifest = json.loads((built / "manifest.json").read_text(encoding="utf-8"))
        self.assertTrue(manifest["synthetic"])
        self.assertEqual(manifest["extraction"]["model_asked"], "heuristic-fake")
        self.assertIn("not published", text)
        self.assertFalse((self.out / "current").exists())

    def test_a_slice_is_built_from_the_decks_asked_for_only_and_is_never_published(self):
        code, text = run(["--pages-dir", str(self.pages), "--out", str(self.out), "--dry-run", "--slice", "alpha"])
        self.assertEqual(code, 0, text)
        built = next((self.out / "dry-run").iterdir())
        self.assertTrue(built.name.endswith("-slice-dry"))
        decks = {json.loads(line)["deck"] for line in (built / "chunks.jsonl").read_text(encoding="utf-8").splitlines()}
        self.assertEqual(decks, {"A.pdf"})

    def test_a_whole_run_through_the_real_client_records_the_model_and_the_tokens_and_writes_no_key(self):
        api = FakeApi()
        saved = build.ChatClient
        build.ChatClient = lambda key, **kw: llm.ChatClient(key, opener=api, sleep=lambda s: None, **kw)
        try:
            code, text = run(["--pages-dir", str(self.pages), "--out", str(self.out), "--yes", "--publish", "--workers", "1", "--now", "2026-11-11T12:00:00Z"], env={"DEEPSEEK_API_KEY": KEY})
        finally:
            build.ChatClient = saved
        self.assertEqual(code, 0, text)
        self.assertGreater(len(api.requests), 3)
        self.assertTrue(all(r["thinking"] == {"type": "disabled"} and r["temperature"] == 0 for r in api.requests))
        current = self.out / "current"
        manifest = json.loads((current / "manifest.json").read_text(encoding="utf-8"))
        self.assertFalse(manifest["synthetic"])
        self.assertEqual(manifest["llm_usage"]["models_returned"], {"DeepSeek-V4.1-Flash-1017": len(api.requests)})
        self.assertEqual(manifest["llm_usage"]["prompt_tokens"], 300 * len(api.requests))
        self.assertEqual(manifest["extraction"]["model_asked"], "deepseek-flash")
        self.assertTrue(manifest["extraction"]["complete"])
        self.assertTrue((self.out / "previous").exists() is False)
        for path in self.out.rglob("*"):
            if path.is_file():
                self.assertNotIn(KEY, path.read_text(encoding="utf-8", errors="replace"), str(path))
        self.assertNotIn(KEY, text)
        # and the graph it made answers a question
        from leanrag import graph_query as gq
        result = gq.query_graph(current, "circuit breaker stops calls", now=__import__("datetime").datetime(2026, 11, 11, 12, tzinfo=__import__("datetime").timezone.utc))
        self.assertTrue(result["source_texts"])

    def test_a_second_run_with_every_answer_cached_asks_for_no_key_no_yes_and_sends_nothing(self):
        api = FakeApi()
        saved = build.ChatClient
        build.ChatClient = lambda key, **kw: llm.ChatClient(key, opener=api, sleep=lambda s: None, **kw)
        try:
            run(["--pages-dir", str(self.pages), "--out", str(self.out), "--yes", "--workers", "1"], env={"DEEPSEEK_API_KEY": KEY})
            first = len(api.requests)
            self.assertGreater(first, 3)
            code, text = run(["--pages-dir", str(self.pages), "--out", str(self.out), "--workers", "1"])       # no key, no --yes, not at a terminal
        finally:
            build.ChatClient = saved
        self.assertEqual(code, 0, text)
        self.assertEqual(len(api.requests), first)                              # the units AND the cluster names came from the caches
        self.assertIn("every unit is already in the cache", text)
        self.assertIn("sent by this run: 0 requests", text)

    def test_the_zai_provider_sends_to_its_own_endpoint_and_keeps_its_caches_under_its_own_model_name(self):
        api = FakeApi()
        saved = build.ChatClient
        build.ChatClient = lambda key, **kw: llm.ChatClient(key, opener=api, sleep=lambda s: None, **kw)
        try:
            code, text = run(["--pages-dir", str(self.pages), "--out", str(self.out), "--provider", "zai", "--yes", "--now", "2026-11-11T12:00:00Z"], env={"ZAI_API_KEY": KEY})
        finally:
            build.ChatClient = saved
        self.assertEqual(code, 0, text)
        self.assertTrue(all(u == "https://api.z.ai/api/coding/paas/v4/chat/completions" for u in api.urls))
        self.assertTrue(all(r["model"] == "glm-5.3-flash" and r["thinking"] == {"type": "disabled"} for r in api.requests))
        self.assertTrue((self.out / "cache" / "extract-glm-5.3-flash.jsonl").is_file())
        self.assertTrue((self.out / "cache" / "naming-glm-5.3-flash.jsonl").is_file())
        self.assertFalse((self.out / "cache" / "extract-deepseek-flash.jsonl").exists())     # the other model's answers are another file
        built = next((self.out / "builds").iterdir())
        manifest = json.loads((built / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["extraction"]["model_asked"], "glm-5.3-flash")
        for path in self.out.rglob("*"):
            if path.is_file():
                self.assertNotIn(KEY, path.read_text(encoding="utf-8", errors="replace"), str(path))

    def test_a_finished_build_is_rebuilt_and_published_offline_with_no_key_and_it_is_the_same_graph_at_the_same_cost(self):
        api = FakeApi()
        saved, saved_open = build.ChatClient, urllib.request.urlopen
        build.ChatClient = lambda key, **kw: llm.ChatClient(key, opener=api, sleep=lambda s: None, **kw)
        try:
            code, text = run(["--pages-dir", str(self.pages), "--out", str(self.out), "--yes", "--workers", "1", "--now", "2026-11-11T12:00:00Z"], env={"DEEPSEEK_API_KEY": KEY})
            self.assertEqual(code, 0, text)
            first_dir = next((self.out / "builds").iterdir())
            first_graph = (first_dir / "graph.json").read_text(encoding="utf-8")
            first_manifest = json.loads((first_dir / "manifest.json").read_text(encoding="utf-8"))
            sent_first = len(api.requests)
            urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(AssertionError("something was sent"))
            code, text = run(["--pages-dir", str(self.pages), "--out", str(self.out), "--offline", "--publish", "--now", "2026-11-11T12:00:00Z"])
        finally:
            build.ChatClient, urllib.request.urlopen = saved, saved_open
        self.assertEqual(code, 0, text)
        self.assertEqual(len(api.requests), sent_first)
        self.assertIn("OFFLINE", text)
        current = self.out / "current"
        self.assertEqual((current / "graph.json").read_text(encoding="utf-8"), first_graph)          # the same clustering and the same names
        manifest = json.loads((current / "manifest.json").read_text(encoding="utf-8"))
        self.assertFalse(manifest["synthetic"])
        for key in ("calls", "prompt_tokens", "completion_tokens", "models_returned"):
            self.assertEqual(manifest["llm_usage"][key], first_manifest["llm_usage"][key], key)      # what the graph cost, not what this process sent
        self.assertEqual(manifest["llm_usage"]["this_run"]["calls"], 0)
        self.assertEqual(manifest["llm_usage"]["calls"], sent_first)
        self.assertEqual(manifest["graph"]["naming"], first_manifest["graph"]["naming"])

    def test_a_missing_naming_cache_stops_at_the_naming_step_when_there_is_no_key_and_writes_no_graph(self):
        api = FakeApi()
        saved = build.ChatClient
        build.ChatClient = lambda key, **kw: llm.ChatClient(key, opener=api, sleep=lambda s: None, **kw)
        try:
            run(["--pages-dir", str(self.pages), "--out", str(self.out), "--yes", "--workers", "1", "--now", "2026-11-11T12:00:00Z"], env={"DEEPSEEK_API_KEY": KEY})
            before = sorted(p.name for p in (self.out / "builds").iterdir())
            (self.out / "cache" / "naming-deepseek-flash.jsonl").unlink()
            code, text = run(["--pages-dir", str(self.pages), "--out", str(self.out), "--yes", "--workers", "1", "--now", "2026-11-11T12:00:00Z"])
        finally:
            build.ChatClient = saved
        self.assertEqual(code, 3, text)
        self.assertIn("STOPPED while naming the clusters", text)
        self.assertIn("no API key", text)
        self.assertEqual(sorted(p.name for p in (self.out / "builds").iterdir()), before)             # no half-named graph was written

    def test_a_quota_stop_in_the_middle_keeps_the_cache_and_says_to_run_the_same_command_again(self):
        class QuotaAfter(FakeApi):
            def __call__(self, request, timeout=None):
                if len(self.requests) >= 4:
                    self.requests.append({})
                    raise urllib.error.HTTPError(request.full_url, 429, "limit", {}, io.BytesIO(json.dumps({"error": {"code": "1308", "message": "5-hour limit reached"}}).encode()))
                return super().__call__(request, timeout)
        api = QuotaAfter()
        saved = build.ChatClient
        build.ChatClient = lambda key, **kw: llm.ChatClient(key, opener=api, sleep=lambda s: None, **kw)
        try:
            code, text = run(["--pages-dir", str(self.pages), "--out", str(self.out), "--provider", "zai", "--yes", "--publish"], env={"ZAI_API_KEY": KEY})
        finally:
            build.ChatClient = saved
        self.assertEqual(code, 3, text)
        self.assertIn("STOPPED", text)
        self.assertIn("1308", text)
        self.assertIn("run the same command again", text)
        self.assertEqual(len(api.requests), 5)                                                     # the fifth request was the refused one: no retry, no sixth
        self.assertEqual(len(ge.load_cache(self.out / "cache" / "extract-glm-5.3-flash.jsonl")), 4)
        self.assertFalse((self.out / "current").exists())

    def test_a_budget_stops_the_run_with_the_cache_kept_and_nothing_published(self):
        api = FakeApi()
        saved = build.ChatClient
        build.ChatClient = lambda key, **kw: llm.ChatClient(key, opener=api, sleep=lambda s: None, **kw)
        try:
            code, text = run(["--pages-dir", str(self.pages), "--out", str(self.out), "--yes", "--publish", "--workers", "1", "--max-calls", "3"], env={"DEEPSEEK_API_KEY": KEY})
        finally:
            build.ChatClient = saved
        self.assertEqual(code, 3)
        self.assertIn("STOPPED", text)
        self.assertIn("call budget", text)
        self.assertFalse((self.out / "current").exists())
        self.assertTrue(any((self.out / "cache").glob("extract-*.jsonl")))


if __name__ == "__main__":
    unittest.main()
