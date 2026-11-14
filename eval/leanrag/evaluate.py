"""Retrieval evaluation for the course knowledge tool: the same questions, several systems, one score (docs/LEANRAG.md, "Measurements").

A system is asked each question and answers with a ranked list of ITEMS, each covering one or more (deck, page). A question passes at k when every one of
its groups (questions_*.json: `groups`) is hit by one of the first k items. Systems:

  library    the course library's search (src/docs/library-search.ts, run by library_search.ts): the baseline the task names
  standin    what the live knowledge tool answers from today: the course world's chunker (nora/knowledge.py, its own code) over the same decks, then
             leanrag/stub_query.py (BM25). The only difference from the live corpus: PDF text comes from PyMuPDF, the live host's from pypdf
  bm25       OUR page chunks, OUR stemmer, BM25 only: the control that has no graph (leanrag/graph_query.py mode "bm25")
  entity     the graph only: slides found through the entities of the question (mode "entity")
  hybrid     slide text and graph together (mode "hybrid"): what the tool would serve

Nothing here sends anything anywhere or reads a key. Run from the repository root:
  python eval/leanrag/evaluate.py --questions eval/leanrag/questions_dev.json --pages-dir <pages folder> --graph-dir <artifact> \\
      --systems standin,library,bm25,entity,hybrid --library-results <library.json> --nora-dir <course world repo> --out <results.json>
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True

from check_questions import question_set_hash  # noqa: E402
from leanrag import graph_query  # noqa: E402
from leanrag.corpus import deck_pages, deck_title  # noqa: E402

KS = (1, 3, 5)
TYPES = ("lookup", "paraphrase", "compare", "cross-deck")


# --- scoring (pure) ------------------------------------------------------------------------------------------------
def hits_group(group: list[dict], items: list[dict]) -> bool:
    for item in items:
        for option in group:
            if item.get("deck") == option["deck"] and set(item.get("pages", [])) & set(option["pages"]):
                return True
    return False


def passes(question: dict, items: list[dict], k: int) -> bool:
    top = items[:k]
    return all(hits_group(group, top) for group in question["groups"])


def score_system(questions: list[dict], items_by_q: dict[str, list[dict]]) -> dict:
    """{"@1": {"all": [hits, n], "lookup": [hits, n], ...}, ..., "pages_per_item": x, "items_per_question": y, "first_hit_rank": {...}}"""
    out: dict = {}
    for k in KS:
        row: dict = {"all": [0, len(questions)]}
        for t in TYPES:
            row[t] = [0, sum(1 for q in questions if q["type"] == t)]
        for q in questions:
            if passes(q, items_by_q.get(q["id"], []), k):
                row["all"][0] += 1
                row[q["type"]][0] += 1
        out[f"@{k}"] = row
    items = [it for q in questions for it in items_by_q.get(q["id"], [])]
    out["pages_per_item"] = round(sum(len(it.get("pages", [])) for it in items) / max(1, len(items)), 2)
    out["items_per_question"] = round(len(items) / max(1, len(questions)), 2)
    ranks = []
    for q in questions:
        r = next((k for k in range(1, 11) if passes(q, items_by_q.get(q["id"], []), k)), None)
        ranks.append(r)
    out["mrr"] = round(sum(1 / r for r in ranks if r) / max(1, len(questions)), 3)
    return out


# --- the corpus the baselines read ----------------------------------------------------------------------------------
def deck_files(pages_dir: Path) -> list[dict]:
    """The decks a released week names: [{"file", "title", "week" (number)}], in weeks.json order."""
    weeks = json.loads((pages_dir / "weeks.json").read_text(encoding="utf-8")).get("weeks", {})
    out, seen = [], set()
    for key, w in weeks.items():
        if key == "syllabus" or w.get("released") is False:
            continue
        for item in w.get("items", []):
            if item.get("kind") == "slides" and item.get("file") and item["file"] not in seen:
                seen.add(item["file"])
                out.append({"file": item["file"], "title": deck_title(item), "week": w.get("n")})
    return out


def write_library_decks(pages_dir: Path, path: Path) -> None:
    decks = [{"id": d["file"], "title": d["title"], "week": d["week"], "pages": deck_pages(pages_dir / "materials-fall2026" / d["file"])} for d in deck_files(pages_dir)]
    path.write_text(json.dumps(decks, ensure_ascii=False), encoding="utf-8")


# --- the systems ----------------------------------------------------------------------------------------------------
def library_items(path: Path) -> dict[str, list[dict]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {qid: [{"deck": h["id"], "pages": [h["page"]], "kind": "slide"} for h in hits] for qid, hits in data["results"].items()}


def standin_items(questions: list[dict], pages_dir: Path, nora_dir: Path, now, top_k: int = 10) -> tuple[dict[str, list[dict]], dict]:
    """The live stand-in: nora/knowledge.py's Corpus (its own code) with PyMuPDF text, then leanrag/stub_query.py exactly as the container runs it."""
    spec = importlib.util.spec_from_file_location("nora_knowledge", nora_dir / "nora" / "knowledge.py")
    nk = importlib.util.module_from_spec(spec)
    sys.modules["nora_knowledge"] = nk                # a @dataclass looks its module up in sys.modules
    spec.loader.exec_module(nk)                       # its top level imports the standard library only; pypdf is imported inside deck_pages
    nk.deck_pages = lambda path: [re.sub(r"[ \t ]+", " ", t).strip() for t in deck_pages(Path(path))]
    corpus = nk.Corpus(pages_dir, now=now)
    chunks = [{"kind": c.kind, "title": c.title, "where": c.where, "text": c.text, "week": c.week} for c in corpus.chunks]
    file_of = {d["title"]: d["file"] for d in deck_files(pages_dir)}
    from leanrag.stub_query import query_stub  # noqa: PLC0415

    with tempfile.TemporaryDirectory() as tmp:
        stub = Path(tmp) / "stub_corpus.json"
        stub.write_text(json.dumps(chunks), encoding="utf-8")
        out: dict[str, list[dict]] = {}
        for q in questions:
            result = query_stub(stub, q["q"], top_k=top_k)
            items = []
            for src in result["source_texts"]:
                m = re.match(r"(\w+): (.*) \((slides (\d+)(?:-(\d+))?|.*)\)$", src["source_file"], re.S)
                if m and m.group(1) == "slides" and m.group(2) in file_of:
                    first = int(m.group(4))
                    last = int(m.group(5) or first)
                    items.append({"deck": file_of[m.group(2)], "pages": list(range(first, last + 1)), "kind": "slide"})
                else:
                    items.append({"deck": "", "pages": [], "kind": m.group(1) if m else "other"})
            out[q["id"]] = items
    return out, {"chunks": len(chunks), "kinds": {k: sum(1 for c in chunks if c["kind"] == k) for k in {c["kind"] for c in chunks}}, "top_k": top_k}


def graph_items(questions: list[dict], graph_dir: Path, mode: str, now, top_k: int = 10, allow_synthetic: bool = False, profile: str | None = None) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for q in questions:
        result = graph_query.query_graph(graph_dir, q["q"], difficulty="auto", top_k=top_k, mode=mode, now=now, allow_synthetic=allow_synthetic, profile=profile)
        out[q["id"]] = [{"deck": s["deck"], "pages": [s["page"]] if s["page"] else [], "kind": s["kind"]} for s in result["source_texts"]]
    return out


# --- main ------------------------------------------------------------------------------------------------------------
def show(name: str, scores: dict) -> None:
    def cell(row: list) -> str:
        return f"{row[0]:>2}/{row[1]:<2}"
    print(f"{name:<9}" + "".join(f"  {k}: {cell(scores[k]['all'])}" for k in ("@1", "@3", "@5")) + f"   mrr {scores['mrr']:.3f}   pages/item {scores['pages_per_item']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--questions", required=True)
    ap.add_argument("--pages-dir", required=True)
    ap.add_argument("--graph-dir", help="the built artifact (manifest.json, graph.json, chunks.jsonl)")
    ap.add_argument("--systems", default="bm25,entity,hybrid")
    ap.add_argument("--library-results", help="the output of library_search.ts")
    ap.add_argument("--write-library-decks", help="write the decks file library_search.ts reads, then stop")
    ap.add_argument("--nora-dir", help="the course world repo (for the standin)")
    ap.add_argument("--now", default="2026-11-11T12:00:00Z", help="the clock the evaluation runs at (decides which chunks are visible)")
    ap.add_argument("--allow-synthetic", action="store_true", help="accept a dry-run graph (for the plumbing only: its numbers mean nothing)")
    ap.add_argument("--profile", default=None, help="which engine the graph systems (bm25, entity, hybrid) run: v1 (frozen 2026-11-12) or v2 (the two fixes); default LEANRAG_PROFILE or graph_query.DEFAULT_PROFILE")
    ap.add_argument("--out")
    args = ap.parse_args()
    import datetime as dt

    now = dt.datetime.fromisoformat(args.now.replace("Z", "+00:00"))
    pages_dir = Path(args.pages_dir)
    if args.write_library_decks:
        write_library_decks(pages_dir, Path(args.write_library_decks))
        print(f"wrote {args.write_library_decks}")
        return 0
    doc = json.loads(Path(args.questions).read_text(encoding="utf-8"))
    questions = doc["questions"]
    names = [s.strip() for s in args.systems.split(",") if s.strip()]
    result: dict = {"ran_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "now": args.now,
                    "question_set": {"set": doc["set"], "version": doc["version"], "hash": question_set_hash(doc), "n": len(questions)},
                    "engine": {"profile": graph_query.resolve_profile(args.profile), "constants": graph_query.engine_config(args.profile),
                               "hash": hashlib.sha256(json.dumps(graph_query.engine_config(args.profile), sort_keys=True).encode()).hexdigest()[:16]},
                    "systems": {}, "scores": {}, "per_question": defaultdict(dict)}
    if args.graph_dir:
        manifest = json.loads((Path(args.graph_dir) / "manifest.json").read_text(encoding="utf-8"))
        result["artifact"] = {"dir": str(args.graph_dir), "built_at": manifest.get("built_at"), "synthetic": manifest.get("synthetic"), "graph": manifest.get("graph"),
                              "extraction_model_asked": manifest.get("extraction", {}).get("model_asked"), "llm_usage": manifest.get("llm_usage")}
    for name in names:
        if name == "library":
            if not args.library_results:
                raise SystemExit("--library-results is needed for the library system (run library_search.ts first)")
            items, info = library_items(Path(args.library_results)), {}
        elif name == "standin":
            if not args.nora_dir:
                raise SystemExit("--nora-dir is needed for the standin system")
            items, info = standin_items(questions, pages_dir, Path(args.nora_dir), now)
        elif name in ("bm25", "entity", "hybrid"):
            if not args.graph_dir:
                raise SystemExit(f"--graph-dir is needed for {name}")
            items, info = graph_items(questions, Path(args.graph_dir), name, now, allow_synthetic=args.allow_synthetic, profile=args.profile), {}
        else:
            raise SystemExit(f"unknown system {name!r}")
        scores = score_system(questions, items)
        result["systems"][name] = {"info": info, "items": items}
        result["scores"][name] = scores
        for q in questions:
            result["per_question"][q["id"]][name] = {f"@{k}": passes(q, items.get(q["id"], []), k) for k in KS}
        show(name, scores)
    print()
    print("by question type, hits at @3 (out of the number of questions of the type):")
    print(f"{'':<9}" + "".join(f"{t:>12}" for t in TYPES))
    for name in names:
        print(f"{name:<9}" + "".join(f"{result['scores'][name]['@3'][t][0]:>8}/{result['scores'][name]['@3'][t][1]:<3}" for t in TYPES))
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
