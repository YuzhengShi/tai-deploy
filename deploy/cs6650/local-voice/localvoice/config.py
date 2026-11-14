"""The settings of the service, all from the environment (README.md lists every one with its default and what it does). A value that does not parse, or is out of range, stops the start with a message that
names the variable: a mistyped number silently replaced by a default would make a measurement mean something other than what its author thinks."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping, Sequence

from .segmenter import SegmenterConfig
from .vad import EnergyVadConfig

PREFIX = 'LOCAL_VOICE_'
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ConfigError(ValueError):
    pass


def _raw(env: Mapping[str, str], name: str, aliases: Sequence[str] = ()) -> tuple[str, str | None]:
    for key in (PREFIX + name, *aliases):
        value = env.get(key)
        if value is not None and value.strip() != '':
            return key, value.strip()
    return PREFIX + name, None


def _int(env, name: str, default: int, lo: int, hi: int, aliases: Sequence[str] = ()) -> int:
    key, value = _raw(env, name, aliases)
    if value is None:
        return default
    try:
        number = int(value)
    except ValueError:
        raise ConfigError('%s=%r is not a whole number' % (key, value)) from None
    if not lo <= number <= hi:
        raise ConfigError('%s=%d must be from %d to %d' % (key, number, lo, hi))
    return number


def _float(env, name: str, default: float, lo: float, hi: float) -> float:
    key, value = _raw(env, name)
    if value is None:
        return default
    try:
        number = float(value)
    except ValueError:
        raise ConfigError('%s=%r is not a number' % (key, value)) from None
    if not (lo <= number <= hi):      # also false for NaN
        raise ConfigError('%s=%s must be from %g to %g' % (key, value, lo, hi))
    return number


def _str(env, name: str, default: str) -> str:
    _, value = _raw(env, name)
    return default if value is None else value


def _choice(env, name: str, default: str, allowed: Sequence[str]) -> str:
    key, value = _raw(env, name)
    if value is None:
        return default
    value = value.lower()
    if value not in allowed:
        raise ConfigError('%s=%r must be one of %s' % (key, value, ', '.join(allowed)))
    return value


@dataclass(frozen=True)
class Config:
    host: str = '127.0.0.1'
    port: int = 18800
    asr_model_dir: str = '/models/parakeet-tdt-0.6b-v2-int8'
    asr_threads: int = 4
    asr_workers: int = 3
    tts_backend: str = 'supertonic'
    st_model_dir: str = '/models/supertonic/v1'
    st_steps: int = 5
    piper_model_dir: str = '/models/vits-piper-en_US-lessac-medium'
    tts_threads: int = 2
    tts_workers: int = 3
    keyterms_file: str = os.path.join(HERE, 'keyterms.json')
    silero_model: str = ''
    max_connections: int = 4
    idle_commit_ms: int = 3000
    max_pending_segments: int = 6
    stale_silence_ms: int = 200
    ws_ping_s: float = 20.0
    ws_ping_timeout_s: float = 20.0
    max_tts_pending: int = 16
    log_level: str = 'INFO'
    segmenter: SegmenterConfig = field(default_factory=SegmenterConfig)
    vad: EnergyVadConfig = field(default_factory=EnergyVadConfig)

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> 'Config':
        env = os.environ if env is None else env
        d = SegmenterConfig()
        v = EnergyVadConfig()
        segmenter = SegmenterConfig(
            seg_pause_ms=_int(env, 'SEG_PAUSE_MS', d.seg_pause_ms, 100, 5000, aliases=('SEG_PAUSE_MS',)),
            end_pause_ms=_int(env, 'END_PAUSE_MS', d.end_pause_ms, 100, 10000, aliases=('END_PAUSE_MS',)),
            max_utterance_ms=_int(env, 'MAX_UTTERANCE_MS', d.max_utterance_ms, 2000, 120000),
            min_speech_ms=_int(env, 'MIN_SPEECH_MS', d.min_speech_ms, 0, 2000),
            preroll_ms=_int(env, 'PREROLL_MS', d.preroll_ms, 0, 1000),
            trail_keep_ms=_int(env, 'TRAIL_KEEP_MS', d.trail_keep_ms, 0, 1000),
            onset_ms=_int(env, 'ONSET_MS', d.onset_ms, 20, 500),
            interim_ms=_int(env, 'INTERIM_MS', d.interim_ms, 0, 30000),
            max_segment_ms=_int(env, 'MAX_SEGMENT_MS', d.max_segment_ms, 0, 60000),
            cut_window_ms=_int(env, 'CUT_WINDOW_MS', d.cut_window_ms, 100, 2000),
        )
        try:
            segmenter.validate()
        except ValueError as exc:
            raise ConfigError('segmentation settings: %s' % exc) from None
        vad = EnergyVadConfig(
            rms_min=_float(env, 'VAD_RMS_MIN', v.rms_min, 1, 20000),
            ratio=_float(env, 'VAD_RATIO', v.ratio, 1, 20),
            floor_window_ms=_int(env, 'VAD_FLOOR_MS', v.floor_window_ms, 200, 30000),
            min_history_frames=v.min_history_frames,
        )
        return Config(
            host=_str(env, 'HOST', Config.host),
            port=_int(env, 'PORT', Config.port, 0, 65535),
            asr_model_dir=_str(env, 'ASR_MODEL_DIR', Config.asr_model_dir),
            asr_threads=_int(env, 'ASR_THREADS', Config.asr_threads, 1, 64),
            asr_workers=_int(env, 'ASR_WORKERS', Config.asr_workers, 1, 32),
            tts_backend=_choice(env, 'TTS_BACKEND', Config.tts_backend, ('supertonic', 'piper')),
            st_model_dir=_str(env, 'ST_MODEL_DIR', Config.st_model_dir),
            st_steps=_int(env, 'ST_STEPS', Config.st_steps, 1, 32),
            piper_model_dir=_str(env, 'PIPER_MODEL_DIR', Config.piper_model_dir),
            tts_threads=_int(env, 'TTS_THREADS', Config.tts_threads, 1, 64),
            tts_workers=_int(env, 'TTS_WORKERS', Config.tts_workers, 1, 32),
            keyterms_file=_str(env, 'KEYTERMS_FILE', Config.keyterms_file),
            silero_model=_str(env, 'SILERO_MODEL', ''),
            max_connections=_int(env, 'MAX_CONNECTIONS', Config.max_connections, 1, 64),
            idle_commit_ms=_int(env, 'IDLE_COMMIT_MS', Config.idle_commit_ms, 500, 60000),
            max_pending_segments=_int(env, 'MAX_PENDING_SEGMENTS', Config.max_pending_segments, 1, 64),
            stale_silence_ms=_int(env, 'STALE_SILENCE_MS', Config.stale_silence_ms, 20, 2000),
            ws_ping_s=_float(env, 'WS_PING_S', Config.ws_ping_s, 0.05, 600),
            ws_ping_timeout_s=_float(env, 'WS_PING_TIMEOUT_S', Config.ws_ping_timeout_s, 0.05, 600),
            max_tts_pending=_int(env, 'MAX_TTS_PENDING', Config.max_tts_pending, 1, 256),
            log_level=_choice(env, 'LOG_LEVEL', Config.log_level.lower(), ('debug', 'info', 'warning', 'error')).upper(),
            segmenter=segmenter,
            vad=vad,
        )
