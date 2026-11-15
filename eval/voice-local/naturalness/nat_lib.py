"""nat_lib.py: the helpers every script of the naturalness test shares (PROTOCOL.md): reading and writing WAV, the speech level, the lab's soft limiter, the level and trim controls, the ONE resampler,
a numpy YIN, and the word normalizer of the word error rate.

Run with the PC's voice environment (numpy, onnxruntime, sherpa-onnx, supertonic): D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe
"""
from __future__ import annotations

import difflib
import math
import os
import re
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'deploy', 'cs6650', 'local-voice'))
from localvoice.tts import resample as _resample   # noqa: E402  the service's own resampler: windowed-sinc low-pass, then linear interpolation

TARGET_DB = -16.0          # the live voice's speech level (docs/LOCAL_VOICE.md 9.13)
KNEE = 0.75                # src/voice/lab/mouth/level.ts: the knee at 75 % of full scale
CEILING = 29163 / 32768    # and the ceiling at 29163 / 32768 (-1 dBFS)
ROOM = CEILING - KNEE


# ---------------------------------------------------------------- WAV
def read_wav(path: str) -> tuple[np.ndarray, int]:
    """float32 mono in [-1, 1] and the sample rate. 16-bit PCM only (a stereo file is averaged)."""
    with wave.open(path, 'rb') as w:
        if w.getsampwidth() != 2:
            raise ValueError('16-bit PCM only: %s' % path)
        n, ch, sr = w.getnframes(), w.getnchannels(), w.getframerate()
        raw = w.readframes(n)
    x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def read_pcm_i16(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, 'rb') as w:
        n, sr = w.getnframes(), w.getframerate()
        raw = w.readframes(n)
    return np.frombuffer(raw, dtype='<i2'), sr


def write_wav(path: str, x: np.ndarray, sr: int) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pcm = (np.clip(x, -1.0, 32767 / 32768) * 32768.0).round().astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------- level
def frame_rms(x: np.ndarray, sr: int, ms: int = 10) -> np.ndarray:
    n = max(1, int(sr * ms / 1000))
    k = len(x) // n
    if k == 0:
        return np.zeros(0)
    f = x[: k * n].reshape(k, n).astype(np.float64)
    return np.sqrt((f * f).mean(axis=1))


def voiced_mask(x: np.ndarray, sr: int, ms: int = 10) -> np.ndarray:
    """Frames of `ms` above max(60/32768, 6 % of the 95th percentile of the frame levels): the rule of the earlier level measurements (9.13), so that the numbers are comparable."""
    r = frame_rms(x, sr, ms)
    if len(r) == 0:
        return np.zeros(0, dtype=bool)
    thr = max(60 / 32768, 0.06 * float(np.percentile(r, 95)))
    return r > thr


def speech_level_db(x: np.ndarray, sr: int, mask: np.ndarray | None = None) -> float:
    """RMS of the voiced frames in dBFS (full scale = 1.0)."""
    m = voiced_mask(x, sr) if mask is None else mask
    n = max(1, int(sr * 10 / 1000))
    if not m.any():
        return -120.0
    f = x[: len(m) * n].reshape(len(m), n).astype(np.float64)[m]
    return 20 * math.log10(max(1e-9, math.sqrt(float((f * f).mean()))))


def soft_limit(x: np.ndarray) -> np.ndarray:
    """level.ts's tanh knee above 75 % of full scale towards the ceiling of -1 dBFS, on floats."""
    y = np.asarray(x, dtype=np.float64)
    a = np.abs(y)
    over = a > KNEE
    out = y.copy()
    out[over] = np.sign(y[over]) * (KNEE + ROOM * np.tanh((a[over] - KNEE) / ROOM))
    return out


def apply_gain_db(x: np.ndarray, db: float) -> np.ndarray:
    """A fixed gain and the soft limiter: what the lab does to a mouth's PCM (`applyGain`). float32 in, float32 out."""
    return soft_limit(x.astype(np.float64) * 10 ** (db / 20)).astype(np.float32)


def apply_gain_i16(pcm: np.ndarray, db: float) -> np.ndarray:
    """level.ts `applyGain` on 16-bit samples, rounded to whole samples as the lab rounds them."""
    knee, ceiling = 0.75 * 32768, 29163
    room = ceiling - knee
    y = pcm.astype(np.float64) * 10 ** (db / 20)
    a = np.abs(y)
    over = a > knee
    y[over] = np.sign(y[over]) * (knee + room * np.tanh((a[over] - knee) / room))
    return np.round(y).astype('<i2')


def normalize_level(x: np.ndarray, sr: int, target_db: float = TARGET_DB) -> tuple[np.ndarray, float]:
    """A fixed gain chosen per clip so that the speech level AFTER the soft limiter is `target_db` (within 0.05 dB). Returns the clip and the gain in dB."""
    mask = voiced_mask(x, sr)
    g = target_db - speech_level_db(x, sr, mask)
    gain_total = g
    y = apply_gain_db(x, gain_total)
    for _ in range(12):
        err = target_db - speech_level_db(y, sr, mask)
        if abs(err) < 0.05:
            break
        gain_total += err
        y = apply_gain_db(x, gain_total)
    return y, gain_total


def trim(x: np.ndarray, sr: int, pad_ms: int = 100) -> np.ndarray:
    """Leading and trailing silence cut to `pad_ms` (frames not voiced by the rule above)."""
    m = voiced_mask(x, sr)
    if not m.any():
        return x
    n = int(sr * 10 / 1000)
    first, last = int(np.argmax(m)), int(len(m) - 1 - np.argmax(m[::-1]))
    pad = int(sr * pad_ms / 1000)
    a = max(0, first * n - pad)
    b = min(len(x), (last + 1) * n + pad)
    return x[a:b]


def to16k(x: np.ndarray, sr: int) -> np.ndarray:
    return _resample(np.asarray(x, dtype=np.float32), sr, 16000)


def speech_seconds(x: np.ndarray, sr: int) -> float:
    """First voiced frame to last voiced frame (the speaking time, without the engine's padding)."""
    m = voiced_mask(x, sr)
    if not m.any():
        return 0.0
    first, last = int(np.argmax(m)), int(len(m) - 1 - np.argmax(m[::-1]))
    return (last + 1 - first) * 0.01


# ---------------------------------------------------------------- degradations of the predictor check (B1)
def band_limit_8k(x16: np.ndarray) -> np.ndarray:
    """A telephone-like copy: 16 kHz audio taken down to 8 kHz sampling (4 kHz bandwidth) and back up, with the same resampler."""
    down = _resample(x16.astype(np.float32), 16000, 8000)
    return _resample(down, 8000, 16000)


def add_noise(x16: np.ndarray, snr_db: float, seed: int = 1) -> np.ndarray:
    """White noise at `snr_db` below the speech level (RMS of the voiced frames)."""
    rng = np.random.default_rng(seed)
    level = speech_level_db(x16, 16000)
    sigma = 10 ** ((level - snr_db) / 20)
    return (x16 + rng.normal(0.0, sigma, len(x16))).astype(np.float32)


# ---------------------------------------------------------------- YIN (de Cheveigne and Kawahara 2002), numpy
def yin_f0(x16: np.ndarray, fmin: float = 70.0, fmax: float = 450.0, hop: int = 160, win: int = 480, thresh: float = 0.15) -> np.ndarray:
    """F0 in Hz per 10 ms frame (NaN where unvoiced) of 16 kHz audio. The frame energy rule of `voiced_mask` also has to hold, so that silence is never given a pitch."""
    sr = 16000
    tmin, tmax = int(sr / fmax), int(sr / fmin)
    L = win + tmax + 2
    x = np.asarray(x16, dtype=np.float64)
    nframes = max(0, (len(x) - L) // hop + 1)
    mask = voiced_mask(x16, sr)
    out = np.full(len(mask), np.nan)
    if nframes == 0:
        return out
    nfft = 1 << int(math.ceil(math.log2(L + win)))
    idx = np.arange(L)[None, :] + hop * np.arange(nframes)[:, None]
    segs = x[idx]                                                     # (nframes, L)
    base = segs[:, :win]
    f_base = np.fft.rfft(base, n=nfft, axis=1)
    f_seg = np.fft.rfft(segs, n=nfft, axis=1)
    cross = np.fft.irfft(np.conj(f_base) * f_seg, n=nfft, axis=1)[:, : tmax + 1]   # r(tau) = sum_j base_j * seg_{j+tau}
    cs = np.concatenate([np.zeros((nframes, 1)), np.cumsum(segs * segs, axis=1)], axis=1)
    e0 = cs[:, win][:, None]
    taus = np.arange(0, tmax + 1)
    e_tau = cs[:, win + taus] - cs[:, taus]                            # energy of seg[tau : tau + win]
    d = e0 + e_tau - 2 * cross
    d[:, 0] = 0
    cm = np.cumsum(d[:, 1:], axis=1)
    cmnd = np.ones_like(d)
    cmnd[:, 1:] = d[:, 1:] * np.arange(1, tmax + 1)[None, :] / np.maximum(cm, 1e-12)
    f0 = np.full(nframes, np.nan)
    for i in range(nframes):
        c = cmnd[i]
        below = np.where(c[tmin: tmax] < thresh)[0]
        if len(below):
            t = tmin + int(below[0])
            while t + 1 < tmax and c[t + 1] < c[t]:
                t += 1
        else:
            t = tmin + int(np.argmin(c[tmin: tmax]))
            if c[t] > 0.35:
                continue
        if 1 <= t < tmax:                                              # parabolic interpolation
            a, b, cc = c[t - 1], c[t], c[t + 1]
            den = a - 2 * b + cc
            if abs(den) > 1e-12:
                t = t + 0.5 * (a - cc) / den
        f0[i] = sr / t
    n = min(nframes, len(out))
    out[:n] = f0[:n]
    out[: len(mask)][~mask[: len(out)]] = np.nan
    # a 5-frame median on voiced runs removes octave blips
    sm = out.copy()
    for i in range(len(out)):
        if np.isnan(out[i]):
            continue
        w = out[max(0, i - 2): i + 3]
        w = w[~np.isnan(w)]
        sm[i] = float(np.median(w))
    return sm


def yin_f0_robust(x16: np.ndarray) -> np.ndarray:
    """Two passes: the wide range first (70 to 450 Hz), then the range around the clip's own median (0.62 to 1.7 times it), which removes the octave errors YIN makes at creaky ends of sentences
    (a first look at the live agent's clips gave 99 Hz for a voice at 200 Hz, a 'reset' of an octave that was not there)."""
    first = yin_f0(x16)
    v = first[~np.isnan(first)]
    if len(v) < 10:
        return first
    m = float(np.median(v))
    return yin_f0(x16, fmin=max(60.0, 0.62 * m), fmax=min(500.0, 1.7 * m))


# ---------------------------------------------------------------- the word error rate's normalizer
_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']


def _num_words(n: int) -> str:
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ('' if n % 10 == 0 else ' ' + _ONES[n % 10])
    if n < 1000:
        return _ONES[n // 100] + ' hundred' + ('' if n % 100 == 0 else ' ' + _num_words(n % 100))
    return str(n)


_COMPOUNDS = {'waitgroup': 'wait group', 'mapreduce': 'map reduce', 'dockerfile': 'docker file', 'goroutines': 'go routines', 'goroutine': 'go routine', 'ok': 'okay'}


def norm_words(text: str) -> list[str]:
    """Lower case, digits to words, hyphens to spaces, punctuation dropped (apostrophes kept), a few compound course terms split the same way on both sides."""
    t = text.lower().replace('-', ' ')
    t = re.sub(r'\d+', lambda m: ' ' + _num_words(int(m.group())) + ' ', t)
    t = re.sub(r"[^a-z' ]+", ' ', t)
    out: list[str] = []
    for w in t.split():
        w = w.strip("'")
        if not w:
            continue
        out.extend(_COMPOUNDS.get(w, w).split())
    return out


def edit_ops(ref: list[str], hyp: list[str]) -> tuple[int, int, int]:
    """(substitutions, deletions, insertions) of one minimal alignment."""
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]))
    i, j, s, dele, ins = n, m, 0, 0, 0
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i][j] == d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]):
            s += ref[i - 1] != hyp[j - 1]
            i, j = i - 1, j - 1
        elif i > 0 and d[i][j] == d[i - 1][j] + 1:
            dele += 1
            i -= 1
        else:
            ins += 1
            j -= 1
    return s, dele, ins


def aligned_index(ref: list[str], hyp: list[str]) -> dict[int, int]:
    """Reference word index -> hypothesis word index, for the words a sequence matcher pairs (equal words only)."""
    sm = difflib.SequenceMatcher(a=ref, b=hyp, autojunk=False)
    out: dict[int, int] = {}
    for tag, a0, a1, b0, _b1 in sm.get_opcodes():
        if tag == 'equal':
            for k in range(a1 - a0):
                out[a0 + k] = b0 + k
    return out


# ---------------------------------------------------------------- statistics
def bootstrap_ci(values: np.ndarray, stat=np.mean, n: int = 10000, seed: int = 1, alpha: float = 0.05) -> tuple[float, float, float]:
    """(statistic, low, high): percentile bootstrap over the units of `values` (the passages)."""
    v = np.asarray(values, dtype=np.float64)
    v = v[~np.isnan(v)]
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(v), size=(n, len(v)))
    boots = np.array([stat(v[i]) for i in idx])
    return float(stat(v)), float(np.percentile(boots, 100 * alpha / 2)), float(np.percentile(boots, 100 * (1 - alpha / 2)))


def auc(pos: np.ndarray, neg: np.ndarray) -> float:
    """P(a clip of `pos` scores above a clip of `neg`), ties counting half."""
    pos, neg = np.asarray(pos, dtype=float), np.asarray(neg, dtype=float)
    if len(pos) == 0 or len(neg) == 0:
        return float('nan')
    gt = (pos[:, None] > neg[None, :]).sum()
    eq = (pos[:, None] == neg[None, :]).sum()
    return float((gt + 0.5 * eq) / (len(pos) * len(neg)))
