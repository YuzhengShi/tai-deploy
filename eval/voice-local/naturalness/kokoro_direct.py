"""kokoro_direct.py: the Kokoro model run directly on token ids (onnxruntime), for round 3 of the blind listening test (PROTOCOL-round3.md, amendment 2).

Why it exists. sherpa-onnx 1.13.8 makes the model's token ids from espeak-ng's IPA, and for the American voice it silently DROPS a phoneme the model has no token for: espeak-ng's `ɚ` (U+025A, the unstressed
"-er"; the engine's own warning "Skip unknown phonemes. Unicode codepoint: \\U+025a"). "worker" arrives as "work", "server" as "serv", "measure" as "mezh". The Python API takes text only, so the ids cannot be
repaired inside the engine. This module takes the engine's OWN ids (read from its debug log, one sentence at a time), replaces the truncated words by the pronunciation the model's own US lexicon
(`lexicon-us-en.txt`, Misaki's) gives for them, and runs the same `model.int8.onnx` with the same `voices.bin` the way the engine does (tokens with a 0 at both ends, the style row of the voice at the number of
tokens without the two pads, the speed as given). `validate` checks that this reproduces the engine on sentences that need no repair.
"""
from __future__ import annotations

import os
import re

os.environ.setdefault('ORT_DISABLE_TELEMETRY', '1')    # the pip onnxruntime asks a Microsoft host on import otherwise (deploy/cs6650/local-voice/README.md); set BEFORE the import

import numpy as np

MODEL = r'D:\tai-voice-local\tts\kokoro-int8-multi-lang-v1_1'
SPACE_ID = 16
PUNCT = {';', ':', ',', '.', '!', '?', '—', '…', '"', '(', ')', '“', '”'}

# The words whose espeak-ng US form loses its `ɚ` in this engine (found by comparing the 12 sentences of round 3 with the British phonemes of the same sentences, and checked against the engine's own count of
# 12 skipped phonemes), and the pronunciation of the model's own US lexicon for each (the suffixes -s, -ing, 's by the usual rules).
REPAIRS = {
    'wˈɜːk': ('w ˈ ɜ ɹ k ə ɹ', 'worker'),
    'wˈɜːkz': ('w ˈ ɜ ɹ k ə ɹ z', "worker's"),
    'mˈæst': ('m ˈ æ s t ə ɹ', 'master'),
    'ˈænsɹɪŋ': ('ˈ æ n s ə ɹ ɪ ŋ', 'answering'),
    'ˈænsz': ('ˈ æ n s ə ɹ z', 'answers'),
    'jˈuːzɹ': ('j ˈ u z ə ɹ', 'user'),
    'psˈɛnt': ('p ə ɹ s ˈ ɛ n t', 'percent'),
    'sˈɜːvz': ('s ˈ ɜ ɹ v ə ɹ z', 'servers'),
    'mˈɛʒ': ('m ˈ ɛ ʒ ə ɹ', 'measure'),
    'ɹˈɛkd': ('ɹ ˈ ɛ k ə ɹ d', 'record'),
    'sˈɜːv': ('s ˈ ɜ ɹ v ə ɹ', 'server'),
}


def load_vocab() -> tuple[dict[str, int], dict[int, str]]:
    sym2id, id2sym = {}, {}
    for line in open(os.path.join(MODEL, 'tokens.txt'), encoding='utf-8'):
        sym, idx = line.rstrip('\n').rsplit(' ', 1)
        sym2id[sym] = int(idx)
        id2sym[int(idx)] = sym
    return sym2id, id2sym


def read_log(path: str) -> list[tuple[list[int], int]]:
    """(token ids with the two pads, number of phonemes the engine skipped) for every sentence of an engine debug log, in order."""
    text = open(path, 'rb').read().decode('utf-8', 'replace')
    out, skips = [], 0
    pos = 0
    pat = re.compile(r'ConvertTextToTokenIds:158 \s*\r?\n([0-9 ]+)\r?\n')
    for m in pat.finditer(text):
        skips = text.count('Skip unknown phonemes', pos, m.start())
        out.append(([int(x) for x in m.group(1).split()], skips))
        pos = m.end()
    return out


def split_words(ids: list[int]) -> list[list[int]]:
    """The ids between the pads, split at the space token."""
    body = ids[1:-1]
    words, cur = [], []
    for i in body:
        if i == SPACE_ID:
            words.append(cur)
            cur = []
        else:
            cur.append(i)
    words.append(cur)
    return words


def join_words(words: list[list[int]]) -> list[int]:
    out: list[int] = [0]
    for k, w in enumerate(words):
        if k:
            out.append(SPACE_ID)
        out.extend(w)
    out.append(0)
    return out


def repair(ids: list[int], sym2id: dict[str, int], id2sym: dict[int, str]) -> tuple[list[int], list[str]]:
    """Replaces every truncated word of REPAIRS (trailing punctuation kept) and returns the new ids and the words it replaced."""
    words = split_words(ids)
    done = []
    for k, w in enumerate(words):
        tail = []
        core = list(w)
        while core and id2sym.get(core[-1]) in PUNCT:
            tail.insert(0, core.pop())
        s = ''.join(id2sym[i] for i in core)
        if s in REPAIRS:
            new, name = REPAIRS[s]
            words[k] = [sym2id[x] for x in new.split(' ')] + tail
            done.append(name)
    return join_words(words), done


class Runner:
    """model.int8.onnx on token ids: inputs `tokens` (int64 [1, T]), `style` (float32 [1, 256]), `speed` (float32 [1]); output `audio` (24 kHz float32)."""

    def __init__(self, threads: int = 4):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.log_severity_level = 3
        self.sess = ort.InferenceSession(os.path.join(MODEL, 'model.int8.onnx'), sess_options=so, providers=['CPUExecutionProvider'])
        n = os.path.getsize(os.path.join(MODEL, 'voices.bin')) // (510 * 256 * 4)
        self.voices = np.fromfile(os.path.join(MODEL, 'voices.bin'), dtype=np.float32).reshape(n, 510, 256)

    def synth(self, ids: list[int], sid: int, speed: float) -> np.ndarray:
        n = len(ids) - 2
        style = self.voices[sid, min(n, 509)][None, :].astype(np.float32)
        out = self.sess.run(None, {'tokens': np.asarray([ids], dtype=np.int64), 'style': style, 'speed': np.asarray([speed], dtype=np.float32)})
        return np.asarray(out[0], dtype=np.float32).reshape(-1)
