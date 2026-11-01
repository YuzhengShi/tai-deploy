"""LiteLLM callbacks for the TAi evaluation gateway.

1. Strip the thinking blocks Claude Code replays in earlier assistant turns. Cerebras rejects the reasoning_content / thinking_blocks
   fields LiteLLM would build from them (HTTP 400), which would end every tool loop on a reasoning model at its second request.
2. Log the upstream result of every call to GATEWAY_LOG as one JSON line: time, model, seconds, tokens, and for a failure the HTTP
   status (a 429 from Cerebras shows up here, not as silent latency).
"""
import json
import os
import time

from litellm.integrations.custom_logger import CustomLogger

LOG = os.environ.get("GATEWAY_LOG", "/logs/gateway.jsonl")


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


class TaiHandler(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        try:
            stripped = 0
            for msg in data.get("messages") or []:
                content = msg.get("content") if isinstance(msg, dict) else None
                if msg.get("role") == "assistant" and isinstance(content, list):
                    kept = [b for b in content if not (isinstance(b, dict) and b.get("type") in ("thinking", "redacted_thinking"))]
                    if len(kept) != len(content):
                        stripped += len(content) - len(kept)
                        msg["content"] = kept or [{"type": "text", "text": "."}]
            if stripped:
                _write({"event": "stripped_thinking", "blocks": stripped})
        except Exception as exc:
            _write({"event": "hook_error", "error": repr(exc)[:200]})
        return data

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            _write({"event": "ok", "model": kwargs.get("model"), "seconds": round((end_time - start_time).total_seconds(), 2), **_usage(response_obj)})
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
