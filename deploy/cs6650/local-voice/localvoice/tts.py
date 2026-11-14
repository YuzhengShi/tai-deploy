"""The synthesizer side: a backend interface, two engines behind it (Supertonic, the default, and Piper), and the audio plumbing the HTTP side needs (resampling to 24 kHz, 16-bit PCM, chunking).

`TtsBackend.synthesize(text, speed, voice) -> float32 samples at `sample_rate`` is all the server asks of an engine, so another engine can be added without touching the server. It is called from the TTS
thread pool, several at a time, and must be safe for that.

* `SupertonicBackend` is the engine behind LabGPU's adapter (docs/VOICE_SELFBUILT.md 10.13), run locally with the `supertonic` package, English model, ONNX Runtime on the CPU. LabGPU's voice is the style F1 at
  the package defaults (5 steps, speed 1.05), which is what `default`, `af_bella` and `af_heart` give here. The model makes a whole sentence at once, so the first byte of the answer is the end of the synthesis.
  One engine object per worker (their ONNX sessions are not shared); `auto_download` is always False: this service never fetches anything.
  (F1 is the style nearest LabGPU's recordings by length and pitch, not a proven identity: F2 is nearer by spectrum; the owner's ear decides, and both are offered.)
* `PiperBackend` is the optional alternative (Piper `en_US-lessac-medium` through sherpa-onnx). The owner did not accept its voice; it stays for comparisons.

The request's `speed` is a multiplier on the engine's natural pace, 1.0 being the pace LabGPU's voice has.
"""
from __future__ import annotations

import os
import queue
import unicodedata

import numpy as np

OUT_RATE = 24000
#: the HTTP side sends about this many pieces, none smaller than MIN_CHUNK_BYTES (100 ms) or larger than MAX_CHUNK_BYTES
TARGET_CHUNKS = 10
MIN_CHUNK_BYTES = 4800
MAX_CHUNK_BYTES = 65536


class UnsupportedText(Exception):
    """The voice cannot say this text. Never carries the text (the engine's own message lists the characters of the request)."""


class TtsBackend:
    name = 'tts'
    sample_rate = OUT_RATE
    #: the voice names a request may use, mapped to this backend's own voice ids (what `synthesize` is given)
    voice_aliases: dict[str, str] = {'default': 'default'}

    def synthesize(self, text: str, speed: float, voice: str) -> np.ndarray:
        """float32 mono samples at `sample_rate`. `speed` 0.5 to 2.0 (1.0 = natural). Raises `UnsupportedText` for text the voice cannot say."""
        raise NotImplementedError


# ---------------------------------------------------------------- audio helpers

def resample(x, rate_in, rate_out=OUT_RATE):
    """Windowed-sinc low-pass at 0.45 of the lower rate, then linear interpolation to the new rate. x is float32 mono.

    Copied from eval/voice-local/st_bench.py (the function the owner's listening samples were made with)."""
    if rate_in == rate_out:
        return x.astype(np.float32)
    cutoff = 0.45 * min(rate_in, rate_out) / rate_in            # fraction of the input rate
    taps = 96
    n = np.arange(-taps, taps + 1)
    h = np.sinc(2 * cutoff * n) * 2 * cutoff * np.hamming(2 * taps + 1)
    h /= h.sum()
    y = np.convolve(x, h, mode='same') if rate_out < rate_in else x
    t = np.arange(int(len(y) * rate_out / rate_in)) * (rate_in / rate_out)
    return np.interp(t, np.arange(len(y)), y).astype(np.float32)


def pcm16_24k(samples: np.ndarray, rate: int) -> bytes:
    """Raw PCM s16le mono at 24 kHz, as the lab's `LabGPUMouth` reads it. The first four bytes are never 'RIFF': the client takes a body that starts with them for a WAV header."""
    y = resample(np.asarray(samples, dtype=np.float32), rate)
    pcm = (np.clip(y, -1.0, 1.0) * 32767.0).astype('<i2').tobytes()
    if pcm[:4] == b'RIFF':
        pcm = bytes([pcm[0] ^ 1]) + pcm[1:]
    return pcm


def chunk_pcm(pcm: bytes) -> list[bytes]:
    """The body as about ten pieces of whole samples."""
    total = len(pcm)
    if total == 0:
        return []
    size = min(MAX_CHUNK_BYTES, max(MIN_CHUNK_BYTES, -(-total // TARGET_CHUNKS)))
    size += size & 1
    return [pcm[i:i + size] for i in range(0, total, size)]


# ---------------------------------------------------------------- Supertonic

ST_STYLES = ('F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5')
#: LabGPU's English voice is F1 at the package defaults; all three names are one voice, like the adapter's
ST_ALIASES = {'default': 'F1', 'af_bella': 'F1', 'af_heart': 'F1', **{s: s for s in ST_STYLES}}
#: supertonic.config.DEFAULT_SPEED (the natural pace, the one LabGPU's adapter runs at) and the range the package accepts (MIN_SPEED, MAX_SPEED)
ST_NATURAL_SPEED = 1.05
ST_MIN_SPEED = 0.7
ST_MAX_SPEED = 2.0

#: Characters the engine has no sound for, that the lab's own text cleaner (src/voice/lab/mouth/spoken.ts) lets through (`=`) or that follow from it: said in words, or dropped.
_SPELLED = {'=': ' equals ', '<': ' less than ', '>': ' greater than ', '^': ' ', '{': ' ', '}': ' ', '~': ' '}
#: Latin letters with no decomposition into a base letter and a mark (the engine takes the acute accents, not the grave ones or these)
_FOLDED = {'Æ': 'AE', 'æ': 'ae', 'Ð': 'D', 'ð': 'd', 'Ø': 'O', 'ø': 'o', 'Þ': 'Th', 'þ': 'th', 'ß': 'ss', 'Œ': 'OE', 'œ': 'oe',
           'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ħ': 'H', 'ħ': 'h', 'ı': 'i'}
_FIXES_MAX = 4096


class SupertonicBackend(TtsBackend):
    name = 'supertonic-v1'
    voice_aliases = ST_ALIASES

    def __init__(self, model_dir: str, *, steps: int = 5, threads: int = 2, instances: int = 3, engine_factory=None):
        make = engine_factory or self._real_engine
        self._engines = [make(model_dir, threads) for _ in range(max(1, instances))]
        first = self._engines[0]
        self.sample_rate = int(first.sample_rate)
        self._steps = steps
        have = set(first.voice_style_names)
        self._styles = {name: first.get_voice_style(name) for name in ST_STYLES if name in have}
        if 'F1' not in self._styles:
            raise RuntimeError('the Supertonic model folder has no voice style F1: %s' % model_dir)
        self._processor = first.model.text_processor
        self._fixes: dict[str, str] = {}
        self._free: queue.Queue = queue.Queue()
        for engine in self._engines:
            self._free.put(engine)

    @staticmethod
    def _real_engine(model_dir: str, threads: int):
        from supertonic import TTS

        # auto_download=False: a folder without the model is an error to report, never a reason to go and fetch it
        return TTS(model_dir=model_dir, auto_download=False, intra_op_num_threads=threads)

    def warm_up(self) -> None:
        """The first synthesis of each engine loads kernels; do it before the first caller does."""
        for engine in self._engines:
            engine.synthesize('Warm up.', voice_style=self._styles['F1'], total_steps=self._steps, speed=ST_NATURAL_SPEED)

    def _valid(self, text: str) -> bool:
        return bool(self._processor.validate_text(text)[0])

    def _fix_char(self, ch: str) -> str:
        done = self._fixes.get(ch)
        if done is not None:
            return done
        if self._valid(ch):
            out = ch
        else:
            out = _SPELLED.get(ch) or _FOLDED.get(ch)
            if out is None:
                base = ''.join(c for c in unicodedata.normalize('NFKD', ch) if not unicodedata.combining(c))
                out = base if base else ch
            if not self._valid(out):
                out = ch
        if len(self._fixes) < _FIXES_MAX:
            self._fixes[ch] = out
        return out

    def _sanitize(self, text: str) -> str:
        """What the engine cannot say but a person can read aloud ("x = 5", a grave accent) is put into words or folded to plain letters; anything still unsayable is `UnsupportedText`."""
        fixed = ''.join(self._fix_char(c) for c in text)
        if not fixed.strip() or not self._valid(fixed):
            raise UnsupportedText()
        return fixed

    def synthesize(self, text: str, speed: float, voice: str) -> np.ndarray:
        style = self._styles.get(voice)
        if style is None:
            raise ValueError('no such voice style')
        fixed = self._sanitize(text)
        package_speed = min(ST_MAX_SPEED, max(ST_MIN_SPEED, ST_NATURAL_SPEED * speed))
        engine = self._free.get()
        try:
            try:
                wav, _ = engine.synthesize(fixed, voice_style=style, total_steps=self._steps, speed=package_speed)
            except ValueError:
                # the package's own refusal (an unsupported character it found after all, a text that is empty once cleaned): its message holds the text, so it is not passed on
                raise UnsupportedText() from None
        finally:
            self._free.put(engine)
        return np.asarray(wav[0], dtype=np.float32)


# ---------------------------------------------------------------- Piper (optional)

PIPER_ALIASES = {'default': 'lessac', 'af_bella': 'lessac', 'lessac': 'lessac'}


class PiperBackend(TtsBackend):
    name = 'piper-en_US-lessac-medium'
    voice_aliases = PIPER_ALIASES

    def __init__(self, model_dir: str, *, threads: int = 2, instances: int = 3):
        import sherpa_onnx

        model = os.path.join(model_dir, 'en_US-lessac-medium.onnx')
        tokens = os.path.join(model_dir, 'tokens.txt')
        data_dir = os.path.join(model_dir, 'espeak-ng-data')
        for path in (model, tokens):
            if not os.path.isfile(path):
                raise RuntimeError('model file not found: %s' % path)
        if not os.path.isdir(data_dir):
            raise RuntimeError('model folder not found: %s' % data_dir)

        def build():
            vits = sherpa_onnx.OfflineTtsVitsModelConfig(model=model, tokens=tokens, data_dir=data_dir)
            config = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(vits=vits, num_threads=threads, provider='cpu'), max_num_sentences=1)
            if not config.validate():
                raise RuntimeError('the Piper configuration is not valid: %s' % model_dir)
            return sherpa_onnx.OfflineTts(config)

        # one object per worker, never shared: nothing here relies on what sherpa-onnx's espeak front end does when two threads call it at once
        self._engines = [build() for _ in range(max(1, instances))]
        self.sample_rate = int(self._engines[0].sample_rate)
        self._free: queue.Queue = queue.Queue()
        for engine in self._engines:
            self._free.put(engine)

    def warm_up(self) -> None:
        for engine in self._engines:
            engine.generate('Warm up.', sid=0, speed=1.0)

    def synthesize(self, text: str, speed: float, voice: str) -> np.ndarray:
        engine = self._free.get()
        try:
            audio = engine.generate(text, sid=0, speed=float(speed))
        finally:
            self._free.put(engine)
        return np.asarray(audio.samples, dtype=np.float32)
