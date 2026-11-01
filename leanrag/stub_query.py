"""A stand-in for LeanRAG's query layer, for the evaluation.

Real LeanRAG embeds the question with Cohere on Bedrock and walks a graph built by DeepSeek on Bedrock (graph.pkl). Neither exists off
AWS, and the public repository ships no graph. This module answers query_knowledge() from a JSON list of chunks with BM25 and returns
the SAME result shape as LeanRAGIndex.query(), so mcp_server.py formats it unchanged and the agent sees what it would see with the real
thing. Retrieval quality is NOT what it tests: it keeps the tool, its name, its signature and its output format honest.

It is switched on by the presence of leanrag/stub_corpus.json (git-ignored: the corpus is course material and lives only on the box).
Each chunk: {"kind", "title", "where", "text", "week"}.
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

_TOKEN = re.compile(r"[a-z0-9_+#.]{2,}")
_STOP = set("the a an and or of to in on for with is are was be it its this that as at by from how do does what why when which can i my me you your we".split())
_cache: dict[str, "_Index"] = {}


def _tokens(text: str) -> list[str]:
    return [t.strip(".") for t in _TOKEN.findall(text.lower()) if t.strip(".") and t.strip(".") not in _STOP]


class _Index:
    def __init__(self, chunks: list[dict]):
        self.chunks = chunks
        docs = [_tokens(f"{c.get('title', '')} {c.get('text', '')}") for c in chunks]
        self.lengths = [len(d) for d in docs]
        self.avg = (sum(self.lengths) / len(docs)) if docs else 1.0
        self.postings: dict[str, list[tuple[int, int]]] = defaultdict(list)
        for i, doc in enumerate(docs):
            for term, tf in Counter(doc).items():
                self.postings[term].append((i, tf))
        n = len(docs)
        self.idf = {t: math.log(1 + (n - len(p) + 0.5) / (len(p) + 0.5)) for t, p in self.postings.items()}

    def scores(self, question: str, k1: float = 1.4, b: float = 0.75) -> dict[int, float]:
        out: dict[int, float] = defaultdict(float)
        for term in set(_tokens(question)):
            idf = self.idf.get(term)
            if idf is None:
                continue
            for i, tf in self.postings[term]:
                out[i] += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * self.lengths[i] / (self.avg or 1.0)))
        return out


def _load(path: Path) -> _Index:
    key = str(path)
    if key not in _cache:
        _cache[key] = _Index(json.loads(path.read_text(encoding="utf-8")))
    return _cache[key]


def query_stub(path: Path, question: str, difficulty: str = "auto", top_k: int = 10) -> dict:
    index = _load(path)
    ranked = sorted(index.scores(question).items(), key=lambda kv: kv[1], reverse=True)[:top_k]
    top = ranked[0][1] if ranked else 1.0
    seen: set[str] = set()
    seeds, entities, relations, sources = [], [], [], []
    weeks: set[str] = set()
    for i, score in ranked:
        c = index.chunks[i]
        title = c.get("title") or "untitled"
        if title not in seen:
            seen.add(title)
            seeds.append({"name": title, "score": float(score / top)})
            entities.append({"name": title, "layer": 0, "description": (c.get("text") or "")[:160].replace("\n", " ")})
            week = c.get("week") or ""
            if week:
                weeks.add(week)
                relations.append({"head": title, "tail": week, "relation": "part of"})
        sources.append({"source_file": "%s: %s (%s)" % (c.get("kind", "material"), title, c.get("where", "")), "text": c.get("text") or ""})
    for week in sorted(weeks):
        entities.append({"name": week, "layer": 1, "description": ""})
    return {"difficulty": difficulty if difficulty != "auto" else "entity", "seed_entities": seeds, "entities": entities,
            "relations": relations, "source_texts": sources}
