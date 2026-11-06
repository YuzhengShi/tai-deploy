"""LiteLLM callbacks for the TAi evaluation gateway.

1. Strip what clients replay of a reasoning model's earlier turns: the thinking blocks Claude Code sends on the Anthropic route, and the
   reasoning_content / reasoning fields pi sends on the chat-completions route. Cerebras rejects them (HTTP 400, "messages.4.assistant.
   reasoning_content: property ... is unsupported", seen when a gpt-oss answer was replayed to the next call), which would end every
   tool loop on a reasoning model at its second request.
2. Log the upstream result of every call to GATEWAY_LOG as one JSON line: time, model, seconds, tokens, and for a failure the HTTP
   status (a 429 from Cerebras shows up here, not as silent latency).
3. Keep TAi inside its share of the qwen tokens-per-minute bucket it has with Nora (the same Cerebras account). The qwen alias may use
   TAI_QWEN_TPM_BUDGET tokens in any 60 seconds (0 = no limit); above that a new request is sent to gpt-oss instead (an event "spill" in
   the log). What a request uses of the bucket is its UNCACHED prompt tokens plus its completion: Cerebras does not charge the cached
   part of a prompt (harness/rate_probe.py: five calls with a 41,088-token cached prefix took 60 tokens each from the bucket), and most of
   TAi's 33k-token prompt is cached. Failures of qwen itself (a 429 because Nora used the bucket, a 5xx) are handled by
   router_settings.fallbacks in config.yaml, not here.
"""
import collections
import json
import os
import time

from litellm.integrations.custom_logger import CustomLogger

LOG = os.environ.get("GATEWAY_LOG", "/logs/gateway.jsonl")
SPILL = {"qwen": "gpt-oss"}         # alias that has a budget -> where its overflow goes
UNDERLYING = {"qwen": "qwen"}       # alias -> what its model name contains once LiteLLM has resolved it (the budget counts by this)


class Budget:
    """Tokens used in a sliding window (60 s): add what a request cost when it completes, ask whether the limit is reached."""

    def __init__(self, limit, window=60.0):
        self.limit = limit
        self.window = window
        self.events = collections.deque()

    def _trim(self, now):
        while self.events and self.events[0][0] <= now - self.window:
            self.events.popleft()

    def add(self, tokens, now=None):
        now = time.time() if now is None else now
        self.events.append((now, tokens))
        self._trim(now)

    def used(self, now=None):
        now = time.time() if now is None else now
        self._trim(now)
        return sum(t for _ts, t in self.events)

    def reached(self, now=None):
        return self.limit > 0 and self.used(now) >= self.limit


BUDGETS = {"qwen": Budget(int(os.environ.get("TAI_QWEN_TPM_BUDGET", "90000")))}


def budget_tokens(usage):
    """What a completed request takes from Cerebras's tokens-per-minute bucket: the prompt tokens that were not a cache hit, and the completion."""
    return max((usage.get("in") or 0) - (usage.get("cached") or 0), 0) + (usage.get("out") or 0)


def _write(entry):
    entry["ts"] = round(time.time(), 3)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def _usage(response_obj):
    usage = response_obj.get("usage") if isinstance(response_obj, dict) else getattr(response_obj, "usage", None)
    if usage is None:
        return {}
    get = (lambda k: usage.get(k)) if isinstance(usage, dict) else (lambda k: getattr(usage, k, None))
    details = get("prompt_tokens_details")
    cached = None
    if details is not None:
        cached = details.get("cached_tokens") if isinstance(details, dict) else getattr(details, "cached_tokens", None)
    return {"in": get("prompt_tokens") or get("input_tokens"), "out": get("completion_tokens") or get("output_tokens"), "cached": cached}


REPLAYED_REASONING_FIELDS = ("reasoning_content", "reasoning", "thinking_blocks")


def strip_replayed_reasoning(messages):
    """Remove the reasoning an assistant message carries from an earlier call: Anthropic thinking blocks in its content, and the
    reasoning fields of the chat-completions format. Changes the messages in place, returns how many pieces it removed."""
    stripped = 0
    for msg in messages or []:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, list):
            kept = [b for b in content if not (isinstance(b, dict) and b.get("type") in ("thinking", "redacted_thinking"))]
            if len(kept) != len(content):
                stripped += len(content) - len(kept)
                msg["content"] = kept or [{"type": "text", "text": "."}]
        for field in REPLAYED_REASONING_FIELDS:
            if field in msg:
                del msg[field]
                stripped += 1
    return stripped


class TaiHandler(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        try:
            stripped = strip_replayed_reasoning(data.get("messages"))
            if stripped:
                _write({"event": "stripped_thinking", "blocks": stripped})
            alias = data.get("model")
            budget = BUDGETS.get(alias)
            if budget is not None and budget.reached():
                _write({"event": "spill", "from": alias, "to": SPILL[alias], "used_in_window": budget.used(), "limit": budget.limit})
                data["model"] = SPILL[alias]
        except Exception as exc:
            _write({"event": "hook_error", "error": repr(exc)[:200]})
        return data

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            usage = _usage(response_obj)
            _write({"event": "ok", "model": kwargs.get("model"), "seconds": round((end_time - start_time).total_seconds(), 2), **usage})
            for alias, marker in UNDERLYING.items():
                if marker in str(kwargs.get("model")).lower():
                    BUDGETS[alias].add(budget_tokens(usage))
        except Exception:
            pass

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        try:
            exc = kwargs.get("exception")
            _write({"event": "fail", "model": kwargs.get("model"), "seconds": round((end_time - start_time).total_seconds(), 2),
                    "status": getattr(exc, "status_code", None), "error": str(exc)[:240]})
        except Exception:
            pass


proxy_handler_instance = TaiHandler()
