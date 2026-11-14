"""Build the hierarchical graph from the extraction and write the artifact the query engine loads.

Three layers, as in LeanRAG: G0 are the entities the extraction found (each linked to the slides it came from), G1 are clusters of G0 entities and G2
are themes that group the clusters. The clustering is the part that would use dense embeddings in the paper; here the vectors are TF-IDF over each
entity's name and description reduced by an SVD (LSA), which needs no model and sends nothing anywhere (docs/LEANRAG.md, "Decisions"). The summaries of
clusters and of cross-cluster relations are model calls (the same client as the extraction); where a call fails the cluster is named after its members.

numpy and scikit-learn are imported inside the functions that need them (the agent image has both; the query path imports neither). No pickle: the artifact
is JSON, so a container reads data and never runs it.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .corpus import Chunk, Corpus
from .graph_extract import PROMPT_VERSION, RunReport, UnitResult
from .llm import FatalLlmError, LlmError
from .text import terms

FORMAT = 1


@dataclass
class BuildParams:
    cluster_size: int = 20          # target entities per G1 cluster (the plan's cluster_size=20)
    tau: int = 3                    # cross-cluster relations needed before a model summarises them (the plan's τ=3)
    theme_ratio: int = 6            # target G1 clusters per G2 theme (the paper's 20 would leave two themes for this corpus)
    lsa_dims: int = 40
    seed: int = 42
    max_relation_summaries: int = 40

    def to_dict(self) -> dict:
        return dict(self.__dict__)


# --- aggregation ---------------------------------------------------------------------------------------------------
def aggregate(results: list[UnitResult]) -> tuple[list[dict], list[dict]]:
    """Merge the units' entities by name key and their relations by (head, type, tail). Ids are assigned in key order, so a rebuild from the same
    answers gives the same ids."""
    merged: dict[str, dict] = {}
    for result in results:
        if result.parsed is None:
            continue
        for e in result.parsed.entities:
            m = merged.setdefault(e["key"], {"key": e["key"], "names": Counter(), "types": Counter(), "descriptions": [], "chunks": []})
            m["names"][e["name"]] += 1
            m["types"][e["type"]] += 1
            if e["description"] and e["description"] not in m["descriptions"]:
                m["descriptions"].append(e["description"])
            for c in e["chunks"]:
                if c not in m["chunks"]:
                    m["chunks"].append(c)
    entities: list[dict] = []
    ids: dict[str, str] = {}
    for n, key in enumerate(sorted(merged), 1):
        m = merged[key]
        eid = f"e{n:04d}"
        ids[key] = eid
        entities.append({"id": eid, "key": key, "name": m["names"].most_common(1)[0][0], "type": m["types"].most_common(1)[0][0],
                         "desc": " ".join(m["descriptions"][:3])[:500], "chunks": m["chunks"]})
    rel_map: dict[tuple[str, str, str], dict] = {}
    for result in results:
        if result.parsed is None:
            continue
        for r in result.parsed.relations:
            h, t = ids.get(r["head"]), ids.get(r["tail"])
            if not h or not t:
                continue
            m = rel_map.setdefault((h, r["relation"], t), {"h": h, "r": r["relation"], "t": t, "w": 0, "chunks": []})
            m["w"] += 1
            for c in r["chunks"]:
                if c not in m["chunks"]:
                    m["chunks"].append(c)
    return entities, sorted(rel_map.values(), key=lambda r: (r["h"], r["r"], r["t"]))


# --- clustering ----------------------------------------------------------------------------------------------------
def lsa_vectors(docs: list[str], dims: int, seed: int):
    import numpy as np  # noqa: PLC0415
    from sklearn.decomposition import TruncatedSVD  # noqa: PLC0415
    from sklearn.feature_extraction.text import TfidfVectorizer  # noqa: PLC0415

    tfidf = TfidfVectorizer(analyzer=lambda s: terms(s), sublinear_tf=True)
    matrix = tfidf.fit_transform(docs)
    k = min(dims, matrix.shape[1] - 1, matrix.shape[0] - 1)
    if k < 2:
        return np.zeros((len(docs), 2))
    vectors = TruncatedSVD(n_components=k, random_state=seed).fit_transform(matrix)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.maximum(norms, 1e-9)


def gmm_labels(vectors, per_cluster: int, seed: int) -> list[int]:
    """Cluster labels 0..k-1 (numbered by first appearance) from a Gaussian mixture of ceil(n / per_cluster) components."""
    from sklearn.mixture import GaussianMixture  # noqa: PLC0415

    n = len(vectors)
    k = min(n, max(2, math.ceil(n / per_cluster)))
    if n < 4 or k < 2:
        return [0] * n
    gmm = GaussianMixture(n_components=k, covariance_type="diag", reg_covar=1e-3, n_init=3, random_state=seed)
    raw = gmm.fit_predict(vectors)
    order: dict[int, int] = {}
    return [order.setdefault(int(label), len(order)) for label in raw]


CLUSTER_SYSTEM = """TASK: name-cluster
You name a group of related concepts from a distributed systems course (CS6650). Use only the items listed; add nothing from your own knowledge.
Reply with one JSON object: {"name": a theme in 2 to 5 words, "description": one or two sentences saying what the group is about, using the items' own words}"""

RELATION_SYSTEM = """TASK: name-relation
Two groups of related concepts from a distributed systems course are connected by relations between their items. Reply with one JSON object:
{"relation": one short UPPER_SNAKE_CASE label for how the first group relates to the second, for example ENABLES, DEPENDS_ON, CONTRASTS_WITH, PART_OF}"""


def _json_object(text: str) -> dict:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(text[start:end + 1])
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _count(stats: dict | None, name: str) -> None:
    if stats is not None:
        stats[name] = stats.get(name, 0) + 1


def _name_group(client, members: list[dict], label: str, stats: dict | None = None) -> tuple[str, str]:
    """(name, description) of a group of {"name","desc"} items: a model call for 3 or more, else the items' own names.
    A call that fails for its own reason leaves the items' names (and is counted in `stats`); a refusal that stops everything (key, quota, offline) is not swallowed."""
    fallback_name = " / ".join(m["name"] for m in members[:3])[:80] or label
    fallback_desc = "; ".join(m["name"] for m in members[:8])[:300]
    if len(members) <= 2 or client is None:
        return fallback_name, fallback_desc
    listing = "\n".join(f"- {m['name']}: {m['desc']}" if m["desc"] else f"- {m['name']}" for m in members[:25])
    try:
        answer = _json_object(client.complete_json(CLUSTER_SYSTEM, f"Items:\n{listing}\nReply with the JSON object only.", 300).text)
    except FatalLlmError:
        raise
    except LlmError:
        _count(stats, "name_fallbacks")
        return fallback_name, fallback_desc
    name = re.sub(r"\s+", " ", str(answer.get("name") or "")).strip()[:80]
    desc = re.sub(r"\s+", " ", str(answer.get("description") or "")).strip()[:400]
    _count(stats, "name_calls")
    if not (name and desc):
        _count(stats, "name_fallbacks")
    return name or fallback_name, desc or fallback_desc


def _label(members: list[dict]) -> str:
    """The relation type that stands for a bundle of relations: the type with the most weight, with the second one after it ("A / B") when that has at
    least a quarter of the first's weight. Members may carry a compound label of their own ("A / B"): its parts count one by one."""
    weight: Counter = Counter()
    for m in members:
        w = int(m.get("w") or 1)
        for part in str(m["r"]).split(" / "):
            if part.strip():
                weight[part.strip()] += w
    ranked = sorted(weight.items(), key=lambda kv: (-kv[1], kv[0]))[:2]
    if not ranked:
        return "RELATED_TO"
    if len(ranked) == 2 and ranked[1][1] * 4 >= ranked[0][1]:
        return f"{ranked[0][0]} / {ranked[1][0]}"
    return ranked[0][0]


def _cross_relations(rels: list[dict], group_of: dict[str, str], names: dict[str, dict], client, params: BuildParams, summarise: bool,
                     stats: dict | None = None) -> list[dict]:
    """Relations between groups: counted by (head group, tail group); the heaviest, when `summarise`, get one model-written label (>= tau of them)."""
    buckets: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rels:
        a, b = group_of.get(r["h"]), group_of.get(r["t"])
        if a and b and a != b:
            buckets[(a, b)].append(r)
    out: list[dict] = []
    budget = params.max_relation_summaries
    for (a, b), members in sorted(buckets.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        label = _label(members)
        if summarise and client is not None and len(members) >= params.tau and budget > 0:
            budget -= 1
            listing = "\n".join(f"- {m['h']} {m['r']} {m['t']}" for m in members[:10])
            prompt = f"First group: {names[a]['name']} - {names[a]['desc'][:200]}\nSecond group: {names[b]['name']} - {names[b]['desc'][:200]}\nRelations ({len(members)}):\n{listing}\nReply with the JSON object only."
            try:
                got = re.sub(r"[^A-Z_]", "", str(_json_object(client.complete_json(RELATION_SYSTEM, prompt, 100).text).get("relation") or "").upper().replace(" ", "_"))
                _count(stats, "relation_calls")
                if got:
                    label = got[:40]
                else:
                    _count(stats, "relation_fallbacks")
            except FatalLlmError:
                raise
            except LlmError:
                _count(stats, "relation_fallbacks")
        out.append({"h": a, "r": label, "t": b, "w": len(members)})
    return out


def build_graph(entities: list[dict], relations: list[dict], client, params: BuildParams, progress=None, stats: dict | None = None) -> dict:
    """The graph document (graph.json) from the aggregated entities and relations. `client` names clusters (None: by their members).
    `stats`, if given, is filled with how many naming and labelling calls were answered and how many fell back to the items' own words."""
    say = progress or (lambda msg: None)
    if not entities:
        raise ValueError("no entities: nothing to build a graph from")
    docs = [f"{e['name']} {e['name']} {e['name']} {e['desc']}" for e in entities]
    vectors = lsa_vectors(docs, params.lsa_dims, params.seed)
    labels = gmm_labels(vectors, params.cluster_size, params.seed)
    say(f"G1: {len(entities)} entities into {len(set(labels))} clusters")
    clusters: list[dict] = []
    members_of: dict[int, list[dict]] = defaultdict(list)
    for e, label in zip(entities, labels):
        members_of[label].append(e)
    for label in sorted(members_of):
        cid = f"k{label + 1:03d}"
        members = members_of[label]
        name, desc = _name_group(client, members, cid, stats)
        clusters.append({"id": cid, "name": name, "desc": desc, "members": [m["id"] for m in members]})
        for m in members:
            m["cluster"] = cid
    by_cluster = {c["id"]: c for c in clusters}
    cluster_relations = _cross_relations(relations, {e["id"]: e["cluster"] for e in entities}, by_cluster, client, params, summarise=True, stats=stats)

    say(f"G2: {len(clusters)} clusters into themes")
    cluster_vectors = lsa_vectors([f"{c['name']} {c['name']} {c['desc']}" for c in clusters], params.lsa_dims, params.seed)
    theme_labels = gmm_labels(cluster_vectors, params.theme_ratio, params.seed)
    themes: list[dict] = []
    theme_members: dict[int, list[dict]] = defaultdict(list)
    for c, label in zip(clusters, theme_labels):
        theme_members[label].append(c)
    for label in sorted(theme_members):
        tid = f"t{label + 1:02d}"
        members = theme_members[label]
        name, desc = _name_group(client, members, tid, stats)
        themes.append({"id": tid, "name": name, "desc": desc, "members": [m["id"] for m in members]})
        for m in members:
            m["theme"] = tid
    by_theme = {t["id"]: t for t in themes}
    as_relations = [{"h": cr["h"], "r": cr["r"], "t": cr["t"], "w": cr["w"]} for cr in cluster_relations]
    theme_relations = _cross_relations(as_relations, {c["id"]: c["theme"] for c in clusters}, by_theme, None, params, summarise=False)

    return {"format": FORMAT,
            "entities": [{k: e[k] for k in ("id", "name", "type", "desc", "chunks", "cluster")} for e in entities],
            "relations": relations,
            "clusters": clusters, "cluster_relations": cluster_relations,
            "themes": themes, "theme_relations": theme_relations}


# --- the artifact --------------------------------------------------------------------------------------------------
def manifest_for(corpus: Corpus, report: RunReport, graph: dict, params: BuildParams, client, synthetic: bool, usage: dict | None, default_mode: str = "hybrid",
                 naming: dict | None = None) -> dict:
    kinds = Counter(c.kind for c in corpus.chunks)
    versions: dict = {"python": sys.version.split()[0]}
    for name in ("numpy", "sklearn"):
        try:
            versions[name] = __import__(name).__version__
        except Exception:  # noqa: BLE001
            versions[name] = "missing"
    return {
        "format": FORMAT,
        "built_at": __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime()),
        "synthetic": synthetic,
        "default_mode": default_mode,        # which of the engine's modes the tool serves (graph_query.MODES): decided by the evaluation, docs/LEANRAG.md
        "tool": "leanrag.build",
        "corpus": {"now": corpus.now, "page_config": corpus.page_config, "files": corpus.files, "decks": corpus.decks, "warnings": corpus.warnings,
                   "chunks": dict(kinds), "chunk_count": len(corpus.chunks)},
        "extraction": {"prompt_version": PROMPT_VERSION, "model_asked": getattr(client, "model", ""), **report.counts(), "complete": report.complete,
                       "stopped_because": report.stopped_because},
        "llm_usage": usage or {},
        "graph": {"entities": len(graph["entities"]), "relations": len(graph["relations"]), "clusters": len(graph["clusters"]),
                  "cluster_relations": len(graph["cluster_relations"]), "themes": len(graph["themes"]), "theme_relations": len(graph["theme_relations"]),
                  "naming": dict(naming or {})},        # naming and labelling calls answered / that fell back to the items' own words
        "params": {**params.to_dict(), "versions": versions},
    }


def write_artifact(out_dir: Path, chunks: list[Chunk], graph: dict, manifest: dict) -> Path:
    """Write manifest.json, graph.json and chunks.jsonl into `out_dir` (made fresh through a temporary folder and a rename)."""
    out_dir = Path(out_dir)
    tmp = out_dir.with_name(out_dir.name + f".tmp-{os.getpid()}")
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    (tmp / "graph.json").write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    with open(tmp / "chunks.jsonl", "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c.to_dict(), ensure_ascii=False) + "\n")
    (tmp / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if out_dir.exists():
        shutil.rmtree(out_dir)
    os.replace(tmp, out_dir)
    return out_dir


def publish(build_dir: Path, root: Path) -> Path:
    """Make `build_dir` the graph the host mounts: copy it to <root>/current (the old one becomes <root>/previous). Never called for a synthetic build."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((Path(build_dir) / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("synthetic"):
        raise ValueError("a synthetic (dry run) graph is never published")
    staging, current, previous = root / "current.new", root / "current", root / "previous"
    if staging.exists():
        shutil.rmtree(staging)
    shutil.copytree(build_dir, staging)
    if previous.exists():
        shutil.rmtree(previous)
    if current.exists():
        os.replace(current, previous)
    os.replace(staging, current)
    return current
