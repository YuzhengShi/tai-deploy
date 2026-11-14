"""What the tests share: synthetic audio, stand-in backends, the service running in a background thread on an ephemeral port, a raw-socket HTTP client (the chunk framing is the point of the /tts tests, and
`urllib` hides it), a websocket client, and a log capture. Nothing here needs a model."""
import asyncio
import json
import logging
import os
import socket
import sys
import threading
import time
from dataclasses import dataclass, replace

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                                   # deploy/cs6650/local-voice
REPO = os.path.abspath(os.path.join(ROOT, '..', '..', '..'))   # the repository (or worktree) root
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from localvoice.asr import Decoded                              # noqa: E402
from localvoice.config import Config                            # noqa: E402
from localvoice.httpd import App                                # noqa: E402
from localvoice.listen import DecodeGate                        # noqa: E402
from localvoice.keyterms import load_keyterms                   # noqa: E402
from localvoice.services import Services                        # noqa: E402
from localvoice.tts import ST_ALIASES, TtsBackend, UnsupportedText  # noqa: E402
from localvoice.vad import EnergyVadConfig, energy_factory      # noqa: E402

RATE = 16000


# ---------------------------------------------------------------- synthetic audio (16 kHz PCM16 little-endian)

def speech(seconds, level=3000.0, seed=1, dip_every=10):
    """Noise at RMS `level`, with one quiet frame (RMS 100, 20 ms) every `dip_every` frames: loud speech without a pause, like real speech in having minima. (Steady noise at one level would be taken
    by the VAD for the room's floor after half a second, and rejected: the floor is the quietest frame of the last two seconds.)"""
    n = int(seconds * RATE)
    frames = -(-n // 320)
    levels = np.full(frames, float(level))
    if dip_every:
        levels[dip_every - 1::dip_every] = 100.0
    envelope = np.repeat(levels, 320)[:n]
    rng = np.random.default_rng(seed)
    return np.clip(rng.normal(0, 1, n) * envelope, -32768, 32767).astype('<i2').tobytes()


def silence(seconds, level=0.0, seed=2):
    n = int(seconds * RATE)
    if level <= 0:
        return bytes(n * 2)
    rng = np.random.default_rng(seed)
    return np.clip(rng.normal(0, level, n), -32768, 32767).astype('<i2').tobytes()


def frames_of(pcm, size=640):
    return [pcm[i:i + size] for i in range(0, len(pcm), size)]


# ---------------------------------------------------------------- stand-in backends

class StubRecognizer:
    """Says 'seg1', 'seg2' ... in the order it is asked (or the texts it was given, or whatever `text_for(index, samples)` returns). Records how many samples each call had."""
    name = 'stub-asr'

    def __init__(self, texts=None, text_for=None, delay=0.0, fail_calls=()):
        self.calls = []
        self._texts = list(texts) if texts else None
        self._text_for = text_for
        self._delay = delay
        self._fail = set(fail_calls)
        self._lock = threading.Lock()

    def decode(self, samples):
        with self._lock:
            index = len(self.calls)
            self.calls.append(len(samples))
        if self._delay:
            time.sleep(self._delay)
        if index in self._fail:
            raise RuntimeError('stub decode failure')
        if self._text_for is not None:
            text = self._text_for(index, samples)
        elif self._texts is not None and index < len(self._texts):
            text = self._texts[index]
        else:
            text = 'seg%d' % (index + 1)
        return Decoded(text, 0.9)


class StubTts(TtsBackend):
    """A sine tone 0.05 s long per character (at the given speed), at 22.05 kHz so that the service has to resample. Records (text, speed, voice) of every call."""
    name = 'stub-tts'
    sample_rate = 22050
    voice_aliases = dict(ST_ALIASES)

    def __init__(self, delay=0.0, seconds_per_char=0.05):
        self.calls = []
        self._delay = delay
        self._spc = seconds_per_char
        self._lock = threading.Lock()

    def synthesize(self, text, speed, voice):
        with self._lock:
            self.calls.append((text, speed, voice))
        if self._delay:
            time.sleep(self._delay)
        if 'UNSUPPORTED' in text:
            raise UnsupportedText()
        if 'BOOM' in text:
            raise RuntimeError('stub synthesis failure')
        n = max(1, int(self.sample_rate * self._spc * len(text) / speed))
        t = np.arange(n) / self.sample_rate
        return (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)


def make_config(**overrides):
    return replace(Config(), port=0, **overrides)


def make_services(recognizer=None, tts=None, asr_workers=3, tts_workers=3):
    from concurrent.futures import ThreadPoolExecutor
    return Services(
        recognizer=recognizer or StubRecognizer(),
        tts=tts or StubTts(),
        asr_pool=ThreadPoolExecutor(max_workers=asr_workers, thread_name_prefix='test-asr'),
        tts_pool=ThreadPoolExecutor(max_workers=tts_workers, thread_name_prefix='test-tts'),
        vad_factory=energy_factory(EnergyVadConfig()),
        keyterms=load_keyterms(os.path.join(ROOT, 'keyterms.json')),
        gate=DecodeGate(asr_workers),
    )


# ---------------------------------------------------------------- the service in a thread

class RunningServer:
    def __init__(self, services=None, cfg=None):
        self.services = services or make_services()
        self.cfg = cfg or make_config()
        self.app = App(self.cfg, self.services)
        self.port = None
        self.loop = None
        self._error = None
        self._started = threading.Event()
        self._thread = threading.Thread(target=self._run, name='test-server', daemon=True)

    def _run(self):
        loop = asyncio.new_event_loop()
        self.loop = loop
        asyncio.set_event_loop(loop)
        try:
            server = loop.run_until_complete(self.app.start('127.0.0.1', 0))
            self.port = server.sockets[0].getsockname()[1]
        except BaseException as exc:      # noqa: BLE001
            self._error = exc
            self._started.set()
            return
        self._started.set()
        loop.run_forever()
        server.close()
        # cancel until nothing is left: a cancelled task needs another turn of the loop to finish, and finishing may start another (a close that waits); a task left pending when the loop is closed
        # is reported when it is garbage collected, which can be in the middle of some other test
        for _ in range(10):
            pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
            if not pending:
                break
            for task in pending:
                task.cancel()
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        try:
            loop.run_until_complete(asyncio.wait_for(server.wait_closed(), 3))
        except Exception:                 # noqa: BLE001
            pass
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()

    def __enter__(self):
        self._thread.start()
        if not self._started.wait(15):
            raise RuntimeError('the test server did not start')
        if self._error:
            raise self._error
        return self

    def __exit__(self, *exc):
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(15)
        self.services.shutdown()


class LogCapture(logging.Handler):
    """Every record any logger emits while it is installed (the root logger, at DEBUG), as formatted text: the privacy tests search it."""

    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []
        self.records = []

    def emit(self, record):
        self.records.append(record)
        self.lines.append(self.format(record))

    def __enter__(self):
        root = logging.getLogger()
        self._old_level = root.level
        root.setLevel(logging.DEBUG)
        root.addHandler(self)
        return self

    def __exit__(self, *exc):
        root = logging.getLogger()
        root.removeHandler(self)
        root.setLevel(self._old_level)

    @property
    def text(self):
        return '\n'.join(self.lines)


# ---------------------------------------------------------------- raw HTTP

@dataclass
class RawResponse:
    status: int
    reason: str
    headers: dict
    body: bytes
    #: the payload of each HTTP chunk, in order (empty for an answer that is not chunked)
    chunks: list
    t_head: float
    t_first_byte: float
    t_total: float


def _dechunk(raw):
    """(list of chunk payloads, whether the terminating chunk was seen)"""
    chunks, pos = [], 0
    while True:
        end = raw.find(b'\r\n', pos)
        if end < 0:
            return chunks, False
        size = int(raw[pos:end].split(b';')[0], 16)
        pos = end + 2
        if size == 0:
            return chunks, True
        if len(raw) < pos + size + 2:
            return chunks, False
        chunks.append(raw[pos:pos + size])
        pos += size + 2


def request_bytes(method, path, body=None, headers=None, host='127.0.0.1'):
    lines = ['%s %s HTTP/1.1' % (method, path), 'Host: %s' % host]
    h = dict(headers or {})
    if body is not None and not any(k.lower() == 'content-length' for k in h):
        h['Content-Length'] = str(len(body))
    lines += ['%s: %s' % kv for kv in h.items()]
    return ('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1') + (body or b'')


def raw_request(port, method, path, body=None, headers=None, timeout=15, raw=None):
    """One request on a fresh socket, read to the end of the connection (every answer is `Connection: close`)."""
    t0 = time.perf_counter()
    with socket.create_connection(('127.0.0.1', port), timeout=timeout) as s:
        s.sendall(raw if raw is not None else request_bytes(method, path, body, headers))
        buf = b''
        t_head = t_first = None
        while True:
            try:
                data = s.recv(65536)
            except (ConnectionResetError, socket.timeout):
                break
            if not data:
                break
            buf += data
            now = time.perf_counter() - t0
            if t_head is None and b'\r\n\r\n' in buf:
                t_head = now
            if t_first is None and b'\r\n\r\n' in buf and len(buf) > buf.index(b'\r\n\r\n') + 4:
                t_first = now
        total = time.perf_counter() - t0
    head, _, rest = buf.partition(b'\r\n\r\n')
    lines = head.decode('latin-1').split('\r\n')
    _, status, *reason = lines[0].split(' ', 2)
    headers_out = {}
    for line in lines[1:]:
        k, _, v = line.partition(':')
        headers_out[k.strip().lower()] = v.strip()
    chunks = []
    body_out = rest
    if headers_out.get('transfer-encoding', '').lower() == 'chunked':
        chunks, _ = _dechunk(rest)
        body_out = b''.join(chunks)
    return RawResponse(int(status), ' '.join(reason), headers_out, body_out, chunks, t_head or total, t_first or total, total)


def tts_request(port, text='Hello there.', voice='af_bella', speed=None, **extra):
    payload = {'text': text, 'voice': voice}
    if speed is not None:
        payload['speed'] = speed
    payload.update(extra)
    return raw_request(port, 'POST', '/tts', json.dumps(payload).encode('utf-8'), {'Content-Type': 'application/json'})


# ---------------------------------------------------------------- websocket

def ws_connect(port, query='encoding=linear16&sample_rate=16000&language=en&label=test', **kw):
    from websockets.sync.client import connect
    # legacy=True: the connection itself, usable with or without `with` (the library's newer style wants `with` and warns otherwise)
    return connect('ws://127.0.0.1:%d/v1/listen?%s' % (port, query), open_timeout=5, compression=None, legacy=True, **kw)


def send_audio(ws, pcm, size=640):
    for piece in frames_of(pcm, size):
        ws.send(piece)


def collect(ws, until, timeout=8.0):
    """Reads JSON messages until `until(messages)` is true or `timeout` passes. Returns what was read (a closed connection ends it too)."""
    from websockets.exceptions import ConnectionClosed
    messages = []
    deadline = time.monotonic() + timeout
    while not until(messages):
        left = deadline - time.monotonic()
        if left <= 0:
            break
        try:
            messages.append(json.loads(ws.recv(timeout=left)))
        except TimeoutError:
            break
        except ConnectionClosed:
            break
    return messages


def finals(messages):
    return [m for m in messages if m.get('type') == 'Results' and m.get('speech_final')]


def transcript(msg):
    return msg['channel']['alternatives'][0]['transcript']
