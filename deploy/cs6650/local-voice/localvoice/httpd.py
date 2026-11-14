"""The front of the service: every connection arrives here, one request is read, and it goes to one of three places.

  GET  /health          -> {"ok":true,"asr":"...","tts":"..."}
  GET  /v1/listen       -> a websocket upgrade: the recognizer (wsconn.py, listen.py)
  POST /tts             -> {"text": "...", "voice": "af_bella", "speed": 1.0 (optional)}  ->  200, raw PCM s16le mono 24 kHz, chunked

`/tts` is LabGPU's adapter as the lab's client (src/voice/lab/mouth/labgpu.ts `LabGPUMouth`) uses it: the answer is `application/octet-stream`, sent as HTTP chunks (about ten) so that the client reads a stream, and
it NEVER carries an `X-TTS-Fallback` header (the client throws the audio away when it does: the adapter's own signal that the text was sent to a third party; nothing here ever sends text anywhere).

Requests are checked before any work is done, and every refusal is a small JSON error that never repeats anything the client sent:
  * `Content-Type: application/json` is required: a web page cannot send that to another origin without a preflight request, which this server never answers; any request that carries an `Origin` header is
    refused outright (browsers add it; the lab's own clients do not);
  * the body is at most 16 KiB and must have a Content-Length; `text` is a non-empty string of at most 1000 characters; `voice` is one the backend lists (`default`, `af_bella` ... see tts.py) and `DrBerg`, the
    adapter's voice that must never be used, is not one; `speed` is a number from 0.5 to 2.0 (a boolean is not a number);
  * at most `max_tts_pending` requests wait for or use the synthesis pool; the next gets 503.
The synthesis runs on the TTS thread pool, never on the event loop. While it runs the connection is watched: a client that goes away before the audio is ready (the student barged in, the call ended) costs
nothing more than the synthesis already under way, a queued one is cancelled, and nothing is written to a closed socket.
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import time
from dataclasses import dataclass
from typing import Mapping

from .httpio import HttpError, MAX_HEAD, Request, close_quietly, read_request, response_head, send_error, send_json
from .logutil import LOG, describe, loop_exception_handler
from .services import Services
from .tts import UnsupportedText, chunk_pcm, pcm16_24k
from .wsconn import serve_listen

HEAD_TIMEOUT_S = 10.0
BODY_TIMEOUT_S = 10.0
MAX_BODY = 16 * 1024
MAX_TTS_CHARS = 1000
MIN_SPEED = 0.5
MAX_SPEED = 2.0
#: sockets open at once, of any kind: a flood of idle connections cannot use up the process's file descriptors
MAX_OPEN_SOCKETS = 64

_FORBIDDEN_VOICE = re.compile(r'drberg', re.IGNORECASE)


@dataclass(frozen=True)
class TtsSpec:
    text: str
    #: the name as the client wrote it (one of the backend's `voice_aliases`)
    voice: str
    speed: float


def _reject_constant(_name: str):
    raise ValueError('NaN and Infinity are not JSON')


def parse_tts_body(body: bytes, aliases: Mapping[str, str]) -> TtsSpec:
    """The checks above, as a function of the body. Raises `HttpError(400, ...)` with a fixed message."""
    try:
        obj = json.loads(body.decode('utf-8'), parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        raise HttpError(400, 'the body is not valid JSON') from None
    if not isinstance(obj, dict):
        raise HttpError(400, 'the body must be a JSON object')
    text = obj.get('text')
    if not isinstance(text, str):
        raise HttpError(400, 'text must be a string')
    if len(text) > MAX_TTS_CHARS:
        raise HttpError(400, 'text is longer than %d characters' % MAX_TTS_CHARS)
    # control characters (but not tab and line breaks) are not speech
    text = ''.join(' ' if (ord(c) < 32 and c not in '\t\n\r') or ord(c) == 127 else c for c in text)
    if not text.strip():
        raise HttpError(400, 'text is empty')
    try:
        text.encode('utf-8')
    except UnicodeEncodeError:
        raise HttpError(400, 'text is not valid Unicode') from None
    voice = obj.get('voice')
    if voice is None:
        voice = 'default'
    if not isinstance(voice, str) or _FORBIDDEN_VOICE.search(re.sub(r'[^A-Za-z0-9]', '', voice)) or voice not in aliases:
        raise HttpError(400, 'unknown voice; the voices are: %s' % ', '.join(sorted(aliases)))
    speed = obj.get('speed')
    if speed is None:
        speed = 1.0
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or not MIN_SPEED <= speed <= MAX_SPEED:
        raise HttpError(400, 'speed must be a number from %g to %g' % (MIN_SPEED, MAX_SPEED))
    return TtsSpec(text=text, voice=voice, speed=float(speed))


async def _wait_eof(reader: asyncio.StreamReader) -> None:
    """Returns when the client has closed its side (what a request that is dropped looks like from here). Anything else it sends is read and thrown away."""
    while True:
        if not await reader.read(1024):
            return


def _swallow(fut: asyncio.Future) -> None:
    """A synthesis nobody waits for any more must not leave an unretrieved exception behind."""
    if not fut.cancelled():
        fut.exception()


class App:
    def __init__(self, cfg, services: Services):
        self.cfg = cfg
        self.services = services
        self.open_sockets = 0
        self.ws_active = 0
        self.tts_pending = 0
        self._writers: set = set()

    async def start(self, host: str | None = None, port: int | None = None) -> asyncio.AbstractServer:
        asyncio.get_running_loop().set_exception_handler(loop_exception_handler)
        return await asyncio.start_server(self.handle, host or self.cfg.host, self.cfg.port if port is None else port, limit=MAX_HEAD)

    # ------------------------------------------------------------------ one connection

    def abort_all(self) -> None:
        """Drops every open connection at once (shutdown: a server that waits for its clients to leave would wait for ever for a call that is in progress)."""
        for writer in list(self._writers):
            try:
                writer.transport.abort()
            except Exception:
                pass

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.open_sockets += 1
        self._writers.add(writer)
        try:
            if self.open_sockets > MAX_OPEN_SOCKETS:
                return
            await self._serve(reader, writer)
        except (ConnectionError, OSError, asyncio.IncompleteReadError, asyncio.TimeoutError):
            pass                        # a peer that went away: nobody to answer
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            LOG.warning('a connection failed: %s', describe(exc))
        finally:
            self.open_sockets -= 1
            self._writers.discard(writer)
            await close_quietly(writer)

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            try:
                req = await asyncio.wait_for(read_request(reader), HEAD_TIMEOUT_S)
            except asyncio.TimeoutError:
                raise HttpError(408, 'no request within %d seconds' % HEAD_TIMEOUT_S) from None
            if req is None:
                return
            await self._route(req, reader, writer)
        except HttpError as exc:
            await send_error(writer, exc.status, exc.message, exc.headers)

    async def _route(self, req: Request, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if 'origin' in req.headers:
            raise HttpError(403, 'requests from web pages are not accepted')
        if 'websocket' in req.headers.get('upgrade', '').lower():
            if req.path != '/v1/listen':
                raise HttpError(404, 'not found')
            self._check_listen_query(req)
            await serve_listen(self, reader, writer, req)
            return
        if req.path == '/health':
            if req.method != 'GET':
                raise HttpError(405, 'method not allowed', (('Allow', 'GET'),))
            await send_json(writer, 200, {'ok': True, 'asr': self.services.recognizer.name, 'tts': self.services.tts.name})
            return
        if req.path == '/tts':
            if req.method != 'POST':
                raise HttpError(405, 'method not allowed', (('Allow', 'POST'),))
            await self._tts(req, reader, writer)
            return
        if req.path == '/v1/listen':
            raise HttpError(426, 'this is a websocket endpoint', (('Upgrade', 'websocket'),))
        raise HttpError(404, 'not found')

    @staticmethod
    def _check_listen_query(req: Request) -> None:
        """The address may carry Deepgram's usual parameters; the audio is 16 kHz mono linear16 and nothing else is understood, so a client that says otherwise is refused instead of being heard as noise."""
        encoding = req.query.get('encoding')
        if encoding and encoding[-1].lower() != 'linear16':
            raise HttpError(400, 'only encoding=linear16 is supported')
        rate = req.query.get('sample_rate')
        if rate and rate[-1] != '16000':
            raise HttpError(400, 'only sample_rate=16000 is supported')
        channels = req.query.get('channels')
        if channels and channels[-1] != '1':
            raise HttpError(400, 'only one channel is supported')

    # ------------------------------------------------------------------ /tts

    async def _tts(self, req: Request, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if 'transfer-encoding' in req.headers:
            raise HttpError(501, 'a chunked request body is not supported; send Content-Length')
        length = req.headers.get('content-length')
        if length is None:
            raise HttpError(411, 'Content-Length is required')
        if not length.isdigit() or len(length) > 9:
            raise HttpError(400, 'bad Content-Length')
        size = int(length)
        if size > MAX_BODY:
            raise HttpError(413, 'the body is larger than %d bytes' % MAX_BODY)
        if req.headers.get('expect', '').lower() == '100-continue':
            writer.write(b'HTTP/1.1 100 Continue\r\n\r\n')
            await writer.drain()
        # the body is read before anything else is judged: closing a socket that still has unread bytes in it makes the peer see a reset instead of the answer
        try:
            body = await asyncio.wait_for(reader.readexactly(size), BODY_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise HttpError(408, 'the body did not arrive in time') from None
        if req.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
            raise HttpError(415, 'send Content-Type: application/json')
        spec = parse_tts_body(body, self.services.tts.voice_aliases)
        if self.tts_pending >= self.cfg.max_tts_pending:
            raise HttpError(503, 'busy, try again shortly', (('Retry-After', '1'),))
        t0 = time.perf_counter()
        pcm = await self._synthesize(spec, reader)
        if pcm is None:
            return
        made = time.perf_counter()
        sent, pieces = await self._send_audio(writer, pcm)
        LOG.info('tts: %d characters at speed %.2f -> %.2f s of audio; synthesis %.0f ms, %d of %d pieces sent in %.0f ms', len(spec.text), spec.speed, len(pcm) / 48000.0, (made - t0) * 1000.0,
                 sent, pieces, (time.perf_counter() - made) * 1000.0)

    async def _synthesize(self, spec: TtsSpec, reader: asyncio.StreamReader) -> bytes | None:
        """The finished PCM, or None when the client left first."""
        tts = self.services.tts
        voice = tts.voice_aliases[spec.voice]
        self.tts_pending += 1
        try:
            cf = self.services.tts_pool.submit(_synthesize_blocking, tts, spec.text, spec.speed, voice)
            fut = asyncio.wrap_future(cf)
            watcher = asyncio.ensure_future(_wait_eof(reader))
            try:
                done, _ = await asyncio.wait({fut, watcher}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                watcher.cancel()
            if fut not in done:
                cf.cancel()                         # still queued: never started; already running: its result is dropped
                fut.add_done_callback(_swallow)
                LOG.info('tts: the client left before the audio was ready')
                return None
            try:
                return fut.result()
            except UnsupportedText:
                raise HttpError(400, 'the text has characters the voice cannot say') from None
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOG.warning('tts: synthesis failed: %s', describe(exc))
                raise HttpError(500, 'synthesis failed') from None
        finally:
            self.tts_pending -= 1

    @staticmethod
    async def _send_audio(writer: asyncio.StreamWriter, pcm: bytes) -> tuple[int, int]:
        chunks = chunk_pcm(pcm)
        writer.write(response_head(200, [('Content-Type', 'application/octet-stream'), ('Transfer-Encoding', 'chunked'), ('Cache-Control', 'no-store'),
                                         ('X-Audio-Format', 'pcm_s16le; rate=24000; channels=1')]))
        sent = 0
        try:
            for chunk in chunks:
                if writer.is_closing():
                    break
                writer.write(b'%x\r\n' % len(chunk) + chunk + b'\r\n')
                await writer.drain()
                sent += 1
                await asyncio.sleep(0)
            else:
                writer.write(b'0\r\n\r\n')
                await writer.drain()
        except (ConnectionError, OSError):
            pass
        return sent, len(chunks)


def _synthesize_blocking(tts, text: str, speed: float, voice: str) -> bytes:
    """Runs on the TTS pool: the engine's samples, as 24 kHz PCM."""
    pcm = pcm16_24k(tts.synthesize(text, speed, voice), tts.sample_rate)
    if not pcm:
        raise RuntimeError('the engine made no audio')
    return pcm
