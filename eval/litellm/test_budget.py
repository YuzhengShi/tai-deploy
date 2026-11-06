"""The qwen budget of the gateway (tai_callbacks.py) without LiteLLM: python3 eval/litellm/test_budget.py"""
import importlib.util
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def load_callbacks():
    # LiteLLM is only in the gateway's container: give the module the one class it imports
    for name in ("litellm", "litellm.integrations", "litellm.integrations.custom_logger"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["litellm.integrations.custom_logger"].CustomLogger = type("CustomLogger", (), {})
    spec = importlib.util.spec_from_file_location("tai_callbacks", os.path.join(HERE, "tai_callbacks.py"))
    module = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True
    spec.loader.exec_module(module)
    return module


cb = load_callbacks()


class BudgetTest(unittest.TestCase):
    def test_reached_when_the_window_holds_the_limit(self):
        b = cb.Budget(100)
        self.assertFalse(b.reached(0))
        b.add(60, now=10)
        self.assertFalse(b.reached(10))
        b.add(50, now=20)
        self.assertTrue(b.reached(20))
        self.assertEqual(b.used(20), 110)

    def test_old_requests_leave_the_window(self):
        b = cb.Budget(100)
        b.add(60, now=10)
        b.add(50, now=20)
        self.assertEqual(b.used(69.9), 110)
        self.assertEqual(b.used(70.1), 50)      # the first request left at t = 70
        self.assertFalse(b.reached(70.1))

    def test_zero_means_no_limit(self):
        b = cb.Budget(0)
        b.add(10 ** 9, now=1)
        self.assertFalse(b.reached(1))

    def test_only_uncached_tokens_and_the_completion_are_charged(self):
        # harness/rate_probe.py: a call with a 41,088-token cached prefix took 60 tokens from the bucket (44 uncached + 16 completion)
        self.assertEqual(cb.budget_tokens({"in": 41132, "cached": 41088, "out": 16}), 60)
        self.assertEqual(cb.budget_tokens({"in": 41132, "cached": 0, "out": 16}), 41148)       # a cache miss pays the whole prompt
        self.assertEqual(cb.budget_tokens({"in": 100, "cached": 150, "out": 5}), 5)             # never negative
        self.assertEqual(cb.budget_tokens({}), 0)
        self.assertEqual(cb.budget_tokens({"in": None, "cached": None, "out": None}), 0)

    def test_default_budget_leaves_nora_a_share(self):
        self.assertEqual(cb.BUDGETS["qwen"].limit, int(os.environ.get("TAI_QWEN_TPM_BUDGET", "90000")))
        self.assertLess(cb.BUDGETS["qwen"].limit, 150000)      # the account's qwen bucket
        self.assertEqual(cb.SPILL["qwen"], "gpt-oss")


class ReplayedReasoningTest(unittest.TestCase):
    """Cerebras answers 400 to an assistant message that carries reasoning_content (seen on the chat route when a gpt-oss answer was replayed
    to the next call of a pi conversation); the gateway removes it, and the Anthropic thinking blocks, before the request goes on."""

    def test_the_chat_completions_fields_go(self):
        messages = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "1", "type": "function", "function": {"name": "read", "arguments": "{}"}}],
             "reasoning_content": "I should read the file", "reasoning": "same", "thinking_blocks": [{"type": "thinking", "thinking": "x"}]},
            {"role": "tool", "tool_call_id": "1", "content": "text"},
        ]
        self.assertEqual(cb.strip_replayed_reasoning(messages), 3)
        self.assertEqual(set(messages[1]), {"role", "content", "tool_calls"})
        self.assertEqual(messages[0], {"role": "user", "content": "hi"})
        self.assertEqual(messages[2], {"role": "tool", "tool_call_id": "1", "content": "text"})

    def test_the_anthropic_thinking_blocks_go_as_before(self):
        messages = [{"role": "assistant", "content": [{"type": "thinking", "thinking": "x"}, {"type": "text", "text": "answer"}]},
                    {"role": "assistant", "content": [{"type": "redacted_thinking", "data": "x"}]}]
        self.assertEqual(cb.strip_replayed_reasoning(messages), 2)
        self.assertEqual(messages[0]["content"], [{"type": "text", "text": "answer"}])
        self.assertEqual(messages[1]["content"], [{"type": "text", "text": "."}])      # a message may not end up empty

    def test_only_assistant_messages_and_nothing_else_is_touched(self):
        messages = [{"role": "user", "content": "x", "reasoning": "a user may say what it likes"}, {"role": "system", "content": "s"}]
        self.assertEqual(cb.strip_replayed_reasoning(messages), 0)
        self.assertIn("reasoning", messages[0])
        self.assertEqual(cb.strip_replayed_reasoning(None), 0)
        self.assertEqual(cb.strip_replayed_reasoning([]), 0)
        self.assertEqual(cb.strip_replayed_reasoning(["not a dict", None]), 0)


if __name__ == "__main__":
    unittest.main()
