#!/usr/bin/env python3
"""Accuracy of the service's own pipeline on a recognition set, offline: the clips go through the SEGMENTER (pre-roll, pauses, segments, the utterance end), each segment is decoded by Parakeet, the texts
are joined and the key-term layer is applied: exactly what the service sends as the final of an utterance, without the websocket and without waiting for real time. The numbers are those of
eval/voice-local/asr_bench.py's scorer, so they can be put next to stage 1 of docs/VOICE_SELFBUILT.md A13, which decoded each clip whole (`--whole-clip` reproduces that here).

    python eval_set.py --set ../../../eval/voice-lab/recognition2.json --audio <dir with manifest.json> [--out results.jsonl] [--whole-clip] [--max-segment-ms N] [--interim-ms N] [--seg-pause-ms N]

It needs the repository (it imports the scorer from eval/voice-local); it is a development tool and is not part of the Docker image. Run it on a set only when the set is meant to be heard: a set that is
reserved for a measurement made later must not be run through here first.
"""
import argparse
import json
import os
import statistics
import sys
import time
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', '..', '..', 'eval', 'voice-local'))

from asr_bench import score  # noqa: E402  (the scorer stage 1 used)
from localvoice.asr import ParakeetRecognizer  # noqa: E402
from localvoice.keyterms import layer_for, load_keyterms  # noqa: E402
from localvoice.segmenter import Segment, Segmenter, SegmenterConfig  # noqa: E402
from localvoice.vad import EnergyVad  # noqa: E402


def read_pcm(path):
    with wave.open(path) as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, 16000):
            sys.exit('%s: want 16 kHz mono 16-bit' % path)
        return w.readframes(w.getnframes())


def service_text(rec, pcm, cfg):
    """What the service would send as the final of this clip, before the layer: the segments' texts joined."""
    seg = Segmenter(EnergyVad(), cfg)
    audio = pcm + bytes(int(1.6 * 16000) * 2)           # a pause after the clip, as a call has
    events = []
    for i in range(0, len(audio), 640):
        events += seg.feed(audio[i:i + 640])
    texts = [rec.decode(e.samples).text for e in events if isinstance(e, Segment)]
    return ' '.join(t for t in texts if t), sum(1 for e in events if isinstance(e, Segment)), seg.stats.cuts


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--set', required=True)
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', help='write the raw transcripts here (and <out>.layer.jsonl with the layer applied), in the format of asr_bench.py')
    ap.add_argument('--model-dir', default=os.environ.get('LOCAL_VOICE_ASR_MODEL_DIR', r'D:\tai-voice-local\models\parakeet-tdt-0.6b-v2-int8'))
    ap.add_argument('--threads', type=int, default=4)
    ap.add_argument('--whole-clip', action='store_true', help='decode each clip whole, as stage 1 did (no segmentation)')
    ap.add_argument('--seg-pause-ms', type=int, default=350)
    ap.add_argument('--end-pause-ms', type=int, default=600)
    ap.add_argument('--max-segment-ms', type=int, default=0)
    ap.add_argument('--interim-ms', type=int, default=3000)
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    with open(args.set, encoding='utf-8-sig') as f:
        rset = json.load(f)
    with open(os.path.join(args.audio, 'manifest.json'), encoding='utf-8-sig') as f:
        manifest = json.load(f)
    layer = layer_for(tuple(load_keyterms(os.path.join(HERE, 'keyterms.json'))))
    cfg = SegmenterConfig(seg_pause_ms=args.seg_pause_ms, end_pause_ms=args.end_pause_ms, max_segment_ms=args.max_segment_ms, interim_ms=args.interim_ms)
    cfg.validate()
    rec = ParakeetRecognizer(args.model_dir, args.threads)
    rec.warm_up()
    label = 'whole-clip' if args.whole_clip else 'service(seg=%d,end=%d,cut=%d)' % (args.seg_pause_ms, args.end_pause_ms, args.max_segment_ms)

    plan = [(s, v) for s in rset['recognition'] for v in rset['voices']]
    if args.limit:
        plan = plan[:args.limit]
    raw, layered, segments, cuts, took = [], [], [], 0, []
    for n, (s, voice) in enumerate(plan, 1):
        key = voice + '|' + s['text']
        if key not in manifest:
            sys.exit('no clip in the manifest for ' + key)
        pcm = read_pcm(os.path.join(args.audio, manifest[key]))
        t0 = time.perf_counter()
        if args.whole_clip:
            text, n_seg, n_cut = rec.decode(np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0).text, 1, 0
        else:
            text, n_seg, n_cut = service_text(rec, pcm, cfg)
        took.append((time.perf_counter() - t0) / (len(pcm) / 32000.0))
        segments.append(n_seg)
        cuts += n_cut
        base = {'id': s['id'], 'voice': voice, 'ears': label, 'finals': [], 'firstPartialMs': None, 'lastFinalMs': 0, 'timedOut': False, 'attempts': 1}
        raw.append({**base, 'text': text, 'finals': [text] if text else []})
        shaped = layer.apply(text)
        layered.append({**base, 'ears': label + '+layer', 'text': shaped, 'finals': [shaped] if shaped else []})
        if n % 32 == 0:
            print('  %d / %d' % (n, len(plan)), flush=True)

    if args.out:
        for path, records in ((args.out, raw), (args.out + '.layer.jsonl', layered)):
            with open(path, 'x', encoding='utf-8') as f:
                f.writelines(json.dumps(r) + '\n' for r in records)
    print('configuration: %s; set %s; %d utterances' % (label, os.path.basename(args.set), len(plan)))
    print('segments per clip: mean %.2f, max %d, clips with a soft cut %d; decode time over audio time %.3f' % (statistics.mean(segments), max(segments), cuts, statistics.mean(took)))
    for name, records in (('raw', raw), ('+layer', layered)):
        sc = score(rset['recognition'], records)
        print('%-8s WER %.2f %%   key terms %d/%d = %.1f %%' % (name, sc['wer'], sc['terms_hit'], sc['terms_total'], sc['recall']))


if __name__ == '__main__':
    main()
