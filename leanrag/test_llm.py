"""leanrag/llm.py: the one door to a model API. What is under test is what must hold when the call goes wrong: the key is nowhere it should not be,
a refusal that no retry fixes stops at once, a transient failure is retried, and the budget is a wall. No network: the HTTP layer is a fake.
Run: python leanrag/test_llm.py   (standard library only)
"""
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.dont_write_bytecode = True

from leanrag import llm  # noqa: E402

KEY = "sk-test-0123456789abcdef-NEVER-PRINT-ME"


def ok_body(text='{"entities": [], "relations": []}', model="DeepSeek-V4.1-Flash-1017", pin=100, pout=20, hit=0):
    return json.dumps({"id": "x", "model": model, "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                       "usage": {"prompt_tokens": pin, "completion_tokens": pout, "prompt_cache_hit_tokens": hit}}).encode()


class Resp:
    def __init__(self, body):
        self._b = body

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(code, message="boom", headers=None, vendor_code=None):
    error = {"message": message}
    if vendor_code is not None:
        error["code"] = vendor_code
    return urllib.error.HTTPError("https://api.example/chat/completions", code, "err", headers or {}, io.BytesIO(json.dumps({"error": error}).encode()))


class Script:
    """A fake `urlopen`: each call takes the next item (a body to return or an exception to raise) and records the request."""
    def __init__(self, *items):
        self.items, self.requests = list(items), []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        item = self.items.pop(0)
        if isinstance(item, Exception):
            raise item
        return Resp(item)


def client(script, **kw):
    return llm.ChatClient(KEY, opener=script, sleep=lambda s: None, **kw)


class Calls(unittest.TestCase):
    def test_the_request_asks_for_json_with_thinking_off_at_temperature_zero_and_sends_the_key_only_as_a_bearer_header(self):
        s = Script(ok_body())
        client(s).complete_json("system words", "user words")
        req = s.requests[0]
        body = json.loads(req.data)
        self.assertEqual(req.full_url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(req.get_header("Authorization"), f"Bearer {KEY}")
        self.assertEqual((body["temperature"], body["stream"], body["thinking"], body["response_format"]), (0, False, {"type": "disabled"}, {"type": "json_object"}))
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user"])
        self.assertNotIn(KEY, req.data.decode())
        self.assertNotIn("tools", body)

    def test_it_reports_the_model_that_answered_and_counts_the_tokens(self):
        c = client(Script(ok_body(model="DeepSeek-V4.1-Flash-1017", pin=120, pout=30, hit=100), ok_body(pin=10, pout=5)))
        a = c.complete_json("s", "u")
        c.complete_json("s", "u")
        self.assertEqual((a.model, a.prompt_tokens, a.completion_tokens, a.cache_hit_tokens, a.finish_reason), ("DeepSeek-V4.1-Flash-1017", 120, 30, 100, "stop"))
        self.assertEqual(c.usage.to_dict(), {"calls": 2, "prompt_tokens": 130, "completion_tokens": 35, "cache_hit_tokens": 100, "models_returned": {"DeepSeek-V4.1-Flash-1017": 2}})

    def test_a_transient_failure_is_retried_and_then_succeeds(self):
        s = Script(http_error(429), http_error(503), urllib.error.URLError("reset"), ok_body())
        c = client(s)
        self.assertEqual(c.complete_json("s", "u").text, '{"entities": [], "relations": []}')
        self.assertEqual(len(s.requests), 4)

    def test_retries_stop_after_the_limit(self):
        s = Script(*[http_error(500) for _ in range(5)])
        with self.assertRaises(llm.LlmError) as ctx:
            client(s, max_retries=4).complete_json("s", "u")
        self.assertIn("HTTP 500", str(ctx.exception))
        self.assertEqual(len(s.requests), 5)

    def test_a_refused_key_and_an_empty_balance_stop_at_once_without_a_retry(self):
        for code, word in ((401, "refused the key"), (402, "balance")):
            s = Script(http_error(code), ok_body())
            with self.assertRaises(llm.FatalLlmError) as ctx:
                client(s).complete_json("s", "u")
            self.assertIn(word, str(ctx.exception))
            self.assertEqual(len(s.requests), 1)

    def test_a_bad_request_is_not_retried_and_says_what_the_api_said_in_its_own_words_only(self):
        s = Script(http_error(400, "unknown field thinking"))
        with self.assertRaises(llm.LlmError) as ctx:
            client(s).complete_json("s", "u")
        self.assertIn("HTTP 400: unknown field thinking", str(ctx.exception))
        self.assertEqual(len(s.requests), 1)

    def test_an_answer_that_is_not_a_chat_completion_is_an_error_not_a_crash(self):
        for body in (b"not json", b"{}", json.dumps({"choices": []}).encode()):
            with self.assertRaises(llm.LlmError):
                client(Script(body)).complete_json("s", "u")


class TheKeyStaysPut(unittest.TestCase):
    def test_no_error_repr_or_usage_ever_holds_the_key(self):
        c = client(Script(http_error(500, headers={"Authorization": f"Bearer {KEY}"}), http_error(500), http_error(500), http_error(500), http_error(500)))
        self.assertNotIn(KEY, repr(c))
        for items in ([http_error(401, headers={"Authorization": f"Bearer {KEY}"})], [urllib.error.URLError(f"failed with {KEY}")] * 5, [http_error(400, "bad")]):
            cc = client(Script(*items), max_retries=4)
            with self.assertRaises(llm.LlmError) as ctx:
                cc.complete_json("s", "u")
            self.assertNotIn(KEY, str(ctx.exception))
            self.assertNotIn(KEY, repr(ctx.exception))
            self.assertNotIn(KEY, json.dumps(cc.usage.to_dict()))
        with self.assertRaises(llm.LlmError) as ctx:
            c.complete_json("s", "u")
        self.assertNotIn(KEY, str(ctx.exception))

    def test_the_key_is_read_from_the_environment_or_a_hidden_prompt_and_never_from_a_file(self):
        self.assertEqual(llm.read_api_key({"DEEPSEEK_API_KEY": f"  {KEY}\n"}), KEY)
        self.assertEqual(llm.read_api_key({"LEANRAG_LLM_API_KEY": "abc"}), "abc")
        self.assertEqual(llm.read_api_key({}, prompt=lambda msg: " typed-key ", interactive=True), "typed-key")
        with self.assertRaises(llm.LlmError):
            llm.read_api_key({}, interactive=False)                       # not at a terminal and nothing in the environment
        with self.assertRaises(llm.LlmError):
            llm.read_api_key({}, prompt=lambda msg: "two words", interactive=True)
        with self.assertRaises(llm.LlmError):
            llm.read_api_key({}, prompt=lambda msg: "", interactive=True)

    def test_an_empty_key_is_refused_at_construction(self):
        with self.assertRaises(llm.LlmError):
            llm.ChatClient("")


class Budget(unittest.TestCase):
    def test_a_call_that_would_pass_a_limit_is_not_made(self):
        for budget, word in ((llm.Budget(max_calls=2), "call budget"), (llm.Budget(max_input_tokens=150), "input-token"), (llm.Budget(max_output_tokens=25), "output-token")):
            s = Script(ok_body(pin=100, pout=20), ok_body(pin=100, pout=20), ok_body())
            c = client(s, budget=budget)
            c.complete_json("s", "u")
            c.complete_json("s", "u")              # the limit is checked before a call: the second call is allowed to pass it, the third is not made
            with self.assertRaises(llm.BudgetExceeded) as ctx:
                c.complete_json("s", "u")
            self.assertIn(word, str(ctx.exception))
            self.assertEqual(len(s.requests), 2)


class ThePlanIsShared(unittest.TestCase):
    """The z.ai coding plan's quota is shared with the live service: what the build does at a limit is what keeps students' calls working."""

    def test_a_used_up_quota_stops_at_once_whatever_the_http_status_and_is_never_retried(self):
        for status, code in ((429, "1308"), (429, "1310"), (429, "1304"), (429, "1113"), (403, "1308")):
            s = Script(http_error(status, "limit reached, resets at 2026-11-11 23:00", vendor_code=code), ok_body())
            with self.assertRaises(llm.QuotaExhausted) as ctx:
                client(s).complete_json("s", "u")
            self.assertIsInstance(ctx.exception, llm.FatalLlmError)             # the build treats it like a refused key: stop, keep the cache
            self.assertIn(code, str(ctx.exception))
            self.assertIn("run the same command again", str(ctx.exception))
            self.assertEqual(len(s.requests), 1)

    def test_an_error_in_an_http_200_body_is_read_the_same_way(self):
        body = json.dumps({"error": {"code": "1308", "message": "5-hour limit reached"}}).encode()
        s = Script(body, ok_body())
        with self.assertRaises(llm.QuotaExhausted):
            client(s).complete_json("s", "u")
        self.assertEqual(len(s.requests), 1)
        busy = json.dumps({"code": 1305, "msg": "the model is busy"}).encode()
        with self.assertRaises(llm.LlmError) as ctx:
            client(Script(busy)).complete_json("s", "u")
        self.assertNotIsInstance(ctx.exception, llm.FatalLlmError)
        self.assertIn("1305", str(ctx.exception))
        self.assertIn("the model is busy", str(ctx.exception))

    def test_a_rate_limit_is_waited_out_with_a_long_back_off_and_then_stops_the_build(self):
        sleeps = []
        s = Script(*[http_error(429, "too many requests", vendor_code="1302") for _ in range(5)])
        c = llm.ChatClient(KEY, opener=s, sleep=sleeps.append, max_retries=4)
        with self.assertRaises(llm.RateLimited) as ctx:
            c.complete_json("s", "u")
        self.assertIsInstance(ctx.exception, llm.FatalLlmError)
        self.assertEqual(sleeps, [5, 10, 20, 40])
        self.assertEqual(len(s.requests), 5)
        self.assertIn("1302", str(ctx.exception))

    def test_a_busy_model_is_waited_for_and_is_not_taken_for_a_used_up_quota(self):
        s = Script(http_error(429, "the model is busy", vendor_code="1305"), ok_body())
        self.assertEqual(client(s).complete_json("s", "u").text, '{"entities": [], "relations": []}')
        self.assertEqual(len(s.requests), 2)

    def test_a_provider_that_does_not_take_json_mode_is_asked_again_without_it_and_remembered(self):
        s = Script(http_error(400, "response_format is not supported by this model"), ok_body(), ok_body())
        c = client(s)
        c.complete_json("s", "u")
        c.complete_json("s", "u")
        bodies = [json.loads(r.data) for r in s.requests]
        self.assertIn("response_format", bodies[0])
        self.assertNotIn("response_format", bodies[1])
        self.assertNotIn("response_format", bodies[2])                       # remembered: not asked for again on the next call
        self.assertEqual(bodies[1]["thinking"], {"type": "disabled"})        # only that one field went

    def test_a_provider_that_refuses_temperature_zero_is_asked_again_without_the_field_and_the_rest_stays(self):
        s = Script(http_error(400, "temperature must be greater than 0", vendor_code="1210"), ok_body(), ok_body())
        c = client(s)
        c.complete_json("s", "u")
        c.complete_json("s", "u")
        bodies = [json.loads(r.data) for r in s.requests]
        self.assertEqual(bodies[0]["temperature"], 0)
        self.assertNotIn("temperature", bodies[1])
        self.assertNotIn("temperature", bodies[2])                           # remembered
        self.assertEqual((bodies[1]["thinking"], bodies[1]["response_format"]), ({"type": "disabled"}, {"type": "json_object"}))

    def test_other_bad_requests_do_not_drop_json_mode(self):
        s = Script(http_error(400, "unknown field thinking"))
        c = client(s)
        with self.assertRaises(llm.LlmError):
            c.complete_json("s", "u")
        self.assertIn("response_format", json.loads(s.requests[0].data))
        self.assertTrue(c._json_mode)

    def test_the_cached_tokens_of_the_openai_style_usage_are_read_too(self):
        body = json.dumps({"model": "glm-5.3-flash", "choices": [{"message": {"content": "{}"}, "finish_reason": "stop"}],
                           "usage": {"prompt_tokens": 925, "completion_tokens": 40, "prompt_tokens_details": {"cached_tokens": 896}}}).encode()
        done = client(Script(body)).complete_json("s", "u")
        self.assertEqual((done.model, done.cache_hit_tokens), ("glm-5.3-flash", 896))

    def test_the_answer_is_read_from_content_and_an_empty_content_is_an_empty_text_not_a_crash(self):
        body = json.dumps({"model": "glm-5.3-flash", "choices": [{"message": {"content": None, "reasoning_content": "thinking out loud"}, "finish_reason": "length"}],
                           "usage": {"prompt_tokens": 10, "completion_tokens": 2200}}).encode()
        done = client(Script(body)).complete_json("s", "u")
        self.assertEqual((done.text, done.finish_reason), ("", "length"))


class Providers(unittest.TestCase):
    def test_each_provider_has_its_own_endpoint_model_and_key_variables_and_the_plan_goes_one_request_at_a_time(self):
        zai, deepseek = llm.PROVIDERS["zai"], llm.PROVIDERS["deepseek"]
        self.assertEqual((zai.base_url, zai.model, zai.workers, zai.host), ("https://api.z.ai/api/coding/paas/v4", "glm-5.3-flash", 1, "api.z.ai"))
        self.assertEqual((deepseek.base_url, deepseek.model, deepseek.host), (llm.DEFAULT_BASE_URL, llm.DEFAULT_MODEL, "api.deepseek.com"))
        self.assertGreater(deepseek.workers, 1)
        self.assertNotIn("DEEPSEEK_API_KEY", zai.key_variables)
        self.assertNotIn("ZAI_API_KEY", deepseek.key_variables)

    def test_one_providers_key_is_never_offered_to_the_other_providers_host(self):
        zai = llm.PROVIDERS["zai"]
        with self.assertRaises(llm.LlmError):
            llm.read_api_key({"DEEPSEEK_API_KEY": KEY}, names=zai.key_variables, interactive=False)
        self.assertEqual(llm.read_api_key({"ZAI_API_KEY": " zai-key \n"}, names=zai.key_variables), "zai-key")
        with self.assertRaises(llm.LlmError):
            llm.read_api_key({"ZAI_API_KEY": KEY}, names=llm.PROVIDERS["deepseek"].key_variables, interactive=False)

    def test_a_prompt_is_only_offered_when_both_stdin_and_stdout_are_a_terminal(self):
        class Stream:
            def __init__(self, tty):
                self.tty = tty

            def isatty(self):
                return self.tty
        saved = sys.stdin, sys.stdout
        try:
            for stdin_tty, stdout_tty, expected in ((True, True, True), (True, False, False), (False, True, False), (False, False, False)):
                sys.stdin, sys.stdout = Stream(stdin_tty), Stream(stdout_tty)
                self.assertEqual(llm.at_terminal(), expected, (stdin_tty, stdout_tty))
            sys.stdin, sys.stdout = None, Stream(True)
            self.assertFalse(llm.at_terminal())
            # with stdin a null device that claims to be a terminal (what Windows does) and no console to show a prompt on, the key is asked for from nobody: it must fail, not wait
            sys.stdin, sys.stdout = Stream(True), Stream(False)
            with self.assertRaises(llm.LlmError):
                llm.read_api_key({}, prompt=lambda msg: self.fail("a hidden prompt was shown with nobody to answer it"))
        finally:
            sys.stdin, sys.stdout = saved

    def test_the_hidden_prompt_names_the_host_the_key_is_for(self):
        shown = []
        llm.read_api_key({}, prompt=lambda msg: shown.append(msg) or "typed", interactive=True, names=llm.PROVIDERS["zai"].key_variables, host="api.z.ai")
        self.assertIn("api.z.ai", shown[0])
        self.assertIn("hidden", shown[0])

    def test_the_request_goes_to_the_providers_endpoint(self):
        s = Script(ok_body())
        llm.ChatClient(KEY, base_url=llm.ZAI_BASE_URL, model=llm.ZAI_MODEL, opener=s, sleep=lambda x: None).complete_json("s", "u")
        self.assertEqual(s.requests[0].full_url, "https://api.z.ai/api/coding/paas/v4/chat/completions")
        self.assertEqual(json.loads(s.requests[0].data)["model"], "glm-5.3-flash")


class TheCacheAndTheOfflineRun(unittest.TestCase):
    def test_an_offline_client_refuses_every_request_with_a_fatal_error(self):
        c = llm.OfflineClient("some-model")
        self.assertEqual(c.model, "some-model")
        with self.assertRaises(llm.NotCached) as ctx:
            c.complete_json("s", "u")
        self.assertIsInstance(ctx.exception, llm.FatalLlmError)

    def test_a_lazy_client_asks_for_its_key_only_when_a_request_needs_it_and_a_missing_key_is_fatal(self):
        made = []
        lazy = llm.LazyClient("m", lambda: made.append(1) or client(Script(ok_body(), ok_body())))
        self.assertEqual((made, lazy.usage.calls), ([], 0))                  # nothing asked for by merely existing
        lazy.complete_json("s", "u")
        lazy.complete_json("s", "u")
        self.assertEqual(len(made), 1)                                       # made once, at the first request
        self.assertEqual(lazy.usage.calls, 2)

        def no_key():
            raise llm.LlmError("no API key: set X")
        with self.assertRaises(llm.FatalLlmError):                          # not "one answer failed": the step that needed the key must stop
            llm.LazyClient("m", no_key).ensure()

    def test_a_cached_client_asks_once_per_prompt_and_a_second_process_finds_the_answer_in_the_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / "names.jsonl"
            s = Script(ok_body('{"name": "A"}', model="m-1", pin=50, pout=7), ok_body('{"name": "B"}', model="m-1", pin=60, pout=8))
            first = llm.CachedClient(client(s), path)
            self.assertEqual(first.complete_json("sys", "one").text, '{"name": "A"}')
            self.assertEqual(first.complete_json("sys", "one").text, '{"name": "A"}')       # the same prompt: from the cache
            self.assertEqual(first.complete_json("sys", "two").text, '{"name": "B"}')
            self.assertEqual(len(s.requests), 2)
            self.assertEqual(len(first.used), 2)
            second = llm.CachedClient(llm.OfflineClient("deepseek-flash"), path)         # a later run with no key at all
            self.assertEqual(second.complete_json("sys", "one").text, '{"name": "A"}')
            with self.assertRaises(llm.NotCached):
                second.complete_json("sys", "three")                                   # a new prompt is not in the file
            self.assertEqual(llm.sum_usage(second.used.values())["models_returned"], {"m-1": 1})
            for line in path.read_text(encoding="utf-8").splitlines():
                self.assertNotIn(KEY, line)

    def test_the_cache_is_keyed_by_the_model_and_the_prompt_and_a_torn_last_line_is_ignored(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / "names.jsonl"
            llm.CachedClient(client(Script(ok_body("{}"))), path).complete_json("sys", "u")
            other = client(Script(ok_body("{}")))
            other.model = "another-model"
            llm.CachedClient(other, path).complete_json("sys", "u")                        # another model: asked, not served
            self.assertEqual(len(path.read_text(encoding="utf-8").splitlines()), 2)
            with open(path, "a", encoding="utf-8") as f:
                f.write('{"key": "abc", "raw": "{trunc')
            llm.CachedClient(llm.OfflineClient("deepseek-flash"), path).complete_json("sys", "u")

    def test_the_usage_totals_count_the_requests_an_answer_took_and_are_the_same_for_cached_answers(self):
        records = [{"model": "m-1", "prompt_tokens": 100, "completion_tokens": 20, "cache_hit_tokens": 40, "attempts": 2},
                   {"model": "m-1", "prompt_tokens": 50, "completion_tokens": 10},
                   {"model": "", "prompt_tokens": 0, "completion_tokens": 0}]
        self.assertEqual(llm.sum_usage(records), {"calls": 3, "prompt_tokens": 150, "completion_tokens": 30, "cache_hit_tokens": 40, "models_returned": {"m-1": 3}})


if __name__ == "__main__":
    unittest.main()
