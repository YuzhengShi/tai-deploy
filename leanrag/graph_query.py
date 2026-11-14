"""Query-time retrieval over the built graph. Standard library only; no model call, no embedding call, no network.

A question is turned into stems (the course library's stemmer, text.py) and scored three ways: against the text of every slide (BM25), against every
entity's name and description (BM25, with a bonus when the whole name is in the question), and through the graph (a slide scores for each top entity
that was extracted from it, and a little for the neighbours of those entities). The slides that score best are the evidence, with their numbers.
`mode` says which of the three count: "bm25" (slides only: the control that has no graph), "entity" (the graph only) or "hybrid" (both).

The hierarchy shows in what accompanies the evidence: for the level asked (entity, cluster, theme) the answer carries the summaries of the clusters
and themes the top entities belong to and the relations between them. `auto` picks the level from the question (comparison words, how many clusters the
top entities fall in). What it does NOT do: understand a question, follow a chain of relations further than one step, or read a picture on a slide.

Only chunks a student may read at `now` are searched (a chunk carries `visible_from`: its week's first day, Pacific time, or an assignment's unlock time).

Engines live here, chosen by `profile`: **v1** is the engine that was frozen and run once on the first test set (docs/LEANRAG.md, 2026-11-12: it did not beat
plain BM25); **v2** is v1 with the first of the two fixes that run pointed at: a comparison ("how does X differ from Y", "compare X and Y") is split into its two
sides, each side is ranked on its own and the lists are interleaved, so that the second half of a comparison is not hidden behind the first by the cap of three slides
from one deck; **v2cal** adds the second: the graph's evidence calibrated by how much of the question an anchor holds (a weak anchor counts for little, and the best
slide of a weak graph signal no longer counts as 1.0), instead of normalised by its own best. v2 is the default (rule R1 of the second round in docs/LEANRAG.md);
v1 is one argument, or LEANRAG_PROFILE=v1, away.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
from collections import defaultdict
from pathlib import Path

from .text import Bm25, terms

FORMAT = 1
LEVELS = ("entity", "cluster", "theme")
MODES = ("hybrid", "entity", "bm25")
WEIGHTS = {"hybrid": (0.5, 0.4, 0.1), "entity": (0.0, 0.8, 0.2), "bm25": (1.0, 0.0, 0.0)}   # (slide text, entity link, neighbour link)
SEEDS = 8                     # entities that count as the question's anchors
SEED_FLOOR = 0.25             # an entity needs this share of the best entity score to be an anchor
NAME_BONUS = 1.0              # added to the normalised entity score when every stem of the name is in the question
NEIGHBOURS_PER_SEED = 3
PER_GROUP = 3                 # at most this many results from one deck (or one assignment): a list that is all one deck hides the others
TEXTS = 2                     # assignment / syllabus texts that may accompany the slides
TEXT_SHARE = 0.8              # ... when they match the question at least this well compared with the best slide (or the question is about assignments)
MAX_QUESTION_TERMS = 14
ASSIGNMENT_CUES = re.compile(r"\b(homework|assignment|assignments|hw\d*|mastery|midterm|final|project|due|deadline|rubric|syllabus|exam|grading|grade|grades)\b", re.I)
COMPARE_CUES = re.compile(r"\b(compare|comparison|difference|differences|differ|differs|versus|vs|trade-?offs?|pros and cons|better than|contrast)\b", re.I)
BROAD_CUES = re.compile(r"\b(overview|summary|summarize|summarise|big picture|everything|all of|how does the course|what does the course|course say|across)\b", re.I)

# The two sides of a comparison, tried in this order on the lower-cased question without its closing punctuation. A question none of them fits is not split.
SPLIT_PATTERNS = (
    re.compile(r"\b(?:difference|differences|distinction|distinctions|trade-?offs?)\s+between\s+(?P<a>.+?)\s+(?:and|vs\.?|versus|or)\s+(?P<b>.+)$"),
    re.compile(r"^(?P<a>.+?)\s+(?:differs?|different|distinct)\s+(?:from|than)\s+(?P<b>.+)$"),
    re.compile(r"^(?P<a>.+?)\s+(?:versus|vs\.?)\s+(?P<b>.+)$"),
    re.compile(r"^(?P<a>.+?)\s+(?:compared?|contrasted?|compares)\s+(?:to|with)\s+(?P<b>.+)$"),
    re.compile(r"\bcompar(?:e|ing|ison)\s+(?:of\s+)?(?P<a>.+?)\s+(?:and|with|to|versus|vs\.?)\s+(?P<b>.+)$"),
)

# The engines. v1 is exactly what ran on the first test set (its config hash is 255d88ce18e4b132 and must not change).
#   v2     = v1 + fix 1 only: a comparison is split into its two sides (the graph signal is untouched). Chosen on the development set alone: of the graph-signal
#            variants tried (docs/LEANRAG.md) all but the calibrated one tied on it, and a tie means the simpler.
#   v2cal  = v2 + fix 2: the graph signal calibrated by how much of the question an anchor holds (it cost the one development question the graph answers, which
#            is why it is not v2; it is measured next to v2 on the new test set for information, and is not what decides what is served).
PROFILES = {
    "v1": {"weights": WEIGHTS, "compare_split": False, "graph": "relative", "coverage_floor": 0.0, "agg": "sum", "spread": 0.5},
    "v2": {"weights": WEIGHTS, "compare_split": True, "graph": "relative", "coverage_floor": 0.0, "agg": "sum", "spread": 0.5},
    "v2cal": {"weights": {"hybrid": (0.5, 0.3, 0.1), "entity": (0.0, 0.8, 0.2), "bm25": (1.0, 0.0, 0.0)}, "compare_split": True, "graph": "calibrated",
              "coverage_floor": 0.25, "agg": "max", "spread": 0.5},
}
DEFAULT_PROFILE = "v2"       # rule R1 of docs/LEANRAG.md, second round: v2 hit as many as v1 on the new test set, so it is the default (v1 is one argument away)


def resolve_profile(profile: str | None = None) -> str:
    """The profile asked for, else LEANRAG_PROFILE (the evaluation's override), else the default; a name that is not a profile means the default."""
    name = profile or os.environ.get("LEANRAG_PROFILE") or DEFAULT_PROFILE
    return name if name in PROFILES else DEFAULT_PROFILE


class GraphError(Exception):
    pass


def _pacific_midnight(day: str) -> dt.datetime:
    y, m, d = (int(x) for x in day.split("-"))
    try:
        from zoneinfo import ZoneInfo  # noqa: PLC0415
        return dt.datetime(y, m, d, tzinfo=ZoneInfo("America/Los_Angeles")).astimezone(dt.timezone.utc)
    except Exception:  # noqa: BLE001  (no tz database: UTC midnight, 8 hours early at worst)
        return dt.datetime(y, m, d, tzinfo=dt.timezone.utc)


def visible(visible_from: str, now: dt.datetime) -> bool:
    if not visible_from:
        return True
    try:
        if "T" in visible_from:
            at = dt.datetime.fromisoformat(visible_from.replace("Z", "+00:00"))
            at = at if at.tzinfo else at.replace(tzinfo=dt.timezone.utc)
        else:
            at = _pacific_midnight(visible_from)
    except ValueError:
        return False          # a time we cannot read is a chunk we do not show
    return at <= now


def now_utc() -> dt.datetime:
    forced = os.environ.get("LEANRAG_NOW")          # the evaluation pins the clock; nothing else sets it
    if forced:
        parsed = dt.datetime.fromisoformat(forced.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
    return dt.datetime.now(dt.timezone.utc)


def _normalise(scores: dict) -> dict:
    top = max(scores.values(), default=0.0)
    return {k: v / top for k, v in scores.items()} if top > 0 else {}


def _spread(n: int, exponent: float) -> float:
    """How thinly an entity's score is spread over the n slides it points at (v1: the square root, whose exact float the first run recorded)."""
    return math.sqrt(n) if exponent == 0.5 else float(n) ** exponent


def split_sides(question: str) -> list[list[str]] | None:
    """The two sides of a comparison as two lists of stems, or None when the question is not one this can split (or both sides come out the same)."""
    text = re.sub(r"\s+", " ", question.strip().lower()).rstrip("?.! ")
    for pattern in SPLIT_PATTERNS:
        m = pattern.search(text)
        if not m:
            continue
        a = list(dict.fromkeys(terms(m.group("a"))))[:MAX_QUESTION_TERMS]
        b = list(dict.fromkeys(terms(m.group("b"))))[:MAX_QUESTION_TERMS]
        if a and b and set(a) != set(b):
            return [a, b]
    return None


def interleave(lists: list[list[tuple[int, float]]], top_k: int) -> list[tuple[int, float]]:
    """Round robin over ranked lists, each turn taking a list's best slide not taken yet, until top_k slides or every list is used up."""
    picked: list[tuple[int, float]] = []
    seen: set[int] = set()
    cursors = [0] * len(lists)
    while len(picked) < top_k:
        progressed = False
        for n, ranked in enumerate(lists):
            while cursors[n] < len(ranked) and ranked[cursors[n]][0] in seen:
                cursors[n] += 1
            if cursors[n] < len(ranked):
                p, s = ranked[cursors[n]]
                cursors[n] += 1
                seen.add(p)
                picked.append((p, s))
                progressed = True
                if len(picked) >= top_k:
                    break
        if not progressed:
            break
    return picked


class GraphIndex:
    """The artifact in memory: slides, entities, the graph around them, and the two BM25 indexes."""

    def __init__(self, root: str | Path, allow_synthetic: bool = False) -> None:
        root = Path(root)
        try:
            self.manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
            graph = json.loads((root / "graph.json").read_text(encoding="utf-8"))
            lines = (root / "chunks.jsonl").read_text(encoding="utf-8").splitlines()
        except (OSError, ValueError) as exc:
            raise GraphError(f"cannot read the graph artifact in {root}: {type(exc).__name__}") from None
        if self.manifest.get("format") != FORMAT or graph.get("format") != FORMAT:
            raise GraphError("the graph artifact is not format 1")
        if self.manifest.get("synthetic") and not allow_synthetic:
            raise GraphError("the graph artifact is synthetic (a dry run): not served")
        self.root = root
        mode = self.manifest.get("default_mode")
        self.default_mode = mode if mode in MODES else "hybrid"           # what the build (or the operator, editing the manifest) chose to serve
        self.chunks: list[dict] = [json.loads(line) for line in lines if line.strip()]
        self.chunk_at = {c["id"]: i for i, c in enumerate(self.chunks)}
        self.entities: list[dict] = graph["entities"]
        self.entity_at = {e["id"]: i for i, e in enumerate(self.entities)}
        self.clusters = {c["id"]: c for c in graph["clusters"]}
        self.themes = {t["id"]: t for t in graph["themes"]}
        self.cluster_relations: list[dict] = graph["cluster_relations"]
        self.theme_relations: list[dict] = graph["theme_relations"]
        self.out: dict[str, list[dict]] = defaultdict(list)
        self.into: dict[str, list[dict]] = defaultdict(list)
        for r in graph["relations"]:
            self.out[r["h"]].append(r)
            self.into[r["t"]].append(r)
        # the text of each chunk as it is searched: the deck/assignment title once, the slide's heading twice, the text once
        page_docs = []
        for c in self.chunks:
            page_docs.append(terms(c["title"]) + terms(c.get("heading", "")) + terms(c["text"]))
        self.pages_bm25 = Bm25(page_docs)
        entity_docs = [terms(e["name"]) * 3 + terms(e["desc"]) for e in self.entities]
        self.entities_bm25 = Bm25(entity_docs)
        self.name_stems = [frozenset(terms(e["name"])) for e in self.entities]
        self.entity_stems = [frozenset(terms(e["name"]) + terms(e["desc"])) for e in self.entities]       # what an entity says, for how much of a question it holds

    # -- the answer ---------------------------------------------------------------------------------------------
    def query(self, question: str, difficulty: str = "auto", top_k: int = 10, mode: str = "hybrid", now: dt.datetime | None = None,
              profile: str | None = None) -> dict:
        mode = mode if mode in MODES else "hybrid"
        prof = PROFILES[resolve_profile(profile)]
        top_k = max(1, min(int(top_k), 30))
        now = now or now_utc()
        q_terms = list(dict.fromkeys(terms(question)))[:MAX_QUESTION_TERMS]
        ok = [visible(c.get("visible_from", ""), now) for c in self.chunks]

        ev = self._evidence(q_terms, mode, ok, prof)        # the anchors are also what the answer lists as its concepts, whatever the mode
        seeds, via, neighbours, raw_pages = ev["seeds"], ev["via"], ev["neighbours"], ev["raw_pages"]
        # Two channels, ranked apart: lecture slides, and the assignment / syllabus texts (which are long and match many words of any question, so in one
        # list they push the slides out). Each channel's three signals are normalised within the channel (v2: the two graph signals are already calibrated).
        slide_set = {i for i, c in enumerate(self.chunks) if ok[i] and c["kind"] == "slide"}
        text_set = {i for i, c in enumerate(self.chunks) if ok[i] and c["kind"] != "slide"}

        sides = split_sides(question) if prof["compare_split"] else None
        side_evidence: list[dict] = []
        if sides:
            side_evidence = [self._evidence(side, mode, ok, prof) for side in sides]
            lists = [self._capped(self._rank(slide_set, e, mode, prof), top_k) for e in side_evidence]
            lists.append(self._capped(self._rank(slide_set, ev, mode, prof), top_k))        # the whole question too: a slide that says both is still found
            slides = interleave(lists, top_k)
        else:
            slides = self._capped(self._rank(slide_set, ev, mode, prof), top_k)
        about_work = bool(ASSIGNMENT_CUES.search(question))
        best_slide_text_score = max((raw_pages.get(p, 0.0) for p, _ in slides), default=0.0)
        texts = [(p, s) for p, s in self._rank(text_set, ev, mode, prof) if about_work or raw_pages.get(p, 0.0) >= TEXT_SHARE * best_slide_text_score][:TEXTS]
        picked = (texts + slides) if about_work else (slides + texts)

        level = self._level(difficulty, question, seeds)
        entities, relations = self._context(seeds, neighbours, level)
        sources = []
        for p, s in picked:
            c = self.chunks[p]
            sources.append({"source_file": c["deck"] or c["title"], "deck": c["deck"], "title": c["title"], "page": c["page"], "week": c["week"], "kind": c["kind"],
                            "score": round(s, 4), "via": next((e["via"][p] for e in [ev] + side_evidence if e["via"].get(p)), []), "text": c["text"]})
        return {"engine": "graph", "mode": mode, "difficulty": level, "now": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "seed_entities": [{"id": self.entities[i]["id"], "name": self.entities[i]["name"], "score": round(s, 4)} for i, s in seeds],
                "entities": entities, "relations": relations, "source_texts": sources}

    def _evidence(self, q_terms: list[str], mode: str, ok: list[bool], prof: dict) -> dict:
        """What the question's stems find: BM25 over the visible chunks, the anchors among the entities, and the slides the anchors and their neighbours point at."""
        q_set = frozenset(q_terms)
        _a, b, c_weight = prof["weights"][mode]
        raw_pages = {i: s for i, s in self.pages_bm25.scores(q_terms).items() if ok[i]}      # BM25 over every visible chunk, whatever its kind

        raw = _normalise(self.entities_bm25.scores(q_terms))
        for i, stems in enumerate(self.name_stems):
            if stems and stems <= q_set:
                raw[i] = raw.get(i, 0.0) + NAME_BONUS
        top = max(raw.values(), default=0.0)
        entity_scores = {i: s / top for i, s in raw.items()} if top > 0 else {}
        seeds: list[tuple[int, float]] = sorted(((i, s) for i, s in entity_scores.items() if s >= SEED_FLOOR),
                                                key=lambda kv: (-kv[1], self.entities[kv[0]]["id"]))[:SEEDS]
        calibrated = prof["graph"] == "calibrated"
        use_max = prof.get("agg", "sum") == "max"
        spread = prof.get("spread", 0.5)
        if calibrated:
            # an anchor counts for the share of the question's information it holds (each stem worth what it is worth in the slides: its idf), not for how it
            # compares with the best anchor: a weak match to a long question stays weak, whatever the other anchors are
            info = {t: self.pages_bm25.idf.get(t, 0.0) for t in q_terms}
            total = sum(info.values()) or 1.0
            kept: list[tuple[int, float]] = []
            for i, _score in seeds:
                share = sum(w for t, w in info.items() if t in self.entity_stems[i]) / total
                if share >= prof["coverage_floor"] or (self.name_stems[i] and self.name_stems[i] <= q_set):
                    kept.append((i, share))
            seeds = kept

        entity_part: dict[int, float] = defaultdict(float)
        neighbour_part: dict[int, float] = defaultdict(float)
        via: dict[int, list[str]] = defaultdict(list)
        neighbours: dict[str, tuple[float, str]] = {}
        if b or c_weight:
            for i, score in seeds:
                entity = self.entities[i]
                linked = [self.chunk_at[c] for c in entity["chunks"] if c in self.chunk_at and ok[self.chunk_at[c]]]
                for p in linked:
                    share = score / _spread(len(linked), spread)
                    if use_max:
                        entity_part[p] = max(entity_part[p], share)         # the best anchor that points at a slide, not the sum of several weak ones
                    else:
                        entity_part[p] += share
                    if len(via[p]) < 2 and entity["name"] not in via[p]:
                        via[p].append(entity["name"])
                for rel in sorted(self.out[entity["id"]] + self.into[entity["id"]], key=lambda r: (-r["w"], r["h"], r["t"], r["r"]))[:NEIGHBOURS_PER_SEED]:
                    other = rel["t"] if rel["h"] == entity["id"] else rel["h"]
                    if other not in self.entity_at:
                        continue
                    n_score = 0.5 * score
                    if other not in neighbours or neighbours[other][0] < n_score:
                        neighbours[other] = (n_score, rel["r"])
            seed_ids = {self.entities[i]["id"] for i, _ in seeds}
            for other, (n_score, _kind) in neighbours.items():
                if other in seed_ids:
                    continue
                n_chunks = [self.chunk_at[c] for c in self.entities[self.entity_at[other]]["chunks"] if c in self.chunk_at and ok[self.chunk_at[c]]]
                for p in n_chunks:
                    share = n_score / _spread(len(n_chunks), spread)
                    if use_max:
                        neighbour_part[p] = max(neighbour_part[p], share)
                    else:
                        neighbour_part[p] += share
        return {"raw_pages": raw_pages, "seeds": seeds, "entity_part": entity_part, "neighbour_part": neighbour_part, "via": via, "neighbours": neighbours}

    def _rank(self, channel: set[int], ev: dict, mode: str, prof: dict) -> list[tuple[int, float]]:
        """The slides (or texts) of a channel by their combined signals, best first; ties by chunk id."""
        a, b, c_weight = prof["weights"][mode]
        calibrated = prof["graph"] == "calibrated"
        combined: dict[int, float] = defaultdict(float)
        for signal, weight, absolute in ((ev["raw_pages"], a, False), (ev["entity_part"], b, calibrated), (ev["neighbour_part"], c_weight, calibrated)):
            if not weight:
                continue
            values = {p: v for p, v in signal.items() if p in channel}
            for p, s in (values if absolute else _normalise(values)).items():
                combined[p] += weight * s
        return sorted(combined.items(), key=lambda kv: (-kv[1], self.chunks[kv[0]]["id"]))

    def _capped(self, ranked: list[tuple[int, float]], top_k: int) -> list[tuple[int, float]]:
        """The first `top_k` of a ranking with at most PER_GROUP from one deck (a list that is all one deck hides the others)."""
        picked: list[tuple[int, float]] = []
        per_group: dict[str, int] = defaultdict(int)
        for p, s in ranked:
            group = self.chunks[p]["deck"] or self.chunks[p]["title"]
            if per_group[group] >= PER_GROUP:
                continue
            per_group[group] += 1
            picked.append((p, s))
            if len(picked) >= top_k:
                break
        return picked

    def _level(self, difficulty: str, question: str, seeds: list[tuple[int, float]]) -> str:
        if difficulty in LEVELS:
            return difficulty
        clusters = {self.entities[i].get("cluster") for i, _ in seeds[:5]}
        themes = {self.clusters[c]["theme"] for c in clusters if c in self.clusters and "theme" in self.clusters[c]}
        if BROAD_CUES.search(question) or len(themes) >= 3:
            return "theme"
        if COMPARE_CUES.search(question) or len(clusters) >= 2:
            return "cluster"
        return "entity"

    def _context(self, seeds: list[tuple[int, float]], neighbours: dict[str, tuple[float, str]], level: str) -> tuple[list[dict], list[dict]]:
        """What accompanies the evidence: the anchors, their nearest neighbours, and for the cluster and theme levels the groups they belong to."""
        entities: list[dict] = []
        relations: list[dict] = []
        shown: dict[str, str] = {}

        def add_entity(e: dict) -> None:
            if e["id"] not in shown:
                shown[e["id"]] = e["name"]
                entities.append({"id": e["id"], "layer": 0, "name": e["name"], "description": e["desc"]})

        for i, _ in seeds[:5]:
            add_entity(self.entities[i])
        for other, _ in sorted(neighbours.items(), key=lambda kv: (-kv[1][0], kv[0]))[:6]:
            if other in self.entity_at:
                add_entity(self.entities[self.entity_at[other]])
        for rel in [r for h in list(shown) for r in self.out.get(h, []) if r["t"] in shown]:
            relations.append({"head": shown[rel["h"]], "relation": rel["r"], "tail": shown[rel["t"]], "weight": rel["w"]})
        relations = relations[:12]
        if level in ("cluster", "theme"):
            top_clusters = list(dict.fromkeys(self.entities[i].get("cluster") for i, _ in seeds[:3]))
            top_clusters = [c for c in top_clusters if c in self.clusters]
            for cid in top_clusters:
                c = self.clusters[cid]
                entities.append({"id": cid, "layer": 1, "name": c["name"], "description": c["desc"]})
            names = {cid: self.clusters[cid]["name"] for cid in self.clusters}
            for r in self.cluster_relations:
                if (r["h"] in top_clusters or r["t"] in top_clusters) and len([x for x in relations if x.get("layer") == 1]) < 5:
                    relations.append({"head": names[r["h"]], "relation": r["r"], "tail": names[r["t"]], "weight": r["w"], "layer": 1})
        if level == "theme":
            top_themes = list(dict.fromkeys(self.clusters[c]["theme"] for c in [e["id"] for e in entities if e["layer"] == 1] if "theme" in self.clusters[c]))
            for tid in top_themes[:3]:
                t = self.themes[tid]
                entities.append({"id": tid, "layer": 2, "name": t["name"], "description": t["desc"]})
            tnames = {tid: self.themes[tid]["name"] for tid in self.themes}
            for r in self.theme_relations:
                if (r["h"] in top_themes or r["t"] in top_themes) and len([x for x in relations if x.get("layer") == 2]) < 4:
                    relations.append({"head": tnames[r["h"]], "relation": r["r"], "tail": tnames[r["t"]], "weight": r["w"], "layer": 2})
        return entities, relations


def engine_config(profile: str | None = None) -> dict:
    """Every number that decides a ranking, in one place: the evaluation records its hash with its results, and a change to any of them is a new engine.
    v1's dictionary is exactly the one whose hash (255d88ce18e4b132) the first test run recorded; v2 adds to it and overrides the weights."""
    name = resolve_profile(profile)
    base = {"format": FORMAT, "weights": {m: list(w) for m, w in WEIGHTS.items()}, "seeds": SEEDS, "seed_floor": SEED_FLOOR, "name_bonus": NAME_BONUS,
            "neighbours_per_seed": NEIGHBOURS_PER_SEED, "per_group": PER_GROUP, "max_question_terms": MAX_QUESTION_TERMS, "bm25": {"k1": 1.4, "b": 0.75},
            "texts": TEXTS, "text_share": TEXT_SHARE, "assignment_cues": ASSIGNMENT_CUES.pattern}
    if name == "v1":
        return base
    prof = PROFILES[name]
    return {**base, "profile": name, "weights": {m: list(w) for m, w in prof["weights"].items()}, "compare_split": prof["compare_split"], "graph": prof["graph"],
            "coverage_floor": prof["coverage_floor"], "agg": prof["agg"], "spread": prof["spread"], "split_patterns": [p.pattern for p in SPLIT_PATTERNS]}


_cache: dict[tuple, GraphIndex] = {}


def load_index(root: str | Path, allow_synthetic: bool = False) -> GraphIndex:
    """One index per artifact folder and per version of its manifest (the file's time and size), kept for the life of the process."""
    manifest = Path(root) / "manifest.json"
    try:
        st = manifest.stat()
    except OSError as exc:
        raise GraphError(f"no graph artifact in {root}: {type(exc).__name__}") from None
    key = (str(Path(root).resolve()), st.st_mtime_ns, st.st_size, allow_synthetic)
    if key not in _cache:
        _cache.clear()
        _cache[key] = GraphIndex(root, allow_synthetic)
    return _cache[key]


def query_graph(root: str | Path, question: str, difficulty: str = "auto", top_k: int = 10, mode: str | None = None, now: dt.datetime | None = None,
                allow_synthetic: bool = False, profile: str | None = None) -> dict:
    """The one call the tool makes. `mode` defaults to LEANRAG_MODE (the evaluation's override), then to the manifest's `default_mode`, then to hybrid;
    `profile` to LEANRAG_PROFILE, then to DEFAULT_PROFILE."""
    index = load_index(root, allow_synthetic)
    return index.query(question, difficulty=difficulty, top_k=top_k, mode=mode or os.environ.get("LEANRAG_MODE") or index.default_mode, now=now, profile=profile)
