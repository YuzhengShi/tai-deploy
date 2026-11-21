"""Round 2 of the weak-model experiment (A2): a second LiteLLM callback of the scratch gateway, next to the unchanged tai_callbacks.py.

pi lists the tools of its MCP servers in the order the servers finish connecting, which varies from one container to the next. The
content of every tool is the same; only the order of the MCP tools changes. A hosted provider that caches many earlier prompts (round
1's DeepSeek) still finds the prompt it saw; the local server keeps one prompt per slot, so every changed order computes the whole tool
list again (about 11k tokens, 8-9 minutes on the PC). This hook puts the MCP tools in one fixed order before the request goes on:
pi's own tools first as pi sent them, then the MCP tools in CANON (the order pi itself sent in the pilot), then any other tool as sent.
It changes no tool and drops none; it logs each reordering to /logs/r2-canon.jsonl.
"""
import json
import os
import time

from litellm.integrations.custom_logger import CustomLogger

LOG = os.environ.get("R2_CANON_LOG", "/logs/r2-canon.jsonl")
CANON = ["mcp__nanoclaw__send_message", "mcp__nanoclaw__schedule_task", "mcp__nanoclaw__run_go", "mcp__nanoclaw__show_document",
         "mcp__nanoclaw__find_course_document", "mcp__nanoclaw__show_chart", "mcp__nanoclaw__show_trace", "mcp__nanoclaw__ask_to_predict",
         "mcp__nanoclaw__list_tasks", "mcp__nanoclaw__pause_task", "mcp__nanoclaw__resume_task", "mcp__nanoclaw__cancel_task",
         "mcp__nanoclaw__register_group", "mcp__nanoclaw__react_to_message", "mcp__nanoclaw__render_diagram", "mcp__nanoclaw__canvas_query",
         "mcp__nanoclaw__github_query", "mcp__nanoclaw__piazza_query", "mcp__nanoclaw__read_image_text", "mcp__nanoclaw__weekly_brief",
         "mcp__nanoclaw__start_mock_interview", "mcp__nanoclaw__memory_query", "mcp__nanoclaw__memory_store",
         "mcp__nanoclaw__set_student_identity", "mcp__leanrag__query_knowledge"]
RANK = {n: i for i, n in enumerate(CANON)}


def name_of(tool):
    return ((tool or {}).get("function") or {}).get("name") or (tool or {}).get("name") or ""


def canonical(tools):
    own = [t for t in tools if not name_of(t).startswith("mcp__")]
    mcp = [t for t in tools if name_of(t).startswith("mcp__")]
    known = sorted([t for t in mcp if name_of(t) in RANK], key=lambda t: RANK[name_of(t)])
    other = [t for t in mcp if name_of(t) not in RANK]
    return own + known + other


def _write(entry):
    entry["ts"] = round(time.time(), 3)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


class CanonTools(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        try:
            tools = data.get("tools")
            if isinstance(tools, list) and tools:
                new = canonical(tools)
                before, after = [name_of(t) for t in tools], [name_of(t) for t in new]
                if before != after:
                    data["tools"] = new
                    first = next(i for i, (a, b) in enumerate(zip(before, after)) if a != b)
                    _write({"event": "reordered", "n": len(tools), "first_moved_at": first, "sent": before[first:first + 3]})
                else:
                    _write({"event": "same", "n": len(tools)})
        except Exception as exc:
            _write({"event": "hook_error", "error": repr(exc)[:200]})
        return data


handler = CanonTools()
