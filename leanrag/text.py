"""Words for the graph engine: normalisation, stems, stop words, BM25. Standard library only.

The query path (graph_query.py) runs inside the agent image with nothing but the interpreter, and it must not need a package to answer. The stemmer is a
port of `stem()` in src/docs/library-search.ts (the course library's search), so that when the graph is compared with that search the difference is
not "they stem differently". The stop words are the same list, plus nothing.

Nothing here reads a file, the network or the environment.
"""
from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter, defaultdict

STOP = frozenset(
    "a an the of in on to is are was were be it its this that these those and or for with about from by at as how what why when where which who "
    "does do did can could would should me my i you we us our please show find give slide slides deck decks lecture lectures page pages explain tell".split()
)

_SOFT_HYPHEN = "­"
_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_LIGATURES = {"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl"}


def normalize(text: str) -> str:
    """Letters and digits only, lower case, accents folded, single spaces (a soft hyphen is no break between words)."""
    text = text.replace(_SOFT_HYPHEN, "")
    for src, dst in _LIGATURES.items():
        text = text.replace(src, dst)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return " ".join(_WORD.findall(text.lower()))


def stem(word: str) -> str:
    """A word as the stem both sides are compared by (a plural, -ing, -ed, -ion and a final e come off)."""
    if len(word) <= 3 or word.isdigit():
        return word
    s = word
    if s.endswith("ies") and len(s) > 4:
        s = s[:-3] + "y"
    elif s.endswith("sses"):
        s = s[:-2]
    elif re.search(r"(?:ch|sh|x|z|s)es$", s) and len(s) > 4:
        s = s[:-2]
    elif s.endswith("s") and not re.search(r"(?:ss|us|is|os)$", s):
        s = s[:-1]
    for _ in range(2):
        if len(s) > 5 and s.endswith("ing"):
            s = s[:-3]
        elif len(s) > 4 and s.endswith("ed"):
            s = s[:-2]
        elif len(s) > 6 and s.endswith("ion"):
            s = s[:-3]
        else:
            break
    if len(s) > 4 and s.endswith("e"):
        s = s[:-1]
    return s


def terms(text: str, drop_stop: bool = True) -> list[str]:
    """The stems of the words of `text`, in order, with repeats (one-letter words are dropped, except a digit)."""
    out: list[str] = []
    for word in normalize(text).split():
        if drop_stop and word in STOP:
            continue
        if len(word) < 2 and not word.isdigit():
            continue
        out.append(stem(word))
    return out


class Bm25:
    """Okapi BM25 over documents given as lists of terms. `scores(query_terms)` returns {doc index: score} for the documents that share a term."""

    def __init__(self, docs: list[list[str]], k1: float = 1.4, b: float = 0.75) -> None:
        self.k1, self.b = k1, b
        self.n = len(docs)
        self.lengths = [len(d) for d in docs]
        self.avg = (sum(self.lengths) / self.n) if self.n else 0.0
        self.postings: dict[str, list[tuple[int, int]]] = defaultdict(list)
        for i, doc in enumerate(docs):
            for term, tf in Counter(doc).items():
                self.postings[term].append((i, tf))
        self.idf = {t: math.log(1 + (self.n - len(p) + 0.5) / (len(p) + 0.5)) for t, p in self.postings.items()}

    def scores(self, query_terms: list[str]) -> dict[int, float]:
        out: dict[int, float] = defaultdict(float)
        for term in set(query_terms):
            idf = self.idf.get(term)
            if idf is None:
                continue
            for i, tf in self.postings[term]:
                norm = tf + self.k1 * (1 - self.b + self.b * self.lengths[i] / (self.avg or 1.0))
                out[i] += idf * tf * (self.k1 + 1) / norm
        return out
