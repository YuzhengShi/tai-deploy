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

    def test_default_budget_leaves_nora_a_share(self):
        self.assertEqual(cb.BUDGETS["qwen"].limit, int(os.environ.get("TAI_QWEN_TPM_BUDGET", "90000")))
        self.assertLess(cb.BUDGETS["qwen"].limit, 150000)      # the account's qwen bucket
        self.assertEqual(cb.SPILL["qwen"], "gpt-oss")


if __name__ == "__main__":
    unittest.main()
