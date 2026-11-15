"""serve.py: the blind listening test's local server. It serves the test's folder (index.html, manifest.json, clips/) on 127.0.0.1 ONLY and takes one POST, /save, which writes the listener's answers into
<root>/results/. Nothing is fetched from or sent to any other machine. The answer key (which clip is which condition) is NOT in the served folder.

    python serve.py [--root D:\\tai-voice-local\\listening-test-20261115\\site] [--port 8765]
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import sys
import time


def make_handler(root: str, results: str):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store')
            super().end_headers()

        def log_message(self, fmt, *args):   # no per-request noise, and never a path with an answer in it
            pass

        def do_POST(self):
            if self.path != '/save':
                self.send_error(404)
                return
            n = int(self.headers.get('content-length') or 0)
            if n <= 0 or n > 200_000:
                self.send_error(413)
                return
            try:
                data = json.loads(self.rfile.read(n))
                if not isinstance(data.get('ratings'), dict) or not isinstance(data.get('order'), list):
                    raise ValueError('shape')
                who = re.sub(r'[^A-Za-z0-9_-]+', '_', str(data.get('participant', 'anonymous')))[:40] or 'anonymous'
                os.makedirs(results, exist_ok=True)
                name = '%s-%s.json' % (who, time.strftime('%Y%m%d-%H%M%S'))
                with open(os.path.join(results, name), 'w', encoding='utf-8') as f:
                    json.dump(data, f, indent=1)
                body = json.dumps({'ok': True, 'file': os.path.join(results, name)}).encode()
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                self.send_error(400)

    return Handler


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=r'D:\tai-voice-local\listening-test-20261115\site')
    ap.add_argument('--port', type=int, default=8765)
    a = ap.parse_args()
    results = os.path.join(os.path.dirname(os.path.abspath(a.root)), 'results')
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', a.port), make_handler(os.path.abspath(a.root), results))
    print('listening test on http://127.0.0.1:%d/  (answers go to %s)' % (a.port, results), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
