#!/usr/bin/env python3
"""A scripted Anthropic Messages API, for testing TAi's machinery without a real model.

Claude Code (the CLI the Agent SDK drives inside TAi's container) is pointed here with ANTHROPIC_BASE_URL. The "model" does exactly
what a script says: emit a fixed tool call, wait, answer with text, or fail with an HTTP error. So a guard, a resume or a scheduling
test has a ground truth that does not depend on what a language model feels like doing.

A script is chosen by a directive in the student's message: MOCK:<name> (letters, digits, _ . -). The message reaches the model
wrapped in <messages><message ...>..</message></messages> and XML-escaped, which this charset survives. <name> is a JSON file in
MOCK_SCRIPTS (default /scripts):

    {"steps": [{"tool": "Bash", "input": {"command": "id"}, "sleep": 2}, {"tool": "Read", "input": {"file_path": "/etc/hostname"}}],
     "final": {"echo": "all"}}

  steps[k]  is what the model does at its k-th request since the directive arrived (k = tool results already returned):
            {"tool", "input"} emits a tool call; {"sleep": s} waits s seconds first; {"error": {"status", "type", "message"}}
            answers with an HTTP error; {"text": "..."} answers with text and stops.
  final     once the steps are used up: {"text": "..."}; {"echo": "all"} answers with what each tool returned (first 300 chars);
            {"history": true} answers with what the model was shown (message count, markers MARK-xxx seen in earlier turns,
            whether the system prompt carries TAi's persona); a "sleep" key delays any of these.

A script names Claude Code's tools (Bash, Read, Write, Edit, Grep, Glob, WebFetch ...). When the client is pi (its tools are bash, read ...)
the call is translated to pi's name and arguments, so one script serves both harnesses (pi_call).

Requests with no tools (Claude Code's own background calls: titles, quota checks) get a short fixed text. Every request is appended
to MOCK_LOG as one JSON line (time, path, message summary, step, what was sent back), so a test can read what the model was shown.
"""
import hashlib
import json
import os
import random
import re
import string
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("MOCK_PORT", "8000"))
SCRIPTS_DIR = os.environ.get("MOCK_SCRIPTS", "/scripts")
LOG_PATH = os.environ.get("MOCK_LOG", "/logs/mockllm.jsonl")
DIRECTIVE = re.compile(r"MOCK:([A-Za-z0-9_.-]+)")
MARKER = re.compile(r"MARK-[A-Za-z0-9]+")
PLANTED = re.compile(r"PLANTED-[A-Za-z0-9_-]+")
PERSONA_FINGERPRINT = "Teaching Assistant for CS6650"
CHUNK = 48 * 1024

_log_lock = threading.Lock()


def rid(prefix, n=24):
    return prefix + "".join(random.choices(string.ascii_letters + string.digits, k=n))


def block_text(block):
    """The text a content block carries (tool results are nested)."""
    if isinstance(block, str):
        return block
    kind = block.get("type")
    if kind == "text":
        return block.get("text", "")
    if kind == "tool_result":
        content = block.get("content", "")
        if isinstance(content, list):
            return "\n".join(block_text(b) for b in content)
        return str(content)
    if kind == "tool_use":
        return json.dumps(block.get("input", {}))
    return ""


def message_text(msg):
    content = msg.get("content", "")
    if isinstance(content, str):
        return content
    return "\n".join(block_text(b) for b in content)


def is_pi(body):
    """Is the client pi? Its tools are called bash, read, write ... where Claude Code's are Bash, Read, Write ..."""
    names = {t.get("name") for t in (body or {}).get("tools") or []}
    return "bash" in names and "Bash" not in names


def pi_call(name, inp):
    """A script is written for Claude Code's tools; the same call for pi, whose tools take `path` where Claude's take `file_path`, and whose
    edit is a list of {oldText, newText}. MCP tools (mcp__server__tool) keep their names in both."""
    if name == "Bash":
        return "bash", {k: inp[k] for k in ("command", "timeout") if k in inp}
    if name == "Read":
        return "read", {"path": inp.get("file_path", ""), **{k: inp[k] for k in ("offset", "limit") if k in inp}}
    if name == "Write":
        return "write", {"path": inp.get("file_path", ""), "content": inp.get("content", "")}
    if name in ("Edit", "MultiEdit"):
        edits = inp.get("edits") or [{"old_string": inp.get("old_string", ""), "new_string": inp.get("new_string", "")}]
        return "edit", {"path": inp.get("file_path", ""), "edits": [{"oldText": e.get("old_string", ""), "newText": e.get("new_string", "")} for e in edits]}
    if name == "Grep":
        return "grep", {k: inp[k] for k in ("pattern", "path", "glob") if k in inp}
    if name == "Glob":
        return "find", {k: inp[k] for k in ("pattern", "path") if k in inp}
    if name == "WebFetch":
        return "web_fetch", {"url": inp.get("url", "")}
    return name, inp


def has_tool_result(msg):
    content = msg.get("content", "")
    return isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)


def real_user_indexes(messages):
    return [i for i, m in enumerate(messages) if m.get("role") == "user" and not has_tool_result(m)]


def system_text(body):
    system = body.get("system", "")
    if isinstance(system, list):
        return "\n".join(block_text(b) for b in system)
    return str(system)


def summarize(messages):
    out = []
    for m in messages:
        content = m.get("content", "")
        kinds = ["text"] if isinstance(content, str) else [b.get("type", "?") for b in content if isinstance(b, dict)]
        out.append({"role": m.get("role"), "kinds": kinds, "head": message_text(m)[:90].replace("\n", " ")})
    return out


def load_script(name):
    path = os.path.join(SCRIPTS_DIR, name + ".json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:  # a missing or broken script is itself a test result
        return {"steps": [], "final": {"text": f"MOCK ERROR: cannot load script {name}: {type(exc).__name__}"}}


def decide(body):
    """What the scripted model does for this request: (action dict, info dict for the log)."""
    messages = body.get("messages", [])
    info = {"n_messages": len(messages), "tools": len(body.get("tools") or [])}
    if not body.get("tools"):
        # Claude Code's own calls (titles, quota checks, and WebFetch's "answer this question about the page" step). The page
        # text a WebFetch hands to the small model is what shows that a fetch really happened, so keep the start of it.
        users_bg = real_user_indexes(messages)
        seen = message_text(messages[users_bg[-1]])[:400].replace("\n", " ") if users_bg else ""
        return {"text": "Mock summary."}, dict(info, kind="background", seen=seen)
    users = real_user_indexes(messages)
    if not users:
        return {"text": "mock: no user message"}, dict(info, kind="nouser")
    last = users[-1]
    directive = DIRECTIVE.search(message_text(messages[last]))
    if not directive:
        return {"text": "mock: no directive"}, dict(info, kind="nodirective", last_user=message_text(messages[last])[:120])
    name = directive.group(1)
    script = load_script(name)
    steps = script.get("steps", [])
    results = [b for m in messages[last + 1:] if has_tool_result(m) for b in m["content"] if b.get("type") == "tool_result"]
    k = len(results)
    info.update(script=name, step=k, n_steps=len(steps))
    if k < len(steps):
        step = steps[k]
        info["kind"] = "step"
        return step, info
    final = script.get("final", {"echo": "all"})
    info["kind"] = "final"
    if final.get("history"):
        earlier = "\n".join(message_text(m) for m in messages[:last])
        markers = sorted(set(MARKER.findall(earlier)))
        # PLANTED-xxx in the system prompt or in a tool declaration: what an agent that loaded files from its working directory would show
        planted = sorted(set(PLANTED.findall(system_text(body) + json.dumps(body.get("tools") or []))))
        text = "HISTORY n_messages=%d real_user_turns=%d earlier_markers=%s persona_in_system=%s planted=%s" % (
            len(messages), len(users), ",".join(markers) or "none", PERSONA_FINGERPRINT in system_text(body), ",".join(planted) or "none")
        return {"text": text, "sleep": final.get("sleep", 0)}, info
    if final.get("echo"):
        parts = ["[%d] %s" % (i + 1, block_text(r).strip().replace("\n", " ")[:300]) for i, r in enumerate(results)]
        return {"text": "RESULTS " + " | ".join(parts), "sleep": final.get("sleep", 0)}, info
    return {"text": final.get("text", "mock: done"), "sleep": final.get("sleep", 0)}, info


def sse(event, data):
    return ("event: %s\ndata: %s\n\n" % (event, json.dumps(data))).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # the JSONL log is the record; keep stderr quiet
        pass

    def _json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _chunk(self, data):
        self.wfile.write(("%X\r\n" % len(data)).encode() + data + b"\r\n")

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/health"):
            return self._json(200, {"ok": True, "mock": True})
        if path.startswith("/v1/models"):
            return self._json(200, {"data": [{"id": "mock", "type": "model"}], "has_more": False})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            return self._json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "bad json"}})
        if path.endswith("/count_tokens"):
            return self._json(200, {"input_tokens": max(1, len(raw) // 4)})
        if not path.endswith("/messages"):
            return self._json(404, {"type": "error", "error": {"type": "not_found_error", "message": path}})

        action, info = decide(body)
        entry = {"ts": round(time.time(), 3), "path": path, "model": body.get("model"), "stream": bool(body.get("stream")),
                 "max_tokens": body.get("max_tokens"), "bytes": len(raw), "system_len": len(system_text(body)),
                 "system_sha1": hashlib.sha1(system_text(body).encode()).hexdigest()[:10],
                 "messages": summarize(body.get("messages", [])), "action": {k: (v if k != "input" else "...") for k, v in action.items()}}
        # What the request weighs, by part (bytes of JSON): the system prompt blocks, each tool definition, the messages. This is what a
        # harness adds before the student has said anything, and what an input-token budget (Cerebras's tokens a minute) is spent on.
        tools = body.get("tools") or []
        system = body.get("system", "")
        entry.update(system_blocks=[len(block_text(b)) for b in system] if isinstance(system, list) else [len(str(system))],
                     tools_bytes=len(json.dumps(tools)), tool_sizes={t.get("name", "?"): len(json.dumps(t)) for t in tools},
                     messages_bytes=len(json.dumps(body.get("messages", []))))
        dump = os.environ.get("MOCK_DUMP_FIRST")   # keep the whole body of the first request that carries tools, for a look at what is in it
        if dump and tools and not os.path.exists(dump):
            try:
                with open(dump, "w", encoding="utf-8") as f:
                    f.write(raw.decode("utf-8", "replace"))
            except OSError:
                pass
        entry.update(info)
        with _log_lock:
            try:
                with open(LOG_PATH, "a", encoding="utf-8") as f:
                    f.write(json.dumps(entry) + "\n")
            except OSError:
                pass

        delay = float(action.get("sleep") or 0)
        if delay:
            time.sleep(delay)
        if action.get("error"):
            err = action["error"]
            return self._json(int(err.get("status", 500)), {"type": "error", "error": {
                "type": err.get("type", "api_error"), "message": err.get("message", "mock error")}})
        in_tokens = max(1, len(raw) // 4)
        if body.get("stream"):
            self._stream(action, body, in_tokens)
        else:
            self._whole(action, body, in_tokens)

    # -- response shapes ------------------------------------------------------------------------------------------------

    def _blocks(self, action, body=None):
        if action.get("tool"):
            name, inp = action["tool"], action.get("input", {})
            if is_pi(body):
                name, inp = pi_call(name, inp)
            return [{"type": "tool_use", "id": rid("toolu_"), "name": name, "input": inp}], "tool_use"
        return [{"type": "text", "text": action.get("text", "")}], "end_turn"

    def _whole(self, action, body, in_tokens):
        blocks, stop = self._blocks(action, body)
        self._json(200, {"id": rid("msg_"), "type": "message", "role": "assistant", "model": body.get("model", "mock"), "content": blocks,
                         "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": in_tokens, "output_tokens": 8}})

    def _stream(self, action, body, in_tokens):
        blocks, stop = self._blocks(action, body)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        self._chunk(sse("message_start", {"type": "message_start", "message": {
            "id": rid("msg_"), "type": "message", "role": "assistant", "model": body.get("model", "mock"), "content": [],
            "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": in_tokens, "output_tokens": 1}}}))
        block = blocks[0]
        if block["type"] == "text":
            self._chunk(sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}))
            text = block["text"]
            for i in range(0, max(len(text), 1), CHUNK):
                self._chunk(sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                         "delta": {"type": "text_delta", "text": text[i:i + CHUNK]}}))
        else:
            self._chunk(sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {
                "type": "tool_use", "id": block["id"], "name": block["name"], "input": {}}}))
            payload = json.dumps(block["input"])
            for i in range(0, max(len(payload), 1), CHUNK):
                self._chunk(sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                         "delta": {"type": "input_json_delta", "partial_json": payload[i:i + CHUNK]}}))
        self._chunk(sse("content_block_stop", {"type": "content_block_stop", "index": 0}))
        self._chunk(sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                                          "usage": {"output_tokens": 8}}))
        self._chunk(sse("message_stop", {"type": "message_stop"}))
        self.wfile.write(b"0\r\n\r\n")


if __name__ == "__main__":
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("mock llm on :%d, scripts in %s, log %s" % (PORT, SCRIPTS_DIR, LOG_PATH), file=sys.stderr, flush=True)
    server.serve_forever()
