"""A small hand-made graph artifact for the tests (made-up decks, not course material): `write_fixture(dir)` writes manifest.json, graph.json, chunks.jsonl.

The decks and what is in them, so that a test can say why a result is right:
  Deck One (week w1, visible from 2026-09-07):  p1 circuit breaker, p2 bulkhead, p3 timeouts and retries, p4 caching (cache-aside)
  Deck Two (week w2, visible from 2026-09-14):  p1 load balancers, p2 stateless services
  Deck Three (week w9, visible from 2026-11-02): p1 consensus (Raft)
  Deck Four (visible from 2027-01-01):          p1 sharding   <- not visible in 2026
  an assignment text (Homework 4) that repeats many of the words of every question, and a syllabus chunk.
"""
from __future__ import annotations

import json
from pathlib import Path

CHUNKS = [
    {"id": "d00:p001", "kind": "slide", "deck": "Deck One.pdf", "title": "Deck One", "week": "w1", "page": 1, "visible_from": "2026-09-07", "heading": "Circuit Breaker Pattern",
     "text": "1\nCircuit Breaker Pattern\nA circuit breaker stops calls to a failing service.\nOpen means no traffic flows. Closed means traffic flows."},
    {"id": "d00:p002", "kind": "slide", "deck": "Deck One.pdf", "title": "Deck One", "week": "w1", "page": 2, "visible_from": "2026-09-07", "heading": "Bulkhead Pattern",
     "text": "2\nBulkhead Pattern\nA bulkhead isolates thread pools so that one slow service cannot use all the threads.\nIf one pool fails the others are unaffected."},
    {"id": "d00:p003", "kind": "slide", "deck": "Deck One.pdf", "title": "Deck One", "week": "w1", "page": 3, "visible_from": "2026-09-07", "heading": "Timeouts and Retries",
     "text": "3\nTimeouts and Retries\nTimeouts fail fast. Retries do not help when a service is slow."},
    {"id": "d00:p004", "kind": "slide", "deck": "Deck One.pdf", "title": "Deck One", "week": "w1", "page": 4, "visible_from": "2026-09-07", "heading": "Caching",
     "text": "4\nCaching\nA cache keeps results in memory. In the cache-aside pattern the application asks the cache first and loads the database on a miss."},
    {"id": "d01:p001", "kind": "slide", "deck": "Deck Two.pdf", "title": "Deck Two", "week": "w2", "page": 1, "visible_from": "2026-09-14", "heading": "Load Balancers",
     "text": "1\nLoad Balancers\nA load balancer spreads requests across servers, for example round robin."},
    {"id": "d01:p002", "kind": "slide", "deck": "Deck Two.pdf", "title": "Deck Two", "week": "w2", "page": 2, "visible_from": "2026-09-14", "heading": "Stateless Services",
     "text": "2\nStateless Services\nStateless services keep no session state, so any server can answer any request."},
    {"id": "d02:p001", "kind": "slide", "deck": "Deck Three.pdf", "title": "Deck Three", "week": "w9", "page": 1, "visible_from": "2026-11-02", "heading": "Consensus",
     "text": "1\nConsensus\nConsensus protocols such as Raft elect a leader and replicate a log."},
    {"id": "d03:p001", "kind": "slide", "deck": "Deck Four.pdf", "title": "Deck Four", "week": "w14", "page": 1, "visible_from": "2027-01-01", "heading": "Sharding",
     "text": "1\nSharding\nSharding splits data across servers by a key."},
    {"id": "hw:4:0", "kind": "homework", "deck": "", "title": "Homework 4", "week": "w4", "page": 0, "visible_from": "2026-09-28T16:00:00Z", "heading": "",
     "text": "Homework 4\nIn this assignment build a service with a circuit breaker, a bulkhead, a cache and a load balancer. Explain the circuit breaker, the bulkhead, the cache and the load balancer in your report."},
    {"id": "syl:0", "kind": "syllabus", "deck": "", "title": "Syllabus", "week": "syllabus", "page": 0, "visible_from": "", "heading": "",
     "text": "Syllabus\nMidterm mastery counts for 15 percent and the final project for 20 percent."},
]

ENTITIES = [
    ("e0001", "circuit breaker", "pattern", "stops calls to a failing service", ["d00:p001", "hw:4:0"], "k001"),
    ("e0002", "bulkhead", "pattern", "isolates thread pools", ["d00:p002", "hw:4:0"], "k001"),
    ("e0003", "timeout", "technique", "fail fast", ["d00:p003"], "k001"),
    ("e0004", "cache-aside", "pattern", "application loads the cache on a miss", ["d00:p004"], "k002"),
    ("e0005", "load balancer", "tool", "spreads requests across servers", ["d01:p001"], "k002"),
    ("e0006", "stateless service", "concept", "keeps no session state", ["d01:p002", "d00:p004"], "k002"),
    ("e0007", "raft", "protocol", "elects a leader", ["d02:p001"], "k003"),
    ("e0008", "sharding", "technique", "splits data by a key", ["d03:p001"], "k003"),
]
RELATIONS = [
    {"h": "e0001", "r": "COMPARED_WITH", "t": "e0002", "w": 2, "chunks": ["d00:p001", "d00:p002"]},
    {"h": "e0003", "r": "ENABLES", "t": "e0001", "w": 1, "chunks": ["d00:p003"]},
    {"h": "e0005", "r": "REQUIRES", "t": "e0006", "w": 2, "chunks": ["d01:p001", "d01:p002"]},
    {"h": "e0004", "r": "USES", "t": "e0006", "w": 1, "chunks": ["d00:p004"]},
]


def graph() -> dict:
    return {
        "format": 1,
        "entities": [{"id": i, "name": n, "type": t, "desc": d, "chunks": c, "cluster": k} for i, n, t, d, c, k in ENTITIES],
        "relations": RELATIONS,
        "clusters": [
            {"id": "k001", "name": "Resilience patterns", "desc": "Patterns that keep a service up when a dependency is slow or failing.", "members": ["e0001", "e0002", "e0003"], "theme": "t01"},
            {"id": "k002", "name": "Scaling services", "desc": "Caches, load balancers and stateless services.", "members": ["e0004", "e0005", "e0006"], "theme": "t01"},
            {"id": "k003", "name": "Data distribution", "desc": "Consensus and sharding.", "members": ["e0007", "e0008"], "theme": "t02"},
        ],
        "cluster_relations": [{"h": "k001", "r": "SUPPORTS", "t": "k002", "w": 3}],
        "themes": [{"id": "t01", "name": "Resilience and scale", "desc": "Keeping services fast and available.", "members": ["k001", "k002"]},
                   {"id": "t02", "name": "Distributed data", "desc": "Where data lives.", "members": ["k003"]}],
        "theme_relations": [{"h": "t01", "r": "SUPPORTS", "t": "t02", "w": 1}],
    }


def write_fixture(out: Path, synthetic: bool = False) -> Path:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "graph.json").write_text(json.dumps(graph()), encoding="utf-8")
    (out / "chunks.jsonl").write_text("\n".join(json.dumps(c) for c in CHUNKS) + "\n", encoding="utf-8")
    (out / "manifest.json").write_text(json.dumps({"format": 1, "synthetic": synthetic, "built_at": "2026-11-11T00:00:00Z"}), encoding="utf-8")
    return out
