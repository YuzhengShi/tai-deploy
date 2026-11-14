"""`POST /tts` and `GET /health` over a raw socket, against the service with a stand-in synthesizer (a sine tone 0.05 s long per character at 22.05 kHz, so that the service has to resample)."""
import json
import socket
import threading
import time
import unittest

import numpy as np

from tests.helpers import (LogCapture, RunningServer, StubRecognizer, StubTts, make_config, make_services, raw_request, request_bytes, tts_request)
from localvoice.tts import PIPER_ALIASES


def service(tts=None, cfg=None, **kw):
    return RunningServer(make_services(StubRecognizer(), tts or StubTts(**kw), tts_workers=(cfg.tts_workers if cfg else 3)), cfg)


def error_of(resp):
    body = json.loads(resp.body)
    assert list(body) == ['error'] or set(body) == {'error'}, body
    return body['error']


def pcm_of(resp):
    return np.frombuffer(resp.body, dtype='<i2')


class SuccessTests(unittest.TestCase):
    def test_the_answer_is_raw_24_khz_pcm_in_about_ten_chunks_and_never_a_fallback(self):
        with service() as srv:
            resp = tts_request(srv.port, 'x' * 60)                          # 60 characters: 3.0 s
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers['content-type'], 'application/octet-stream')
        self.assertEqual(resp.headers['transfer-encoding'], 'chunked')
        self.assertEqual(resp.headers['connection'], 'close')
        self.assertNotIn('x-tts-fallback', resp.headers)
        self.assertNotIn('content-length', resp.headers)
        self.assertEqual(len(resp.body), 144000)                             # 3.0 s at 24 kHz, 16 bit, mono
        self.assertEqual(len(resp.chunks), 10)
        self.assertTrue(all(len(c) % 2 == 0 for c in resp.chunks))
        self.assertEqual(resp.body[:4] == b'RIFF', False)

    def test_the_samples_are_the_tone_resampled_not_noise(self):
        with service() as srv:
            resp = tts_request(srv.port, 'x' * 60)
        x = pcm_of(resp).astype(np.float64)
        mid = x[3000:-3000]
        self.assertAlmostEqual(float(np.abs(mid).max()) / 32767, 0.3, delta=0.02)
        crossings = int(np.sum(np.diff(np.signbit(mid).astype(np.int8)) != 0))
        self.assertAlmostEqual(crossings / (len(mid) / 24000) / 2, 440, delta=10)

    def test_a_short_sentence_is_a_few_chunks_a_long_one_has_a_bounded_chunk_size(self):
        with service() as srv:
            short = tts_request(srv.port, 'hi')
            long = tts_request(srv.port, 'y' * 1000)                         # 50 s: 2.4 MB
        self.assertEqual(len(short.chunks), 1)
        self.assertEqual(len(long.body), 2_400_000)
        self.assertTrue(all(len(c) <= 65536 for c in long.chunks))
        self.assertGreater(len(long.chunks), 30)

    def test_the_voices_a_request_may_name(self):
        tts = StubTts()
        with service(tts) as srv:
            for voice in ('default', 'af_bella', 'af_heart', 'F1', 'F5', 'M1', 'M5'):
                self.assertEqual(tts_request(srv.port, 'hello there', voice).status, 200, voice)
            self.assertEqual(raw_request(srv.port, 'POST', '/tts', b'{"text":"hello there"}', {'Content-Type': 'application/json'}).status, 200)     # no voice: the default
            self.assertEqual(raw_request(srv.port, 'POST', '/tts', b'{"text":"hello there","voice":null,"speed":null}', {'Content-Type': 'application/json'}).status, 200)
        self.assertEqual([c[2] for c in tts.calls], ['F1', 'F1', 'F1', 'F1', 'F5', 'M1', 'M5', 'F1', 'F1'])      # the names are mapped to the backend's own ids
        self.assertEqual([c[1] for c in tts.calls][-1], 1.0)

    def test_other_voices_are_refused_without_being_repeated(self):
        with service() as srv:
            for voice in ('lessac', 'DrBerg', 'drberg', 'Dr_Berg', 'dr.berg', 'DR-BERG', 'nope', 'a b', 'x' * 65, '', 'F6', 'f1', 'AF_BELLA', '../../etc/passwd'):
                resp = tts_request(srv.port, 'hello there', voice)
                self.assertEqual(resp.status, 400, repr(voice))
                self.assertIn('unknown voice', error_of(resp))
                self.assertNotIn('berg', resp.body.decode().lower())
                if len(voice) > 3:
                    self.assertNotIn(voice, resp.body.decode())
            for voice in (123, True, ['F1'], {'a': 1}):
                self.assertEqual(tts_request(srv.port, 'hello there', voice).status, 400, repr(voice))

    def test_the_optional_voices_of_the_other_backend(self):
        class PiperLike(StubTts):
            voice_aliases = dict(PIPER_ALIASES)

        with service(PiperLike()) as srv:
            for voice in ('default', 'af_bella', 'lessac'):
                self.assertEqual(tts_request(srv.port, 'hello there', voice).status, 200, voice)
            self.assertEqual(tts_request(srv.port, 'hello there', 'F1').status, 400)
            self.assertEqual(tts_request(srv.port, 'hello there', 'af_heart').status, 400)

    def test_speed_reaches_the_engine_and_changes_the_length(self):
        tts = StubTts()
        with service(tts) as srv:
            normal = tts_request(srv.port, 'x' * 60)
            fast = tts_request(srv.port, 'x' * 60, speed=1.5)
            slow = tts_request(srv.port, 'x' * 60, speed=0.5)
            edge = [tts_request(srv.port, 'x' * 60, speed=s).status for s in (2.0, 0.5, 1, 2)]
        self.assertEqual([c[1] for c in tts.calls][:3], [1.0, 1.5, 0.5])
        self.assertAlmostEqual(len(fast.body) / len(normal.body), 1 / 1.5, delta=0.01)
        self.assertAlmostEqual(len(slow.body) / len(normal.body), 2.0, delta=0.01)
        self.assertEqual(edge, [200] * 4)

    def test_bad_speeds_are_refused(self):
        with service() as srv:
            for speed in (0.49, 2.01, 0, -1, 'fast', True, False, [1], {'a': 1}, '1.0'):
                resp = tts_request(srv.port, 'hello there', speed=speed)
                self.assertEqual(resp.status, 400, repr(speed))
                self.assertIn('speed', error_of(resp))
            for literal in (b'NaN', b'Infinity', b'-Infinity'):
                body = b'{"text":"hello there","voice":"F1","speed":' + literal + b'}'
                self.assertEqual(raw_request(srv.port, 'POST', '/tts', body, {'Content-Type': 'application/json'}).status, 400, literal)

    def test_text_checks(self):
        with service() as srv:
            for text in ('', '   ', '\n\t', 123, None, ['a'], {'a': 1}, True):
                resp = tts_request(srv.port, text)
                self.assertEqual(resp.status, 400, repr(text))
            self.assertEqual(raw_request(srv.port, 'POST', '/tts', b'{"voice":"F1"}', {'Content-Type': 'application/json'}).status, 400)
            self.assertEqual(tts_request(srv.port, 'a' * 1000).status, 200)
            over = tts_request(srv.port, 'a' * 1001)
            self.assertEqual(over.status, 400)
            self.assertIn('1000', error_of(over))
            lone = raw_request(srv.port, 'POST', '/tts', b'{"text":"bad \\ud800 surrogate"}', {'Content-Type': 'application/json'})
            self.assertEqual(lone.status, 400)

    def test_control_characters_are_not_sent_to_the_engine(self):
        tts = StubTts()
        with service(tts) as srv:
            tts_request(srv.port, 'a\x00b\x07c\x7fd\te\nf\rg')
        self.assertEqual(tts.calls[0][0], 'a b c d\te\nf\rg')

    def test_non_ascii_text_goes_through_as_it_is(self):
        tts = StubTts()
        with service(tts) as srv:
            self.assertEqual(tts_request(srv.port, 'café 世界 \U0001f600').status, 200)
        self.assertEqual(tts.calls[0][0], 'café 世界 \U0001f600')

    def test_text_the_voice_cannot_say_is_a_400_and_an_engine_failure_a_500_and_neither_repeats_the_text(self):
        with LogCapture() as logs, service() as srv:
            bad = tts_request(srv.port, 'say UNSUPPORTED SECRETTEXT1')
            boom = tts_request(srv.port, 'BOOM SECRETTEXT2')
            ok = tts_request(srv.port, 'fine again')
        self.assertEqual((bad.status, boom.status, ok.status), (400, 500, 200))
        self.assertEqual(error_of(bad), 'the text has characters the voice cannot say')
        self.assertEqual(error_of(boom), 'synthesis failed')
        for resp in (bad, boom):
            self.assertNotIn(b'SECRETTEXT', resp.body)
        self.assertNotIn('SECRETTEXT', logs.text)
        self.assertIn('RuntimeError', logs.text)                            # the class of the failure is logged, not its message
        self.assertNotIn('stub synthesis failure', logs.text)


class RequestRulesTests(unittest.TestCase):
    def post(self, srv, body, headers=None, **kw):
        h = {'Content-Type': 'application/json'} if headers is None else headers
        return raw_request(srv.port, 'POST', '/tts', body, h, **kw)

    def test_bodies_that_are_not_requests(self):
        with service() as srv:
            for body in (b'not json', b'[1,2]', b'"text"', b'123', b'null', b'{', b'\xff\xfe', b'{"text": "hi",}', b'[' * 5000):
                resp = self.post(srv, body)
                self.assertEqual(resp.status, 400, body[:20])
                self.assertNotIn('not json', resp.body.decode())

    def test_the_headers_a_request_must_have(self):
        with service() as srv:
            body = json.dumps({'text': 'hello there'}).encode()
            self.assertEqual(self.post(srv, body, {'Content-Type': 'text/plain'}).status, 415)
            self.assertEqual(self.post(srv, body, {'Content-Type': 'application/x-www-form-urlencoded'}).status, 415)
            self.assertEqual(self.post(srv, body, {}).status, 415)
            self.assertEqual(self.post(srv, body, {'Content-Type': 'application/json; charset=utf-8'}).status, 200)
            self.assertEqual(self.post(srv, body, {'content-type': 'Application/JSON'}).status, 200)
            self.assertEqual(self.post(srv, body, {'Content-Type': 'application/json', 'Origin': 'http://evil.example'}).status, 403)
            self.assertEqual(raw_request(srv.port, 'POST', '/tts', raw=b'POST /tts HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n\r\n' + body).status, 411)
            self.assertEqual(self.post(srv, body, {'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked'}).status, 501)
            self.assertEqual(self.post(srv, body, {'Content-Type': 'application/json', 'Content-Length': 'abc'}).status, 400)
            self.assertEqual(raw_request(srv.port, 'POST', '/tts', raw=b'POST /tts HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\n12345').status, 400)

    def test_the_body_limit(self):
        with service() as srv:
            big = json.dumps({'text': 'a', 'pad': 'z' * 17000}).encode()
            self.assertEqual(self.post(srv, big).status, 413)
            ok = json.dumps({'text': 'a', 'pad': 'z' * 15000}).encode()
            self.assertEqual(self.post(srv, ok).status, 200)

    def test_methods_and_paths(self):
        with service() as srv:
            for method in ('GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'):
                resp = raw_request(srv.port, method, '/tts')
                self.assertEqual(resp.status, 405, method)
                self.assertEqual(resp.headers['allow'], 'POST')
            self.assertEqual(raw_request(srv.port, 'POST', '/health', b'{}', {'Content-Type': 'application/json'}).status, 405)
            self.assertEqual(raw_request(srv.port, 'GET', '/nothing').status, 404)
            self.assertEqual(raw_request(srv.port, 'GET', '/').status, 404)
            self.assertEqual(raw_request(srv.port, 'POST', '/tts/extra', b'{}', {'Content-Type': 'application/json'}).status, 404)
            self.assertEqual(self.post(srv, b'{"text":"hello there"}').status, 200)
            self.assertEqual(raw_request(srv.port, 'POST', '/tts?voice=x', b'{"text":"hello there"}', {'Content-Type': 'application/json'}).status, 200)   # a query is ignored

    def test_expect_100_continue_is_honoured(self):
        with service() as srv:
            body = b'{"text":"hello there"}'
            head = b'POST /tts HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: %d\r\n\r\n' % len(body)
            with socket.create_connection(('127.0.0.1', srv.port), timeout=5) as s:
                s.sendall(head)
                got = b''
                while b'\r\n\r\n' not in got:
                    got += s.recv(1024)
                self.assertTrue(got.startswith(b'HTTP/1.1 100 Continue'))
                s.sendall(body)
                rest = b''
                while True:
                    chunk = s.recv(65536)
                    if not chunk:
                        break
                    rest += chunk
            self.assertIn(b'HTTP/1.1 200 OK', rest)

    def test_errors_are_json_and_never_carry_anything_the_client_sent(self):
        marker = 'MARKER9f3a'
        with service() as srv:
            bodies = [
                json.dumps({'text': marker * 200}).encode(), json.dumps({'text': marker, 'voice': marker}).encode(), json.dumps({'text': marker, 'speed': marker}).encode(),
                json.dumps({marker: marker}).encode(), ('{"text": "%s",}' % marker).encode(), json.dumps([marker]).encode(),
            ]
            for body in bodies:
                resp = self.post(srv, body)
                self.assertGreaterEqual(resp.status, 400)
                self.assertEqual(resp.headers['content-type'], 'application/json')
                self.assertNotIn(marker.encode(), resp.body)
            for headers in ({'Content-Type': marker}, {'X-Thing': marker, 'Content-Type': 'application/json'}):
                resp = self.post(srv, b'{"text":"%s"}' % marker.encode(), headers)
                self.assertNotIn(marker.encode(), resp.body)

    def test_health(self):
        with service() as srv:
            resp = raw_request(srv.port, 'GET', '/health')
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers['content-type'], 'application/json')
        self.assertEqual(json.loads(resp.body), {'ok': True, 'asr': 'stub-asr', 'tts': 'stub-tts'})


class DisconnectAndLoadTests(unittest.TestCase):
    def open_request(self, srv, text='hello there', voice='F1'):
        s = socket.create_connection(('127.0.0.1', srv.port), timeout=5)
        body = json.dumps({'text': text, 'voice': voice}).encode()
        s.sendall(request_bytes('POST', '/tts', body, {'Content-Type': 'application/json'}))
        return s

    def quiet(self, logs):
        return [r for r in logs.records if r.levelno >= 30 or r.exc_info]

    def test_a_client_that_leaves_before_the_audio_is_ready_costs_nothing_and_leaves_nothing(self):
        with LogCapture() as logs, service(delay=0.4) as srv:
            s = self.open_request(srv)
            time.sleep(0.1)
            s.close()
            time.sleep(0.8)
            self.assertEqual(srv.app.tts_pending, 0)
            self.assertEqual(tts_request(srv.port, 'still works').status, 200)
        self.assertEqual(self.quiet(logs), [])

    def test_a_request_still_waiting_for_a_worker_when_its_client_leaves_is_never_synthesized(self):
        tts = StubTts(delay=0.6)
        cfg = make_config(tts_workers=1)
        with service(tts, cfg) as srv:
            first = self.open_request(srv, 'first request')
            time.sleep(0.15)                                              # the one worker is busy with it
            second = self.open_request(srv, 'second request')
            time.sleep(0.15)
            second.close()
            time.sleep(1.2)
            first.close()
            self.assertEqual(srv.app.tts_pending, 0)
        self.assertEqual([c[0] for c in tts.calls], ['first request'])

    def test_a_client_that_leaves_in_the_middle_of_the_audio(self):
        with LogCapture() as logs, service() as srv:
            s = self.open_request(srv, 'z' * 1000)                         # 50 s of audio, 2.4 MB: far more than the socket buffers hold
            s.settimeout(5)
            got = b''
            while b'\r\n\r\n' not in got:
                got += s.recv(4096)
            s.close()
            time.sleep(0.5)
            self.assertEqual(srv.app.tts_pending, 0)
            self.assertEqual(tts_request(srv.port, 'still works').status, 200)
            for _ in range(40):
                if srv.app.open_sockets == 0:
                    break
                time.sleep(0.05)
            self.assertEqual(srv.app.open_sockets, 0)
        self.assertEqual(self.quiet(logs), [])

    def test_a_flood_of_requests_gets_503_not_a_queue_without_end(self):
        cfg = make_config(max_tts_pending=1, tts_workers=1)
        with service(StubTts(delay=0.6), cfg) as srv:
            first = self.open_request(srv)
            time.sleep(0.2)
            resp = tts_request(srv.port, 'one too many')
            self.assertEqual(resp.status, 503)
            self.assertEqual(resp.headers['retry-after'], '1')
            first.close()
            time.sleep(1.0)
            self.assertEqual(tts_request(srv.port, 'after').status, 200)

    def test_requests_run_in_parallel_on_the_pool(self):
        results = []
        with service(StubTts(delay=0.4)) as srv:
            def go():
                results.append(tts_request(srv.port, 'parallel').status)
            t0 = time.perf_counter()
            threads = [threading.Thread(target=go) for _ in range(3)]
            [t.start() for t in threads]
            [t.join(10) for t in threads]
            took = time.perf_counter() - t0
        self.assertEqual(results, [200, 200, 200])
        self.assertLess(took, 1.0)                                         # three of 0.4 s each, in parallel (one after another they would take 1.2 s)

    def test_privacy_the_text_of_a_request_never_reaches_the_log(self):
        with LogCapture() as logs, service() as srv:
            tts_request(srv.port, 'SECRETSENTENCE alpha beta gamma', 'F1')
            tts_request(srv.port, 'SECRETSENTENCE two', 'nope')
            raw_request(srv.port, 'POST', '/tts', b'{"text": "SECRETSENTENCE three",}', {'Content-Type': 'application/json'})
            time.sleep(0.2)
        self.assertNotIn('SECRETSENTENCE', logs.text)
        self.assertIn('tts:', logs.text)                                   # but it does log that a request was served, with counts
        self.assertEqual([r for r in logs.records if r.exc_info], [])


if __name__ == '__main__':
    unittest.main()
