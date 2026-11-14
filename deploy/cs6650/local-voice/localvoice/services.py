"""What the service runs on: the recognizer, the synthesizer, their thread pools, the VAD factory and the key terms. `build_services` makes the real ones from the configuration (it loads and warms both
models, which takes some seconds: the port is opened only afterwards, so the container's health check turns green only when a call can be served); tests build a `Services` of stand-ins directly."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable

from .asr import ParakeetRecognizer, Recognizer
from .config import Config
from .keyterms import load_keyterms
from .listen import DecodeGate
from .logutil import LOG
from .tts import PiperBackend, SupertonicBackend, TtsBackend
from .vad import FrameVad, energy_factory, silero_factory


@dataclass
class Services:
    recognizer: Recognizer
    tts: TtsBackend
    asr_pool: ThreadPoolExecutor
    tts_pool: ThreadPoolExecutor
    vad_factory: Callable[[], FrameVad]
    keyterms: list
    gate: DecodeGate

    def shutdown(self) -> None:
        self.asr_pool.shutdown(wait=False, cancel_futures=True)
        self.tts_pool.shutdown(wait=False, cancel_futures=True)


def build_services(cfg: Config) -> Services:
    keyterms = load_keyterms(cfg.keyterms_file)
    LOG.info('loading the recognizer (%s, %d threads, %d decode workers)', cfg.asr_model_dir, cfg.asr_threads, cfg.asr_workers)
    recognizer = ParakeetRecognizer(cfg.asr_model_dir, cfg.asr_threads)
    recognizer.warm_up()
    if cfg.tts_backend == 'piper':
        LOG.info('loading the synthesizer (Piper, %s, %d engines of %d threads)', cfg.piper_model_dir, cfg.tts_workers, cfg.tts_threads)
        tts: TtsBackend = PiperBackend(cfg.piper_model_dir, threads=cfg.tts_threads, instances=cfg.tts_workers)
    else:
        LOG.info('loading the synthesizer (Supertonic, %s, %d steps, %d engines of %d threads)', cfg.st_model_dir, cfg.st_steps, cfg.tts_workers, cfg.tts_threads)
        tts = SupertonicBackend(cfg.st_model_dir, steps=cfg.st_steps, threads=cfg.tts_threads, instances=cfg.tts_workers)
    tts.warm_up()  # type: ignore[attr-defined]
    vad_factory = silero_factory(cfg.silero_model) if cfg.silero_model else energy_factory(cfg.vad)
    return Services(
        recognizer=recognizer,
        tts=tts,
        asr_pool=ThreadPoolExecutor(max_workers=cfg.asr_workers, thread_name_prefix='asr'),
        tts_pool=ThreadPoolExecutor(max_workers=cfg.tts_workers, thread_name_prefix='tts'),
        vad_factory=vad_factory,
        keyterms=keyterms,
        gate=DecodeGate(cfg.asr_workers),
    )
