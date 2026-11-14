"""The entry point's life cycle: it comes up, serves, and goes down promptly even while a call is in progress."""
import asyncio
import threading
import time
import unittest

from tests.helpers import StubRecognizer, StubTts, collect, make_config, make_services, raw_request, send_audio, silence, speech, ws_connect
import server


class ServeTests(unittest.TestCase):
    def start(self):
        info = {}
        up = threading.Event()

        def run():
            services = make_services(StubRecognizer(), StubTts())

            async def main():
                info['loop'] = asyncio.get_running_loop()
                info['stop'] = asyncio.Event()
                await server.serve(make_config(), services, stop=info['stop'], on_listen=lambda port: (info.__setitem__('port', port), up.set()))

            try:
                asyncio.run(main())           # as the real entry point runs it: what is still running when serve() returns is cancelled and awaited
            finally:
                info['done'] = True
                services.shutdown()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.assertTrue(up.wait(10))
        return info, thread

    def test_it_serves_and_then_stops_within_a_moment_with_a_connection_open(self):
        info, thread = self.start()
        self.assertEqual(raw_request(info['port'], 'GET', '/health').status, 200)
        ws = ws_connect(info['port'])
        send_audio(ws, speech(0.8) + silence(1.2))
        self.assertTrue(collect(ws, lambda m: any(x.get('type') == 'UtteranceEnd' for x in m)))
        t0 = time.monotonic()
        info['loop'].call_soon_threadsafe(info['stop'].set)
        thread.join(8)
        self.assertFalse(thread.is_alive(), 'serve() did not return: it is waiting for a client to leave')
        self.assertLess(time.monotonic() - t0, 6)
        self.assertTrue(info.get('done'))
        ws.close()


if __name__ == '__main__':
    unittest.main()
