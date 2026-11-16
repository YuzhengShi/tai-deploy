"""kokoro_round3.py: renders and measures the Kokoro conditions of round 3 of the blind listening test, exactly as PROTOCOL-round3.md (with its amendment 1) fixed them. No step uses the owner's ears.

    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe -I -B kokoro_round3.py frontend    # token sequences under en-us and en: do the two bf_vale conditions differ?
    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe -I -B kokoro_round3.py calibrate   # join rule, speed rule (rate-matched to the live voice), the clips, the speed of synthesis
    D:\\tai-voice-local\\venv-tts\\Scripts\\python.exe -I -B kokoro_round3.py wer         # Parakeet on every condition of the kit (as it will be played) and the words it misreads

Conditions: maple (af_maple), sol (af_sol), vale-us (bf_vale, the default front end, espeak-ng en-us), vale-gb (bf_vale, lang 'en' = espeak-ng's British voice). Passages p3, p6, p9, one request per sentence.
Files: raw sentence clips under <bank>/pc/sent/kokoro-<cond>-speed<s>/r1, the clips as they will be played under <bank>/pc/kokoro/played/<cond>/<pid>.wav (join treatment applied, no level match
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
CONDITIONS = {   # name -> (speaker id, espeak-ng voice for English: '' = the model's own, en-us)
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


def make_tts(lang: str, debug: bool = False):
    import sherpa_onnx
    d = MODEL
    kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
        model=os.path.join(d, 'model.int8.onnx'), voices=os.path.join(d, 'voices.bin'), tokens=os.path.join(d, 'tokens.txt'), data_dir=os.path.join(d, 'espeak-ng-data'),
        dict_dir=os.path.join(d, 'dict'), lexicon=os.path.join(d, 'lexicon-us-en.txt') + ',' + os.path.join(d, 'lexicon-zh.txt'), lang=lang)
    model = sherpa_onnx.OfflineTtsModelConfig(kokoro=kokoro, num_threads=THREADS, provider='cpu', debug=debug)
    cfg = sherpa_onnx.OfflineTtsConfig(model=model, max_num_sentences=1)
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
    os.makedirs(OUT, exist_ok=True)
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


# ---------------------------------------------------------------- rendering
_TTS: dict[str, object] = {}


def render(cond: str, speed: float, timing: dict | None = None) -> dict[str, list[np.ndarray]]:
    """The raw sentence clips of a condition at a request speed (cached on disk: a re-run reads the same clips back)."""
    import nat_lib as L
    sid, lang = CONDITIONS[cond]
    d = os.path.join(BANK, 'pc', 'sent', 'kokoro-%s-speed%.2f' % (cond, speed), 'r1')
    P = passages()
    files = {(pid, k): os.path.join(d, '%s-s%d.wav' % (pid, k)) for pid in KIT_PASSAGES for k in range(1, len(P[pid]) + 1)}
    if all(os.path.exists(f) for f in files.values()):
        return {pid: [L.read_wav(files[(pid, k)])[0] for k in range(1, len(P[pid]) + 1)] for pid in KIT_PASSAGES}
    if lang not in _TTS:
        _TTS[lang] = make_tts(lang)
        _TTS[lang].generate('Warm up.', sid=sid, speed=1.0)
    tts = _TTS[lang]
    out: dict[str, list[np.ndarray]] = {}
    print('  rendering %s at speed %.2f (12 sentences)...' % (cond, speed), flush=True)
    for pid in KIT_PASSAGES:
        out[pid] = []
        for k, text in enumerate(P[pid], 1):
            t0 = time.perf_counter()
            a = tts.generate(text, sid=sid, speed=speed)
            ms = (time.perf_counter() - t0) * 1000.0
            x = np.asarray(a.samples, dtype=np.float32)
            assert a.sample_rate == 24000, a.sample_rate
            L.write_wav(files[(pid, k)], x, 24000)
            out[pid].append(L.read_wav(files[(pid, k)])[0])      # as the 16-bit file holds it
            if timing is not None:
                timing.setdefault('%.2f' % speed, []).append((ms, len(x) / 24000.0))
    return out


def time_synthesis(cond: str, speed: float) -> list[tuple[float, float]]:
    """(milliseconds, seconds of audio) of one request per sentence, the clips thrown away: the engine sends one sentence per request, so a sentence's synthesis time is its time to first audio.
    One stream, four threads, after a warm-up: the numbers of A13's stage 1 and 2 (docs/VOICE_SELFBUILT.md 10.11, 10.12) are on the same footing."""
    sid, lang = CONDITIONS[cond]
    if lang not in _TTS:
        _TTS[lang] = make_tts(lang)
        _TTS[lang].generate('Warm up.', sid=sid, speed=1.0)
    tts = _TTS[lang]
    P = passages()
    out = []
    for pid in KIT_PASSAGES:
        for text in P[pid]:
            t0 = time.perf_counter()
            a = tts.generate(text, sid=sid, speed=speed)
            out.append(((time.perf_counter() - t0) * 1000.0, len(a.samples) / 24000.0))
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
        timing: dict = {}
        c10 = render(cond, 1.0, timing)
        j10 = joins_ms(c10)
        med = float(statistics.median(j10))
        normalise = abs(med - ctl_med) > JOIN_TOLERANCE_MS
        pad = ctl_med / 2.0 if normalise else None
        r10 = rate_of(c10, pad)
        c12 = render(cond, 1.2, timing)
        r12 = rate_of(c12, pad)
        pts = [(1.0, r10), (1.2, r12)]
        s_star = interpolate(pts[0], pts[1], target)
        steps = [{'speed': 1.0, 'rate': round(r10, 3)}, {'speed': 1.2, 'rate': round(r12, 3)}]
        final_speed, final_clips, final_rate = None, None, None
        c3 = render(cond, s_star, timing)
        r3 = rate_of(c3, pad)
        pts.append((s_star, r3))
        steps.append({'speed': s_star, 'rate': round(r3, 3)})
        if abs(r3 - target) <= RATE_TOLERANCE:
            final_speed, final_clips, final_rate = s_star, c3, r3
        else:
            near = sorted(pts, key=lambda p: abs(p[1] - target))[:2]
            s4 = interpolate(near[0], near[1], target)
            c4 = render(cond, s4, timing)
            r4 = rate_of(c4, pad)
            steps.append({'speed': s4, 'rate': round(r4, 3), 'note': 'second interpolation step, used whatever its rate'})
            final_speed, final_clips, final_rate = s4, c4, r4
        # the clips as they will be played
        pl = played(final_clips, pad)
        for pid, x in pl.items():
            L.write_wav(os.path.join(OUT, 'played', cond, pid + '.wav'), x, 24000)
        fin = time_synthesis(cond, final_speed)
        rtf = [ms / 1000.0 / dur for ms, dur in fin if dur]
        first = [ms for ms, _ in fin]
        report['conditions'][cond] = {
            'median_join_ms_at_1.0': round(med, 1), 'join_difference_to_control_ms': round(med - ctl_med, 1), 'treatment': 'normalise: every sentence edge %.0f ms' % pad if normalise else 'none (played as the engine makes it)',
            'steps': steps, 'chosen_speed': final_speed, 'chosen_rate_words_per_s': round(final_rate, 3), 'within_tolerance': abs(final_rate - target) <= RATE_TOLERANCE,
            'synthesis_at_chosen_speed': {'sentences': len(fin), 'first_audio_ms_p50': round(statistics.median(first)), 'first_audio_ms_p90': round(sorted(first)[int(round(0.9 * (len(first) - 1)))]), 'first_audio_ms_max': round(max(first)),
                                          'rtf_median': round(statistics.median(rtf), 3), 'rtf_max': round(max(rtf), 3), 'threads': THREADS},
        }
        chosen[cond] = {'speed': final_speed, 'pad_ms': pad}
        print('%-8s join %.0f ms (control %.0f): %s | rates %s | chosen speed %.2f at %.3f words/s | synthesis %s' % (
            cond, med, ctl_med, report['conditions'][cond]['treatment'], [(s['speed'], s['rate']) for s in steps], final_speed, final_rate, report['conditions'][cond]['synthesis_at_chosen_speed']), flush=True)
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
        sources[cond] = {pid: L.read_wav(os.path.join(OUT, 'played', cond, pid + '.wav')) for pid in KIT_PASSAGES}
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
        print('%-14s WER %5.1f %% (%d / %d)  not matched: %s' % (cond, rows[cond]['wer_percent'], edits, words, {k: v for k, v in misread.items() if v}), flush=True)
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
    ap.add_argument('step', choices=['frontend', 'calibrate', 'wer'])
    a = ap.parse_args()
    {'frontend': cmd_frontend, 'calibrate': cmd_calibrate, 'wer': cmd_wer}[a.step]()
    return 0


if __name__ == '__main__':
    sys.exit(main())
