"""`/v1/listen` over a real websocket, against the service running with stand-in backends. The messages are fed to a Python port of the lab client's joiner (tests/joiner.py), so what is asserted is what
the engine would hear."""
import json
import socket
import time
import unittest

from websockets.exceptions import ConnectionClosed, InvalidStatus

from tests.helpers import (RATE, LogCapture, RunningServer, StubRecognizer, StubTts, collect, finals, frames_of, make_config, make_services, raw_request, send_audio, silence, speech, transcript,
                           ws_connect)
from tests.joiner import UtteranceJoiner, events_of, read_results
from localvoice.segmenter import SegmenterConfig

RESULT_KEYS = {'type', 'duration', 'start', 'is_final', 'speech_final', 'from_finalize', 'channel'}


def has_end(messages):
    return any(m.get('type') == 'UtteranceEnd' for m in messages)


def service(texts=None, cfg=None, **rec):
    return RunningServer(make_services(StubRecognizer(texts, **rec)), cfg)


def drain(ws):
    """Whatever has arrived, without waiting."""
    out = []
    while True:
        try:
            out.append(json.loads(ws.recv(timeout=0)))
        except TimeoutError:
            return out
        except ConnectionClosed:
            return out


class MessageTests(unittest.TestCase):
    def test_one_utterance_is_a_partial_a_final_and_an_utterance_end_in_the_shape_the_client_reads(self):
        with service(['hello world']) as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(1.0) + silence(1.2))
            msgs = collect(ws, has_end)
        self.assertEqual([m['type'] for m in msgs], ['Results', 'Results', 'UtteranceEnd'])
        partial, final, end = msgs
        for m in (partial, final):
            self.assertEqual(set(m), RESULT_KEYS)
            alt = m['channel']['alternatives']
            self.assertEqual(len(alt), 1)
            self.assertEqual(set(alt[0]), {'transcript', 'confidence'})
            self.assertIsInstance(alt[0]['transcript'], str)
            self.assertIsInstance(alt[0]['confidence'], float)
            for flag in ('is_final', 'speech_final', 'from_finalize'):
                self.assertIsInstance(m[flag], bool)
            self.assertIsInstance(m['start'], float)
            self.assertIsInstance(m['duration'], float)
        self.assertEqual((partial['is_final'], partial['speech_final'], partial['from_finalize']), (False, False, False))
        self.assertEqual((final['is_final'], final['speech_final'], final['from_finalize']), (True, True, False))
        self.assertEqual(transcript(partial), 'hello world')
        self.assertEqual(transcript(final), 'hello world')
        self.assertAlmostEqual(final['start'], 0.0, delta=0.05)
        self.assertAlmostEqual(final['duration'], 1.2, delta=0.1)       # the segment: its speech and the 200 ms of silence kept after it
        self.assertEqual(set(end), {'type', 'last_word_end'})
        self.assertEqual(events_of(msgs), [('partial', 'hello world'), ('final', 'hello world')])

    def test_the_text_of_an_utterance_grows_by_segment_and_the_final_is_the_whole(self):
        with service() as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(0.8) + silence(0.46) + speech(0.8) + silence(1.2))
            msgs = collect(ws, has_end)
        self.assertEqual([transcript(m) for m in msgs if m['type'] == 'Results'], ['seg1', 'seg1 seg2', 'seg1 seg2'])
        self.assertEqual([m['is_final'] for m in msgs if m['type'] == 'Results'], [False, False, True])
        self.assertEqual(events_of(msgs), [('partial', 'seg1'), ('partial', 'seg1 seg2'), ('final', 'seg1 seg2')])

    def test_two_utterances_come_in_order_and_do_not_mix(self):
        with service() as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(0.8) + silence(1.0) + speech(0.8) + silence(1.0))
            msgs = collect(ws, lambda m: len([x for x in m if x['type'] == 'UtteranceEnd']) == 2)
        self.assertEqual([m['type'] for m in msgs], ['Results', 'Results', 'UtteranceEnd', 'Results', 'Results', 'UtteranceEnd'])
        self.assertEqual([transcript(m) for m in finals(msgs)], ['seg1', 'seg2'])
        self.assertEqual(events_of(msgs), [('partial', 'seg1'), ('final', 'seg1'), ('partial', 'seg2'), ('final', 'seg2')])

    def test_speech_the_recognizer_hears_as_nothing_sends_nothing(self):
        with service(['']) as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(0.8) + silence(1.2))
            msgs = collect(ws, lambda m: False, timeout=1.0)
        self.assertEqual(msgs, [])

    def test_a_blip_and_noise_send_nothing(self):
        with service() as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(0.1) + silence(1.5))
            self.assertEqual(collect(ws, lambda m: False, timeout=1.0), [])
        self.assertEqual(srv.services.recognizer.calls, [])

    def test_unknown_query_parameters_are_ignored(self):
        with service() as srv, ws_connect(srv.port, 'encoding=linear16&sample_rate=16000&language=zh&label=x&model=nova-3&punctuate=true&utterance_end_ms=1000') as ws:
            send_audio(ws, speech(0.8) + silence(1.2))
            self.assertTrue(has_end(collect(ws, has_end)))

    def test_an_address_with_no_query_at_all_works(self):
        # the operator's `tai_live.sh set` takes no `?` or `&` in a value, so the lab is pointed at the bare address
        from websockets.sync.client import connect
        with service() as srv, connect('ws://127.0.0.1:%d/v1/listen' % srv.port, open_timeout=5, compression=None, legacy=True) as ws:
            send_audio(ws, speech(0.8) + silence(1.2))
            msgs = collect(ws, has_end)
        self.assertEqual(events_of(msgs), [('partial', 'seg1'), ('final', 'seg1')])


class ControlMessageTests(unittest.TestCase):
    def test_finalize_ends_the_utterance_now_and_says_so(self):
        with service() as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(0.6))
            ws.send(json.dumps({'type': 'Finalize'}))
            msgs = collect(ws, lambda m: bool(finals(m)))
            final = finals(msgs)[0]
            self.assertEqual((final['is_final'], final['speech_final'], final['from_finalize']), (True, True, True))
            self.assertEqual(transcript(final), 'seg1')
            self.assertEqual(events_of(msgs), [('partial', 'seg1'), ('final', 'seg1')])
            self.assertEqual(collect(ws, lambda m: False, timeout=0.5), [])            # no UtteranceEnd after an answer to a Finalize
            send_audio(ws, speech(0.6) + silence(1.0))                                     # and the next utterance starts afresh
            msgs = collect(ws, has_end)
            self.assertEqual([transcript(m) for m in finals(msgs)], ['seg2'])

    def test_finalize_with_nothing_pending_is_answered_with_an_empty_transcript_the_client_ignores(self):
        with service() as srv, ws_connect(srv.port) as ws:
            ws.send(json.dumps({'type': 'Finalize'}))
            msgs = collect(ws, lambda m: bool(m))
        self.assertEqual(len(msgs), 1)
        self.assertEqual((msgs[0]['is_final'], msgs[0]['speech_final'], msgs[0]['from_finalize']), (True, True, True))
        self.assertEqual(transcript(msgs[0]), '')
        self.assertEqual(events_of(msgs), [])

    def test_close_stream_flushes_and_then_closes_normally(self):
        with service() as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(0.6))
            ws.send(json.dumps({'type': 'CloseStream'}))
            msgs = collect(ws, lambda m: False, timeout=5)
            self.assertEqual(ws.protocol.close_code, 1000)
        self.assertEqual([transcript(m) for m in finals(msgs)], ['seg1'])
        self.assertTrue(finals(msgs)[0]['from_finalize'])

    def test_the_lab_client_closes_with_a_close_stream_and_a_close_frame_at_once(self):
        with service() as srv:
            ws = ws_connect(srv.port)
            send_audio(ws, speech(0.6))
            ws.send(json.dumps({'type': 'CloseStream'}))
            ws.close(1000)
            time.sleep(0.5)
            for _ in range(50):                                                            # the slot is free again
                if srv.app.ws_active == 0:
                    break
                time.sleep(0.05)
            self.assertEqual(srv.app.ws_active, 0)
            with ws_connect(srv.port) as ws2:
                send_audio(ws2, speech(0.8) + silence(1.2))
                self.assertTrue(has_end(collect(ws2, has_end)))

    def test_keepalive_and_nonsense_text_messages_are_ignored(self):
        with service() as srv, ws_connect(srv.port) as ws:
            for text in ('{"type":"KeepAlive"}', 'not json', '[1,2]', '{"type":5}', '{}', '"Finalize"', '{"type":"Nope"}', 'é'):
                ws.send(text)
            self.assertEqual(collect(ws, lambda m: False, timeout=0.5), [])
            send_audio(ws, speech(0.8) + silence(1.2))
            self.assertTrue(has_end(collect(ws, has_end)))

    def test_audio_in_pieces_of_any_size_gives_the_same_result(self):
        with service() as srv, ws_connect(srv.port) as ws:
            pcm = speech(0.8) + silence(1.2)
            for size in (333, 641, 2, 1500):
                send_audio(ws, pcm, size)
                msgs = collect(ws, has_end)
                self.assertEqual([transcript(m) for m in finals(msgs)], ['seg%d' % ({333: 1, 641: 2, 2: 3, 1500: 4}[size])], size)

    def test_extra_key_terms_in_the_address_are_merged_with_the_services_own(self):
        with service(['we use open telemetry and map reduce']) as srv:
            with ws_connect(srv.port, 'encoding=linear16&sample_rate=16000&keyterm=OpenTelemetry&keyterm=consistent%20hashing') as ws:
                send_audio(ws, speech(0.8) + silence(1.2))
                msgs = collect(ws, has_end)
            self.assertEqual(transcript(finals(msgs)[0]), 'we use OpenTelemetry and MapReduce')
            srv.services.recognizer._texts = ['we use open telemetry and map reduce']
            srv.services.recognizer.calls.clear()
            with ws_connect(srv.port) as ws:
                send_audio(ws, speech(0.8) + silence(1.2))
                msgs = collect(ws, has_end)
            self.assertEqual(transcript(finals(msgs)[0]), 'we use open telemetry and MapReduce')

    def test_the_punctuation_of_the_recognizer_reaches_the_client_untouched(self):
        with service(['Can you explain what a mutex is?']) as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(0.8) + silence(1.2))
            msgs = collect(ws, has_end)
        self.assertEqual(transcript(finals(msgs)[0]), 'Can you explain what a mutex is?')


class LimitsAndRefusalsTests(unittest.TestCase):
    def test_the_connection_over_the_limit_is_accepted_and_closed_at_once_with_1013(self):
        with service(cfg=make_config(max_connections=2)) as srv:
            a = ws_connect(srv.port)
            b = ws_connect(srv.port)
            time.sleep(0.2)
            c = ws_connect(srv.port)
            with self.assertRaises(ConnectionClosed):
                c.recv(timeout=5)
            self.assertEqual(c.protocol.close_code, 1013)
            self.assertEqual(srv.app.ws_active, 2)
            a.close()
            for _ in range(60):
                if srv.app.ws_active == 1:
                    break
                time.sleep(0.05)
            with ws_connect(srv.port) as d:                                                  # a slot has come free
                send_audio(d, speech(0.8) + silence(1.2))
                self.assertTrue(has_end(collect(d, has_end)))
            b.close()

    def test_a_format_the_service_does_not_speak_is_refused_before_the_upgrade(self):
        with service() as srv:
            for query in ('encoding=mulaw&sample_rate=8000', 'encoding=linear16&sample_rate=8000', 'encoding=opus', 'sample_rate=44100', 'channels=2'):
                with self.assertRaises(InvalidStatus, msg=query) as cm:
                    ws_connect(srv.port, query)
                self.assertEqual(cm.exception.response.status_code, 400, query)

    def test_other_requests_to_the_websocket_path(self):
        with service() as srv:
            self.assertEqual(raw_request(srv.port, 'GET', '/v1/listen').status, 426)          # no upgrade header
            self.assertEqual(raw_request(srv.port, 'POST', '/v1/listen', b'{}', {'Content-Type': 'application/json'}).status, 426)
            from websockets.sync.client import connect
            with self.assertRaises(InvalidStatus) as cm:
                connect('ws://127.0.0.1:%d/v1/other' % srv.port, open_timeout=5)
            self.assertEqual(cm.exception.response.status_code, 404)

    def test_a_request_from_a_web_page_is_refused(self):
        with service() as srv:
            with self.assertRaises(InvalidStatus) as cm:
                ws_connect(srv.port, origin='http://evil.example')
            self.assertEqual(cm.exception.response.status_code, 403)
            self.assertEqual(raw_request(srv.port, 'GET', '/health', headers={'Origin': 'http://evil.example'}).status, 403)

    def test_a_message_over_64_kib_closes_the_connection_with_1009(self):
        with service() as srv, ws_connect(srv.port) as ws:
            ws.send(bytes(70_000))
            collect(ws, lambda m: False, timeout=3)
            self.assertEqual(ws.protocol.close_code, 1009)
            self.assertEqual(srv.services.recognizer.calls, [])

    def test_garbage_on_the_port_does_no_harm(self):
        with service() as srv:
            for payload in (b'\x00\x01\x02garbage\r\n\r\n', b'GET\r\n\r\n', b'GET / HTTP/1.1\r\nNo colon here\r\n\r\n', b'\xff' * 5000, b'GET /' + b'a' * 20000 + b' HTTP/1.1\r\n\r\n'):
                with socket.create_connection(('127.0.0.1', srv.port), timeout=3) as s:
                    s.sendall(payload)
                    try:
                        s.recv(4096)
                    except OSError:
                        pass
            self.assertEqual(raw_request(srv.port, 'GET', '/health').status, 200)
            with ws_connect(srv.port) as ws:
                send_audio(ws, speech(0.8) + silence(1.2))
                self.assertTrue(has_end(collect(ws, has_end)))

    def test_a_connection_that_sends_no_request_is_dropped_by_the_head_timeout(self):
        import localvoice.httpd as httpd
        old = httpd.HEAD_TIMEOUT_S
        httpd.HEAD_TIMEOUT_S = 0.3
        try:
            with service() as srv, socket.create_connection(('127.0.0.1', srv.port), timeout=5) as s:
                data = s.recv(4096)
                self.assertTrue(data.startswith(b'HTTP/1.1 408'))
        finally:
            httpd.HEAD_TIMEOUT_S = old


class BackstopTests(unittest.TestCase):
    def test_the_idle_backstop_ends_an_utterance_whose_audio_stopped(self):
        with service(cfg=make_config(idle_commit_ms=500)) as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(0.8))                                    # no silence after it: audio time alone would never end this
            t0 = time.monotonic()
            msgs = collect(ws, has_end, timeout=5)
            self.assertLess(time.monotonic() - t0, 3.0)
        self.assertEqual([transcript(m) for m in finals(msgs)], ['seg1'])
        self.assertFalse(finals(msgs)[0]['from_finalize'])

    def test_keepalive_messages_do_not_postpone_the_idle_backstop(self):
        with service(cfg=make_config(idle_commit_ms=500)) as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(0.8))
            end = time.monotonic() + 0.9
            while time.monotonic() < end:
                ws.send('{"type":"KeepAlive"}')
                time.sleep(0.05)
            self.assertTrue(has_end(collect(ws, has_end, timeout=3)))

    def test_the_hard_cap_through_the_socket(self):
        cfg = make_config(segmenter=SegmenterConfig(max_utterance_ms=2000, interim_ms=0))
        with service(cfg=cfg) as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(3.0) + silence(1.0))
            msgs = collect(ws, lambda m: len(finals(m)) == 2)
        self.assertEqual([transcript(m) for m in finals(msgs)], ['seg1', 'seg2'])

    def test_a_dead_peer_is_dropped_and_a_live_one_is_kept_by_pings(self):
        cfg = make_config(ws_ping_s=0.2, ws_ping_timeout_s=0.2)
        with service(cfg=cfg) as srv:
            with ws_connect(srv.port) as live:
                dead = socket.create_connection(('127.0.0.1', srv.port), timeout=5)
                dead.sendall(b'GET /v1/listen HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
                head = b''
                while b'\r\n\r\n' not in head:
                    head += dead.recv(1024)
                self.assertTrue(head.startswith(b'HTTP/1.1 101'))
                time.sleep(1.5)                                          # the raw socket never answers a ping; the library's client does
                dead.settimeout(3)
                tail = b''
                try:
                    while True:
                        chunk = dead.recv(4096)
                        if not chunk:
                            break
                        tail += chunk
                except (ConnectionResetError, socket.timeout) as exc:
                    if isinstance(exc, socket.timeout):
                        self.fail('the dead peer was not dropped')
                dead.close()
                send_audio(live, speech(0.8) + silence(1.2))
                self.assertTrue(has_end(collect(live, has_end)))         # the live connection is still there after 1.5 s without audio


class RobustnessTests(unittest.TestCase):
    def test_a_failed_decode_loses_that_utterance_and_nothing_else(self):
        with LogCapture() as logs, service(fail_calls={0}) as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(0.8) + silence(1.2) + speech(0.8) + silence(1.2))
            msgs = collect(ws, has_end)
            self.assertEqual([transcript(m) for m in finals(msgs)], ['seg2'])
            self.assertEqual(len(srv.services.recognizer.calls), 2)
        self.assertIn('RuntimeError', logs.text)
        self.assertNotIn('stub decode failure', logs.text)               # the class and the place, never the message

    def test_a_slow_recognizer_and_a_full_queue_hold_the_sender_but_lose_nothing(self):
        cfg = make_config(max_pending_segments=1)
        with service(cfg=cfg, delay=0.05) as srv, ws_connect(srv.port) as ws:
            send_audio(ws, b''.join(speech(0.5, seed=i) + silence(0.7) for i in range(6)))
            msgs = collect(ws, lambda m: len(finals(m)) == 6, timeout=15)
        self.assertEqual([transcript(m) for m in finals(msgs)], ['seg%d' % i for i in range(1, 7)])

    def test_two_connections_at_once_are_independent(self):
        with service(text_for=lambda i, x: 'n%d' % len(x)) as srv:
            with ws_connect(srv.port) as a, ws_connect(srv.port) as b:
                send_audio(a, speech(0.8, seed=1) + silence(1.2))
                send_audio(b, speech(1.6, seed=2) + silence(1.2))
                ma = collect(a, has_end)
                mb = collect(b, has_end)
            ta, tb = transcript(finals(ma)[0]), transcript(finals(mb)[0])
        self.assertNotEqual(ta, tb)
        self.assertLess(int(ta[1:]), int(tb[1:]))                       # each got the text of its own audio

    def test_shutdown_drops_open_connections_instead_of_waiting_for_them(self):
        with service() as srv:
            ws = ws_connect(srv.port)
            time.sleep(0.2)
            self.assertEqual(srv.app.ws_active, 1)
            srv.loop.call_soon_threadsafe(srv.app.abort_all)
            with self.assertRaises(ConnectionClosed):
                ws.recv(timeout=5)
            for _ in range(60):
                if srv.app.open_sockets == 0:
                    break
                time.sleep(0.05)
            self.assertEqual((srv.app.ws_active, srv.app.open_sockets), (0, 0))

    def test_the_connection_count_comes_back_to_zero(self):
        with service() as srv:
            for _ in range(3):
                with ws_connect(srv.port) as ws:
                    send_audio(ws, speech(0.8) + silence(1.2))
                    collect(ws, has_end)
            for _ in range(60):
                if srv.app.ws_active == 0 and srv.app.open_sockets == 0:
                    break
                time.sleep(0.05)
            self.assertEqual((srv.app.ws_active, srv.app.open_sockets), (0, 0))


class InterimTests(unittest.TestCase):
    def test_a_long_stretch_gets_partials_while_it_goes_on_and_the_final_is_the_segments_text_alone(self):
        rec = dict(text_for=lambda i, x: 'long' if len(x) > 6.5 * RATE else 'short')
        with service(**rec) as srv, ws_connect(srv.port) as ws:
            seen = []
            for piece in frames_of(speech(7.0), 16000):                  # 0.5 s of audio every 0.12 s: faster than real time, but the recognizer is idle between pieces
                ws.send(piece)
                time.sleep(0.12)
                seen += drain(ws)
            seen += collect(ws, lambda m: False, timeout=0.3)
            ws.send(silence(1.2))
            rest = collect(ws, has_end)
        partials_while_speaking = [transcript(m) for m in seen if m['type'] == 'Results' and not m['is_final']]
        self.assertIn('short', partials_while_speaking)
        msgs = seen + rest
        self.assertEqual([transcript(m) for m in finals(msgs)], ['long'])           # the interims' text is not in the final, and is not doubled into it
        self.assertTrue(all(transcript(m) in ('short', 'long') for m in msgs if m['type'] == 'Results'))
        self.assertEqual(events_of(msgs)[-1], ('final', 'long'))

    def test_no_interim_is_started_while_the_decode_workers_are_busy_with_segments(self):
        rec = dict(text_for=lambda i, x: 'long' if len(x) > 6.5 * RATE else 'short')
        with service(**rec) as srv, ws_connect(srv.port) as ws:
            srv.services.gate.in_flight = 99               # as if the workers were full of other connections' segments
            seen = []
            for piece in frames_of(speech(7.0), 16000):
                ws.send(piece)
                time.sleep(0.12)
                seen += drain(ws)
            srv.services.gate.in_flight = 0
            ws.send(silence(1.2))
            msgs = seen + collect(ws, has_end)
        self.assertEqual([transcript(m) for m in msgs if m['type'] == 'Results'], ['long', 'long'])            # the segment's partial and the final: no interim was decoded
        self.assertEqual(len(srv.services.recognizer.calls), 1)                                                  # one decode in all: the segment's

    def test_an_interim_result_that_is_out_of_date_when_it_is_ready_is_not_sent(self):
        with service(['stale-interim', 'real'], delay=0.5) as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(3.1))                # the interim is offered at the first frame of speech after the 3.0 s mark and its decode (0.5 s) begins
            send_audio(ws, silence(0.3))               # the speaker has stopped for 300 ms (not yet the 350 ms that closes the segment) when the decode is ready
            time.sleep(1.0)
            send_audio(ws, silence(1.2))
            msgs = collect(ws, has_end, timeout=8)
        self.assertNotIn('stale-interim', json.dumps(msgs))
        self.assertEqual([transcript(m) for m in finals(msgs)], ['real'])

    def test_a_segment_does_not_wait_for_an_interim_decode_that_is_still_running(self):
        # the interim is offered with the first speech frame past 3.0 s and its decode takes 1.5 s; the pause closes the segment 350 ms later and the segment's own decode is quick: the segment's
        # partial must come with that decode (the owner's call of 2026-11-15: it waited for the interim, 1.2 to 1.45 s after the end of speech instead of 0.5 s)
        def slow_first(index, samples):
            if index == 0:
                time.sleep(1.5)
                return 'stale-interim'
            return 'real'
        with service(text_for=slow_first) as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(3.1))
            t0 = time.perf_counter()
            send_audio(ws, silence(1.2))
            first = collect(ws, lambda ms: any(m.get('type') == 'Results' for m in ms), timeout=8)
            waited = time.perf_counter() - t0
            msgs = first + collect(ws, has_end, timeout=8)
        self.assertEqual([transcript(m) for m in msgs if m['type'] == 'Results'], ['real', 'real'])             # the segment's partial and the final; the interim's text was thrown away
        self.assertLess(waited, 0.9)
        self.assertEqual(len(srv.services.recognizer.calls), 2)                                                    # the interim was decoded (its worker was free) and the segment

    def test_the_next_utterances_are_not_confused_by_an_interim_decode_that_finishes_late(self):
        def slow_first(index, samples):
            if index == 0:
                time.sleep(1.0)
                return 'stale-interim'
            return 'real%d' % index
        with service(text_for=slow_first) as srv, ws_connect(srv.port) as ws:
            send_audio(ws, speech(3.1) + silence(1.2))
            send_audio(ws, speech(1.0, seed=5) + silence(1.2))
            msgs = collect(ws, lambda ms: sum(1 for m in ms if m.get('type') == 'UtteranceEnd') >= 2, timeout=10)
            time.sleep(1.2)                                                          # the abandoned decode ends now; nothing of it may be sent
            msgs += collect(ws, lambda ms: False, timeout=0.3)
        self.assertNotIn('stale-interim', json.dumps(msgs))
        self.assertEqual([transcript(m) for m in finals(msgs)], ['real1', 'real2'])


class JoinerPortTests(unittest.TestCase):
    """The port of v1.ts's UtteranceJoiner behaves as the TypeScript tests pin it (src/voice/lab/ears/v1.test.ts)."""

    def results(self, text, **flags):
        return {'type': 'Results', 'channel': {'alternatives': [{'transcript': text}]}, **flags}

    def test_partials_final_and_the_repeat_rule(self):
        j = UtteranceJoiner()
        self.assertEqual(j.feed(read_results(self.results('hello'))), [('partial', 'hello')])
        self.assertEqual(j.feed(read_results(self.results('hello world', is_final=True))), [('partial', 'hello world')])
        self.assertEqual(j.feed(read_results(self.results('Hello, world!', is_final=True))), [('partial', 'Hello, world!')])    # the utterance so far, repeated: replaces
        self.assertEqual(j.feed(read_results(self.results('and more', is_final=True))), [('partial', 'Hello, world! and more')])
        # Deepgram's speech_final message is itself the last segment, not a repeat: it is appended
        self.assertEqual(j.feed(read_results(self.results('last bit', speech_final=True))), [('final', 'Hello, world! and more last bit')])

    def test_empty_text_makes_no_event_and_flags_may_be_strings(self):
        j = UtteranceJoiner()
        self.assertEqual(j.feed(read_results(self.results(''))), [])
        self.assertEqual(j.feed(read_results(self.results('  ', speech_final=True))), [])
        self.assertEqual(j.feed(read_results(self.results('x', speech_final='true'))), [('final', 'x')])

    def test_utterance_end_releases_what_waits_once(self):
        j = UtteranceJoiner()
        j.feed(read_results(self.results('part one', is_final=True)))
        self.assertEqual(j.flush(), [('final', 'part one')])
        self.assertEqual(j.flush(), [])

    def test_a_server_message_that_is_not_results_is_skipped(self):
        self.assertEqual(events_of([{'type': 'Metadata'}, {'type': 'SpeechStarted'}, {'type': 'Results'}]), [])


if __name__ == '__main__':
    unittest.main()
