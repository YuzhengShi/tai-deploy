"""A small chat-completions client for the OFFLINE graph build (DeepSeek's own API, or the OpenAI-style endpoint of the z.ai GLM Coding Plan). Standard library only; the query path never imports it.

What it is for: the build (leanrag/build.py) asks a model to read slide text and return entities and relations, and to name clusters. This file is that
one door. Rules it keeps:

  * The key is read only from the process environment (the provider's own variable, see PROVIDERS, or LEANRAG_LLM_API_KEY) or typed at a hidden prompt
    (getpass). Each provider names its own variable, so one provider's key is never offered to another provider's host. It is never written to a file,
    a log, the cache or the manifest, and no exception carries a request header or the request body.
  * A call that would pass the budget (calls, input tokens, output tokens) is not made: `BudgetExceeded`. The check is before each call, so the last
    call can pass a limit by one answer.
  * An answer that says the plan's quota or balance is used up (QUOTA_CODES) stops the build at once: no retry brings it back before the window resets,
    and a retry storm would take quota from whatever else uses the same key. A rate limit (HTTP 429) is waited out with a long back-off and, if it
    persists, stops the build too (`RateLimited`). Progress is in the cache either way.
  * Temperature 0 and JSON mode (each left out for good if the provider answers HTTP 400 naming it), thinking off (as the gateway's `deepseek` and
    `glm` aliases send it: eval/litellm/config.yaml), no tools, no streaming.
  * It reports the model id the API RETURNS, not the alias that was asked for: the thesis numbers depend on which model answered.

Nothing here reads a file other than what the caller passes (the answer caches), and it does not import leanrag.config (which loads a .env).
"""
from __future__ import annotations

import getpass
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-flash"      # the id eval/litellm/config.yaml asks for ("DeepSeek-V4.1-Flash"); the answer says which model really replied
KEY_VARIABLES = ("DEEPSEEK_API_KEY", "LEANRAG_LLM_API_KEY")        # the default provider's
# The GLM Coding Plan's OpenAI-style endpoint (the pay-per-token one, /api/paas/v4, answers code 1113 "no balance or resource package" for a plan key).
ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4"
ZAI_MODEL = "glm-5.3-flash"
RETRY_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}
# z.ai codes that mean "used up until the window resets": no balance or package, the day's limit, the 5-hour limit, the weekly limit.
# (1302 / 1303 / 1305, too many at once / too fast / the model is busy, are waited out like any 429.)
QUOTA_CODES = {"1113", "1304", "1308", "1310"}


class LlmError(Exception):
    """Anything that went wrong with a call. The message never holds the key, a header or the request."""


class BudgetExceeded(LlmError):
    pass


class FatalLlmError(LlmError):
    """A refusal that no retry fixes (the key, the balance): the build stops instead of paying for the same answer on every unit."""


class QuotaExhausted(FatalLlmError):
    """The plan's quota or balance is used up until its window resets."""


class RateLimited(FatalLlmError):
    """HTTP 429 that did not go away through the whole back-off."""


class NotCached(FatalLlmError):
    """An offline run met a step whose answer is not in the cache."""


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    model: str
    key_variables: tuple
    workers: int          # requests at a time (z.ai: one, because the plan's quota is shared with the live service that uses the same key)
    host: str             # what the hidden prompt names, so the right key is typed
    note: str = ""


PROVIDERS = {
    "deepseek": Provider("deepseek", DEFAULT_BASE_URL, DEFAULT_MODEL, KEY_VARIABLES, 4, "api.deepseek.com"),
    "zai": Provider("zai", ZAI_BASE_URL, ZAI_MODEL, ("ZAI_API_KEY", "LEANRAG_LLM_API_KEY"), 1, "api.z.ai",
                    "the z.ai GLM Coding Plan: its quota is shared with the live TAi and Nora, so one request at a time"),
}


@dataclass
class Completion:
    text: str
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_hit_tokens: int = 0
    finish_reason: str = ""


@dataclass
class Budget:
    max_calls: int = 400
    max_input_tokens: int = 600_000
    max_output_tokens: int = 170_000


@dataclass
class Usage:
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_hit_tokens: int = 0
    models: dict = field(default_factory=dict)      # the model ids the API returned -> how many answers

    def to_dict(self) -> dict:
        return {"calls": self.calls, "prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens,
                "cache_hit_tokens": self.cache_hit_tokens, "models_returned": dict(self.models)}


def sum_usage(records) -> dict:
    """What the answers a build is made from cost, in the shape of Usage.to_dict(): the sum over cached and fresh answers alike, so that a build
    rebuilt from the cache (no key, nothing sent) still says what its graph cost. `attempts` is how many requests an answer took (1 when absent)."""
    total: dict = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cache_hit_tokens": 0, "models_returned": {}}
    for r in records:
        model = str(r.get("model") or "")
        attempts = (int(r.get("attempts") or 1)) if model else 0
        total["calls"] += attempts
        for field_name in ("prompt_tokens", "completion_tokens", "cache_hit_tokens"):
            total[field_name] += int(r.get(field_name) or 0)
        if model:
            total["models_returned"][model] = total["models_returned"].get(model, 0) + attempts
    return total


def at_terminal() -> bool:
    """True only when a person can see a prompt and answer it: stdin AND stdout are a terminal. (On Windows the null device passes for a terminal on
    stdin alone, and a hidden prompt would then wait for ever in a script, a scheduler or a tool that runs the build.)"""
    try:
        return bool(sys.stdin is not None and sys.stdin.isatty() and sys.stdout is not None and sys.stdout.isatty())
    except (AttributeError, ValueError):
        return False


def read_api_key(env=None, prompt=getpass.getpass, interactive: bool | None = None, names: tuple = KEY_VARIABLES, host: str = "api.deepseek.com") -> str:
    """The key from the environment (one of `names`), else typed (hidden) when there is a person at the terminal. Never from a file."""
    env = os.environ if env is None else env
    for name in names:
        value = (env.get(name) or "").strip()
        if value:
            return value
    if interactive is None:
        interactive = at_terminal()
    if not interactive:
        raise LlmError(f"no API key: set {names[0]} in the environment of this process, or run the command at a terminal and type it when asked")
    value = (prompt(f"API key for {host} (typed hidden, kept in memory only): ") or "").strip()
    if not value or any(ch.isspace() for ch in value):
        raise LlmError("that is not a key (empty, or it has a space in it)")
    return value


class ChatClient:
    """A provider's /chat/completions, one request at a time per call (a caller may use several threads: the counters are locked)."""

    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL, model: str = DEFAULT_MODEL, budget: Budget | None = None,
                 timeout: float = 120.0, max_retries: int = 4, opener=None, sleep=time.sleep, json_mode: bool = True) -> None:
        if not api_key:
            raise LlmError("no API key")
        self._key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.budget = budget or Budget()
        self.timeout = timeout
        self.max_retries = max_retries
        self.usage = Usage()
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep
        self._lock = threading.Lock()
        self._json_mode = json_mode
        self._temperature: float | None = 0

    def __repr__(self) -> str:        # the key is not in any repr
        return f"ChatClient(base_url={self.base_url!r}, model={self.model!r}, calls={self.usage.calls})"

    def _check_budget(self) -> None:
        u, b = self.usage, self.budget
        if u.calls >= b.max_calls:
            raise BudgetExceeded(f"call budget used: {u.calls} of {b.max_calls}")
        if u.prompt_tokens >= b.max_input_tokens:
            raise BudgetExceeded(f"input-token budget used: {u.prompt_tokens} of {b.max_input_tokens}")
        if u.completion_tokens >= b.max_output_tokens:
            raise BudgetExceeded(f"output-token budget used: {u.completion_tokens} of {b.max_output_tokens}")

    def _body(self, system: str, user: str, max_tokens: int) -> bytes:
        payload = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": max_tokens,
            "thinking": {"type": "disabled"},
            "stream": False,
        }
        if self._temperature is not None:
            payload["temperature"] = self._temperature
        if self._json_mode:
            payload["response_format"] = {"type": "json_object"}
        return json.dumps(payload).encode("utf-8")

    def complete_json(self, system: str, user: str, max_tokens: int = 1500) -> Completion:
        with self._lock:
            self._check_budget()
        body = self._body(system, user, max_tokens)
        last = "no attempt was made"
        for attempt in range(self.max_retries + 1):
            request = urllib.request.Request(f"{self.base_url}/chat/completions", data=body, method="POST",
                                             headers={"Content-Type": "application/json", "Authorization": f"Bearer {self._key}"})
            try:
                with self._open(request, timeout=self.timeout) as response:
                    raw = response.read()
            except urllib.error.HTTPError as exc:
                status = exc.code
                code, detail = _error_info(exc)
                if status == 401:
                    raise FatalLlmError("the API refused the key (HTTP 401)") from None
                if status == 402:
                    raise FatalLlmError("the API says the balance is empty (HTTP 402)") from None
                if code in QUOTA_CODES:
                    raise QuotaExhausted(f"the plan's quota or balance is used up (code {code}{(': ' + detail) if detail else ''}); what is done is in the cache: run the same command again once the window has reset") from None
                if status == 400 and self._json_mode and "response_format" in detail.lower():
                    self._json_mode = False           # a provider that does not take JSON mode: ask without it (the answer is parsed either way)
                    body = self._body(system, user, max_tokens)
                    last = "HTTP 400"
                    continue
                if status == 400 and self._temperature is not None and "temperature" in detail.lower():
                    self._temperature = None          # a provider that does not take temperature 0: leave the field out (its own default is used)
                    body = self._body(system, user, max_tokens)
                    last = "HTTP 400"
                    continue
                if status in RETRY_STATUS and attempt < self.max_retries:
                    last = f"HTTP {status}"
                    self._sleep(min(60, 5 * 2 ** attempt) if status == 429 else min(30, 2 ** attempt))
                    continue
                if status == 429:
                    raise RateLimited(f"still rate-limited after {attempt + 1} tries{(' (code ' + code + ')') if code else ''}: the build stops so that it does not keep taking quota; what is done is in the cache, run the same command again later") from None
                raise LlmError(f"the API answered HTTP {status}{(': ' + detail) if detail else ''}") from None
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
                last = type(exc).__name__
                if attempt < self.max_retries:
                    self._sleep(min(30, 2 ** attempt))
                    continue
                raise LlmError(f"could not reach the API ({last})") from None
            try:
                data = json.loads(raw)
                choice = data["choices"][0]
                text = choice["message"]["content"] or ""
            except (ValueError, KeyError, IndexError, TypeError):
                code, detail = _error_fields(raw)             # some providers put an error in an HTTP 200 body
                if code in QUOTA_CODES:
                    raise QuotaExhausted(f"the plan's quota or balance is used up (code {code}{(': ' + detail) if detail else ''}); what is done is in the cache: run the same command again once the window has reset") from None
                raise LlmError("the API's answer was not a chat completion" + (f" (code {code}: {detail})" if code or detail else "")) from None
            usage = data.get("usage") or {}
            details = usage.get("prompt_tokens_details")
            cached = usage.get("prompt_cache_hit_tokens") or (details.get("cached_tokens") if isinstance(details, dict) else 0)
            done = Completion(text=text, model=str(data.get("model") or ""), prompt_tokens=int(usage.get("prompt_tokens") or 0),
                              completion_tokens=int(usage.get("completion_tokens") or 0),
                              cache_hit_tokens=int(cached or 0), finish_reason=str(choice.get("finish_reason") or ""))
            with self._lock:
                self.usage.calls += 1
                self.usage.prompt_tokens += done.prompt_tokens
                self.usage.completion_tokens += done.completion_tokens
                self.usage.cache_hit_tokens += done.cache_hit_tokens
                self.usage.models[done.model] = self.usage.models.get(done.model, 0) + 1
            return done
        raise LlmError(f"the API did not answer after {self.max_retries + 1} tries (last: {last})")


def _error_fields(body) -> tuple[str, str]:
    """(code, message) in an error body: the vendor's own code as text and at most 200 characters of its message (never headers, never what was sent)."""
    try:
        data = json.loads(body)
    except Exception:  # noqa: BLE001  (a body that is not JSON says nothing)
        return "", ""
    if not isinstance(data, dict):
        return "", ""
    error = data.get("error")
    source = error if isinstance(error, dict) else data
    return str(source.get("code") or "")[:20], str(source.get("message") or source.get("msg") or "")[:200]


def _error_info(exc: urllib.error.HTTPError) -> tuple[str, str]:
    """(code, message) of what the API says went wrong in an HTTP error's body."""
    try:
        return _error_fields(exc.read(4096))
    except Exception:  # noqa: BLE001
        return "", ""


class OfflineClient:
    """The client of a run that may send nothing (`build --offline`): every request is refused, so a step that is not in the cache stops the build
    loudly instead of being skipped."""

    def __init__(self, model: str) -> None:
        self.model = model
        self.usage = Usage()

    def complete_json(self, system: str, user: str, max_tokens: int = 1500) -> Completion:
        raise NotCached("this step is not in the cache and the run is offline: run the build once with the key to fill the cache")


class LazyClient:
    """A client made when a request first needs it: `make` (which may ask for the key at the terminal) runs on the first `ensure()` or call. A run that the
    cache answers completely never asks for a key. `ensure()` belongs on the main thread, before any worker starts, so that the hidden prompt is not shown from a thread."""

    def __init__(self, model: str, make) -> None:
        self.model = model
        self._make = make
        self._inner = None
        self._lock = threading.Lock()

    @property
    def usage(self) -> Usage:
        return self._inner.usage if self._inner is not None else Usage()

    def ensure(self):
        with self._lock:
            if self._inner is None:
                try:
                    self._inner = self._make()
                except FatalLlmError:
                    raise
                except LlmError as exc:                 # a missing key is not "one answer failed": it must stop the step that needed it
                    raise FatalLlmError(str(exc)) from None
        return self._inner

    def complete_json(self, system: str, user: str, max_tokens: int = 1500) -> Completion:
        return self.ensure().complete_json(system, user, max_tokens)


class CachedClient:
    """A client with a file of answers keyed by (tag, model, prompt): what the build asks once (cluster and theme names) is found here the next time,
    which is what lets a finished build be rebuilt or published without a key. `used` holds the answer records this run relied on, found or fresh."""

    def __init__(self, inner, path, tag: str = "name-v1") -> None:
        self._inner = inner
        self._path = Path(path)
        self._tag = tag
        self._lock = threading.Lock()
        self._records: dict[str, dict] = {}
        self.used: dict[str, dict] = {}
        if self._path.is_file():
            for line in self._path.read_text(encoding="utf-8").splitlines():
                try:
                    record = json.loads(line)
                    self._records[record["key"]] = record
                except (ValueError, KeyError):
                    continue          # a half-written last line after a crash: that answer is asked again

    @property
    def model(self) -> str:
        return self._inner.model

    @property
    def usage(self) -> Usage:
        return self._inner.usage

    def complete_json(self, system: str, user: str, max_tokens: int = 1500) -> Completion:
        key = hashlib.sha256("\x1f".join((self._tag, self.model, system, user, str(max_tokens))).encode("utf-8")).hexdigest()
        with self._lock:
            hit = self._records.get(key)
            if hit is not None:
                self.used[key] = hit
        if hit is not None:
            return Completion(text=str(hit.get("raw") or ""), model=str(hit.get("model") or ""), prompt_tokens=int(hit.get("prompt_tokens") or 0),
                              completion_tokens=int(hit.get("completion_tokens") or 0), finish_reason="cached")
        done = self._inner.complete_json(system, user, max_tokens)
        record = {"key": key, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "model": done.model, "prompt_tokens": done.prompt_tokens,
                  "completion_tokens": done.completion_tokens, "cache_hit_tokens": done.cache_hit_tokens, "raw": done.text}
        with self._lock:
            self._records[key] = record
            self.used[key] = record
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        return done
