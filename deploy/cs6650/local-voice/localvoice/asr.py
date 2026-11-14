"""The recognizer: NVIDIA Parakeet-TDT-0.6B-v2 (int8) through sherpa-onnx, an OFFLINE model that decodes a whole buffer at once (segmenter.py decides what a buffer is).

Built as `eval/voice-local/asr_bench.py` `build_parakeet` builds it and run as `run_parakeet` runs it (the configuration stage 1 of docs/VOICE_SELFBUILT.md A13 measured: 3.89 % WER on set 2).

One `OfflineRecognizer` is shared by every connection's decodes: measured on this PC (2026-11-14), 108 concurrent decodes of 12 clips from 2, 3 and 4 threads gave exactly the transcripts of a sequential run
and the calls overlap (sherpa-onnx releases the GIL while it decodes), so a second copy of a 650 MB model per worker would buy nothing. The ONNX Runtime thread pool of the one session (`threads`) is what bounds
the CPU the recognizer can use, however many decodes are asked for at once.
"""
from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass
from typing import Protocol

import numpy as np

SAMPLE_RATE = 16000
_WHITESPACE = re.compile(r'\s+')


@dataclass(frozen=True)
class Decoded:
    text: str
    #: 0 to 1; exp of the mean token log-probability the model reports (a rough guide, not a calibrated probability)
    confidence: float


class Recognizer(Protocol):
    #: for /health and the logs
    name: str

    def decode(self, samples: np.ndarray) -> Decoded:
        """float32 samples at 16 kHz. Blocking; called from the decode pool, several at a time (it must be safe for that). An empty text means nothing was heard."""
        ...


class ModelError(RuntimeError):
    """A model that cannot be used at start-up (a missing file...). The message names a path from our own configuration, so it may be shown."""


def _need(path: str) -> str:
    if not os.path.isfile(path):
        raise ModelError('model file not found: %s' % path)
    return path


class ParakeetRecognizer:
    name = 'parakeet-tdt-0.6b-v2-int8'

    def __init__(self, model_dir: str, threads: int = 4):
        import sherpa_onnx

        self._rec = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=_need(os.path.join(model_dir, 'encoder.int8.onnx')),
            decoder=_need(os.path.join(model_dir, 'decoder.int8.onnx')),
            joiner=_need(os.path.join(model_dir, 'joiner.int8.onnx')),
            tokens=_need(os.path.join(model_dir, 'tokens.txt')),
            num_threads=threads,
            sample_rate=SAMPLE_RATE,
            feature_dim=80,
            decoding_method='greedy_search',
            model_type='nemo_transducer',
        )

    def warm_up(self) -> None:
        """The first decode loads kernels: do it before the first caller does."""
        self.decode(np.zeros(SAMPLE_RATE, dtype=np.float32))

    def decode(self, samples: np.ndarray) -> Decoded:
        stream = self._rec.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        self._rec.decode_stream(stream)
        result = stream.result
        text = _WHITESPACE.sub(' ', result.text).strip()
        if not text:
            return Decoded('', 0.0)
        return Decoded(text, _confidence(getattr(result, 'ys_log_probs', None)))


def _confidence(log_probs) -> float:
    try:
        values = [float(v) for v in log_probs]
    except TypeError:
        return 0.0
    if not values:
        return 0.0
    c = math.exp(sum(values) / len(values))
    return round(min(1.0, max(0.0, c)), 4)
