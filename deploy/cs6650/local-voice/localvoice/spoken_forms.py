"""Spoken forms of the live key terms, and the text layer that writes them back (docs/VOICE_SELFBUILT.md A13 and A13a).

A recognizer writes what it hears: "map reduce" for MapReduce, "ec two" for EC2, "s q s" for SQS. The rules below are FIXED and generated from the term list alone (src/voice/settings.ts KEYTERMS):
  1. split a term at spaces, at lower-to-upper case boundaries, before a capital that starts a word inside a run of capitals ("TAi" is T Ai), and between letters and digits;
  2. the spoken forms of a term are: its words as they stand ("map reduce"), the words joined ("mapreduce"), with every digit spelled ("ec two"), and with every all-capital word of two to
     five letters spelled letter by letter ("s q s", "e c two", "g r p c"); duplicates and the term's own plain form are dropped.
The hotwords of a configuration are these spoken forms (what the model should be pushed to write); the layer maps any of them in the hypothesis back to the term as written. Nothing here looks at
a test sentence or at what any recognizer got wrong.
"""
import os
import re

DIGITS = {'0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine'}
_BOUNDARY = re.compile(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])')


def words_of(text):
    """The words of a text, as measure/recognize.ts wordsOf: lower case, runs of [a-z0-9']."""
    return re.findall(r"[a-z0-9']+", text.lower())


def read_keyterms(settings_ts):
    """The KEYTERMS of src/voice/settings.ts, read from the file so that nothing is transcribed by hand."""
    text = open(settings_ts, encoding='utf-8').read()
    block = re.search(r'export const KEYTERMS = \[(.*?)\]', text, re.S)
    if not block:
        raise ValueError('KEYTERMS not found in ' + settings_ts)
    return re.findall(r"'([^']+)'", block.group(1))


def _pieces(term):
    """[(piece as written, lower-case piece)] after rule 1."""
    out = []
    for chunk in term.split():
        for piece in _BOUNDARY.sub(' ', chunk).split():
            out.append(piece)
    return out


def spoken_forms(term):
    """The spoken forms of a term, each a list of words, without the term's own plain form (rule 2)."""
    pieces = _pieces(term)
    plain = [p.lower() for p in pieces]
    forms = []

    def add(words):
        if words and words not in forms:
            forms.append(words)

    def spell_digits(words):
        out = []
        for w in words:
            out.extend(DIGITS[c] for c in w) if w.isdigit() else out.append(w)
        return out

    add(plain)                                    # "map reduce"
    add([''.join(plain)])                         # "mapreduce"
    add(spell_digits(plain))                      # "ec two"
    letters = []
    for p, low in zip(pieces, plain):
        if p.isalpha() and p.isupper() and 2 <= len(p) <= 5:
            letters.extend(list(low))             # "s q s"
        else:
            letters.append(low)
    add(letters)                                  # "e c 2"
    add(spell_digits(letters))                    # "e c two"
    own = words_of(term)
    return [f for f in forms if f != own]


def variants_map(terms):
    """{tuple of spoken words: the term as written}, longest sequences first when applied."""
    out = {}
    for term in terms:
        for words in spoken_forms(term):
            out.setdefault(tuple(words), term)
    return out


def apply_layer(text, mapping):
    """Words of `text` with every spoken form of a key term replaced by the term as written. Output is words only (no case, no punctuation): the scorer reads words."""
    have = words_of(text)
    keys = sorted(mapping, key=len, reverse=True)
    out, i = [], 0
    while i < len(have):
        for key in keys:
            if tuple(have[i:i + len(key)]) == key:
                out.append(mapping[key])
                i += len(key)
                break
        else:
            out.append(have[i])
            i += 1
    return ' '.join(out)


def hotword_lines(terms):
    """The hotwords file: the spoken forms of every term, upper case (the recognizer's vocabulary), one per line, and the plain form of terms that are plain words."""
    lines = []
    for term in terms:
        for words in [words_of(term)] + spoken_forms(term):
            line = ' '.join(w.upper() for w in words)
            if line and line not in lines:
                lines.append(line)
    return lines


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    terms = read_keyterms(os.path.join(here, '..', '..', 'src', 'voice', 'settings.ts'))
    for t in terms:
        print('%-20s %s' % (t, ' | '.join(' '.join(f) for f in spoken_forms(t)) or '-'))
