"""The websocket side of `/v1/listen`: the opening handshake and the framing are the `websockets` library's sans-I/O `ServerProtocol` (it validates the handshake, the masking, the frame sizes, the UTF-8 of text
messages, the close codes and answers pings); this module does the I/O around it and wires the connection to a `ListenSession`.

The protocol (src/voice/lab/ears/v1.ts is the client): binary messages are audio, 16 kHz mono PCM16 little-endian, any size (the lab sends exactly 640 bytes, 20 ms); text messages are JSON control messages,
`{"type":"KeepAlive"}` (ignored), `{"type":"Finalize"}` (end the utterance now and answer) and `{"type":"CloseStream"}` (flush, then close). Anything else is ignored. The server sends `Results` and `UtteranceEnd`
(listen.py).

Safety, all bounded and all by the numbers in config.py:
* at most `max_connections` recognition connections at once; the next one is accepted and closed at once with code 1013 ("try again later"), which the lab client reports as a socket that closed (`down`);
* a message is at most 64 KiB (the library fails the connection with 1009 beyond that), the audio waiting for the decoder is bounded by the session's queue and the 30 s cap of an utterance;
* the server pings every `ws_ping_s`; a connection from which nothing at all (audio, pong, anything) has been heard for a ping interval plus the timeout is dropped, so a client that vanished without a close frame
  cannot hold one of the few slots for ever (the lesson of the nemotron adapter's README, 2026-08-20); a write that cannot complete in `WRITE_TIMEOUT_S` drops it too;
* a connection that has audio open but sends none for `idle_commit_ms` has its utterance ended (the session's idle backstop; audio time alone would never end it).

The log gets the connection's short random tag, counts and durations. Never the query string (it carries key terms), never a transcript, never audio.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import time

from websockets.exceptions import InvalidState
from websockets.frames import Frame, Opcode
from websockets.http11 import Request as WsRequest
from websockets.protocol import SEND_EOF, State
from websockets.server import ServerProtocol

from .httpio import Request
from .keyterms import clean_terms, layer_for
from .listen import ListenSession
from .logutil import LOG, SILENT, describe
from .segmenter import Segmenter

MAX_WS_MESSAGE = 64 * 1024
READ_SIZE = 65536
CLOSE_GRACE_S = 2.0
WRITE_TIMEOUT_S = 30.0
MAX_QUERY_KEYTERMS = 100


async def serve_listen(app, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, req: Request) -> None:
    await _Connection(app, reader, writer, req).run()


class _Connection:
    def __init__(self, app, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, req: Request):
        self.app = app
        self.reader = reader
        self.writer = writer
        self.req = req
        self.proto = ServerProtocol(max_size=MAX_WS_MESSAGE, logger=SILENT)
        self.tag = secrets.token_hex(3)
        self.session: ListenSession | None = None
        self._pinger: asyncio.Task | None = None
        self._abort_timer: asyncio.TimerHandle | None = None
        self._admitted = False
        self._closing_by_us = False
        self._frag_op: Opcode | None = None
        self._frag = bytearray()
        self._last_rx = time.monotonic()
        self._opened = time.monotonic()

    # ------------------------------------------------------------------ life

    async def run(self) -> None:
        try:
            if not await self._handshake():
                return
            if self.app.ws_active >= self.app.cfg.max_connections:
                LOG.info('listen %s: refused, all %d recognition connections are in use', self.tag, self.app.cfg.max_connections)
                await self._begin_close(1013, 'try again later')
            else:
                self._admitted = True
                self.app.ws_active += 1
                self._start_session()
            await self._loop()
        finally:
            self._cleanup()

    async def _handshake(self) -> bool:
        self.proto.receive_data(self.req.head)
        request = next((e for e in self.proto.events_received() if isinstance(e, WsRequest)), None)
        if request is None:
            return False
        response = self.proto.accept(request)
        self.proto.send_response(response)
        await self._flush()
        return response.status_code == 101

    def _start_session(self) -> None:
        app = self.app
        extra = clean_terms(self.req.query.get('keyterm', [])[:MAX_QUERY_KEYTERMS])
        terms = tuple(clean_terms([*app.services.keyterms, *extra]))
        segmenter = Segmenter(app.services.vad_factory(), app.cfg.segmenter)
        self.session = ListenSession(
            recognizer=app.services.recognizer,
            pool=app.services.asr_pool,
            segmenter=segmenter,
            layer=layer_for(terms),
            send=self._send_json,
            close=self._on_close_stream,
            abort=self._abort,
            max_pending=app.cfg.max_pending_segments,
            idle_commit_s=app.cfg.idle_commit_ms / 1000.0,
            gate=app.services.gate,
            stale_silence_ms=app.cfg.stale_silence_ms,
            tag=self.tag,
        )
        self.session.start()
        self._pinger = asyncio.get_running_loop().create_task(self._ping_loop())
        LOG.info('listen %s: open (%d key terms, %d of them from the address; connection %d of %d)', self.tag, len(terms), len(extra), app.ws_active, app.cfg.max_connections)

    def _cleanup(self) -> None:
        if self.session is not None:
            self.session.cancel()
        if self._pinger is not None:
            self._pinger.cancel()
        if self._abort_timer is not None:
            self._abort_timer.cancel()
        if self._admitted:
            self.app.ws_active -= 1
            s = self.session
            seg = s.segmenter.stats
            LOG.info('listen %s: closed after %.1f s with %.1f s of audio: %d utterances, %d segments (%d soft cuts, %d dropped as too short), %d decodes in %.0f ms, %d partials, %d finals, %d decode errors',
                     self.tag, time.monotonic() - self._opened, s.segmenter.audio_s, seg.utterances, seg.segments, seg.cuts, seg.blips, s.stats.decodes, s.stats.decode_ms, s.stats.partials,
                     s.stats.finals, s.stats.decode_errors)

    # ------------------------------------------------------------------ the read loop

    async def _loop(self) -> None:
        while True:
            timeout = self.session.idle_timeout() if self.session is not None and self.proto.state is State.OPEN else None
            try:
                if timeout is None:
                    data = await self.reader.read(READ_SIZE)
                else:
                    data = await asyncio.wait_for(self.reader.read(READ_SIZE), timeout)
            except asyncio.TimeoutError:
                if self.session is not None:
                    await self.session.idle()
                continue
            if not data:
                self.proto.receive_eof()
                await self._flush_quietly()
                return
            self._last_rx = time.monotonic()
            self.proto.receive_data(data)
            await self._flush()
            for event in self.proto.events_received():
                if isinstance(event, Frame) and await self._frame(event):
                    return
            if self.proto.state is not State.OPEN and not self._closing_by_us:
                return                 # the library failed the connection (a frame that was too big, a protocol error) or answered the peer's close

    async def _frame(self, frame: Frame) -> bool:
        """True when the connection is over."""
        op = frame.opcode
        if op is Opcode.CLOSE:
            return True
        if op is Opcode.PING or op is Opcode.PONG:
            return False
        if op is Opcode.TEXT or op is Opcode.BINARY:
            if frame.fin:
                await self._message(op, bytes(frame.data))
            else:
                self._frag_op = op
                self._frag = bytearray(frame.data)
            return False
        if op is Opcode.CONT and self._frag_op is not None:
            self._frag += frame.data
            if frame.fin:
                op, data = self._frag_op, bytes(self._frag)
                self._frag_op, self._frag = None, bytearray()
                await self._message(op, data)
        return False

    async def _message(self, op: Opcode, data: bytes) -> None:
        if self.session is None or self.proto.state is not State.OPEN:
            return
        if op is Opcode.BINARY:
            await self.session.audio(data)
            return
        try:
            message = json.loads(data.decode('utf-8'))
        except ValueError:
            return
        kind = message.get('type') if isinstance(message, dict) else None
        if kind == 'Finalize':
            await self.session.finalize()
        elif kind == 'CloseStream':
            await self.session.close_stream()
        # KeepAlive, and anything we do not know: nothing to do

    # ------------------------------------------------------------------ writing

    async def _flush(self) -> None:
        for data in self.proto.data_to_send():
            if data == SEND_EOF:
                try:
                    self.writer.write_eof()
                except (OSError, RuntimeError, NotImplementedError):
                    pass
            else:
                self.writer.write(data)
        try:
            await asyncio.wait_for(self.writer.drain(), WRITE_TIMEOUT_S)
        except asyncio.TimeoutError:
            self._abort()
            raise ConnectionError('write timed out') from None

    async def _flush_quietly(self) -> None:
        try:
            await self._flush()
        except (ConnectionError, OSError):
            pass

    async def _send_json(self, message: dict) -> bool:
        if self.proto.state is not State.OPEN:
            return False
        try:
            self.proto.send_text(json.dumps(message, separators=(',', ':')).encode('utf-8'))
            await self._flush()
        except (InvalidState, ConnectionError, OSError):
            return False
        return True

    async def _begin_close(self, code: int, reason: str) -> None:
        """We close: our close frame now, the TCP connection when the peer has answered or after a short grace."""
        self._closing_by_us = True
        if self.proto.state is State.OPEN:
            try:
                self.proto.send_close(code, reason)
                await self._flush()
            except (InvalidState, ConnectionError, OSError):
                pass
        if self._abort_timer is None:
            self._abort_timer = asyncio.get_running_loop().call_later(CLOSE_GRACE_S, self._abort)

    async def _on_close_stream(self) -> None:
        await self._begin_close(1000, '')

    def _abort(self) -> None:
        try:
            self.writer.transport.abort()
        except Exception:
            pass

    async def _ping_loop(self) -> None:
        interval = self.app.cfg.ws_ping_s
        patience = interval + self.app.cfg.ws_ping_timeout_s
        while True:
            await asyncio.sleep(interval)
            if self.proto.state is not State.OPEN:
                return
            quiet = time.monotonic() - self._last_rx
            if quiet > patience:
                LOG.info('listen %s: nothing heard for %.0f s, dropping the connection', self.tag, quiet)
                self._abort()
                return
            try:
                self.proto.send_ping(b'lv')
                await self._flush()
            except (InvalidState, ConnectionError, OSError):
                return
            except Exception as exc:
                LOG.warning('listen %s: the ping loop failed: %s', self.tag, describe(exc))
                return
