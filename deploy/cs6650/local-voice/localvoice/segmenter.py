"""Cuts a stream of 20 ms frames into segments an OFFLINE recognizer can decode, and says where an utterance ends.

The recognizer (Parakeet-TDT) decodes a whole buffer at once, so this module decides what a buffer is. It is a pure, synchronous state machine: bytes of PCM in, a list of events out, no I/O, no clock, no
threads (tests/test_vad_segmenter.py drives it with synthetic audio and no model). Every decision is made on AUDIO TIME (counted in frames), never on the wall clock: the same bytes give the same events
whether they arrive in real time or all at once, and a test can stream a minute of audio in a few milliseconds. (The wall-clock backstop for a stream that simply stops is the session's, listen.py.)

Words used here:

* a *segment* is a run of speech with `preroll_ms` of audio before its onset and up to `trail_keep_ms` of silence after it. It is closed by a pause of `seg_pause_ms`. Segments with less than
  `min_speech_ms` of speech in them (a click, a cough) are dropped.
* an *utterance* is one or more segments; a pause of `end_pause_ms` after the last speech ends it, or `max_utterance_ms` since its onset (the hard cap), or the session asks (`finalize`).
* an *interim* is the open segment so far, offered for decoding every `interim_ms` of speech while it stays open. It is not cut off: the segment goes on, and when a pause closes it the whole segment is decoded
  again. An interim exists for the sake of the client, not of the text: the lab engine gives up a recognizer that sends no text for `silentEarsMs` (8 s) after the onset of speech
  (src/voice/lab/agent.ts), and a student who explains something at length can speak that long without a 350 ms pause. A partial built from an interim carries real text, decoded with the whole of the
  segment's left context, so nothing is lost in the segment's final decode; the price is the extra decoding, which only a segment longer than `interim_ms` costs. An interim is offered on a frame of
  speech, never inside a pause: a mark crossed in the pause that is about to close the segment waits for the next speech (and is dropped with the segment when none comes).
* a *soft cut* (`max_segment_ms`, off by default) is the other way to keep a long stretch short: the segment is split at the quietest spot of its last `cut_window_ms`. It also bounds the wait after the end of
  speech to the decode of the last piece, but a word can be split by the cut and the two pieces are decoded without each other's context: on 4 clips of 5 to 7 s with `max_segment_ms` 4000 it turned
  "CAP theorem" into "capital" and "Theorem" and "log entry" into "a lot" and "entry" (2026-11-14), which is why it is not the default.

Events: `Segment` (decode this), `Interim` (decode this if nothing newer is waiting), `UtteranceEnd` (the utterance is over; why).
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from typing import Union

import numpy as np

from .vad import FRAME_BYTES, FRAME_MS, FrameVad


def _frames(ms: int) -> int:
    return max(0, math.ceil(ms / FRAME_MS))


@dataclass(frozen=True)
class SegmenterConfig:
    seg_pause_ms: int = 350
    end_pause_ms: int = 600
    max_utterance_ms: int = 30000
    min_speech_ms: int = 200
    preroll_ms: int = 200
    trail_keep_ms: int = 200
    onset_ms: int = 60
    #: an interim every this many ms of an open segment; 0 = none
    interim_ms: int = 3000
    #: 0 = no soft cut (see the module docstring)
    max_segment_ms: int = 0
    cut_window_ms: int = 400

    def validate(self) -> None:
        def need(name: str, value: int, lo: int, hi: int) -> None:
            if not lo <= value <= hi:
                raise ValueError('%s must be from %d to %d' % (name, lo, hi))

        need('seg_pause_ms', self.seg_pause_ms, 100, 5000)
        need('end_pause_ms', self.end_pause_ms, 100, 10000)
        need('max_utterance_ms', self.max_utterance_ms, 2000, 120000)
        need('min_speech_ms', self.min_speech_ms, 0, 2000)
        need('preroll_ms', self.preroll_ms, 0, 1000)
        need('trail_keep_ms', self.trail_keep_ms, 0, 1000)
        need('onset_ms', self.onset_ms, FRAME_MS, 500)
        need('cut_window_ms', self.cut_window_ms, 100, 2000)
        if self.interim_ms != 0:
            need('interim_ms', self.interim_ms, 1000, 30000)
        if self.max_segment_ms != 0:
            need('max_segment_ms', self.max_segment_ms, 1000, 60000)
            if self.max_segment_ms < 2 * self.cut_window_ms:
                raise ValueError('max_segment_ms must be at least twice cut_window_ms')


@dataclass(frozen=True)
class Segment:
    """A buffer to decode: float32 samples at 16 kHz."""

    samples: np.ndarray
    speech_ms: int
    #: audio time, seconds since the first byte of the stream
    start_s: float
    end_s: float
    #: closed by the length rule (a soft cut) rather than by a pause
    cut: bool


@dataclass(frozen=True)
class Interim:
    """The open segment so far (pre-roll included), float32 samples at 16 kHz, to be decoded for a partial if nothing newer is waiting. Never part of the final text."""

    samples: np.ndarray
    start_s: float
    end_s: float


@dataclass(frozen=True)
class UtteranceEnd:
    #: 'pause' | 'cap' | 'idle' | 'finalize' | 'close'
    reason: str
    at_s: float


Event = Union[Segment, Interim, UtteranceEnd]


@dataclass
class SegmenterStats:
    frames: int = 0
    speech_frames: int = 0
    segments: int = 0
    interims: int = 0
    cuts: int = 0
    blips: int = 0
    utterances: int = 0


# one frame as kept: (its bytes, its level, whether the VAD called it speech)
_Frame = tuple


class Segmenter:
    def __init__(self, vad: FrameVad, cfg: SegmenterConfig = SegmenterConfig()):
        cfg.validate()
        self._vad = vad
        self._seg_pause = _frames(cfg.seg_pause_ms)
        self._end_pause = _frames(cfg.end_pause_ms)
        self._max_utt = _frames(cfg.max_utterance_ms)
        self._min_speech_ms = cfg.min_speech_ms
        self._preroll = _frames(cfg.preroll_ms)
        self._trail = _frames(cfg.trail_keep_ms)
        self._onset = max(1, _frames(cfg.onset_ms))
        self._interim = _frames(cfg.interim_ms)
        self._max_seg = _frames(cfg.max_segment_ms)
        self._cut_window = max(2, _frames(cfg.cut_window_ms))
        self._carry = b''
        #: the newest frames while no segment is open: the pre-roll of the next one (its onset frames are in it too)
        self._ring: deque[_Frame] = deque(maxlen=self._preroll + self._onset)
        #: the open segment's frames, or None
        self._seg: list[_Frame] | None = None
        self._seg_first = 0
        #: length of the open segment when its last interim was offered
        self._interim_at = 0
        #: consecutive non-speech frames since the last speech (inside an open segment, or in a pause)
        self._silence = 0
        #: consecutive speech frames while no segment is open
        self._loud = 0
        self._utt = False
        self._utt_frames = 0
        self._n = 0
        self.stats = SegmenterStats()

    @property
    def in_utterance(self) -> bool:
        return self._utt

    @property
    def audio_s(self) -> float:
        """Seconds of audio consumed (whole frames only)."""
        return self._n * FRAME_MS / 1000.0

    @property
    def silence_ms(self) -> int:
        """How long the audio has been silent since the last speech of the open utterance (0 while speech goes on, and outside an utterance)."""
        return self._silence * FRAME_MS if self._utt else 0

    # ------------------------------------------------------------------ input

    def feed(self, pcm: bytes) -> list[Event]:
        """PCM16 little-endian mono 16 kHz in pieces of any size (a piece may end in the middle of a frame or of a sample). Returns the events they caused, in order."""
        events: list[Event] = []
        data = self._carry + bytes(pcm) if self._carry else bytes(pcm)
        whole = len(data) // FRAME_BYTES * FRAME_BYTES
        self._carry = data[whole:]
        for i in range(0, whole, FRAME_BYTES):
            self._frame(data[i:i + FRAME_BYTES], events)
        return events

    def finalize(self, reason: str = 'finalize') -> list[Event]:
        """End the utterance now (a `Finalize` or `CloseStream` from the client, or the idle backstop): the audio still waiting in a partial frame is padded with silence and used, the open segment is
        closed, and an `UtteranceEnd` follows. 'finalize' and 'close' always give an `UtteranceEnd`, even when no utterance was open (the session answers a Finalize either way); 'idle' only when one was."""
        events: list[Event] = []
        if self._carry:
            frame = self._carry + bytes(FRAME_BYTES - len(self._carry))
            self._carry = b''
            self._frame(frame, events)
        if reason == 'idle' and not self._utt:
            return events
        self._end(reason, events)
        return events

    # ------------------------------------------------------------------ the state machine

    def _frame(self, frame: bytes, events: list[Event]) -> None:
        idx = self._n
        self._n += 1
        x = np.frombuffer(frame, dtype='<i2')
        xf = x.astype(np.float32)
        rms = float(np.sqrt(np.mean(xf * xf)))
        speech = bool(self._vad.process(x, rms))
        self.stats.frames += 1
        self.stats.speech_frames += 1 if speech else 0
        item = (frame, rms, speech)

        if self._seg is None:
            # no segment open: idle, or the pause inside an utterance
            self._ring.append(item)
            if self._utt:
                self._utt_frames += 1
            if speech:
                self._loud += 1
                if self._loud >= self._onset:
                    self._open(idx)
            else:
                self._loud = 0
                if self._utt:
                    self._silence += 1
                    if self._silence >= self._end_pause:
                        self._end('pause', events)
        else:
            self._seg.append(item)
            self._utt_frames += 1
            if speech:
                self._silence = 0
            else:
                self._silence += 1
                if self._silence >= self._seg_pause:
                    self._close(events)
                    if self._silence >= self._end_pause:
                        self._end('pause', events)
            if self._seg is not None and self._max_seg and len(self._seg) >= self._max_seg:
                self._cut(events)
            # an interim is offered on a frame of speech only: when the mark is crossed inside a pause, the segment is about to close (and its own decode follows), so an interim decode started
            # now would hold the segment's up for what remains of it (the owner's call of 2026-11-15: speech of 2.6 to 2.8 s was answered 1.2 to 1.45 s after its end instead of 0.5 s). The offer
            # waits for the next frame of speech, and is never made when none comes
            if self._seg is not None and self._interim and self._silence == 0 and len(self._seg) - self._interim_at >= self._interim:
                self._offer_interim(events)
        if self._utt and self._utt_frames >= self._max_utt:
            self._end('cap', events)

    def _open(self, idx: int) -> None:
        frames = list(self._ring)
        self._ring.clear()
        self._seg = frames
        self._seg_first = idx - len(frames) + 1
        self._interim_at = 0
        self._silence = 0
        if not self._utt:
            self._utt = True
            self._utt_frames = self._loud
        self._loud = 0

    def _close(self, events: list[Event]) -> None:
        """Close the open segment at the current frame: the silence at its end is cut back to `trail_keep_ms`, and the part cut off becomes the start of the next pre-roll."""
        seg = self._seg
        assert seg is not None
        self._seg = None
        drop = max(0, min(self._silence, len(seg)) - self._trail)
        if drop:
            self._ring.extend(seg[len(seg) - drop:])
            seg = seg[:len(seg) - drop]
        self._emit(seg, self._seg_first, False, events)

    def _cut(self, events: list[Event]) -> None:
        """Soft cut: split the open segment at the quietest frame of its last `cut_window_ms` (level averaged over three frames, so that one quiet frame inside a word does not win)."""
        seg = self._seg
        assert seg is not None
        n = len(seg)
        lo = max(1, n - self._cut_window)
        levels = [f[1] for f in seg]
        best_i, best = n - 1, math.inf
        for i in range(lo, n):
            window = levels[max(0, i - 1):min(n, i + 2)]
            level = sum(window) / len(window)
            if level <= best:
                best, best_i = level, i
        first, rest = seg[:best_i + 1], seg[best_i + 1:]
        self._emit(first, self._seg_first, True, events)
        self._seg = rest
        self._seg_first += len(first)
        self._interim_at = 0

    def _offer_interim(self, events: list[Event]) -> None:
        """The open segment so far, for a partial. Only when it holds speech enough to be worth decoding (a long stretch of noise is not)."""
        seg = self._seg
        assert seg is not None
        self._interim_at = len(seg)
        if sum(1 for f in seg if f[2]) * FRAME_MS < self._min_speech_ms:
            return
        samples = np.frombuffer(b''.join(f[0] for f in seg), dtype='<i2').astype(np.float32) / 32768.0
        events.append(Interim(samples, self._seg_first * FRAME_MS / 1000.0, (self._seg_first + len(seg)) * FRAME_MS / 1000.0))
        self.stats.interims += 1

    def _emit(self, frames: list[_Frame], first_idx: int, cut: bool, events: list[Event]) -> None:
        if not frames:
            return
        speech = sum(1 for f in frames if f[2])
        if speech * FRAME_MS < self._min_speech_ms:
            self.stats.blips += 1
            return
        samples = np.frombuffer(b''.join(f[0] for f in frames), dtype='<i2').astype(np.float32) / 32768.0
        events.append(Segment(samples, speech * FRAME_MS, first_idx * FRAME_MS / 1000.0, (first_idx + len(frames)) * FRAME_MS / 1000.0, cut))
        self.stats.segments += 1
        self.stats.cuts += 1 if cut else 0

    def _end(self, reason: str, events: list[Event]) -> None:
        if self._seg is not None:
            self._close(events)
        if self._utt:
            self.stats.utterances += 1
        self._utt = False
        self._utt_frames = 0
        self._silence = 0
        self._loud = 0
        events.append(UtteranceEnd(reason, self._n * FRAME_MS / 1000.0))
