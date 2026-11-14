#!/usr/bin/env python3
"""Supertonic (the engine behind LabGPU's mouth; docs/VOICE_SELFBUILT.md 10.13) run locally with the `supertonic` package (1.0.0, English model `Supertone/supertonic`).

  st_bench.py --model-dir DIR --samples DIR --reference-dir DIR [--threads 4] [--steps 5] [--speed 1.05] [--no-speed-test]

1. Makes the two listening sentences of tts_bench.py with every voice style (F1-F5, M1-M5) at 24 kHz (the rate the lab expects) and writes them as WAV files named supertonic-<style>-s3 / -s6.
2. Compares each with LabGPU's own rendering of the same sentence (labgpu-af_bella-natural-s3 / -s6 in the reference folder) by the average spectrum (30 bands) and the median pitch, and prints the
   styles from the nearest to the farthest. This is a help for finding which style LabGPU's adapter uses; the owner's ears decide.
3. Times the twelve sentences of tts_bench.py with one voice (time to the whole sentence, which is the first audio when the engine asks sentence by sentence; real-time factor).
"""
import argparse
import os
import statistics
import sys
import time
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tts_bench import SAMPLE_SENTENCES, SENTENCES  # noqa: E402  (the lists only; importing sherpa_onnx is not needed here)

OUT_RATE = 24000


def resample(x, rate_in, rate_out=OUT_RATE):
    """Windowed-sinc low-pass at 0.45 of the lower rate, then linear interpolation to the new rate. x is float32 mono."""
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


def write_wav(path, x, rate):
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def read_wav(path):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0, w.getframerate()


def band_spectrum(x, rate, bands=30):
    """Mean log power in `bands` equal-width bands on a mel-like scale over the voiced (loud) frames."""
    frame = int(0.032 * rate)
    hop = frame // 2
    win = np.hanning(frame)
    frames = [x[i:i + frame] * win for i in range(0, len(x) - frame, hop)]
    energy = np.array([float(np.sum(f * f)) for f in frames])
    keep = [f for f, e in zip(frames, energy) if e > 0.1 * energy.max()]
    spec = np.mean([np.abs(np.fft.rfft(f)) ** 2 for f in keep], axis=0)
    freqs = np.fft.rfftfreq(frame, 1.0 / rate)
    mel = 2595 * np.log10(1 + freqs / 700)
    edges = np.linspace(0, mel[-1], bands + 1)
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        sel = (mel >= a) & (mel < b)
        out.append(np.log10(spec[sel].mean() + 1e-12) if sel.any() else -12.0)
    out = np.array(out)
    return out - out.mean()


def median_pitch(x, rate):
    """Median fundamental frequency of the voiced frames by autocorrelation (60-400 Hz)."""
    frame = int(0.04 * rate)
    hop = int(0.01 * rate)
    lo, hi = int(rate / 400), int(rate / 60)
    pitches = []
    energy_max = max(float(np.sum(x[i:i + frame] ** 2)) for i in range(0, len(x) - frame, hop))
    for i in range(0, len(x) - frame, hop):
        f = x[i:i + frame]
        if float(np.sum(f * f)) < 0.2 * energy_max:
            continue
        f = f - f.mean()
        ac = np.correlate(f, f, mode='full')[len(f) - 1:]
        if ac[0] <= 0:
            continue
        lag = lo + int(np.argmax(ac[lo:hi]))
        if ac[lag] > 0.4 * ac[0]:
            pitches.append(rate / lag)
    return statistics.median(pitches) if pitches else float('nan')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model-dir', default=r'D:\tai-voice-local\supertonic\v1')
    ap.add_argument('--samples', default=r'D:\tai-voice-local\samples')
    ap.add_argument('--reference-dir', default=r'D:\tai-voice-local\samples')
    ap.add_argument('--threads', type=int, default=4)
    ap.add_argument('--steps', type=int, default=5)
    ap.add_argument('--speed', type=float, default=1.05)
    ap.add_argument('--no-speed-test', action='store_true')
    ap.add_argument('--voice', default='', help='only time this style (F1 ...): no comparison, no samples')
    args = ap.parse_args()
    from supertonic import TTS

    tts = TTS(model_dir=args.model_dir, auto_download=False, intra_op_num_threads=args.threads)
    print('sample rate', tts.sample_rate, 'styles', tts.voice_style_names)
    refs = {}
    for k in SAMPLE_SENTENCES:
        p = os.path.join(args.reference_dir, 'labgpu-af_bella-natural-s%d.wav' % (k + 1))
        if os.path.exists(p):
            x, r = read_wav(p)
            refs[k] = (x, r)
    rows = []
    for name in ([] if args.voice else tts.voice_style_names):
        os.makedirs(args.samples, exist_ok=True)
        style = tts.get_voice_style(name)
        dist, pitch, dur = [], [], []
        for k in SAMPLE_SENTENCES:
            t0 = time.perf_counter()
            wav, d = tts.synthesize(SENTENCES[k], voice_style=style, total_steps=args.steps, speed=args.speed)
            ms = (time.perf_counter() - t0) * 1000
            x = resample(np.asarray(wav[0], dtype=np.float32), tts.sample_rate)
            write_wav(os.path.join(args.samples, 'supertonic-%s-steps%d-s%d.wav' % (name, args.steps, k + 1)), x, OUT_RATE)
            dur.append(len(x) / OUT_RATE)
            pitch.append(median_pitch(x, OUT_RATE))
            if k in refs:
                rx, rr = refs[k]
                dist.append(float(np.linalg.norm(band_spectrum(x, OUT_RATE) - band_spectrum(rx, rr))))
        rows.append((name, statistics.mean(dist) if dist else float('nan'), statistics.mean(pitch), statistics.mean(dur)))
    ref_pitch = statistics.mean(median_pitch(x, r) for x, r in refs.values()) if refs and rows else float('nan')
    ref_dur = statistics.mean(len(x) / r for x, r in refs.values()) if refs and rows else float('nan')
    if rows:
        print("LabGPU's reference: median pitch %.0f Hz, mean duration of the two sentences %.2f s" % (ref_pitch, ref_dur))
        print('style   spectral distance to LabGPU (lower = nearer)   median pitch   mean duration (steps %d, speed %.2f)' % (args.steps, args.speed))
        for name, d, p, du in sorted(rows, key=lambda r: r[1]):
            print('%-6s  %8.2f                                     %6.0f Hz     %.2f s' % (name, d, p, du))

    if not args.no_speed_test:
        style = tts.get_voice_style(args.voice or (sorted(rows, key=lambda r: r[1])[0][0] if rows else 'F1'))
        tts.synthesize('Warm up.', voice_style=style, total_steps=args.steps, speed=args.speed)
        ms, rtf = [], []
        for text in SENTENCES:
            t0 = time.perf_counter()
            wav, d = tts.synthesize(text, voice_style=style, total_steps=args.steps, speed=args.speed)
            took = (time.perf_counter() - t0) * 1000
            ms.append(took)
            rtf.append(took / 1000.0 / float(d[0]))
        ms.sort()
        print('speed (%d threads, steps %d): whole sentence p50 %d ms, p90 %d ms, max %d ms; real-time factor p50 %.3f, p90 %.3f' % (
            args.threads, args.steps, statistics.median(ms), ms[int(0.9 * (len(ms) - 1))], ms[-1], statistics.median(rtf), sorted(rtf)[int(0.9 * (len(rtf) - 1))]))


if __name__ == '__main__':
    main()
