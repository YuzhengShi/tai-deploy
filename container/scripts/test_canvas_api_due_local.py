"""container/scripts/canvas_api.py against a stand-in Canvas: the student's own clock (due_local) next to due_pacific.

The real script is run as the container runs it (JSON on stdin, JSON on stdout, the credentials and TAI_STUDENT_TZ in the environment),
against a small HTTP server in this process that answers like Canvas (the shapes of container/agent-runner/test/fixtures/tool-results.json).
Run: python container/scripts/test_canvas_api_due_local.py   (needs the `requests` package, which the agent image has)
"""
import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from datetime import datetime, timedelta, timezone  # noqa: E402

from pacific_time import student_zone  # noqa: E402

try:
    import requests  # noqa: F401
    HAVE_REQUESTS = True
except ImportError:
    HAVE_REQUESTS = False


def assignment(aid, name, due):
    return {'id': aid, 'name': name, 'due_at': due, 'points_possible': 30, 'submission_types': ['online_text_entry'],
            'html_url': 'https://canvas.example.edu/courses/1/assignments/%d' % aid, 'published': True}


ASSIGNMENTS = [
    assignment(101, 'Homework 6: Scalability?', '2026-11-02T17:00:00Z'),      # Pacific: Mon Nov 2, 9:00 AM PST
    assignment(102, 'Midterm Mastery Part 2', '2026-11-06T17:00:00Z'),        # Pacific: Fri Nov 6, 9:00 AM PST; its submission cannot be read (HTTP 500)
    assignment(103, 'Reading response', None),                                 # no due date
]
SUBMISSION = {'user_id': 7, 'score': 27.5, 'grade': '27.5', 'late': False, 'missing': False, 'submitted_at': '2026-11-01T20:00:00Z'}


class StandInCanvas(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parts = urlparse(self.path).path.rstrip('/').split('/')          # '', 'api', 'v1', 'courses', '1', 'assignments', ...
        tail = parts[5:]
        if tail == ['assignments']:
            return self.reply(200, ASSIGNMENTS)
        if len(tail) == 2 and tail[0] == 'assignments':
            found = [a for a in ASSIGNMENTS if str(a['id']) == tail[1]]
            return self.reply(200, dict(found[0], description='<p>See the course page.</p>', rubric=None) if found else {'errors': 'not found'})
        if len(tail) == 4 and tail[0] == 'assignments' and tail[2] == 'submissions':
            return self.reply(500 if tail[1] == '102' else 200, {'errors': 'broken'} if tail[1] == '102' else SUBMISSION)
        self.reply(404, {'errors': 'not found'})


def vancouver_stays_on_utc_minus_7():
    zone = student_zone('America/Vancouver')
    return zone is not None and datetime(2026, 12, 1, 20, tzinfo=timezone.utc).astimezone(zone).utcoffset() == timedelta(hours=-7)


@unittest.skipUnless(HAVE_REQUESTS, 'canvas_api.py needs the requests package')
class CanvasApiDueLocal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), StandInCanvas)
        cls.base = 'http://127.0.0.1:%d/api/v1' % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def run_script(self, action, params=None, tz=None):
        env = {k: v for k, v in os.environ.items() if k != 'TAI_STUDENT_TZ' and 'proxy' not in k.lower()}
        env.update({'CANVAS_API_TOKEN': 'test-token', 'CANVAS_BASE_URL': self.base, 'CANVAS_COURSE_ID': '1', 'NO_PROXY': '127.0.0.1'})
        if tz is not None:
            env['TAI_STUDENT_TZ'] = tz
        done = subprocess.run([sys.executable, str(HERE / 'canvas_api.py')], input=json.dumps({'action': action, 'params': params or {}}),
                              capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return json.loads(done.stdout)

    @staticmethod
    def stable(items):
        """Without due_relative, which counts from the clock of the machine that runs the test."""
        return [{k: v for k, v in item.items() if k != 'due_relative'} for item in items]

    def test_without_the_variable_the_answer_is_what_it_was(self):
        listed = self.run_script('assignments')
        self.assertEqual([list(a) for a in listed], [['id', 'name', 'due_at', 'due_pacific', 'due_relative', 'points_possible', 'submission_types', 'html_url', 'published']] * 3)
        self.assertEqual([a['due_pacific'] for a in listed], ['Mon Nov 2, 9:00 AM PST', 'Fri Nov 6, 9:00 AM PST', None])

    def test_a_clock_like_los_angeles_and_a_value_that_is_no_zone_change_nothing(self):
        plain = self.stable(self.run_script('assignments'))
        for tz in ('America/Los_Angeles', 'Not/AZone', 'UTC+8', '', '../../etc/passwd'):
            if tz == 'America/Los_Angeles' and student_zone(tz) is None:
                continue
            self.assertEqual(self.stable(self.run_script('assignments', tz=tz)), plain, tz)
            self.assertEqual(self.stable(self.run_script('my_grades', {'user_id': '7'}, tz=tz)), self.stable(self.run_script('my_grades', {'user_id': '7'})), tz)

    def test_a_student_in_auckland_gets_due_local_between_due_pacific_and_due_relative(self):
        if student_zone('Pacific/Auckland') is None:
            self.skipTest('no time zone data for Pacific/Auckland on this machine')
        listed = self.run_script('assignments', tz='Pacific/Auckland')
        self.assertEqual([list(a)[:7] for a in listed][0], ['id', 'name', 'due_at', 'due_pacific', 'due_local', 'due_relative', 'points_possible'])
        self.assertEqual([a.get('due_local') for a in listed], ['Tue Nov 3, 6:00 AM (Pacific/Auckland, UTC+13)', 'Sat Nov 7, 6:00 AM (Pacific/Auckland, UTC+13)', None])
        self.assertNotIn('due_local', listed[2])                                      # no due date: the key is absent, not null
        self.assertEqual([a['due_pacific'] for a in listed], ['Mon Nov 2, 9:00 AM PST', 'Fri Nov 6, 9:00 AM PST', None])
        # nothing else moved
        plain = self.run_script('assignments')
        self.assertEqual(self.stable([{k: v for k, v in a.items() if k != 'due_local'} for a in listed]), self.stable(plain))
        self.assertEqual(self.run_script('upcoming', tz='Pacific/Auckland')[0]['due_local'], listed[0]['due_local'])

    def test_my_grades_carries_it_in_both_branches(self):
        if student_zone('Pacific/Auckland') is None:
            self.skipTest('no time zone data for Pacific/Auckland on this machine')
        grades = self.run_script('my_grades', {'user_id': '7'}, tz='Pacific/Auckland')
        self.assertEqual([g['assignment'] for g in grades], ['Homework 6: Scalability?', 'Midterm Mastery Part 2', 'Reading response'])
        self.assertEqual([g.get('due_local') for g in grades], ['Tue Nov 3, 6:00 AM (Pacific/Auckland, UTC+13)', 'Sat Nov 7, 6:00 AM (Pacific/Auckland, UTC+13)', None])
        self.assertEqual(grades[1]['error'], 'Could not fetch submission')            # the branch whose submission could not be read
        self.assertEqual(grades[0]['score'], 27.5)
        self.assertEqual(list(grades[1])[:6], ['assignment', 'due_at', 'due_pacific', 'due_local', 'due_relative', 'points_possible'])

    def test_assignment_detail_now_says_its_pacific_time_and_the_students(self):
        if student_zone('Pacific/Auckland') is None:
            self.skipTest('no time zone data for Pacific/Auckland on this machine')
        plain = self.run_script('assignment_detail', {'assignment_id': '101'})
        self.assertEqual(plain['due_pacific'], 'Mon Nov 2, 9:00 AM PST')
        self.assertNotIn('due_local', plain)
        detail = self.run_script('assignment_detail', {'assignment_id': '101'}, tz='Pacific/Auckland')
        self.assertEqual(detail['due_local'], 'Tue Nov 3, 6:00 AM (Pacific/Auckland, UTC+13)')
        self.assertEqual(detail['description'], '<p>See the course page.</p>')       # what was there is still there
        self.assertEqual(detail['due_at'], '2026-11-02T17:00:00Z')

    @unittest.skipUnless(vancouver_stays_on_utc_minus_7(), 'needs the time zone data of 2026e or later (British Columbia on UTC-7 all year): the agent image has it')
    def test_a_student_in_vancouver_after_the_first_of_november(self):
        listed = self.run_script('upcoming', tz='America/Vancouver')
        self.assertEqual(listed[0]['due_pacific'], 'Mon Nov 2, 9:00 AM PST')
        self.assertEqual(listed[0]['due_local'], 'Mon Nov 2, 10:00 AM (America/Vancouver, UTC-7)')


if __name__ == '__main__':
    unittest.main()
