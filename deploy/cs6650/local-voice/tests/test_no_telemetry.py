"""The service must not let onnxruntime phone home (docs/LOCAL_VOICE.md, "Network"): the pip onnxruntime 1.32.0 carries a Microsoft OneCollector telemetry client that is on by default and is switched off
only by the environment variable ORT_DISABLE_TELEMETRY, which has to be set before the library is imported. The behaviour itself (no DNS question at all) is measured on a real container with
check_egress.sh; these tests keep the two places that set the variable from rotting."""
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TelemetryOffTests(unittest.TestCase):
    def test_importing_the_package_switches_it_off_even_over_a_stray_value(self):
        env = dict(os.environ, ORT_DISABLE_TELEMETRY='0', PYTHONDONTWRITEBYTECODE='1')
        out = subprocess.run([sys.executable, '-B', '-c', 'import localvoice, os; print(os.environ["ORT_DISABLE_TELEMETRY"])'], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(out.stdout.strip(), '1', out.stderr[-300:])

    def test_the_package_is_imported_before_onnxruntime_by_the_entry_point_and_the_backends(self):
        # server.py imports `localvoice` first; tts.py (a module of the package) imports the speech package lazily, so by then the variable is set. Importing the package must not itself import onnxruntime.
        code = 'import sys, localvoice, localvoice.tts, localvoice.asr; print("onnxruntime" in sys.modules)'
        out = subprocess.run([sys.executable, '-B', '-c', code], cwd=ROOT, env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'), capture_output=True, text=True, timeout=60)
        self.assertEqual(out.stdout.strip(), 'False', out.stderr[-300:])

    def test_the_image_sets_it_too(self):
        with open(os.path.join(ROOT, 'Dockerfile'), encoding='utf-8') as f:
            text = f.read()
        self.assertIn('ORT_DISABLE_TELEMETRY=1', text)


if __name__ == '__main__':
    unittest.main()
