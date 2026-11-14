#!/usr/bin/env python3
"""Stage 1 of docs/VOICE_SELFBUILT.md A13: a local recognizer over a recognition set, written as a results file in the format of src/voice/lab/measure/recognize.ts (one JSON line per
utterance), so that `recognize.js compare` scores it exactly like C6b's LabGPU, Flux and nova-3. Only accuracy is read from the PC: the times written are this PC's decode times.

  asr_bench.py --model zipformer|parakeet --set <recognition.json> --audio <dir with manifest.json> --out <results.jsonl>
               [--hotwords-score S]   zipformer only: hotwords = the spoken forms of the live key terms (spoken_forms.py) at this score; omitted: no hotwords
               [--layer]              also write <out>.layer.jsonl, the same transcripts with the spoken forms of the key terms written back as the terms (spoken_forms.py)
               [--models DIR] [--threads N] [--limit N]

Audio: 16 kHz mono 16-bit WAVs named by the manifest ("voice|text" -> file). The whole clip is fed (its own silence included), then 0.66 s of silence for the streaming model.
"""
import argparse
import json
import os
import statistics
import sys
import time
import wave

import numpy as np
import sherpa_onnx

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spoken_forms import apply_layer, hotword_lines, read_keyterms, variants_map, words_of  # noqa: E402

SR = 16000
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


# ---------------------------------------------------------------- scoring (the same rules as measure/recognize.ts)
def edit_distance(ref, hyp):
    prev = list(range(len(hyp) + 1))
    for i in range(1, len(ref) + 1):
        cur = [i]
        for j in range(1, len(hyp) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1)))
        prev = cur
    return prev[len(hyp)]


def contains_term(have, term):
    want = words_of(term)
    if not want:
        return False
    return any(have[i:i + len(want)] == want for i in range(len(have) - len(want) + 1))


def distinct_terms(terms):
    seen, out = set(), []
    for t in terms:
        k = ' '.join(words_of(t))
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def score(sentences, records):
    """mean WER and key-term recall over the records, as recognize.ts prints them."""
    wers, hit, total, per_term = [], 0, 0, {}
    by_id = {s['id']: s for s in sentences}
    for r in records:
        s = by_id[r['id']]
        ref = words_of(s['text'])
        hyp = words_of(r['text'])
        wers.append(edit_distance(ref, hyp) / len(ref))
        for term in distinct_terms(s['terms']):
            ok = contains_term(hyp, term)
            hit += ok
            total += 1
            a = per_term.setdefault(term, [0, 0])
            a[0] += ok
            a[1] += 1
    return {'n': len(records), 'wer': statistics.mean(wers) * 100, 'terms_hit': hit, 'terms_total': total, 'recall': 100.0 * hit / max(1, total), 'per_term': per_term}


# ---------------------------------------------------------------- audio
def read_wav(path):
    with wave.open(path) as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != SR:
            raise ValueError('%s: want 16 kHz mono 16-bit, got %d ch %d bytes %d Hz' % (path, w.getnchannels(), w.getsampwidth(), w.getframerate()))
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


# ---------------------------------------------------------------- recognizers
def build_zipformer(models, threads, hotwords_path, score_):
    m = os.path.join(models, 'zipformer-en-2023-06-26')
    kw = dict(
        tokens=os.path.join(m, 'tokens.txt'),
        encoder=os.path.join(m, 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx'),
        decoder=os.path.join(m, 'decoder-epoch-99-avg-1-chunk-16-left-128.onnx'),
        joiner=os.path.join(m, 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx'),
        num_threads=threads, sample_rate=SR, feature_dim=80, enable_endpoint_detection=False,
        decoding_method='modified_beam_search', max_active_paths=4,
    )
    if hotwords_path:
        kw.update(hotwords_file=hotwords_path, hotwords_score=score_, modeling_unit='bpe', bpe_vocab=os.path.join(m, 'bpe.model'))
    return sherpa_onnx.OnlineRecognizer.from_transducer(**kw)


def text_of(result):
    return result if isinstance(result, str) else getattr(result, 'text', str(result))


def run_zipformer(rec, samples):
    """Feeds the clip in 100 ms chunks as fast as it will go, then 0.66 s of silence. Returns (text, first partial ms relative to the end of audio, ms from the last chunk to the final)."""
    stream = rec.create_stream()
    chunk = SR // 10
    first_partial = None
    for i in range(0, len(samples), chunk):
        stream.accept_waveform(SR, samples[i:i + chunk])
        while rec.is_ready(stream):
            rec.decode_stream(stream)
        if first_partial is None and text_of(rec.get_result(stream)).strip():
            first_partial = (min(i + chunk, len(samples)) - len(samples)) / SR * 1000.0
    t0 = time.perf_counter()
    stream.accept_waveform(SR, np.zeros(int(0.66 * SR), dtype=np.float32))
    stream.input_finished()
    while rec.is_ready(stream):
        rec.decode_stream(stream)
    final_ms = (time.perf_counter() - t0) * 1000.0
    return text_of(rec.get_result(stream)).strip(), first_partial, final_ms


def build_parakeet(models, threads):
    m = os.path.join(models, 'parakeet-tdt-0.6b-v2-int8')
    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=os.path.join(m, 'encoder.int8.onnx'), decoder=os.path.join(m, 'decoder.int8.onnx'), joiner=os.path.join(m, 'joiner.int8.onnx'),
        tokens=os.path.join(m, 'tokens.txt'), num_threads=threads, sample_rate=SR, feature_dim=80, decoding_method='greedy_search', model_type='nemo_transducer')


def run_parakeet(rec, samples):
    t0 = time.perf_counter()
    stream = rec.create_stream()
    stream.accept_waveform(SR, samples)
    rec.decode_stream(stream)
    ms = (time.perf_counter() - t0) * 1000.0
    return stream.result.text.strip(), None, ms


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True, choices=['zipformer', 'parakeet'])
    ap.add_argument('--set', required=True)
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--hotwords-score', type=float, default=None)
    ap.add_argument('--layer', action='store_true')
    ap.add_argument('--models', default=r'D:\tai-voice-local\models')
    ap.add_argument('--threads', type=int, default=4)
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()
    if os.path.exists(args.out) or (args.layer and os.path.exists(args.out + '.layer.jsonl')):
        sys.exit('refusing to overwrite ' + args.out)

    rset = json.load(open(args.set, encoding='utf-8-sig'))
    manifest = json.load(open(os.path.join(args.audio, 'manifest.json'), encoding='utf-8-sig'))
    terms = read_keyterms(os.path.join(ROOT, 'src', 'voice', 'settings.ts'))
    mapping = variants_map(terms)

    hot_path = None
    if args.hotwords_score is not None:
        if args.model != 'zipformer':
            sys.exit('hotwords are for the zipformer only')
        hot_path = args.out + '.hotwords.txt'
        open(hot_path, 'w', encoding='utf-8').write('\n'.join(hotword_lines(terms)) + '\n')
    label = args.model + ('+hw%g' % args.hotwords_score if args.hotwords_score is not None else '')
    rec = build_zipformer(args.models, args.threads, hot_path, args.hotwords_score or 0) if args.model == 'zipformer' else build_parakeet(args.models, args.threads)
    run = run_zipformer if args.model == 'zipformer' else run_parakeet

    plan = [(s, v) for s in rset['recognition'] for v in rset['voices']]
    if args.limit:
        plan = plan[:args.limit]
    records, layered, decode_ms, audio_ms = [], [], [], []
    for n, (s, voice) in enumerate(plan, 1):
        key = voice + '|' + s['text']
        if key not in manifest:
            sys.exit('no clip in the manifest for ' + key)
        samples = read_wav(os.path.join(args.audio, manifest[key]))
        text, first_partial, final_ms = run(rec, samples)
        rec_ = {'id': s['id'], 'voice': voice, 'ears': label, 'text': text, 'finals': [text] if text else [], 'firstPartialMs': None if first_partial is None else round(first_partial),
                'lastFinalMs': round(final_ms), 'timedOut': False, 'attempts': 1}
        records.append(rec_)
        if args.layer:
            layered.append({**rec_, 'ears': label + '+layer', 'text': apply_layer(text, mapping), 'finals': [apply_layer(text, mapping)] if text else []})
        decode_ms.append(final_ms)
        audio_ms.append(len(samples) / SR * 1000.0)
        if n % 16 == 0:
            print('  %d / %d' % (n, len(plan)), flush=True)
    with open(args.out, 'x', encoding='utf-8') as f:
        f.writelines(json.dumps(r) + '\n' for r in records)
    if args.layer:
        with open(args.out + '.layer.jsonl', 'x', encoding='utf-8') as f:
            f.writelines(json.dumps(r) + '\n' for r in layered)

    def line(name, recs):
        sc = score(rset['recognition'], recs)
        print('%-24s n=%d  WER %.2f %%  key terms %d/%d = %.1f %%' % (name, sc['n'], sc['wer'], sc['terms_hit'], sc['terms_total'], sc['recall']))
        return sc
    print('config: %s, threads %d, set %s' % (label, args.threads, os.path.basename(args.set)))
    line(label, records)
    if args.layer:
        line(label + '+layer', layered)
    print('time after the last chunk (streaming) or whole decode (offline), this PC: p50 %d ms, p90 %d ms, max %d ms; decode time / audio time %.3f' % (
        statistics.median(decode_ms), sorted(decode_ms)[int(0.9 * (len(decode_ms) - 1))], max(decode_ms), sum(decode_ms) / sum(audio_ms)))


if __name__ == '__main__':
    main()
