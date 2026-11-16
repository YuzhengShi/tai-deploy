"""kokoro_round3.py: renders and measures the Kokoro conditions of round 3 of the blind listening test, as PROTOCOL-round3.md (with its amendments 1 and 2) fixed them. No step uses the owner's ears.

    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe -I -B kokoro_round3.py frontend    # the engine's token sequences under en-us and en (logs kept); amendment 1
    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe -I -B kokoro_round3.py engine      # the FIRST pass, through sherpa-onnx as it ships (silence_scale 0.2, the dropped phoneme): kept as `played-as-shipped`
    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe -I -B kokoro_round3.py calibrate   # amendment 2: the model itself on the engine's ids (repaired, the model's own silences): join rule, speed rule, clips, speed of synthesis
    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe -I -B kokoro_round3.py wer         # Parakeet on every condition of the kit (as it will be played) and the words it does not match

Conditions: maple (af_maple, the engine's US ids, repaired), sol (af_sol, the same), vale (bf_vale, the engine's British ids, `lang='en'`, nothing to repair). Passages p3, p6, p9, one request per sentence.
Files: raw sentence clips under <bank>/pc/sent/kokoro-direct-<cond>-speed<s>/r1, the clips as they will be played under <bank>/pc/kokoro/played/<cond>/<pid>.wav (join treatment applied, no level match
yet), the numbers in <bank>/pc/kokoro/*.json and, small, in results/round3-*.json (in git).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = r'D:\tai-voice-local\tts\kokoro-int8-multi-lang-v1_1'
BANK = r'D:\tai-voice-local\naturalness-bank-20261115'
OUT = os.path.join(BANK, 'pc', 'kokoro')
RESULTS = os.path.join(HERE, 'results')
KIT_PASSAGES = ['p3', 'p6', 'p9']
CONDITIONS = {   # name -> (speaker id, which engine log the ids come from: '' = the model's own espeak-ng voice en-us, 'en' = espeak-ng's British voice)
    'maple': (0, ''),
    'sol': (1, ''),
    'vale': (2, 'en'),
}
SHIPPED = {      # the first pass, through the engine as it ships (kept for the context clip and for the word error rate)
    'maple': (0, ''),
    'sol': (1, ''),
    'vale-us': (2, ''),
    'vale-gb': (2, 'en'),
}
JOIN_TOLERANCE_MS = 150.0     # PROTOCOL-round3.md: within this of the control's median join: played as the engine makes it
RATE_TOLERANCE = 0.10         # words per second
THREADS = 4


def passages() -> dict[str, list[str]]:
    return {p['id']: p['sentences'] for p in json.load(open(os.path.join(HERE, 'passages.json'), encoding='utf-8'))['passages']}


def make_tts(lang: str, debug: bool = False, silence_scale: float = 0.2):
    import sherpa_onnx
    d = MODEL
    kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
        model=os.path.join(d, 'model.int8.onnx'), voices=os.path.join(d, 'voices.bin'), tokens=os.path.join(d, 'tokens.txt'), data_dir=os.path.join(d, 'espeak-ng-data'),
        dict_dir=os.path.join(d, 'dict'), lexicon=os.path.join(d, 'lexicon-us-en.txt') + ',' + os.path.join(d, 'lexicon-zh.txt'), lang=lang)
    model = sherpa_onnx.OfflineTtsModelConfig(kokoro=kokoro, num_threads=THREADS, provider='cpu', debug=debug)
    cfg = sherpa_onnx.OfflineTtsConfig(model=model, max_num_sentences=1, silence_scale=silence_scale)
    if not cfg.validate():
        raise SystemExit('invalid TTS config')
    return sherpa_onnx.OfflineTts(cfg)


# ---------------------------------------------------------------- the front-end check (child process: the engine's debug log is C++ stderr)
def child(lang: str) -> int:
    tts = make_tts(lang, debug=True)
    P = passages()
    for pid in KIT_PASSAGES:
        for text in P[pid]:
            tts.generate(text, sid=2, speed=1.0)
    return 0


def decode_tokens(log_text: str) -> list[str]:
    tok = {}
    for line in open(os.path.join(MODEL, 'tokens.txt'), encoding='utf-8'):
        sym, idx = line.rstrip('\n').rsplit(' ', 1)
        tok[int(idx)] = sym
    out = []
    for m in re.findall(r'ConvertTextToTokenIds:158 \s*\r?\n([0-9 ]+)\r?\n', log_text):
        out.append(''.join(tok.get(int(i), '<%s>' % i) for i in m.split()))
    return out


def cmd_frontend() -> None:
    res = {}
    os.makedirs(OUT, exist_ok=True)
    for lang in ('', 'en'):
        p = subprocess.run([sys.executable, '-I', '-B', os.path.abspath(__file__), '--child', lang], capture_output=True)
        open(os.path.join(OUT, 'frontend-%s.log' % (lang or 'default')), 'wb').write(p.stderr)      # kept: a failed parse need not render again
        text = p.stderr.decode('utf-8', 'replace')
        res[lang or 'en-us (default)'] = decode_tokens(text)
        print('lang %-18s exit %d, %d token sequences, failures: %d' % (repr(lang), p.returncode, len(res[lang or 'en-us (default)']), text.count('Failed to')), flush=True)
    a, b = res['en-us (default)'], res['en']
    n_diff = sum(1 for x, y in zip(a, b) if x != y)
    print('sentences %d, with different phonemes under en-us and en: %d' % (len(a), n_diff))
    json.dump({'sentences': len(a), 'different': n_diff, 'en-us': a, 'en': b}, open(os.path.join(OUT, 'frontend.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    os.makedirs(RESULTS, exist_ok=True)
    json.dump({'sentences': len(a), 'sentences_with_different_phonemes': n_diff, 'identical_everywhere': n_diff == 0}, open(os.path.join(RESULTS, 'round3-frontend.json'), 'w'), indent=1)


# ---------------------------------------------------------------- measures on clips
def edges_ms(x: np.ndarray, sr: int = 24000) -> tuple[float, float]:
    import nat_lib as L
    m = L.voiced_mask(x, sr)
    if not m.any():
        return 0.0, 0.0
    first, last = int(np.argmax(m)), int(len(m) - 1 - np.argmax(m[::-1]))
    n = int(sr * 10 / 1000)
    lead = first * n * 1000.0 / sr
    trail = (len(x) - (last + 1) * n) * 1000.0 / sr
    return lead, trail


def set_edges(x: np.ndarray, pad_ms: float, sr: int = 24000) -> np.ndarray:
    """Leading and trailing silence of exactly `pad_ms` (frames not voiced by the rule of nat_lib.voiced_mask): longer edges cut, shorter ones padded with digital silence."""
    import nat_lib as L
    m = L.voiced_mask(x, sr)
    if not m.any():
        return x
    n = int(sr * 10 / 1000)
    first, last = int(np.argmax(m)), int(len(m) - 1 - np.argmax(m[::-1]))
    a, b = first * n, (last + 1) * n
    pad = int(round(sr * pad_ms / 1000.0))
    keep_a, keep_b = min(pad, a), min(pad, len(x) - b)
    return np.concatenate([np.zeros(pad - keep_a, dtype=np.float32), x[a - keep_a:b + keep_b], np.zeros(pad - keep_b, dtype=np.float32)]).astype(np.float32)


def joins_ms(clips: dict[str, list[np.ndarray]]) -> list[float]:
    out = []
    for pid in KIT_PASSAGES:
        c = clips[pid]
        for k in range(len(c) - 1):
            out.append(edges_ms(c[k])[1] + edges_ms(c[k + 1])[0])
    return out


def passage_words() -> dict[str, int]:
    import nat_lib as L
    P = passages()
    return {pid: sum(len(L.norm_words(s)) for s in P[pid]) for pid in KIT_PASSAGES}


def rate_of(clips: dict[str, list[np.ndarray]], pad_ms: float | None) -> float:
    """Mean over the passages of words per second of speaking time (first to last voiced frame, the pauses inside included) of the passage as played (join treatment applied)."""
    import nat_lib as L
    words = passage_words()
    rates = []
    for pid in KIT_PASSAGES:
        c = clips[pid] if pad_ms is None else [set_edges(x, pad_ms) for x in clips[pid]]
        x = np.concatenate(c)
        rates.append(words[pid] / L.speech_seconds(x, 24000))
    return float(np.mean(rates))


def played(clips: dict[str, list[np.ndarray]], pad_ms: float | None) -> dict[str, np.ndarray]:
    return {pid: np.concatenate(clips[pid] if pad_ms is None else [set_edges(x, pad_ms) for x in clips[pid]]) for pid in KIT_PASSAGES}


# ---------------------------------------------------------------- the first pass: the engine as it ships (kept for the context clip and the word error rate)
_TTS: dict[str, object] = {}


def cmd_engine() -> None:
    """Amendment 2's first pass, kept for reference: the engine as it ships. Do not run it again over `played-as-shipped` unless the folder was lost: its clips are the context clip of the kit."""
    raise SystemExit('the first pass was run with the earlier version of this file (commit 51c1a15 and before): its clips are under %s' % os.path.join(OUT, 'played-as-shipped'))


# ---------------------------------------------------------------- amendment 2: the model itself on the engine's ids
_RUNNER = None
_IDS: dict[str, list[list[int]]] = {}


def runner():
    global _RUNNER
    if _RUNNER is None:
        import kokoro_direct as K
        _RUNNER = K.Runner(THREADS)
    return _RUNNER


def sentence_ids(cond: str) -> list[list[int]]:
    """The 12 token id lists of a condition: the engine's own (from its debug log), the American ones with the truncated words repaired. Every repair is checked against the engine's skip count."""
    import kokoro_direct as K
    sid, lang = CONDITIONS[cond]
    key = lang or 'default'
    if cond in _IDS:
        return _IDS[cond]
    sym2id, id2sym = K.load_vocab()
    rows = K.read_log(os.path.join(OUT, 'frontend-%s.log' % key))
    assert len(rows) == 12, len(rows)
    out = []
    for i, (ids, skips) in enumerate(rows):
        if lang == '':
            new, done = K.repair(ids, sym2id, id2sym)
            assert len(done) == skips, 'sentence %d: the engine skipped %d phonemes, %d words repaired (%s)' % (i, skips, len(done), done)
        else:
            assert skips == 0, 'sentence %d: the British front end skipped %d phonemes' % (i, skips)
            new = ids
        out.append(new)
    _IDS[cond] = out
    return out


def render(cond: str, speed: float) -> dict[str, list[np.ndarray]]:
    """The raw sentence clips of a condition at a request speed (cached on disk: a re-run reads the same clips back)."""
    import nat_lib as L
    sid, _ = CONDITIONS[cond]
    d = os.path.join(BANK, 'pc', 'sent', 'kokoro-direct-%s-speed%.2f' % (cond, speed), 'r1')
    P = passages()
    names = [(pid, k) for pid in KIT_PASSAGES for k in range(1, len(P[pid]) + 1)]
    files = {n: os.path.join(d, '%s-s%d.wav' % n) for n in names}
    if all(os.path.exists(f) for f in files.values()):
        return {pid: [L.read_wav(files[(pid, k)])[0] for k in range(1, len(P[pid]) + 1)] for pid in KIT_PASSAGES}
    ids = sentence_ids(cond)
    r = runner()
    print('  rendering %s at speed %.2f (12 sentences)...' % (cond, speed), flush=True)
    out: dict[str, list[np.ndarray]] = {pid: [] for pid in KIT_PASSAGES}
    for i, (pid, k) in enumerate(names):
        x = r.synth(ids[i], sid, speed)
        L.write_wav(files[(pid, k)], x, 24000)
        out[pid].append(L.read_wav(files[(pid, k)])[0])      # as the 16-bit file holds it
    return out


def time_synthesis(cond: str, speed: float) -> list[tuple[float, float]]:
    """(milliseconds, seconds of audio) of one model run per sentence, the clips thrown away, after a warm-up: one stream, four threads, the model only (the ids exist already; the engine's front end takes
    a few milliseconds more). The engine's own numbers on this PC are in the as-shipped calibration, from the same sentences."""
    sid, _ = CONDITIONS[cond]
    ids = sentence_ids(cond)
    r = runner()
    r.synth(ids[0], sid, speed)
    out = []
    for i in range(12):
        t0 = time.perf_counter()
        x = r.synth(ids[i], sid, speed)
        out.append(((time.perf_counter() - t0) * 1000.0, len(x) / 24000.0))
    return out


def control_clips() -> dict[str, list[np.ndarray]]:
    import nat_lib as L
    P = passages()
    return {pid: [L.read_wav(os.path.join(BANK, 'raw', 'sent', 'local-F1', 'r1', '%s-s%d.wav' % (pid, k)))[0] for k in range(1, len(P[pid]) + 1)] for pid in KIT_PASSAGES}


def live_target() -> tuple[float, dict[str, float]]:
    import nat_lib as L
    words = passage_words()
    per = {}
    for pid in KIT_PASSAGES:
        x, sr = L.read_wav(os.path.join(BANK, 'raw', 'para', 'flux-hannah-whole', 'r1', pid + '.wav'))
        per[pid] = words[pid] / L.speech_seconds(x, sr)
    return float(np.mean(list(per.values()))), per


def interpolate(p1: tuple[float, float], p2: tuple[float, float], target: float) -> float:
    (s1, r1), (s2, r2) = p1, p2
    if abs(r2 - r1) < 1e-6:
        return s1
    s = s1 + (target - r1) * (s2 - s1) / (r2 - r1)
    return round(min(1.5, max(0.8, s)), 2)


def cmd_calibrate() -> None:
    import nat_lib as L
    os.makedirs(OUT, exist_ok=True)
    target, per_flux = live_target()
    ctl = control_clips()
    ctl_joins = joins_ms(ctl)
    ctl_med = float(statistics.median(ctl_joins))
    ctl_rate = rate_of(ctl, None)
    print('live voice: %.3f words/s on %s (per passage %s); control: median join %.0f ms over %d joins, %.3f words/s' % (
        target, KIT_PASSAGES, {k: round(v, 2) for k, v in per_flux.items()}, ctl_med, len(ctl_joins), ctl_rate), flush=True)
    report = {'target_words_per_s': round(target, 3), 'live_per_passage': {k: round(v, 3) for k, v in per_flux.items()}, 'control': {'median_join_ms': round(ctl_med, 1), 'joins': [round(j, 1) for j in ctl_joins], 'words_per_s': round(ctl_rate, 3)}, 'conditions': {}}
    chosen = {}
    for cond in CONDITIONS:
        c10 = render(cond, 1.0)
        j10 = joins_ms(c10)
        med = float(statistics.median(j10))
        normalise = abs(med - ctl_med) > JOIN_TOLERANCE_MS
        pad = ctl_med / 2.0 if normalise else None
        r10 = rate_of(c10, pad)
        c12 = render(cond, 1.2)
        r12 = rate_of(c12, pad)
        pts = [(1.0, r10), (1.2, r12)]
        s_star = interpolate(pts[0], pts[1], target)
        steps = [{'speed': 1.0, 'rate': round(r10, 3)}, {'speed': 1.2, 'rate': round(r12, 3)}]
        c3 = render(cond, s_star)
        r3 = rate_of(c3, pad)
        pts.append((s_star, r3))
        steps.append({'speed': s_star, 'rate': round(r3, 3)})
        if abs(r3 - target) <= RATE_TOLERANCE:
            final_speed, final_clips, final_rate = s_star, c3, r3
        else:
            near = sorted(pts, key=lambda p: abs(p[1] - target))[:2]
            s4 = interpolate(near[0], near[1], target)
            c4 = render(cond, s4)
            r4 = rate_of(c4, pad)
            steps.append({'speed': s4, 'rate': round(r4, 3), 'note': 'second interpolation step, used whatever its rate'})
            final_speed, final_clips, final_rate = s4, c4, r4
        pl = played(final_clips, pad)
        for pid, x in pl.items():
            L.write_wav(os.path.join(OUT, 'played', cond, pid + '.wav'), x, 24000)
        fin = time_synthesis(cond, final_speed)
        rtf = [ms / 1000.0 / dur for ms, dur in fin if dur]
        first = [ms for ms, _ in fin]
        report['conditions'][cond] = {
            'median_join_ms_at_1.0': round(med, 1), 'join_difference_to_control_ms': round(med - ctl_med, 1), 'treatment': ('normalise: every sentence edge %.0f ms' % pad) if normalise else 'none (played as the model makes it)',
            'steps': steps, 'chosen_speed': final_speed, 'chosen_rate_words_per_s': round(final_rate, 3), 'within_tolerance': abs(final_rate - target) <= RATE_TOLERANCE,
            'model_run_at_chosen_speed': {'sentences': len(fin), 'ms_p50': round(statistics.median(first)), 'ms_p90': round(sorted(first)[int(round(0.9 * (len(first) - 1)))]), 'ms_max': round(max(first)),
                                          'rtf_median': round(statistics.median(rtf), 3), 'rtf_max': round(max(rtf), 3), 'threads': THREADS, 'what': 'onnxruntime on token ids, one stream, this PC'},
        }
        chosen[cond] = {'speed': final_speed, 'pad_ms': pad}
        print('%-6s join %.0f ms (control %.0f): %s | rates %s | chosen speed %.2f at %.3f words/s | model run %s' % (
            cond, med, ctl_med, report['conditions'][cond]['treatment'], [(s['speed'], s['rate']) for s in steps], final_speed, final_rate, report['conditions'][cond]['model_run_at_chosen_speed']), flush=True)
    json.dump(report, open(os.path.join(OUT, 'calibration.json'), 'w'), indent=1)
    json.dump(chosen, open(os.path.join(OUT, 'chosen.json'), 'w'), indent=1)
    os.makedirs(RESULTS, exist_ok=True)
    json.dump(report, open(os.path.join(RESULTS, 'round3-calibration.json'), 'w'), indent=1)


# ---------------------------------------------------------------- Parakeet on the clips as they will be played
def cmd_wer() -> None:
    import measure as M
    import nat_lib as L
    from make_kit import finish
    P = passages()
    rows = {}
    sources: dict[str, dict[str, tuple[np.ndarray, int]]] = {}
    for cond in CONDITIONS:
        sources['kokoro-' + cond] = {pid: L.read_wav(os.path.join(OUT, 'played', cond, pid + '.wav')) for pid in KIT_PASSAGES}
    for cond in SHIPPED:
        sources['as-shipped-' + cond] = {pid: L.read_wav(os.path.join(OUT, 'played-as-shipped', cond, pid + '.wav')) for pid in KIT_PASSAGES}
    ctl = control_clips()
    sources['local-control'] = {pid: (np.concatenate(ctl[pid]), 24000) for pid in KIT_PASSAGES}
    sources['flux-whole'] = {pid: L.read_wav(os.path.join(BANK, 'raw', 'para', 'flux-hannah-whole', 'r1', pid + '.wav')) for pid in KIT_PASSAGES}
    for cond, per in sources.items():
        edits = words = 0
        misread: dict[str, list[str]] = {}
        for pid, (x, sr) in per.items():
            y = finish(x, sr)
            res = M.transcribe(L.to16k(y, 24000))
            ref, hyp = L.norm_words(' '.join(P[pid])), L.norm_words(res['text'])
            s, d, i = L.edit_ops(ref, hyp)
            edits += s + d + i
            words += len(ref)
            idx = L.aligned_index(ref, hyp)
            misread[pid] = [ref[k] for k in range(len(ref)) if k not in idx]
        rows[cond] = {'wer_percent': round(100.0 * edits / words, 1), 'edits': edits, 'words': words, 'reference_words_not_matched': misread}
        print('%-18s WER %5.1f %% (%d / %d)  not matched: %s' % (cond, rows[cond]['wer_percent'], edits, words, {k: v for k, v in misread.items() if v}), flush=True)
    json.dump(rows, open(os.path.join(OUT, 'wer.json'), 'w'), indent=1)
    json.dump(rows, open(os.path.join(RESULTS, 'round3-wer.json'), 'w'), indent=1)


def main() -> int:
    if len(sys.argv) >= 3 and sys.argv[1] == '--child':
        return child(sys.argv[2])
    sys.path.insert(0, HERE)
    sys.path.insert(0, os.path.join(HERE, 'listening'))
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument('step', choices=['frontend', 'engine', 'calibrate', 'wer'])
    a = ap.parse_args()
    {'frontend': cmd_frontend, 'engine': cmd_engine, 'calibrate': cmd_calibrate, 'wer': cmd_wer}[a.step]()
    return 0


if __name__ == '__main__':
    sys.exit(main())
