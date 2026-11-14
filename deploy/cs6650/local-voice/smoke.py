#!/usr/bin/env python3
"""Smoke test of the whole service with the real models: starts server.py (or uses one already running), streams clips in REAL TIME through /v1/listen, calls /tts, and prints times.

    python smoke.py                          # start a server on a free port, 4 clips one after another, then /tts
    python smoke.py --concurrent 3           # the clips three at a time (what three calls at once look like)
    python smoke.py --url http://127.0.0.1:18800   # use a server that is already running (and do not stop it)

Nothing a person said, or that the service made of it, is printed: only the kind of each message, how many words it had, and when it arrived. The clips are 16 kHz mono 16-bit WAVs (the clips of
the second recognition set when LOCAL_VOICE_TEST_AUDIO is set or its default is found, or `--clip FILE`); without any, a clip is made by the service's own /tts and brought down to 16 kHz.

What it measures, against the lab engine's rules (src/voice/lab/turn.ts): the engine takes the first text that arrives 350 ms or more after the END OF SPEECH as covering the speech, so that is the
number that decides the wait in a conversation ("covering partial"); the final (`speech_final`) comes after the end-of-utterance pause of 600 ms and any decode still running.
"""
import argparse
import asyncio
import json
import os
import socket
import statistics
import subprocess
import sys
import threading
import time
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from tests.helpers import raw_request  # noqa: E402
from localvoice.tts import resample  # noqa: E402

FRAME = 640
DEV_DEFAULTS = {
    'LOCAL_VOICE_ASR_MODEL_DIR': r'D:\tai-voice-local\models\parakeet-tdt-0.6b-v2-int8',
    'LOCAL_VOICE_ST_MODEL_DIR': r'D:\tai-voice-local\supertonic\v1',
    'LOCAL_VOICE_PIPER_MODEL_DIR': r'D:\tai-voice-local\tts\vits-piper-en_US-lessac-medium',
}
AUDIO_DIR = os.environ.get('LOCAL_VOICE_TEST_AUDIO', r'D:\tai-voice-local\audio-r2')
SET_FILE = os.environ.get('LOCAL_VOICE_TEST_SET', os.path.join(HERE, '..', '..', '..', 'eval', 'voice-lab', 'recognition2.json'))
SENTENCES = [
    "Sure, let's start with what you already know about leader election.",
    "That's close, but think about what happens when two candidates start an election at the same time.",
    "Good question, and it's the payoff of the whole design.",
    "One sec, let me pull that up.",
    "In Raft, the leader sends heartbeats to the followers, and if a follower stops hearing them, it starts a new election after a random timeout.",
    "Walk me through what your goroutine does when the channel is full.",
]


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def rss_mb(pid):
    """Resident memory of a process in MB, or None when this platform's way of asking is not known."""
    try:
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes

            class Counters(ctypes.Structure):
                _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD), ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t),
                            ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t), ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                            ('QuotaNonPagedPoolUsage', ctypes.c_size_t), ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]
            k32 = ctypes.WinDLL('kernel32', use_last_error=True)
            k32.OpenProcess.restype = wintypes.HANDLE
            handle = k32.OpenProcess(0x1000, False, pid)
            counters = Counters()
            counters.cb = ctypes.sizeof(counters)
            ctypes.WinDLL('psapi').GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
            k32.CloseHandle(handle)
            return counters.WorkingSetSize / 1e6
        with open('/proc/%d/status' % pid) as f:
            for line in f:
                if line.startswith('VmRSS:'):
                    return int(line.split()[1]) / 1e3
    except Exception:
        return None
    return None


def start_server():
    port = free_port()
    env = dict(os.environ, LOCAL_VOICE_PORT=str(port), LOCAL_VOICE_HOST='127.0.0.1', PYTHONDONTWRITEBYTECODE='1')
    for key, value in DEV_DEFAULTS.items():
        if key not in env and os.path.exists(value):
            env[key] = value
    t0 = time.perf_counter()
    proc = subprocess.Popen([sys.executable, '-B', os.path.join(HERE, 'server.py')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []
    threading.Thread(target=lambda: [lines.append(l) for l in proc.stdout], daemon=True).start()
    deadline = time.time() + 240
    while time.time() < deadline:
        if proc.poll() is not None:
            sys.exit('the server stopped while starting:\n' + ''.join(lines[-15:]))
        try:
            if raw_request(port, 'GET', '/health', timeout=2).status == 200:
                break
        except OSError:
            pass
        time.sleep(0.3)
    else:
        proc.kill()
        sys.exit('the server did not come up in 240 s')
    print('server up on port %d after %.1f s (models loaded and warmed first, the port opened after)' % (port, time.perf_counter() - t0))
    pid = None
    for line in lines:
        if ' listening on ' in line and '(pid ' in line:
            pid = int(line.split('(pid ')[1].split(',')[0])          # on Windows the process we started is the venv's launcher: the server is its child
    return proc, port, pid, lines


def read_wav(path):
    with wave.open(path) as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, 16000):
            sys.exit('%s: want 16 kHz mono 16-bit' % path)
        return w.readframes(w.getnframes())


def make_clips(port, args):
    if args.clip:
        return [read_wav(args.clip)]
    if os.path.isfile(os.path.join(AUDIO_DIR, 'manifest.json')) and os.path.isfile(SET_FILE):
        with open(os.path.join(AUDIO_DIR, 'manifest.json'), encoding='utf-8-sig') as f:
            manifest = json.load(f)
        with open(SET_FILE, encoding='utf-8-sig') as f:
            data = json.load(f)
        out = []
        for sentence in data['recognition']:
            for voice in data['voices']:
                key = '%s|%s' % (voice, sentence['text'])
                if key in manifest:
                    out.append(read_wav(os.path.join(AUDIO_DIR, manifest[key])))
            if len(out) >= max(args.clips, args.concurrent):
                break
        return out[:max(args.clips, args.concurrent)]
    print('(no clips found: making them with the service\'s own /tts)')
    out = []
    for text in SENTENCES[:max(args.clips, args.concurrent)]:
        resp = raw_request(port, 'POST', '/tts', json.dumps({'text': text, 'voice': 'F1'}).encode(), {'Content-Type': 'application/json'})
        x = np.frombuffer(resp.body, dtype='<i2').astype(np.float32) / 32768.0
        out.append((np.clip(resample(x, 24000, 16000), -1, 1) * 32767).astype('<i2').tobytes())
    return out


def end_of_speech_s(pcm):
    x = np.frombuffer(pcm[:len(pcm) // (FRAME) * FRAME], dtype='<i2').astype(np.float32).reshape(-1, FRAME // 2)
    levels = np.sqrt((x ** 2).mean(axis=1))
    loud = np.nonzero(levels >= 350)[0]
    return (int(loud[-1]) + 1) * 0.02 if len(loud) else 0.0


async def stream_clip(port, pcm, label):
    from websockets.asyncio.client import connect
    eos = end_of_speech_s(pcm)
    audio = pcm + bytes(int(1.6 * 16000) * 2)
    events = []
    async with connect('ws://127.0.0.1:%d/v1/listen?encoding=linear16&sample_rate=16000&language=en&label=smoke' % port, compression=None, ping_interval=None, max_size=2 ** 20) as ws:
        t0 = time.perf_counter()

        async def send():
            for k in range(0, len(audio), FRAME):
                await asyncio.sleep(max(0.0, t0 + (k // FRAME) * 0.02 - time.perf_counter()))
                await ws.send(audio[k:k + FRAME])

        async def receive():
            try:
                while True:
                    msg = json.loads(await ws.recv())
                    now = time.perf_counter() - t0
                    if msg.get('type') == 'Results':
                        text = msg['channel']['alternatives'][0]['transcript']
                        kind = 'final' if msg['speech_final'] else 'partial'
                        events.append((now, kind, len(text.split())))
                    else:
                        events.append((now, msg.get('type'), 0))
            except Exception:
                return

        sender = asyncio.ensure_future(send())
        receiver = asyncio.ensure_future(receive())
        await sender
        await asyncio.sleep(0.5)
        await ws.close()
        await receiver
    return eos, len(pcm) / 32000.0, events


def report_clips(results):
    covering, finals, firsts = [], [], []
    for n, (eos, dur, events) in enumerate(results, 1):
        print('clip %d: %.1f s of audio, the speech ends at %.2f s' % (n, dur, eos))
        print('    t (s)   after the end of speech   message')
        for t, kind, words in events:
            print('    %5.2f   %+6.2f                    %s%s' % (t, t - eos, kind, ' (%d words)' % words if words else ''))
        partials = [(t, w) for t, k, w in events if k == 'partial']
        if partials:
            firsts.append(partials[0][0])
        cover = [t - eos for t, k, w in events if k in ('partial', 'final') and t - eos >= 0.35]
        final = [t - eos for t, k, w in events if k == 'final']
        if cover:
            covering.append(cover[0])
        if final:
            finals.append(final[0])
    def stat(name, xs):
        if xs:
            xs = sorted(xs)
            p90 = '  p90 %.2f' % xs[min(len(xs) - 1, int(0.9 * len(xs)))] if len(xs) >= 5 else ''      # nearest rank; only with enough clips to mean something
            print('%-52s n=%d  min %.2f  median %.2f%s  max %.2f s' % (name, len(xs), xs[0], statistics.median(xs), p90, xs[-1]))
    stat('first partial, after the start of the audio', firsts)
    stat('covering partial (the first text 350 ms+ after the end of speech), after the end of speech', covering)
    stat('final (speech_final), after the end of speech', finals)


def tts_times(port, parallel):
    rows = []
    print('/tts, one request at a time (the text is a fixed generic sentence; only its length is shown)')
    print('    chars   first byte (ms)   total (ms)   audio (s)   chunks')
    for text in SENTENCES:
        r = raw_request(port, 'POST', '/tts', json.dumps({'text': text, 'voice': 'af_bella'}).encode(), {'Content-Type': 'application/json'})
        assert r.status == 200 and 'x-tts-fallback' not in r.headers, r.status
        audio = len(r.body) / 48000.0
        rows.append((r.t_first_byte * 1000, r.t_total * 1000))
        print('    %5d   %15.0f   %10.0f   %9.2f   %6d' % (len(text), r.t_first_byte * 1000, r.t_total * 1000, audio, len(r.chunks)))
    fb = sorted(r[0] for r in rows)
    print('    first byte: median %.0f ms, max %.0f ms (the model makes the whole sentence at once, so the first byte is the end of the synthesis)' % (statistics.median(fb), fb[-1]))
    out = []

    def go(text):
        r = raw_request(port, 'POST', '/tts', json.dumps({'text': text, 'voice': 'af_bella'}).encode(), {'Content-Type': 'application/json'})
        out.append((r.status, r.t_first_byte * 1000, r.t_total * 1000))

    threads = [threading.Thread(target=go, args=(SENTENCES[k % len(SENTENCES)],)) for k in range(parallel)]
    t0 = time.perf_counter()
    [t.start() for t in threads]
    [t.join(60) for t in threads]
    print('/tts, %d requests at once: statuses %s, first byte %s ms, total %.0f ms for all' % (parallel, sorted(set(s for s, _, _ in out)), ', '.join('%.0f' % f for _, f, _ in sorted(out, key=lambda r: r[1])),
                                                                                              (time.perf_counter() - t0) * 1000))


async def run_clips(port, clips, concurrent):
    results = []
    i = 0
    while i < len(clips):
        batch = clips[i:i + concurrent]
        results += await asyncio.gather(*[stream_clip(port, pcm, '%d' % (i + k)) for k, pcm in enumerate(batch)])
        i += concurrent
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', help='http://host:port of a running service (default: start one)')
    ap.add_argument('--clip', help='a 16 kHz mono 16-bit WAV to stream')
    ap.add_argument('--clips', type=int, default=4, help='how many clips to stream (default 4)')
    ap.add_argument('--concurrent', type=int, default=1, help='how many at a time (default 1)')
    ap.add_argument('--tts-parallel', type=int, default=3)
    args = ap.parse_args()
    proc = None
    server_log = []
    if args.url:
        port = int(args.url.rsplit(':', 1)[1].strip('/'))
        pid = None
    else:
        proc, port, pid, server_log = start_server()
    try:
        health = json.loads(raw_request(port, 'GET', '/health').body)
        print('health:', health)
        clips = make_clips(port, args)
        print('streaming %d clip(s) in real time, %d at a time' % (len(clips), args.concurrent))
        report_clips(asyncio.run(run_clips(port, clips, args.concurrent)))
        tts_times(port, args.tts_parallel)
        time.sleep(0.5)
        for line in server_log:
            if 'closed after' in line:
                print('server log:', line.split(' INFO ', 1)[-1].strip())      # counts and times only: that is all the service ever logs
        if pid and rss_mb(pid):
            print('server memory: %.0f MB resident (both models, three speech engines, after the run)' % rss_mb(pid))
    finally:
        if proc is not None:
            if os.name == 'nt':
                subprocess.run(['taskkill', '/T', '/F', '/PID', str(proc.pid)], capture_output=True)    # the launcher and the server under it
            else:
                proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == '__main__':
    main()
