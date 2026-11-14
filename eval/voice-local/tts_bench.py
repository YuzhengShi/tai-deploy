#!/usr/bin/env python3
"""Stage 1 (this PC) and stage 2 (the host) of docs/VOICE_SELFBUILT.md A13 for the mouth: Piper and Kokoro through sherpa-onnx, sentence by sentence as the engine would ask for them.

  tts_bench.py --models DIR --samples DIR [--threads 1,2,4] [--parallel N] [--no-samples]

For every engine and thread count it warms the model up, then synthesizes the twelve fixed agent-style sentences below one after the other and prints, per engine: the time to the first audio of a
sentence (with one sentence per call that is the whole synthesis: the engine sends sentences one at a time), the real-time factor (synthesis time over audio time) and p50/p90. `--parallel N` runs N
such streams at once in threads (stage 2 uses 3). Unless --no-samples, it writes listening samples (two sentences, each engine and voice, speed 1.0 and 1.2) to the samples folder.
The sentences are generic tutoring lines; nothing in them is a student's.
"""
import argparse
import os
import statistics
import threading
import time
import wave

import numpy as np

try:
    import sherpa_onnx
except ImportError:      # st_bench.py imports only the sentence lists from this file
    sherpa_onnx = None

SENTENCES = [
    "Sure, let's start with what you already know about leader election.",
    "That's close, but think about what happens when two candidates start an election at the same time.",
    "Good question, and it's the payoff of the whole design.",
    "One sec, let me pull that up.",
    "In Raft, the leader sends heartbeats to the followers, and if a follower stops hearing them, it starts a new election after a random timeout.",
    "Walk me through what your goroutine does when the channel is full.",
    "Right, so a mutex protects the shared counter, but why does the race detector still complain?",
    "Let me ask you a different way: what does the WaitGroup actually count?",
    "Nice work. Next, tell me how consistent hashing changes when you add a node.",
    "I might be wrong here, so check the lecture slides for the exact wording.",
    "Okay. Take your time.",
    "That's a common mix-up between Paxos and Raft, so let's separate the two ideas.",
]
SAMPLE_SENTENCES = [2, 5]          # indexes into SENTENCES for the listening samples


def build(kind, models, threads):
    if kind == 'piper':
        d = os.path.join(models, 'vits-piper-en_US-lessac-medium')
        vits = sherpa_onnx.OfflineTtsVitsModelConfig(model=os.path.join(d, 'en_US-lessac-medium.onnx'), tokens=os.path.join(d, 'tokens.txt'), data_dir=os.path.join(d, 'espeak-ng-data'))
        model = sherpa_onnx.OfflineTtsModelConfig(vits=vits, num_threads=threads, provider='cpu')
    else:
        d = os.path.join(models, 'kokoro-int8-multi-lang-v1_1')
        kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=os.path.join(d, 'model.int8.onnx'), voices=os.path.join(d, 'voices.bin'), tokens=os.path.join(d, 'tokens.txt'), data_dir=os.path.join(d, 'espeak-ng-data'),
            dict_dir=os.path.join(d, 'dict'), lexicon=os.path.join(d, 'lexicon-us-en.txt') + ',' + os.path.join(d, 'lexicon-zh.txt'))
        model = sherpa_onnx.OfflineTtsModelConfig(kokoro=kokoro, num_threads=threads, provider='cpu')
    config = sherpa_onnx.OfflineTtsConfig(model=model, max_num_sentences=1)
    if not config.validate():
        raise SystemExit('invalid TTS config for ' + kind)
    return sherpa_onnx.OfflineTts(config)


def synth(tts, text, sid=0, speed=1.0):
    t0 = time.perf_counter()
    audio = tts.generate(text, sid=sid, speed=speed)
    ms = (time.perf_counter() - t0) * 1000.0
    return np.asarray(audio.samples, dtype=np.float32), audio.sample_rate, ms


def write_wav(path, samples, rate):
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def pct(xs, p):
    xs = sorted(xs)
    return xs[int(round(p * (len(xs) - 1)))]


def stream_run(tts, sid, out):
    for text in SENTENCES:
        samples, rate, ms = synth(tts, text, sid)
        out.append((ms, len(samples) / rate * 1000.0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--models', default=r'D:\tai-voice-local\tts')
    ap.add_argument('--samples', default=r'D:\tai-voice-local\samples')
    ap.add_argument('--threads', default='1,2,4')
    ap.add_argument('--parallel', type=int, default=1)
    ap.add_argument('--no-samples', action='store_true')
    args = ap.parse_args()
    os.makedirs(args.samples, exist_ok=True)
    for kind in ('piper', 'kokoro'):
        for threads in [int(t) for t in args.threads.split(',')]:
            tts = build(kind, args.models, threads)
            synth(tts, 'Warm up.', 0)                                   # the first call loads kernels
            results = []

            def worker(i):
                local = []
                stream_run(tts if args.parallel == 1 else build(kind, args.models, threads), 0, local)
                results.append(local)
            t0 = time.perf_counter()
            ts = [threading.Thread(target=worker, args=(i,)) for i in range(args.parallel)]
            [t.start() for t in ts]
            [t.join() for t in ts]
            wall = time.perf_counter() - t0
            first = [ms for r in results for ms, _ in r]
            rtf = [ms / dur for r in results for ms, dur in r]
            print('%-7s threads %d streams %d: first audio of a sentence p50 %d ms p90 %d ms max %d ms; RTF p50 %.3f p90 %.3f; %d sentences in %.1f s of wall time' % (
                kind, threads, args.parallel, statistics.median(first), pct(first, 0.9), max(first), statistics.median(rtf), pct(rtf, 0.9), len(first), wall), flush=True)
        if not args.no_samples:
            tts = build(kind, args.models, 4)
            voices = [('lessac', 0)] if kind == 'piper' else [('af_maple', 0), ('af_sol', 1), ('bf_vale', 2)]
            for name, sid in voices:
                for speed in (1.0, 1.2):
                    for k in SAMPLE_SENTENCES:
                        samples, rate, _ = synth(tts, SENTENCES[k], sid, speed)
                        write_wav(os.path.join(args.samples, '%s-%s-speed%.1f-s%d.wav' % (kind, name, speed, k + 1)), samples, rate)
            print('samples for %s written to %s' % (kind, args.samples))


if __name__ == '__main__':
    main()
