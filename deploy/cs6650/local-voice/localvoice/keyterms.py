"""The key-term layer: course words the recognizer writes in pieces ("map reduce", "ec two", "wait group") are written back as the terms ("MapReduce", "EC2", "WaitGroup").

The rules are `spoken_forms.py` (a verbatim copy of eval/voice-local/spoken_forms.py, amendment A13a of docs/VOICE_SELFBUILT.md froze them): the spoken forms of a term are its words, the words joined, with
the digits spelled and with short all-capital words spelled letter by letter. What this module adds is HOW the replacement is made. The frozen `apply_layer` returns lower-case words only, which is right for a
scorer and wrong for the lab engine: its turn judge (src/voice/lab/turn.ts `judgeTurnText`) reads the punctuation of the text ("Can you explain what a mutex is?" is a finished question because of the `?`;
the same words without it end on "is" and are held as unfinished) and the model that answers reads the sentence as the student's. So the replacement here is made on the spans of the words, in the model's own
text: case and punctuation stay, and only the matched words are replaced. The words of the result are those `apply_layer` gives (tests/test_keyterms.py checks that on many sentences).

The service's own terms come from a JSON list (keyterms.json, generated from src/voice/settings.ts by regenerate_keyterms.py); a connection may add its own with `keyterm=` in the URL, like Deepgram's.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache

from .spoken_forms import variants_map

_TOKEN = re.compile(r"[A-Za-z0-9']+")
_ALNUM = re.compile(r'[A-Za-z0-9]')
MAX_TERMS = 200
MAX_TERM_CHARS = 64


def clean_terms(terms) -> list[str]:
    """Strings only, spaces collapsed, at most `MAX_TERM_CHARS` long, with at least one letter or digit, no duplicates, at most `MAX_TERMS` of them, in order."""
    seen: set[str] = set()
    out: list[str] = []
    for term in terms:
        if not isinstance(term, str):
            continue
        term = ' '.join(term.split())
        if not term or len(term) > MAX_TERM_CHARS or not _ALNUM.search(term) or term in seen:
            continue
        seen.add(term)
        out.append(term)
        if len(out) >= MAX_TERMS:
            break
    return out


def load_keyterms(path: str) -> list[str]:
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, list) or not all(isinstance(t, str) for t in data):
        raise ValueError('%s must hold a JSON list of strings' % path)
    return clean_terms(data)


class KeytermLayer:
    def __init__(self, terms: tuple[str, ...]):
        mapping = variants_map(list(terms))
        self._mapping = mapping
        # by first word, longest sequence first: the same choice `apply_layer` makes (all keys, longest first), found without trying every key at every word
        self._by_first: dict[str, list[tuple[str, ...]]] = {}
        for key in sorted(mapping, key=len, reverse=True):
            self._by_first.setdefault(key[0], []).append(key)

    def __bool__(self) -> bool:
        return bool(self._mapping)

    def apply(self, text: str) -> str:
        if not self._by_first or not text:
            return text
        spans = [(m.start(), m.end(), m.group().lower()) for m in _TOKEN.finditer(text)]
        out: list[str] = []
        pos = 0
        i = 0
        while i < len(spans):
            for key in self._by_first.get(spans[i][2], ()):
                n = len(key)
                if i + n <= len(spans) and all(spans[i + j][2] == key[j] for j in range(n)):
                    start, end = spans[i][0], spans[i + n - 1][1]
                    out.append(text[pos:start])
                    out.append(self._render(text[start], self._mapping[key]))
                    pos = end
                    i += n
                    break
            else:
                i += 1
        out.append(text[pos:])
        return ''.join(out)

    @staticmethod
    def _render(first_char: str, term: str) -> str:
        """The term as written, except that a plain lower-case term ("goroutine", "load balancer") takes the capital the words it replaces began with ("Go routine is..." gives "Goroutine is...")."""
        if first_char.isupper() and term.islower():
            return term[0].upper() + term[1:]
        return term


@lru_cache(maxsize=32)
def layer_for(terms: tuple[str, ...]) -> KeytermLayer:
    """One layer per distinct list of terms: connections that ask for the same extra terms (or none) share it."""
    return KeytermLayer(terms)
