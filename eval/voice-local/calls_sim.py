#!/usr/bin/env python3
"""Stage 2 (the host), the realistic part of the load question of docs/VOICE_SELFBUILT.md A13 (added after the saturating test of host-speedtest.sh, and labelled so in the results): N simulated
calls at once, each as a call goes. One call = a student speaks (a clip of set 2, in real time), the recognizer decodes it, the mouth makes three agent sentences one after the other, the agent
"speaks" them (in real time), a short pause, again. Each call is its own process with its own models (as three calls would each have a decoder and a voice). Prints the decode time after the end of the
student's speech (p50, p90, max), the time to the first agent sentence, and the average number of busy cores of the host over the whole run, from /proc/stat (the live service's own use is in it).

  calls_sim.py --calls 3 --seconds 180 --asr-threads 2 --tts-threads 2 --models DIR --tts-models DIR --set recognition2.json --audio DIR [--tts piper]
"""
import argparse
import json
import multiprocessing as mp
import os
import random
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asr_bench  # noqa: E402
import tts_bench  # noqa: E402


def call(idx, args, ready, go, out):
    rng = random.Random(1000 + idx)
    rset = json.load(open(args.set, encoding='utf-8-sig'))
    manifest = json.load(open(os.path.join(args.audio, 'manifest.json'), encoding='utf-8-sig'))
    clips = [os.path.join(args.audio, manifest[v + '|' + s['text']]) for s in rset['recognition'] for v in rset['voices'] if (v + '|' + s['text']) in manifest]
    rec = asr_bench.build_parakeet(args.models, args.asr_threads)
    tts = tts_bench.build(args.tts, args.tts_models, args.tts_threads)
    asr_bench.run_parakeet(rec, asr_bench.read_wav(clips[0]))      # warm both up before the clock starts
    tts_bench.synth(tts, 'Warm up.', 0)
    ready.put(idx)
    go.wait()
    deadline = time.time() + args.seconds
    time.sleep(rng.uniform(0, 8))                                  # the calls do not start in step
    while time.time() < deadline:
        samples = asr_bench.read_wav(rng.choice(clips))
        time.sleep(len(samples) / asr_bench.SR)                    # the student speaks
        _, _, asr_ms = asr_bench.run_parakeet(rec, samples)
        out.put(('asr', idx, asr_ms))
        spoken = 0.0
        first = None
        for text in rng.sample(tts_bench.SENTENCES, 3):
            t0 = time.perf_counter()
            audio, rate, ms = tts_bench.synth(tts, text, 0)
            if first is None:
                first = ms
            spoken += len(audio) / rate
        out.put(('tts', idx, first))
        time.sleep(spoken + rng.uniform(1.0, 3.0))                 # the agent speaks, then a pause


def busy():
    with open('/proc/stat') as f:
        parts = [int(x) for x in f.readline().split()[1:]]
    return parts[3] + parts[4], sum(parts)


def pct(xs, p):
    xs = sorted(xs)
    return xs[int(round(p * (len(xs) - 1)))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--calls', type=int, default=3)
    ap.add_argument('--seconds', type=int, default=180)
    ap.add_argument('--asr-threads', type=int, default=2)
    ap.add_argument('--tts-threads', type=int, default=2)
    ap.add_argument('--tts', default='piper', choices=['piper', 'kokoro'])
    ap.add_argument('--models', required=True)
    ap.add_argument('--tts-models', required=True)
    ap.add_argument('--set', required=True)
    ap.add_argument('--audio', required=True)
    args = ap.parse_args()
    ready, go, out = mp.Queue(), mp.Event(), mp.Queue()
    procs = [mp.Process(target=call, args=(i, args, ready, go, out)) for i in range(args.calls)]
    [p.start() for p in procs]
    [ready.get() for _ in procs]
    i0, t0 = busy()
    s0 = time.time()
    go.set()
    [p.join() for p in procs]
    secs = time.time() - s0
    i1, t1 = busy()
    cores = ((t1 - t0) - (i1 - i0)) / 100.0 / secs
    rows = []
    while not out.empty():
        rows.append(out.get())
    asr = [r[2] for r in rows if r[0] == 'asr']
    tts = [r[2] for r in rows if r[0] == 'tts']
    print('%d simulated calls, %d s, recognizer %d threads and %s %d threads each: %d student turns' % (args.calls, args.seconds, args.asr_threads, args.tts, args.tts_threads, len(asr)))
    print('  decode after the end of the student\'s speech: p50 %d ms, p90 %d ms, max %d ms' % (statistics.median(asr), pct(asr, 0.9), max(asr)))
    print('  first agent sentence: p50 %d ms, p90 %d ms, max %d ms' % (statistics.median(tts), pct(tts, 0.9), max(tts)))
    print('  host busy cores on average over the run: %.2f of %d' % (cores, os.cpu_count() or 0))


if __name__ == '__main__':
    main()
