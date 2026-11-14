"""Checks the labels of the retrieval questions against the slides they point at, and prints the question set's hash.

Why: the retrieval numbers (docs/LEANRAG.md) are only as good as the labels. Every question lists a few `must_contain` words; this script confirms
that EVERY labelled page has at least one of them and that EVERY word is on at least one labelled page of its question, that the page numbers exist
and that the mix of question types is what the file says it is. It reads the decks with PyMuPDF (the agent image has it) and nothing else: no
network, no model, nothing written.

Run: python eval/leanrag/check_questions.py --pages-dir <folder that holds materials-fall2026/>
     (the folder the weekly release keeps current, e.g. deploy/cs6650-pages of the course world; or LEANRAG_PAGES_DIR)
Exit code 0: all labels hold. 1: something does not (each failure is printed).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIGATURES = {"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", " ": " ", "’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-"}


def norm(text: str) -> str:
    for src, dst in LIGATURES.items():
        text = text.replace(src, dst)
    return re.sub(r"\s+", " ", text.lower()).strip()


def question_set_hash(doc: dict) -> str:
    """sha256 of the canonical JSON of what decides a score: the set, its version and the questions (not the prose around them)."""
    body = {"set": doc["set"], "version": doc["version"], "questions": doc["questions"]}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def load_decks(pages_dir: Path) -> dict[str, list[str]]:
    import pymupdf  # noqa: PLC0415  (only this script needs it)

    folder = pages_dir / "materials-fall2026"
    if not folder.is_dir():
        raise SystemExit(f"{folder} is not a folder: give --pages-dir the folder that holds materials-fall2026/")
    decks: dict[str, list[str]] = {}
    for path in sorted(folder.glob("*.pdf")):
        with pymupdf.open(str(path)) as pdf:
            decks[path.name] = [norm(page.get_text("text") or "") for page in pdf]
    return decks


def check(doc: dict, decks: dict[str, list[str]]) -> list[str]:
    problems: list[str] = []
    seen_ids: set[str] = set()
    mix = Counter(q["type"] for q in doc["questions"])
    if dict(mix) != doc["mix"]:
        problems.append(f"{doc['set']}: the file says the mix is {doc['mix']} but the questions are {dict(mix)}")
    for q in doc["questions"]:
        qid = q["id"]
        if qid in seen_ids:
            problems.append(f"{qid}: duplicate id")
        seen_ids.add(qid)
        if q["type"] not in ("lookup", "paraphrase", "compare", "cross-deck"):
            problems.append(f"{qid}: unknown type {q['type']!r}")
        if q["type"] == "compare" and len(q["groups"]) != 2:
            problems.append(f"{qid}: a compare question has two groups")
        if q["type"] in ("lookup", "paraphrase") and len(q["groups"]) != 1:
            problems.append(f"{qid}: a {q['type']} question has one group")
        if q["type"] == "cross-deck":
            decks_per_group = [{opt["deck"] for opt in g} for g in q["groups"]]
            if len(q["groups"]) < 2 or any(a & b for i, a in enumerate(decks_per_group) for b in decks_per_group[i + 1:]):
                problems.append(f"{qid}: a cross-deck question has two or more groups that name different decks")
        terms = [norm(t) for t in q["must_contain"]]
        used = {t: False for t in terms}
        for group in q["groups"]:
            for option in group:
                pages = decks.get(option["deck"])
                if pages is None:
                    problems.append(f"{qid}: there is no deck {option['deck']!r}")
                    continue
                for page in option["pages"]:
                    if not 1 <= page <= len(pages):
                        problems.append(f"{qid}: {option['deck']} has no page {page} ({len(pages)} pages)")
                        continue
                    text = pages[page - 1]
                    hit = [t for t in terms if t in text]
                    for t in hit:
                        used[t] = True
                    if not hit:
                        problems.append(f"{qid}: {option['deck']} page {page} has none of {terms}")
        for t, ok in used.items():
            if not ok:
                problems.append(f"{qid}: the word {t!r} is on none of the labelled pages")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pages-dir", default=os.environ.get("LEANRAG_PAGES_DIR"), help="the folder that holds materials-fall2026/")
    ap.add_argument("--files", nargs="*", default=[str(HERE / "questions_dev.json"), str(HERE / "questions_test.json")])
    args = ap.parse_args()
    if not args.pages_dir:
        ap.error("--pages-dir (or LEANRAG_PAGES_DIR) is required")
    decks = load_decks(Path(args.pages_dir))
    print(f"decks read: {len(decks)} ({sum(len(p) for p in decks.values())} pages)")
    failed = 0
    docs = [json.loads(Path(f).read_text(encoding="utf-8")) for f in args.files]
    texts = Counter(q["q"].strip().lower() for d in docs for q in d["questions"])
    for text, n in texts.items():
        if n > 1:
            print(f"FAIL  the question {text!r} is in more than one place")
            failed += 1
    for doc in docs:
        problems = check(doc, decks)
        print(f"{doc['set']:<5} v{doc['version']}  {len(doc['questions'])} questions  hash {question_set_hash(doc)}  {'OK' if not problems else str(len(problems)) + ' problem(s)'}")
        for p in problems:
            print("  FAIL ", p)
        failed += len(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
