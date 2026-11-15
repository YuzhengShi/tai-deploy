"""measure.py: the measures of the naturalness test (PROTOCOL.md): levels and pace, the recognizer's word error rate, descriptors of the sentence joins, the UTMOS predictor and its checks, and the report.

    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe measure.py levels | wer | flow | utmos [--model PATH] [--stub] | report

Every step writes a cache under <bank>\\work (resumable); `report` reads them and writes results/ (small files, in git). Audio stays under <bank> (never in git).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # so that `python -I` (no script directory on the path) finds nat_lib
import nat_lib as L  # noqa: E402

BANK = r'D:\tai-voice-local\naturalness-bank-20261115'
WORK = os.path.join(BANK, 'work')
RESULTS = os.path.join(L.HERE, 'results')
SAMPLES = r'D:\tai-voice-local\samples'
PASSAGES = {p['id']: p['sentences'] for p in json.load(open(os.path.join(L.HERE, 'passages.json'), encoding='utf-8'))['passages']}
PARAKEET = r'D:\tai-voice-local\models\parakeet-tdt-0.6b-v2-int8'
UTMOS_ONNX = r'D:\tai-voice-local\predictors\utmos22_strong.onnx'
CORE = ['flux-hannah', 'aura-thalia', 'aura-mars', 'local-F1']
MARGIN = 0.30
TERMS = ['raft', 'kafka', 'terraform', 'idempotent', 'heartbeats', 'partitions', 'deterministic', 'hashing', 'clockwise', 'replicas', 'go routines', 'wait group', 'docker file', 'goroutine']


def log(*a):
    print(*a, flush=True)


def cache_path(name: str) -> str:
    os.makedirs(WORK, exist_ok=True)
    return os.path.join(WORK, name)


def load_cache(name: str) -> dict:
    p = cache_path(name)
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}


def save_cache(name: str, data: dict) -> None:
    json.dump(data, open(cache_path(name), 'w', encoding='utf-8'), indent=0)


# ---------------------------------------------------------------- the clips
def sentence_clips() -> list[dict]:
    """Every per-sentence clip of the bank: raw/ (made on the host) and pc/ (made on the PC by render_local_pc.py)."""
    out = []
    for root in ('raw', 'pc'):
        for path in sorted(glob.glob(os.path.join(BANK, root, 'sent', '*', 'r*', '*.wav'))):
            rel = os.path.relpath(path, BANK).replace('\\', '/')
            parts = rel.split('/')
            cond, run = parts[2], int(parts[3][1:])
            m = re.match(r'(p\d+)-s(\d+)\.wav$', parts[4])
            if not m:
                continue
            pid, k = m.group(1), int(m.group(2))
            text = PASSAGES[pid][k - 1]
            out.append({'key': rel, 'root': root, 'cond': cond, 'run': run, 'passage': pid, 'sentence': k, 'text': text, 'words': len(L.norm_words(text)), 'path': path})
    return out


def variant_audio(item_path: str, variant: str) -> np.ndarray:
    """16 kHz float audio of a clip as a controlled variant: `norm` (trimmed, level-matched at -16 dBFS with the soft limiter: the headline), `asis` (trimmed, as rendered), `deployed` (+9 dB and the soft
    limiter on the 16-bit PCM exactly as the lab does it, then trimmed)."""
    if variant == 'deployed':
        pcm, sr = L.read_pcm_i16(item_path)
        x = L.apply_gain_i16(pcm, 9.0).astype(np.float32) / 32768.0
        return L.to16k(L.trim(x, sr), sr)
    x, sr = L.read_wav(item_path)
    x = L.trim(x, sr)
    if variant == 'norm':
        x, _ = L.normalize_level(x, sr)
    elif variant != 'asis':
        raise ValueError(variant)
    return L.to16k(x, sr)


# ---------------------------------------------------------------- levels and pace
def cmd_levels() -> None:
    rows = {}
    for it in sentence_clips():
        x, sr = L.read_wav(it['path'])
        lv = L.speech_level_db(x, sr)
        sp = L.speech_seconds(x, sr)
        row = {'cond': it['cond'], 'run': it['run'], 'passage': it['passage'], 'sentence': it['sentence'], 'level_db': round(lv, 2), 'peak_db': round(20 * np.log10(max(1e-9, float(np.abs(x).max()))), 2),
               'seconds': round(len(x) / sr, 3), 'speech_s': round(sp, 3), 'words': it['words'], 'wps': round(it['words'] / sp, 3) if sp else None}
        if it['cond'].startswith('local'):
            pcm, _ = L.read_pcm_i16(it['path'])
            y = L.apply_gain_i16(pcm, 9.0)
            yf = y.astype(np.float32) / 32768.0
            row['deployed_level_db'] = round(L.speech_level_db(yf, sr), 2)
            row['deployed_peak_db'] = round(20 * np.log10(max(1e-9, float(np.abs(yf).max()))), 2)
            row['limiter_touched'] = int((np.abs(pcm.astype(np.float64) * 10 ** (9 / 20)) > 0.75 * 32768).sum())
            row['samples'] = int(len(pcm))
        rows[it['key']] = row
    save_cache('levels.json', rows)
    for cond in sorted({r['cond'] for r in rows.values()}):
        rs = [r for r in rows.values() if r['cond'] == cond]
        log('%-20s clips %3d  level %6.2f dBFS  words/s %.2f  mean clip %.2fs' % (cond, len(rs), np.mean([r['level_db'] for r in rs]), np.mean([r['wps'] for r in rs if r['wps']]), np.mean([r['seconds'] for r in rs])))


# ---------------------------------------------------------------- the recognizer
_REC = None


def recognizer():
    global _REC
    if _REC is None:
        import sherpa_onnx
        _REC = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=os.path.join(PARAKEET, 'encoder.int8.onnx'), decoder=os.path.join(PARAKEET, 'decoder.int8.onnx'), joiner=os.path.join(PARAKEET, 'joiner.int8.onnx'),
            tokens=os.path.join(PARAKEET, 'tokens.txt'), num_threads=4, sample_rate=16000, feature_dim=80, decoding_method='greedy_search', model_type='nemo_transducer')
    return _REC


def transcribe(x16: np.ndarray) -> dict:
    """Parakeet on 16 kHz audio with half a second of silence on each side (the model drops a first word that starts at the very first sample). Returns the text and the words with start/end times
    (seconds, in the unpadded clip)."""
    pad = np.zeros(8000, dtype=np.float32)
    rec = recognizer()
    st = rec.create_stream()
    st.accept_waveform(16000, np.concatenate([pad, x16.astype(np.float32), pad]))
    rec.decode_stream(st)
    r = st.result
    words: list[dict] = []
    for tok, ts, du in zip(r.tokens, r.timestamps, getattr(r, 'durations', None) or [0.0] * len(r.tokens)):
        if tok.startswith(' ') or not words:
            words.append({'w': tok.strip(), 's': ts - 0.5, 'e': ts + du - 0.5})
        else:
            words[-1]['w'] += tok
            words[-1]['e'] = ts + du - 0.5
    return {'text': r.text.strip(), 'words': words}


def cmd_wer() -> None:
    cache = load_cache('wer.json')
    items = [it for it in sentence_clips() if it['key'] not in cache]
    log('wer: %d clips to decode (%d cached)' % (len(items), len(cache)))
    t0 = time.time()
    for i, it in enumerate(items):
        x16 = variant_audio(it['path'], 'norm')
        res = transcribe(x16)
        ref = L.norm_words(it['text'])
        hyp = L.norm_words(res['text'])
        s, d, ins = L.edit_ops(ref, hyp)
        refj, hypj = ' '.join(ref), ' '.join(hyp)
        terms = {t: (t in refj, t in hypj) for t in TERMS if t in refj}
        cache[it['key']] = {'hyp': res['text'], 'sub': s, 'del': d, 'ins': ins, 'ref_words': len(ref), 'terms': {t: bool(v[1]) for t, v in terms.items()}}
        if (i + 1) % 50 == 0:
            save_cache('wer.json', cache)
            log('  %d/%d  %.0fs' % (i + 1, len(items), time.time() - t0))
    save_cache('wer.json', cache)
    by = {}
    for it in sentence_clips():
        c = cache[it['key']]
        b = by.setdefault(it['cond'], [0, 0])
        b[0] += c['sub'] + c['del'] + c['ins']
        b[1] += c['ref_words']
    for cond, (e, n) in sorted(by.items()):
        log('%-20s WER %5.2f %%  (%d edits / %d words)' % (cond, 100 * e / n, e, n))


# ---------------------------------------------------------------- the joins
def _gap(mask: np.ndarray, lo: int, hi: int, min_frames: int = 6) -> tuple[int, int] | None:
    """The longest silent run (at least `min_frames` of 10 ms) that touches frames [lo, hi]: (first, last) frame of the run, or None."""
    n = len(mask)
    lo, hi = max(0, lo), min(n - 1, hi)
    best = None
    i = 0
    while i < n:
        if not mask[i]:
            j = i
            while j + 1 < n and not mask[j + 1]:
                j += 1
            if j - i + 1 >= min_frames and j >= lo and i <= hi and (best is None or j - i > best[1] - best[0]):
                best = (i, j)
            i = j + 1
        else:
            i += 1
    return best


def _f0_side(f0: np.ndarray, a: int, b: int) -> float | None:
    v = f0[max(0, a): max(0, b)]
    v = v[~np.isnan(v)]
    return float(np.median(v)) if len(v) >= 4 else None


def join_stats(x16: np.ndarray, joins: list[dict]) -> list[dict]:
    """For each join ({'frame': frame of the join if known, or 'next_t': the recognizer's time of the next sentence's first word}) the pause at it (the longest silent run of at least 60 ms around it; 0 if
    none) and the pitch reset: median F0 of the voiced frames in the 250 ms after the pause minus the 250 ms before it, in semitones."""
    mask = L.voiced_mask(x16, 16000)
    f0 = L.yin_f0_robust(x16)
    out = []
    for j in joins:
        if j.get('frame') is not None:
            c = j['frame']
            g = _gap(mask, c - 3, c + 3)
        elif j.get('next_t') is not None:
            c = int(j['next_t'] * 100)
            g = _gap(mask, c - 80, c + 10)
        else:
            out.append({'located': False})
            continue
        if g is None:
            a_end = c - 1
            b_start = c
            pause = 0
        else:
            a_end, b_start = g[0] - 1, g[1] + 1
            pause = (g[1] - g[0] + 1) * 10
        before = _f0_side(f0, a_end - 24, a_end + 1)
        after = _f0_side(f0, b_start, b_start + 25)
        reset = 12 * np.log2(after / before) if before and after else None
        out.append({'located': True, 'pause_ms': pause, 'f0_before': before, 'f0_after': after, 'reset_st': None if reset is None else round(float(reset), 2)})
    return out


def _hyp_words_with_times(res: dict) -> tuple[list[str], list[float]]:
    ws, ts = [], []
    for w in res['words']:
        for nw in L.norm_words(w['w']):
            ws.append(nw)
            ts.append(w['s'])
    return ws, ts


def locate_joins(passage: str, res: dict) -> list[dict]:
    """The three sentence joins of a whole clip, from the recognizer's word times: the time of the first word of each next sentence (a word the recognizer missed is replaced by the next one it found)."""
    sents = PASSAGES[passage]
    refs = [L.norm_words(s) for s in sents]
    ref_all = [w for r in refs for w in r]
    hyp, ts = _hyp_words_with_times(res)
    amap = L.aligned_index(ref_all, hyp)
    joins, cum = [], 0
    for k in range(len(sents) - 1):
        cum += len(refs[k])
        t = None
        for off in range(0, 3):
            if cum + off in amap:
                t = ts[amap[cum + off]]
                break
        joins.append({'next_t': t})
    return joins


def cmd_flow() -> None:
    cache = load_cache('flow.json')
    paras: list[dict] = []
    # per-sentence clips played back to back, as the lab plays them: the joins are known
    by = {}
    for it in sentence_clips():
        if it['root'] == 'raw' and it['cond'] in ('flux-hannah', 'aura-thalia', 'local-F1', 'aura-mars'):
            by.setdefault((it['cond'], it['run'], it['passage']), []).append(it)
    for (cond, run, pid), its in sorted(by.items()):
        its.sort(key=lambda r: r['sentence'])
        paras.append({'key': 'concat/%s/r%d/%s' % (cond, run, pid), 'cond': cond + '-persentence', 'run': run, 'passage': pid, 'parts': [i['path'] for i in its]})
    for path in sorted(glob.glob(os.path.join(BANK, 'raw', 'para', '*', 'r*', 'p*.wav'))):
        rel = os.path.relpath(path, BANK).replace('\\', '/').split('/')
        paras.append({'key': 'para/%s/%s/%s' % (rel[2], rel[3], rel[4][:-4]), 'cond': rel[2], 'run': int(rel[3][1:]), 'passage': rel[4][:-4], 'path': path})
    live = {'A1-live-agent-run1.wav': 1, 'A2-live-agent-run2.wav': 2}
    for f, run in live.items():
        paras.append({'key': 'ref/live-agent/r%d/p0' % run, 'cond': 'live-agent', 'run': run, 'passage': 'p0', 'path': os.path.join(SAMPLES, 'naturalness-20261115', f)})
    for f, run in {'A3-cf-lab-run1.wav': 1, 'A4-cf-lab-run2.wav': 2}.items():
        paras.append({'key': 'ref/cf-lab/r%d/p0' % run, 'cond': 'cf-lab', 'run': run, 'passage': 'p0', 'path': os.path.join(SAMPLES, 'naturalness-20261115', f)})
    todo = [p for p in paras if p['key'] not in cache]
    log('flow: %d paragraph clips (%d cached)' % (len(paras), len(paras) - len(todo)))
    for i, p in enumerate(todo):
        if 'parts' in p:
            xs, sr = [], 24000
            for part in p['parts']:
                x, sr = L.read_wav(part)
                xs.append(x)
            joins_s = np.cumsum([len(x) for x in xs])[:-1] / sr
            x24 = np.concatenate(xs)
            x24n, _ = L.normalize_level(x24, sr)
            x16 = L.to16k(x24n, sr)
            joins = [{'frame': int(round(t * 100))} for t in joins_s]
        else:
            x24, sr = L.read_wav(p['path'])
            x24n, _ = L.normalize_level(x24, sr)
            x16 = L.to16k(x24n, sr)
            res = transcribe(x16)
            joins = locate_joins(p['passage'], res)
        stats = join_stats(x16, joins)
        cache[p['key']] = {'cond': p['cond'], 'run': p['run'], 'passage': p['passage'], 'seconds': round(len(x16) / 16000, 2), 'joins': stats}
        if (i + 1) % 20 == 0:
            save_cache('flow.json', cache)
            log('  %d/%d' % (i + 1, len(todo)))
    save_cache('flow.json', cache)
    for line in flow_table(cache):
        log(line)


def flow_table(cache: dict) -> list[str]:
    """Per condition: pause at the joins (median, quartiles, share with no pause of at least 60 ms), the spread of the pauses inside a clip (mean of the within-clip SD), and the pitch reset at the joins
    (median of the signed value in semitones, median and 75th percentile of its absolute value)."""
    lines = ['%-26s %5s %5s %18s %8s %9s %20s' % ('condition', 'joins', 'loc.', 'pause med [q1-q3] ms', 'no pause', 'SD/clip', 'reset med | |med| |p75|')]
    for c in sorted({v['cond'] for v in cache.values()}):
        cl = [v for v in cache.values() if v['cond'] == c]
        js = [j for v in cl for j in v['joins']]
        loc = [j for j in js if j['located']]
        pauses = np.array([j['pause_ms'] for j in loc], dtype=float)
        sds = [np.std([j['pause_ms'] for j in v['joins'] if j['located']]) for v in cl if sum(j['located'] for j in v['joins']) >= 2]
        resets = np.array([j['reset_st'] for j in loc if j.get('reset_st') is not None], dtype=float)
        q = np.percentile(pauses, [25, 50, 75]) if len(pauses) else [float('nan')] * 3
        lines.append('%-26s %5d %5d %6.0f [%4.0f-%4.0f]     %7.0f%% %7.0fms %+6.1f | %4.1f | %4.1f st' % (
            c, len(js), len(loc), q[1], q[0], q[2], 100 * np.mean(pauses == 0) if len(pauses) else float('nan'), np.mean(sds) if sds else float('nan'),
            np.median(resets) if len(resets) else float('nan'), np.median(np.abs(resets)) if len(resets) else float('nan'), np.percentile(np.abs(resets), 75) if len(resets) else float('nan')))
    return lines


# ---------------------------------------------------------------- the predictor
class Utmos:
    def __init__(self, path: str):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = 4
        self.sess = ort.InferenceSession(path, sess_options=so, providers=['CPUExecutionProvider'])
        self.inp = self.sess.get_inputs()[0].name
        self.out = self.sess.get_outputs()[0].name

    def __call__(self, x16: np.ndarray) -> float:
        return float(np.asarray(self.sess.run([self.out], {self.inp: x16[None, :].astype(np.float32)})[0]).reshape(-1)[0])


class StubScorer:
    """Only to test the pipeline before the predictor is downloaded: a smooth function of the clip, never stored with real scores."""

    def __call__(self, x16: np.ndarray) -> float:
        return float(3.0 + 0.5 * np.tanh(np.std(x16) * 8) - 0.1 * (len(x16) / 16000 > 12))


def utmos_items() -> list[dict]:
    """Everything the predictor scores: (key, builder). Built lazily so that a missing file costs nothing."""
    items: list[dict] = []
    clips = sentence_clips()
    for it in clips:
        c = it['cond']
        items.append({'key': it['key'] + '|norm', 'path': it['path'], 'variant': 'norm'})
        if c in CORE:
            items.append({'key': it['key'] + '|asis', 'path': it['path'], 'variant': 'asis'})
        if c == 'local-F1' and it['root'] == 'raw':
            items.append({'key': it['key'] + '|deployed', 'path': it['path'], 'variant': 'deployed'})
    # B1: degradations and a level sweep on the Flux sentences of run 1 (from the level-matched clip)
    for it in clips:
        if it['cond'] == 'flux-hannah' and it['run'] == 1:
            for deg in ('band8k', 'noise20', 'gain-20', 'gain-10', 'gain+9'):
                items.append({'key': it['key'] + '|' + deg, 'path': it['path'], 'variant': deg})
    # B2: the owner's earlier samples (two sentences in many voices)
    for path in sorted(glob.glob(os.path.join(SAMPLES, '*-s[36].wav'))):
        items.append({'key': 'samples/' + os.path.basename(path) + '|norm', 'path': path, 'variant': 'norm'})
    # paragraph clips (exploratory, outside the 1 to 10 s the export was checked at)
    for path in sorted(glob.glob(os.path.join(BANK, 'raw', 'para', '*', 'r*', 'p*.wav'))):
        items.append({'key': os.path.relpath(path, BANK).replace('\\', '/') + '|norm', 'path': path, 'variant': 'norm'})
    for f in ('A1-live-agent-run1.wav', 'A2-live-agent-run2.wav', 'A3-cf-lab-run1.wav', 'A4-cf-lab-run2.wav'):
        items.append({'key': 'ref/' + f + '|norm', 'path': os.path.join(SAMPLES, 'naturalness-20261115', f), 'variant': 'norm'})
    return items


def build_audio(it: dict) -> np.ndarray:
    v = it['variant']
    if v in ('norm', 'asis', 'deployed'):
        return variant_audio(it['path'], v)
    base = variant_audio(it['path'], 'norm')
    if v == 'band8k':
        return L.band_limit_8k(base)
    if v == 'noise20':
        return L.add_noise(base, 20.0)
    if v.startswith('gain'):
        db = float(v[4:])
        return L.apply_gain_db(base, db)
    raise ValueError(v)


def cmd_utmos(model: str, stub: bool) -> None:
    name = 'utmos_stub.json' if stub else 'utmos.json'
    cache = load_cache(name)
    if stub:
        scorer = StubScorer()
    else:
        if not os.path.exists(model):
            log('the predictor file is not there: %s' % model)
            sys.exit(3)
        scorer = Utmos(model)
    items = [it for it in utmos_items() if it['key'] not in cache]
    log('utmos%s: %d items to score (%d cached)' % (' (STUB)' if stub else '', len(items), len(cache)))
    t0 = time.time()
    for i, it in enumerate(items):
        cache[it['key']] = round(scorer(build_audio(it)), 4)
        if (i + 1) % 50 == 0:
            save_cache(name, cache)
            log('  %d/%d  %.0fs' % (i + 1, len(items), time.time() - t0))
    save_cache(name, cache)
    log('done in %.0fs' % (time.time() - t0))


# ---------------------------------------------------------------- the report
def reading(lo: float, hi: float) -> str:
    """PROTOCOL.md's reading of a difference interval against the margin."""
    if lo > MARGIN or hi < -MARGIN:
        return 'a clear difference'
    if lo > -MARGIN and hi < MARGIN:
        return 'no detectable difference' if lo <= 0 <= hi else 'a small difference'
    return 'inconclusive at n = 10'


def passage_means(scores: dict[str, float], clips: list[dict], cond: str, variant: str, root: str | None = None) -> dict[str, float]:
    """passage -> mean score over the clips of `cond` (all runs, all four sentences)."""
    acc: dict[str, list[float]] = {}
    for it in clips:
        if it['cond'] != cond or (root and it['root'] != root):
            continue
        k = it['key'] + '|' + variant
        if k in scores:
            acc.setdefault(it['passage'], []).append(scores[k])
    return {p: float(np.mean(v)) for p, v in acc.items()}


def cmd_report(stub: bool) -> None:
    os.makedirs(RESULTS, exist_ok=True)
    clips = sentence_clips()
    levels = load_cache('levels.json')
    wer = load_cache('wer.json')
    flow = load_cache('flow.json')
    scores = load_cache('utmos_stub.json' if stub else 'utmos.json')
    out: dict = {'stub': stub}
    md: list[str] = []

    # --- levels and pace
    md.append('### Levels and pace (per-sentence clips, as rendered)\n')
    md.append('| condition | clips | speech level dBFS | peak dBFS | words/s | seconds per clip |')
    md.append('|---|---|---|---|---|---|')
    out['levels'] = {}
    for cond in sorted({r['cond'] for r in levels.values()}):
        rs = [r for r in levels.values() if r['cond'] == cond]
        row = {'clips': len(rs), 'level_db': float(np.mean([r['level_db'] for r in rs])), 'peak_db': float(np.max([r['peak_db'] for r in rs])), 'wps': float(np.mean([r['wps'] for r in rs if r['wps']])), 'seconds': float(np.mean([r['seconds'] for r in rs]))}
        if cond.startswith('local-F1') and 'deployed_level_db' in rs[0]:
            row['deployed_level_db'] = float(np.mean([r['deployed_level_db'] for r in rs]))
            row['limiter_touched_pct'] = 100 * sum(r['limiter_touched'] for r in rs) / sum(r['samples'] for r in rs)
        out['levels'][cond] = row
        md.append('| %s | %d | %.1f | %.1f | %.2f | %.1f |' % (cond, row['clips'], row['level_db'], row['peak_db'], row['wps'], row['seconds']))
    md.append('')

    # --- word error rate
    md.append('### Word error rate of the local recognizer on each voice (per-sentence clips, level-matched)\n')
    md.append('| condition | words | errors | WER % [95 % interval over passages] | course terms heard |')
    md.append('|---|---|---|---|---|')
    out['wer'] = {}
    for cond in sorted({it['cond'] for it in clips}):
        per_p: dict[str, list[int]] = {}
        th, tn = 0, 0
        for it in clips:
            if it['cond'] != cond or it['key'] not in wer:
                continue
            w = wer[it['key']]
            a = per_p.setdefault(it['passage'], [0, 0])
            a[0] += w['sub'] + w['del'] + w['ins']
            a[1] += w['ref_words']
            for _t, ok in w['terms'].items():
                tn += 1
                th += bool(ok)
        if not per_p:
            continue
        arr = np.array(list(per_p.values()), dtype=float)
        tot_e, tot_n = arr[:, 0].sum(), arr[:, 1].sum()
        rng = np.random.default_rng(1)
        boots = [arr[i, 0].sum() / arr[i, 1].sum() for i in rng.integers(0, len(arr), size=(10000, len(arr)))]
        lo, hi = np.percentile(boots, [2.5, 97.5])
        out['wer'][cond] = {'words': int(tot_n), 'errors': int(tot_e), 'wer': float(tot_e / tot_n), 'lo': float(lo), 'hi': float(hi), 'terms_heard': th, 'terms': tn}
        md.append('| %s | %d | %d | %.1f [%.1f, %.1f] | %d / %d |' % (cond, tot_n, tot_e, 100 * tot_e / tot_n, 100 * lo, 100 * hi, th, tn))
    md.append('')

    # --- joins
    if flow:
        md.append('### The sentence joins of the paragraph clips (descriptors, not a validated measure)\n')
        md.append('```')
        md.extend(flow_table(flow))
        md.append('```\n')
        out['flow'] = {}
        for c in sorted({v['cond'] for v in flow.values()}):
            js = [j for v in flow.values() if v['cond'] == c for j in v['joins'] if j['located']]
            out['flow'][c] = {'joins': len(js), 'pause_ms_median': float(np.median([j['pause_ms'] for j in js])) if js else None,
                              'reset_abs_st_median': float(np.median([abs(j['reset_st']) for j in js if j.get('reset_st') is not None])) if js else None}

    # --- predictor
    if scores:
        md.append('### UTMOS22 strong%s\n' % (' (STUB: pipeline test only, not a result)' if stub else ''))
        out['utmos'] = {}
        # B1
        def mean_of(variant: str, cond: str = 'flux-hannah') -> float:
            v = [scores[it['key'] + '|' + variant] for it in clips if it['cond'] == cond and it['run'] == 1 and (it['key'] + '|' + variant) in scores]
            return float(np.mean(v)) if v else float('nan')
        b1 = {'clean (level-matched)': mean_of('norm'), 'band-limited to 8 kHz sampling': mean_of('band8k'), 'white noise at 20 dB SNR': mean_of('noise20'), 'level -20 dB': mean_of('gain-20'), 'level -10 dB': mean_of('gain-10'),
              'level as rendered': mean_of('asis'), 'level +9 dB (limited)': mean_of('gain+9')}
        out['utmos']['B1'] = b1
        md.append('**B1, Flux hannah, run 1, 40 sentences**\n')
        for k, v in b1.items():
            md.append('* %s: %.2f' % (k, v))
        md.append('* the check passes: %s' % ('yes' if b1['clean (level-matched)'] > b1['band-limited to 8 kHz sampling'] and b1['clean (level-matched)'] > b1['white noise at 20 dB SNR'] else 'NO'))
        md.append('')
        # B2
        liked_names = ['labgpu-af_bella-natural'] + ['supertonic-%s-steps5' % v for v in ('F1', 'F2', 'F3', 'F4', 'M1', 'M2', 'M3', 'M4', 'M5')]
        rejected_prefix = ('kokoro-', 'piper-')
        aucs, detail = [], {}
        for s in ('s3', 's6'):
            liked, rejected = [], []
            for key, val in scores.items():
                if not key.startswith('samples/') or not key.endswith('-%s.wav|norm' % s):
                    continue
                base = key[len('samples/'):-len('-%s.wav|norm' % s)]
                if base in liked_names:
                    liked.append(val)
                elif base.startswith(rejected_prefix):
                    rejected.append(val)
            if liked and rejected:
                aucs.append(L.auc(np.array(liked), np.array(rejected)))
                detail[s] = {'liked': len(liked), 'rejected': len(rejected), 'liked_mean': float(np.mean(liked)), 'rejected_mean': float(np.mean(rejected))}
        if aucs:
            a = float(np.mean(aucs))
            out['utmos']['B2'] = {'auc': a, 'detail': detail, 'verdict': 'tracks his ear' if a >= 0.9 else ('weakly' if a >= 0.7 else 'does not track his ear')}
            md.append('**B2, his earlier verdicts** (liked: LabGPU and Supertonic F1 to F4, M1 to M5; rejected: Kokoro and Piper): AUC %.2f (%s); %s\n' % (a, out['utmos']['B2']['verdict'], json.dumps(detail)))
        # headline
        md.append('**Headline: per-sentence UTMOS, level-matched; unit = passage (n = 10); difference to Flux hannah with a 95 %% bootstrap interval; margin +/-%.2f**\n' % MARGIN)
        md.append('| voice | UTMOS mean [95 % interval] | minus Flux hannah [95 % interval] | reading |')
        md.append('|---|---|---|---|')
        flux = passage_means(scores, clips, 'flux-hannah', 'norm')
        for cond in ['flux-hannah', 'aura-thalia', 'aura-mars', 'local-F1']:
            pm = passage_means(scores, clips, cond, 'norm', 'pc' if 'steps' in cond else 'raw')
            if len(pm) < 10:
                continue
            ps = sorted(pm)
            vals = np.array([pm[p] for p in ps])
            m, lo, hi = L.bootstrap_ci(vals)
            diff = np.array([pm[p] - flux[p] for p in ps if p in flux])
            if cond == 'flux-hannah':
                md.append('| %s | %.2f [%.2f, %.2f] | (reference) | |' % (cond, m, lo, hi))
                out['utmos'][cond] = {'mean': m, 'lo': lo, 'hi': hi}
                continue
            dm, dlo, dhi = L.bootstrap_ci(diff)
            out['utmos'][cond] = {'mean': m, 'lo': lo, 'hi': hi, 'diff': dm, 'diff_lo': dlo, 'diff_hi': dhi, 'reading': reading(dlo, dhi)}
            md.append('| %s | %.2f [%.2f, %.2f] | %+.2f [%+.2f, %+.2f] | %s |' % (cond, m, lo, hi, dm, dlo, dhi, reading(dlo, dhi)))
        md.append('')
        # sensitivity of the local voice: PROTOCOL.md reads these against local F1 as deployed, with no margin and no label
        md.append('**Sensitivity of the local voice: minus local F1 as deployed (F1, speed 1.2, 5 steps), same unit and interval; no margin and no reading (they say what moves the score)**\n')
        md.append('| variant | UTMOS mean [95 % interval] | minus local F1 deployed [95 % interval] |')
        md.append('|---|---|---|')
        base = passage_means(scores, clips, 'local-F1', 'norm', 'raw')
        for cond in ['local-F2', 'local-F1-speed1.0', 'local-F1-steps16', 'local-F1-steps24']:
            pm = passage_means(scores, clips, cond, 'norm', 'pc' if 'steps' in cond else 'raw')
            if len(pm) < 10:
                continue
            ps = sorted(pm)
            m, lo, hi = L.bootstrap_ci(np.array([pm[p] for p in ps]))
            dm, dlo, dhi = L.bootstrap_ci(np.array([pm[p] - base[p] for p in ps if p in base]))
            out['utmos'][cond] = {'mean': m, 'lo': lo, 'hi': hi, 'diff_vs_local_F1': dm, 'diff_lo': dlo, 'diff_hi': dhi}
            md.append('| %s | %.2f [%.2f, %.2f] | %+.2f [%+.2f, %+.2f] |' % (cond, m, lo, hi, dm, dlo, dhi))
        md.append('')
        # level sensitivity
        md.append('**Level sensitivity (per-sentence, mean over all clips of the condition)**\n')
        md.append('| condition | as rendered | deployed (+9 dB, limited) | level-matched |')
        md.append('|---|---|---|---|')
        for cond in CORE:
            row = []
            for v in ('asis', 'deployed', 'norm'):
                vals = [scores[it['key'] + '|' + v] for it in clips if it['cond'] == cond and it['root'] == 'raw' and (it['key'] + '|' + v) in scores]
                row.append('%.2f' % np.mean(vals) if vals else '-')
            md.append('| %s | %s |' % (cond, ' | '.join(row)))
        md.append('')
        # paragraph clips
        md.append('**Paragraph clips (exploratory, 15 to 21 s: outside the range the export was checked at), level-matched, mean over passages and runs**\n')
        for cond in sorted({k.split('/')[2] for k in scores if k.startswith('raw/para/')}):
            vals = [v for k, v in scores.items() if k.startswith('raw/para/%s/' % cond)]
            md.append('* %s: %.2f (n = %d)' % (cond, np.mean(vals), len(vals)))
        for f in ('A1-live-agent-run1.wav', 'A2-live-agent-run2.wav', 'A3-cf-lab-run1.wav', 'A4-cf-lab-run2.wav'):
            if 'ref/%s|norm' % f in scores:
                md.append('* %s (p0 only): %.2f' % (f, scores['ref/%s|norm' % f]))
        md.append('')

    suffix = '-stub' if stub else ''
    json.dump(out, open(os.path.join(RESULTS, 'summary%s.json' % suffix), 'w'), indent=1)
    open(os.path.join(RESULTS, 'summary%s.md' % suffix), 'w', encoding='utf-8').write('\n'.join(md) + '\n')
    log('\n'.join(md))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['levels', 'wer', 'flow', 'utmos', 'report'])
    ap.add_argument('--model', default=UTMOS_ONNX)
    ap.add_argument('--stub', action='store_true')
    a = ap.parse_args()
    {'levels': cmd_levels, 'wer': cmd_wer, 'flow': cmd_flow, 'utmos': lambda: cmd_utmos(a.model, a.stub), 'report': lambda: cmd_report(a.stub)}[a.cmd]()
    return 0


if __name__ == '__main__':
    sys.exit(main())
