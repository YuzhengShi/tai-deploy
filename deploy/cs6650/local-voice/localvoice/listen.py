"""One recognition session: the audio of one `/v1/listen` connection in, Deepgram-style `Results` messages out. No sockets in here (wsconn.py owns them): the session is given a `send` coroutine.

The pipeline: bytes -> `Segmenter` (events) -> a bounded queue -> ONE emitter task that decodes the segments in order on the shared decode pool and sends the messages. One queue per connection, consumed one
item at a time, gives the order the client relies on for free: segment N before N+1, the final of utterance N before anything of N+1, and a final built from the very texts the partials carried (the whole
utterance is never decoded a second time). Decodes of different connections still overlap on the pool.

What the client sees (src/voice/lab/ears/v1.ts `readResults` and `UtteranceJoiner` are the specification):

* after a segment is decoded, a *partial*: `Results` with `is_final` false and the text of the WHOLE utterance so far (the decoded segments joined; the key-term layer applied); while a segment is still open
  and long, a partial from an *interim* decode of it (segmenter.py: it keeps the lab engine's silent-recognizer watchdog fed during a long stretch of speech);
* when the utterance ends (a pause, the hard cap, `Finalize`, `CloseStream`, the idle backstop), the *final*: `Results` with `is_final` and `speech_final` true and the whole text, `from_finalize` true when a
  `Finalize` or `CloseStream` asked for it; then, for an end the recognizer found itself, an `UtteranceEnd` (what LabGPU's adapter does after its final). A `Finalize` with nothing pending is still answered, with an
  empty transcript (the client ignores empty text), as Deepgram answers it. An utterance with no text (a blip, noise) sends nothing.

A partial must never be taken for the whole story when it is not. The lab engine treats the first text that arrives 350 ms or more after the end of speech as covering the speech (src/voice/lab/turn.ts
`coverAfterMs`) and, in a conversation, answers on it at once. An interim decode takes 0.3 to 1 s, so one that was offered just before the student stopped would arrive after that 350 ms and lack the last
words. So an interim result is dropped when something newer is queued behind it (the segment has closed: its own, complete decode follows) or when the audio has been silent for `stale_silence_ms` (200) by the time
it is ready (the segment is about to close). The same rule covers the partial of a piece cut by the optional soft cut. The text of a cut piece is kept for the final either way.

Backpressure: the queue holds at most `max_pending` items; when it is full `audio()` waits, so the connection stops being read and TCP slows the sender. A client that streams faster than real time (a test
harness) is held to the decode speed instead of filling memory.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

from .asr import Recognizer
from .keyterms import KeytermLayer
from .logutil import LOG, describe
from .segmenter import Interim, Segment, Segmenter

Send = Callable[[dict], Awaitable[bool]]


def results_message(text: str, confidence: float, *, start: float, duration: float, is_final: bool, speech_final: bool, from_finalize: bool) -> dict:
    return {
        'type': 'Results',
        'duration': round(duration, 3),
        'start': round(start, 3),
        'is_final': is_final,
        'speech_final': speech_final,
        'from_finalize': from_finalize,
        'channel': {'alternatives': [{'transcript': text, 'confidence': round(confidence, 4)}]},
    }


@dataclass
class _End:
    reason: str
    close_after: bool = False


class DecodeGate:
    """How many decodes are asked for and not yet finished, over ALL connections. An interim decode is a convenience (it keeps the client's watchdog fed); a segment's decode is what the engine waits for.
    So an interim is not started when the decode workers are nearly all busy: one worker is always left for the segments."""

    def __init__(self, workers: int = 3):
        self.in_flight = 0
        self.interim_limit = max(1, workers - 1)

    def interim_ok(self) -> bool:
        return self.in_flight < self.interim_limit


#: the default of `stale_silence_ms`: an interim result is not sent when the audio has been silent this long (well under the 350 ms the engine waits for, so that its own idea of the end of speech, a few
#: frames away, cannot differ enough to matter). Keep it below the engine's `TAI_VOICE_LAB_COVER_MS`.
STALE_SILENCE_MS = 200


@dataclass
class SessionStats:
    audio_bytes: int = 0
    interims_dropped: int = 0
    decodes: int = 0
    decode_errors: int = 0
    decode_ms: float = 0.0
    partials: int = 0
    finals: int = 0
    max_queue: int = 0


class ListenSession:
    def __init__(
        self,
        *,
        recognizer: Recognizer,
        pool,
        segmenter: Segmenter,
        layer: KeytermLayer,
        send: Send,
        close: Callable[[], Awaitable[None]],
        abort: Callable[[], None],
        max_pending: int = 6,
        idle_commit_s: float = 3.0,
        gate: DecodeGate | None = None,
        stale_silence_ms: int = STALE_SILENCE_MS,
        tag: str = '',
    ):
        self._rec = recognizer
        self._pool = pool
        self._seg = segmenter
        self._layer = layer
        self._send_raw = send
        self._close = close
        self._abort = abort
        self._idle_commit_s = idle_commit_s
        self._gate = gate or DecodeGate()
        self._stale_silence_ms = stale_silence_ms
        self._tag = tag
        self._q: asyncio.Queue = asyncio.Queue(maxsize=max(1, max_pending))
        self._task: asyncio.Task | None = None
        self._dead = False
        self._last_audio = time.monotonic()
        # the utterance being built
        self._texts: list[str] = []
        self._confs: list[float] = []
        self._utt_start = 0.0
        self._utt_end = 0.0
        self.stats = SessionStats()

    # ------------------------------------------------------------------ driven by the connection

    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self._emit_loop())

    @property
    def in_utterance(self) -> bool:
        return self._seg.in_utterance

    @property
    def segmenter(self) -> Segmenter:
        return self._seg

    def idle_timeout(self) -> float | None:
        """How long the connection may wait for data before the idle backstop must run: None while no utterance is open (nothing is waiting for the audio that is not coming)."""
        if self._dead or not self._seg.in_utterance:
            return None
        return max(0.05, self._idle_commit_s - (time.monotonic() - self._last_audio))

    async def audio(self, pcm: bytes) -> None:
        if self._dead:
            return
        self._last_audio = time.monotonic()
        self.stats.audio_bytes += len(pcm)
        await self._apply(self._seg.feed(pcm))

    async def finalize(self) -> None:
        """`Finalize`: end the utterance now and answer, whether or not there was anything."""
        if not self._dead:
            await self._apply(self._seg.finalize('finalize'))

    async def close_stream(self) -> None:
        """`CloseStream`: flush like Finalize, then the connection is closed by `close` once the answer has been sent (this call does not wait for it, so the connection keeps being read)."""
        if not self._dead:
            await self._apply(self._seg.finalize('close'), close_after=True)

    async def idle(self) -> None:
        """No audio for `idle_commit_s` while an utterance was open: the audio stopped (a muted page, a stalled network); end the utterance with what there is."""
        if not self._dead:
            await self._apply(self._seg.finalize('idle'))

    def cancel(self) -> None:
        self._dead = True
        if self._task is not None:
            self._task.cancel()

    # ------------------------------------------------------------------ the queue

    async def _apply(self, events, close_after: bool = False) -> None:
        for i, event in enumerate(events):
            if self._dead:
                return
            if isinstance(event, Segment):
                await self._q.put(event)
            elif isinstance(event, Interim):
                if self._q.full():
                    self.stats.interims_dropped += 1       # an interim is only worth decoding when nothing is waiting: it never makes the connection wait
                else:
                    self._q.put_nowait(event)
            else:
                await self._q.put(_End(event.reason, close_after=close_after and i == len(events) - 1))
            self.stats.max_queue = max(self.stats.max_queue, self._q.qsize())

    async def _emit_loop(self) -> None:
        while True:
            item = await self._q.get()
            if self._dead:
                continue            # the connection is gone or broken: keep draining so that nobody waits on a full queue
            try:
                if isinstance(item, Segment):
                    ok = await self._segment(item)
                elif isinstance(item, Interim):
                    ok = await self._interim(item)
                else:
                    ok = await self._end(item)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOG.warning('listen %s: the emitter failed: %s', self._tag, describe(exc))
                ok = False
            if not ok:
                self._dead = True
                self._abort()

    async def _decode(self, samples):
        self._gate.in_flight += 1
        try:
            return await asyncio.get_running_loop().run_in_executor(self._pool, self._rec.decode, samples)
        finally:
            self._gate.in_flight -= 1

    async def _segment(self, seg: Segment) -> bool:
        t0 = time.perf_counter()
        try:
            decoded = await self._decode(seg.samples)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.stats.decode_errors += 1
            LOG.warning('listen %s: a decode failed: %s', self._tag, describe(exc))
            return True
        self.stats.decodes += 1
        self.stats.decode_ms += (time.perf_counter() - t0) * 1000.0
        if not decoded.text:
            return True
        if not self._texts:
            self._utt_start = seg.start_s
        self._utt_end = seg.end_s
        self._texts.append(decoded.text)
        self._confs.append(decoded.confidence)
        if seg.cut and self._stale():
            return True             # kept for the final; its partial would lack what was said after the cut
        self.stats.partials += 1
        return await self._send(self._message(is_final=False, speech_final=False, from_finalize=False))

    async def _interim(self, item: Interim) -> bool:
        if not self._q.empty() or not self._gate.interim_ok():
            self.stats.interims_dropped += 1
            return True             # something newer is waiting (this would be out of date before it was sent), or the decode workers are busy with what the engine is waiting for
        t0 = time.perf_counter()
        try:
            decoded = await self._decode(item.samples)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.stats.decode_errors += 1
            LOG.warning('listen %s: an interim decode failed: %s', self._tag, describe(exc))
            return True
        self.stats.decodes += 1
        self.stats.decode_ms += (time.perf_counter() - t0) * 1000.0
        if not decoded.text:
            return True
        if self._stale():
            self.stats.interims_dropped += 1
            return True
        start = self._utt_start if self._texts else item.start_s
        text = self._layer.apply(' '.join([*self._texts, decoded.text]))
        confs = [*self._confs, decoded.confidence]
        self.stats.partials += 1
        return await self._send(results_message(text, sum(confs) / len(confs), start=start, duration=max(0.0, item.end_s - start), is_final=False, speech_final=False, from_finalize=False))

    def _stale(self) -> bool:
        """A result that was decoded from audio the speaker has since stopped after (or that something newer has overtaken) must not be sent as if it were the whole of what was said."""
        return not self._q.empty() or self._seg.silence_ms >= self._stale_silence_ms

    async def _end(self, end: _End) -> bool:
        from_finalize = end.reason in ('finalize', 'close')
        ok = True
        if self._texts:
            ok = await self._send(self._message(is_final=True, speech_final=True, from_finalize=from_finalize))
            self.stats.finals += 1
            if ok and not from_finalize:
                ok = await self._send({'type': 'UtteranceEnd', 'last_word_end': round(self._utt_end, 3)})
        elif end.reason == 'finalize':
            at = self._seg.audio_s
            ok = await self._send(results_message('', 0.0, start=at, duration=0.0, is_final=True, speech_final=True, from_finalize=True))
        self._texts, self._confs = [], []
        if ok and end.close_after:
            await self._close()
            self._dead = True   # the connection is closing: whatever is still queued is not wanted (the close is not a failure, so no abort)
        return ok

    def _message(self, *, is_final: bool, speech_final: bool, from_finalize: bool) -> dict:
        text = self._layer.apply(' '.join(self._texts))
        confidence = sum(self._confs) / len(self._confs) if self._confs else 0.0
        return results_message(text, confidence, start=self._utt_start, duration=max(0.0, self._utt_end - self._utt_start), is_final=is_final, speech_final=speech_final, from_finalize=from_finalize)

    async def _send(self, message: dict) -> bool:
        try:
            return bool(await self._send_raw(message))
        except asyncio.CancelledError:
            raise
        except Exception:
            return False
