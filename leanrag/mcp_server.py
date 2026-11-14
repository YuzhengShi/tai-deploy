"""LeanRAG MCP server — exposes query_knowledge tool via stdio transport.

Run as:  python -m leanrag.mcp_server
The Agent SDK spawns this process and communicates over stdin/stdout.
"""

from __future__ import annotations

import logging
import re
import sys

from mcp.server.fastmcp import FastMCP

from .query import query_knowledge as _query_knowledge

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger(__name__)

mcp = FastMCP("leanrag", log_level="WARNING")


# ── Formatting ────────────────────────────────────────────────────────

_MAX_SOURCE_FILES = 8
_MAX_CHUNK_CHARS = 600


def _format_context(result: dict) -> str:
    """Format the raw query result as a readable context string for the agent."""
    lines: list[str] = []

    lines.append(f"## LeanRAG Knowledge Retrieval (difficulty: {result['difficulty']})")
    lines.append("")

    # Seed entities (highest-similarity matches)
    lines.append("### Most Relevant Concepts")
    for seed in result["seed_entities"][:5]:
        lines.append(f"- **{seed['name']}** (relevance: {seed['score']:.2f})")
    lines.append("")

    # All entities with descriptions
    lines.append("### Concepts in Context")
    for ent in result["entities"]:
        label = {0: "entity", 1: "cluster", 2: "theme"}.get(ent["layer"], "?")
        desc = ent["description"]
        if desc:
            lines.append(f"- [{label}] **{ent['name']}**: {desc}")
        else:
            lines.append(f"- [{label}] **{ent['name']}**")
    lines.append("")

    # Relations
    if result["relations"]:
        lines.append("### Relationships")
        for rel in result["relations"]:
            head = rel["head"].split(":", 1)[-1] if ":" in rel["head"] else rel["head"]
            tail = rel["tail"].split(":", 1)[-1] if ":" in rel["tail"] else rel["tail"]
            lines.append(f"- {head} --[{rel['relation']}]--> {tail}")
        lines.append("")

    # Source texts (course materials) — deduplicated by file, capped
    if result["source_texts"]:
        lines.append("### Source Course Materials")
        seen_files: set[str] = set()
        shown = 0
        for src in result["source_texts"]:
            if shown >= _MAX_SOURCE_FILES:
                remaining = len(result["source_texts"]) - shown
                lines.append(f"_... and {remaining} more source chunks_")
                break
            fkey = src["source_file"]
            if fkey in seen_files:
                continue
            seen_files.add(fkey)
            text = src["text"]
            if len(text) > _MAX_CHUNK_CHARS:
                text = text[:_MAX_CHUNK_CHARS] + "..."
            lines.append(f"**Source: {src['source_file']}**")
            lines.append(f"```\n{text}\n```")
            lines.append("")
            shown += 1

    return "\n".join(lines)


# ── Formatting of the graph engine's result (graph_query.py; docs/LEANRAG.md) ───────────────────────

_MAX_GRAPH_CHARS = 7000      # what one answer may take of the model's context
_MAX_SLIDE_CHARS = 700


def _week_label(week: str) -> str:
    m = re.match(r"^w(\d+)$", week or "")
    return f"week {m.group(1)}" if m else (week or "")


def _format_graph_context(result: dict) -> str:
    """The graph engine's result as text. Keeps the shape the host reads: `### Source Course Materials`, then one `**Source: <file>**` line per document
    (container/agent-runner/src/progress.ts turns those lines into the chips of the page), each followed by the slides found in it, with their numbers."""
    lines: list[str] = [f"## Course Knowledge (slide-level retrieval, level: {result['difficulty']})", ""]
    if result["seed_entities"]:
        lines.append("### Most Relevant Concepts")
        for seed in result["seed_entities"][:5]:
            lines.append(f"- **{seed['name']}** (relevance: {seed['score']:.2f})")
        lines.append("")
    if result["entities"]:
        lines.append("### Concepts in Context")
        for ent in result["entities"]:
            label = {0: "concept", 1: "cluster", 2: "theme"}.get(ent["layer"], "?")
            lines.append(f"- [{label}] **{ent['name']}**" + (f": {ent['description']}" if ent["description"] else ""))
        lines.append("")
    if result["relations"]:
        lines.append("### Relationships")
        for rel in result["relations"]:
            lines.append(f"- {rel['head']} --[{rel['relation']}]--> {rel['tail']}")
        lines.append("")
    head = "\n".join(lines)
    sources = result["source_texts"]
    if not sources:
        return head + "\n### Source Course Materials\n_Nothing in the released course material matched this question._"
    groups: dict[str, list[dict]] = {}
    for src in sources:
        groups.setdefault(src["source_file"], []).append(src)
    body: list[str] = ["### Source Course Materials"]
    used = len(head) + len(body[0])
    shown = 0
    for source_file, items in groups.items():
        block = [f"**Source: {source_file}**", "```text"]
        for src in items:
            text = src["text"] if len(src["text"]) <= _MAX_SLIDE_CHARS else src["text"][:_MAX_SLIDE_CHARS] + "..."
            if src["kind"] == "slide":
                tag = f"[slide {src['page']}, {_week_label(src['week'])}]"
            else:
                tag = "[assignment text]" if src["kind"] == "homework" else "[syllabus]"
            block.append(tag)
            block.append(text)
            block.append("")
        block[-1] = "```"
        size = sum(len(x) + 1 for x in block)
        if shown and used + size > _MAX_GRAPH_CHARS:
            body.append(f"_... and {len(sources) - shown} more passages not shown_")
            break
        body.extend(block)
        body.append("")
        used += size
        shown += len(items)
    return head + "\n" + "\n".join(body).rstrip()


# ── Tool ──────────────────────────────────────────────────────────────

@mcp.tool(
    description=(
        "Query the CS6650 course knowledge graph for structured, grounded information. "
        "Returns concepts, relationships, and source course materials relevant to the question. "
        "Use this BEFORE answering any course content question to ground your response in "
        "Professor Coady's actual materials rather than general knowledge.\n\n"
        "difficulty levels:\n"
        "- 'auto': system chooses based on query specificity (recommended)\n"
        "- 'entity': fine-grained concept lookup (e.g., 'What does a Paxos proposer do?')\n"
        "- 'cluster': concept group context (e.g., 'Compare consensus protocols')\n"
        "- 'theme': broad thematic analysis (e.g., 'Fault tolerance vs scalability tradeoffs')"
    ),
)
def query_knowledge(
    question: str,
    difficulty: str = "auto",
    top_k: int = 10,
) -> str:
    """Query the CS6650 course knowledge graph."""
    log.info("query_knowledge: question=%r difficulty=%s top_k=%d", question, difficulty, top_k)

    if difficulty not in ("auto", "entity", "cluster", "theme"):
        difficulty = "auto"
    top_k = max(1, min(top_k, 30))

    try:
        result = _query_knowledge(question, difficulty=difficulty, top_k=top_k)
        if result.get("engine") == "graph":
            return _format_graph_context(result)
        return _format_context(result)
    except FileNotFoundError as exc:
        return f"LeanRAG error: knowledge graph not found — {exc}"
    except Exception as exc:
        log.exception("query_knowledge failed")
        return f"LeanRAG error: {type(exc).__name__}: {exc}"


# ── Entry point ───────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run(transport="stdio")
