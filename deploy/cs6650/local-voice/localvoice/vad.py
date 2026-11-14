"""Voice-activity detection on 20 ms frames, behind a one-method interface so that a better detector can replace the first one.

`FrameVad.process(frame, rms)` says whether ONE frame (320 samples of 16 kHz PCM16, 20 ms) is speech. The caller (`segmenter.Segmenter`) turns the frame decisions into onsets, pauses and segments; this
module only decides frame by frame. `rms` is the level of the frame in sample units (0 to 32768), computed once by the caller because it also uses it to choose where to cut a long segment.

`EnergyVad` is the first version, the rule of the lab engine's own VAD (src/voice/lab/vad.ts) and of LabGPU's adapter (RMS above 350): a frame is speech when its level is at least
max(`rms_min`, `ratio` times the quietest frame of the last `floor_window_ms`). The browser sends noise-suppressed, levelled audio, which is what makes an absolute floor workable.

`SileroFrameVad` wraps sherpa-onnx's `VoiceActivityDetector` (the Silero model) for the day a model file is put on the box (`LOCAL_VOICE_SILERO_MODEL`); nothing is downloaded by this service, and no model
file is on the development PC, so its wiring is tested with a stand-in detector only (tests/test_vad_segmenter.py), not with a real model.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Callable, Protocol

import numpy as np

FRAME_MS = 20
SAMPLE_RATE = 16000
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000      # 320
FRAME_BYTES = FRAME_SAMPLES * 2                     # 640


class FrameVad(Protocol):
    """One instance per connection (it has state)."""

    def process(self, frame: np.ndarray, rms: float) -> bool:
        """`frame`: int16 samples of one 20 ms frame. True when it is speech."""
        ...


@dataclass(frozen=True)
class EnergyVadConfig:
    rms_min: float = 350.0
    ratio: float = 3.0
    floor_window_ms: int = 2000
    #: frames of history needed before the tracked floor is trusted: a stream that begins with speech must not take its first frames for the room's noise and shut speech out
    min_history_frames: int = 25

    def validate(self) -> None:
        if not 1 <= self.rms_min <= 20000:
            raise ValueError('rms_min must be from 1 to 20000')
        if not 1.0 <= self.ratio <= 20.0:
            raise ValueError('ratio must be from 1 to 20')
        if not 200 <= self.floor_window_ms <= 30000:
            raise ValueError('floor_window_ms must be from 200 to 30000')


class EnergyVad:
    def __init__(self, cfg: EnergyVadConfig = EnergyVadConfig()):
        cfg.validate()
        self._cfg = cfg
        self._recent: deque[float] = deque(maxlen=max(1, cfg.floor_window_ms // FRAME_MS))

    @property
    def floor(self) -> float:
        """The quietest level of the recent frames (0 before any frame)."""
        return min(self._recent) if self._recent else 0.0

    def process(self, frame: np.ndarray, rms: float) -> bool:
        self._recent.append(rms)
        if len(self._recent) < self._cfg.min_history_frames:
            threshold = self._cfg.rms_min
        else:
            threshold = max(self._cfg.rms_min, self._cfg.ratio * min(self._recent))
        return rms >= threshold


class SileroFrameVad:
    """Frame decisions from a sherpa-onnx `VoiceActivityDetector` (Silero). `detector` is anything with `accept_waveform(float32 samples)` and `is_speech_detected()`."""

    def __init__(self, detector):
        self._detector = detector

    def process(self, frame: np.ndarray, rms: float) -> bool:
        self._detector.accept_waveform((frame.astype(np.float32) / 32768.0))
        return bool(self._detector.is_speech_detected())


def silero_factory(model_path: str, threshold: float = 0.5) -> Callable[[], FrameVad]:
    """A factory of Silero-backed detectors (one per connection) from a model file on disk. Fails now, at start-up, if the file or the library cannot be used."""
    import os

    if not os.path.isfile(model_path):
        raise FileNotFoundError('LOCAL_VOICE_SILERO_MODEL: no file at %s' % model_path)
    import sherpa_onnx

    def build() -> FrameVad:
        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = model_path
        config.silero_vad.threshold = threshold
        config.silero_vad.min_silence_duration = 0.1
        config.silero_vad.min_speech_duration = 0.06
        config.sample_rate = SAMPLE_RATE
        return SileroFrameVad(sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=30))

    build()  # one now: a model that cannot be loaded stops the service at start-up, not at the first call
    return build


def energy_factory(cfg: EnergyVadConfig) -> Callable[[], FrameVad]:
    cfg.validate()
    return lambda: EnergyVad(cfg)
