"""container/scripts/canvas_api.py: a student is shown only the course files they could open in Canvas (docs/SECURITY.md, "Opening documents, the view and
the course library").

The script carries the instructor's token, and the instructor sees every file of the course. `files` and `file_content` therefore apply the student's rule themselves
outside the admin chat (NANOCLAW_IS_MAIN is exactly "1" there: container/agent-runner/src/access.ts). Three layers, none of which can reach a real Canvas:
  - the rule alone (why_not_for_students), run on canvas_file_visibility_cases.json: the table that src/docs/canvas-files.ts whySkipped, the viewer's copy of the
    same rule, was run on as well (a one-time check, listCanvasFiles on every row: 29 of 29 the same);
  - the two actions through handle() with a fake api_get that records every request, and read_attachment replaced by a recorder (a refused file must not be read);
  - the real script as the container runs it (JSON on stdin, JSON on stdout, the environment of the MCP server) against a stand-in Canvas on the loopback address,
    for the one thing that import cannot show: who the environment makes a student, and that a refused file's bytes are never asked for.
Run: python container/scripts/test_canvas_api_student_files.py   (needs the `requests` package, which the agent image has)
"""
import calendar
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

try:
    import requests
    HAVE_REQUESTS = True
except ImportError:
    HAVE_REQUESTS = False

TOKEN = 'test-token'
BASE = 'https://canvas.example.edu/api/v1'
os.environ.update(CANVAS_API_TOKEN=TOKEN, CANVAS_BASE_URL=BASE, CANVAS_COURSE_ID='1')    # the same values as test_week_status.py: the module is read once per process
os.environ.pop('TAI_STUDENT_TZ', None)
if HAVE_REQUESTS:
    import canvas_api

TABLE = json.loads((HERE / 'canvas_file_visibility_cases.json').read_text(encoding='utf-8'))
NOW_MS = calendar.timegm((2026, 11, 7, 12, 0, 0)) * 1000                      # TABLE['now'], worked out without the code under test
SENTENCE = 'This file is not available to students.'
NOT_MAIN = (None, '', '0', 'true', 'yes', 'TRUE', ' 1', '1 ', '01', 'main')   # everything that is not exactly "1"
LISTING_KEYS = ['id', 'display_name', 'filename', 'size', 'content_type', 'updated_at', 'url']


def file_object(file_id, **extra):
    """A file as Canvas describes it, complete: the flags and dates of a case go on top."""
    name = 'case-%d.pdf' % file_id
    return {'id': file_id, 'display_name': name, 'filename': name, 'content-type': 'application/pdf', 'size': 1000, 'updated_at': '2026-11-01T00:00:00Z',
            'url': 'https://canvas.example.edu/files/%d/download?download_frd=1&verifier=KEY%d' % (file_id, file_id), **extra}


def http_error(status):
    response = requests.Response()
    response.status_code = status
    return requests.exceptions.HTTPError('HTTP %d' % status, response=response)


class FakeApi:
    """api_get with the answers of a table of endpoint -> answer (an Exception is raised), and a record of every request. An endpoint it does not know fails the test."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def __call__(self, endpoint, params=None):
        self.calls.append((endpoint, params))
        got = self.answers(endpoint) if callable(self.answers) else self.answers[endpoint]
        if isinstance(got, Exception):
            raise got
        return got


@unittest.skipUnless(HAVE_REQUESTS, 'canvas_api.py needs the requests package')
class CanvasApiTestCase(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop('NANOCLAW_IS_MAIN', None)
        clock = mock.patch.object(canvas_api, 'now_ms', lambda: NOW_MS)
        clock.start()
        self.addCleanup(clock.stop)

    def chat_is_main(self, value):
        """The environment the MCP server hands its scripts: None is no variable at all."""
        if value is None:
            os.environ.pop('NANOCLAW_IS_MAIN', None)
        else:
            os.environ['NANOCLAW_IS_MAIN'] = value

    def ask(self, api, action, params=None, reads=None):
        """handle() with api_get replaced; read_attachment answers with the file's name (and is recorded), and a download of any other kind fails the test."""
        def read(url, filename, content_type, size=0):
            if reads is not None:
                reads.append((url, filename))
            return 'text of ' + filename, None

        with mock.patch.object(canvas_api, 'api_get', api), mock.patch.object(canvas_api, 'read_attachment', read), \
                mock.patch.object(canvas_api, 'download_file', side_effect=AssertionError('a file was downloaded')):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                answer = canvas_api.handle({'action': action, 'params': params or {}})
            self.assertNotIn(TOKEN, out.getvalue())
            self.assertNotIn(TOKEN, json.dumps(answer, default=str))
            return answer


class TheRuleOnTheSharedTable(CanvasApiTestCase):
    def test_every_row_of_the_table(self):
        for number, row in enumerate(TABLE['cases']):
            with self.subTest(row['name']):
                item = file_object(1000 + number, **row['flags'])
                self.assertEqual(canvas_api.why_not_for_students(item, NOW_MS), row['skip'])
                self.assertEqual(canvas_api.students_may_open(item, NOW_MS), row['skip'] is None)

    def test_the_table_has_every_kind_of_row_and_the_edges(self):
        self.assertEqual(TABLE['now'], '2026-11-07T12:00:00Z')
        self.assertEqual(canvas_api.instant_ms(TABLE['now']), NOW_MS)
        reasons = {row['skip'].split(' (')[0] for row in TABLE['cases'] if row['skip']}
        self.assertEqual(reasons, {'hidden or locked for students', 'not released to students yet', 'no longer available to students'})
        self.assertTrue(any(row['skip'] is None for row in TABLE['cases']))
        names = ' | '.join(row['name'] for row in TABLE['cases'])
        for edge in ('at this very moment', 'one second from now', 'offset', 'day alone', 'null', 'not dates', 'exactly true'):
            self.assertIn(edge, names)

    def test_a_row_is_judged_by_the_clock_when_no_moment_is_given(self):
        # now_ms is replaced by the test case's own clock (12:00:00 UTC): a file that unlocks a second later is closed, one that unlocks now is open
        self.assertIsNotNone(canvas_api.why_not_for_students(file_object(1, unlock_at='2026-11-07T12:00:01Z')))
        self.assertIsNone(canvas_api.why_not_for_students(file_object(1, unlock_at='2026-11-07T12:00:00Z')))

    def test_what_is_not_a_record_is_not_a_file_a_student_may_have(self):
        for thing in (None, [], [file_object(1)], 'file', 7, True):
            self.assertEqual(canvas_api.why_not_for_students(thing, NOW_MS), 'not a file record', repr(thing))
            self.assertFalse(canvas_api.students_may_open(thing, NOW_MS))

    def test_dates_are_read_as_javascript_reads_them(self):
        at = NOW_MS
        for text in ('2026-11-07T12:00:00Z', '2026-11-07T12:00:00.000Z', '2026-11-07T12:00Z', '2026-11-07T04:00:00-08:00', '2026-11-07T17:30:00+05:30',
                     '2026-11-07T12:00:00+0000', '2026-11-07T12:00:00+00:00'):
            self.assertEqual(canvas_api.instant_ms(text), at, text)
        self.assertEqual(canvas_api.instant_ms('2026-11-07T12:00:00.5Z'), at + 500)               # a fraction counts, to the millisecond
        self.assertEqual(canvas_api.instant_ms('2026-11-07T12:00:00.123999Z'), at + 123)
        self.assertEqual(canvas_api.instant_ms('2026-11-07'), calendar.timegm((2026, 11, 7, 0, 0, 0)) * 1000)
        self.assertEqual(canvas_api.instant_ms('1970-01-01T00:00:00Z'), 0)
        # a datetime with no offset is UTC here (JavaScript would say local time: the host's clock is UTC, and Canvas always sends Z)
        self.assertEqual(canvas_api.instant_ms('2026-11-07T12:00:00'), at)

    def test_text_that_is_not_a_date_is_no_limit(self):
        for value in (None, '', 'not a date', 12345, 12.5, True, [], {}, '2026-13-01T00:00:00Z', '2026-02-30', '2026-11-07T25:00:00Z', '2026-11-07T12:60:00Z',
                      '2026-11-07T12:00:00+24:00', '2026-11-07T12:00:00+05:60', '2026-11-07T12:00:00+05', 'Sat, 07 Nov 2026 12:00:00 GMT', ' 2026-11-07T12:00:00Z',
                      '2026-11-07T12:00:00Zjunk'):
            self.assertIsNone(canvas_api.instant_ms(value), repr(value))
            self.assertIsNone(canvas_api.why_not_for_students(file_object(1, unlock_at=value, lock_at=value), NOW_MS), repr(value))

    def test_who_is_a_student_is_decided_by_exactly_one_text(self):
        for value in NOT_MAIN:
            self.chat_is_main(value)
            self.assertTrue(canvas_api.student_view(), repr(value))
        self.chat_is_main('1')
        self.assertFalse(canvas_api.student_view())


class TheFilesAction(CanvasApiTestCase):
    LISTING = [
        file_object(11, display_name='Lecture 4.pdf'),
        file_object(12, display_name='Solutions HW5.pdf', hidden=True),
        file_object(13, display_name='Draft syllabus.pdf', locked=True),
        file_object(14, display_name='Next week.pdf', unlock_at='2026-12-01T08:00:00Z'),
        file_object(15, display_name='Old handout.pdf', lock_at='2026-10-01T08:00:00Z'),
        file_object(16, display_name='Notes.txt', **{'content-type': 'text/plain'}),
        file_object(17, display_name='Lab.pdf', hidden_for_user=False, locked_for_user=False, unlock_at='2026-10-01T08:00:00Z', lock_at='2026-12-31T08:00:00Z'),
        file_object(18, display_name='Locked for me.pdf', locked_for_user=True),
    ]
    HIDDEN_NAMES = ('Solutions', 'Draft syllabus', 'Next week', 'Old handout', 'Locked for me')

    def listing(self):
        return FakeApi({'/courses/1/files': [dict(f) for f in self.LISTING]})

    def test_a_student_gets_the_files_a_student_could_open_and_nothing_that_says_what_was_left_out(self):
        for value in NOT_MAIN:
            self.chat_is_main(value)
            api = self.listing()
            answer = self.ask(api, 'files')
            self.assertEqual([f['id'] for f in answer], [11, 16, 17], repr(value))
            self.assertEqual([list(f) for f in answer], [LISTING_KEYS] * 3, repr(value))             # the shape of an entry is what it always was
            text = json.dumps(answer)
            for name in self.HIDDEN_NAMES:
                self.assertNotIn(name, text, repr(value))
            self.assertNotIn('hidden', text)
            self.assertEqual(api.calls, [('/courses/1/files', {'per_page': 50, 'sort': 'updated_at', 'order': 'desc'})])   # the same one request

    def test_the_admin_chat_gets_every_file(self):
        self.chat_is_main('1')
        answer = self.ask(self.listing(), 'files')
        self.assertEqual([f['id'] for f in answer], [11, 12, 13, 14, 15, 16, 17, 18])
        self.assertEqual([f['display_name'] for f in answer][:2], ['Lecture 4.pdf', 'Solutions HW5.pdf'])
        self.assertEqual([list(f) for f in answer], [LISTING_KEYS] * 8)

    def test_a_listing_with_nothing_a_student_may_open_is_empty_not_an_error(self):
        api = FakeApi({'/courses/1/files': [file_object(1, hidden=True), file_object(2, locked=True)]})
        self.assertEqual(self.ask(api, 'files'), [])

    def test_something_in_the_listing_that_is_no_file_is_dropped_for_a_student(self):
        api = FakeApi({'/courses/1/files': [None, 'x', file_object(5)]})
        self.assertEqual([f['id'] for f in self.ask(api, 'files')], [5])

    def test_what_a_student_may_see_of_the_other_actions_is_answered_the_same_in_every_view(self):
        # (this test said "the other actions answer the same in every view" while they showed a student what Canvas hides: test_canvas_api_student_view.py is where they differ)
        answers = {
            '/courses/1/assignments': [{'id': 1, 'name': 'HW1', 'due_at': '2026-11-09T17:00:00Z', 'points_possible': 10, 'submission_types': ['online_text_entry'], 'html_url': 'u', 'published': True}],
            '/courses/1/pages': [{'url': 'syllabus', 'title': 'Syllabus', 'updated_at': '2026-11-01T00:00:00Z', 'published': True}],
            '/courses/1/modules': [{'id': 2, 'name': 'Week 8', 'position': 1, 'items_count': 1, 'items': [{'title': 'Lecture 8', 'type': 'File', 'content_id': 99, 'html_url': 'h'}]}],
            '/courses/1/files': [file_object(99)],                                         # the File item is one a student could open, so a student's modules judge it from this listing
            '/courses/1/syllabus': {},
        }
        for action in ('assignments', 'pages', 'modules'):
            self.chat_is_main('1')
            admin = self.ask(FakeApi(answers), action)
            self.chat_is_main(None)
            student = self.ask(FakeApi(answers), action)
            self.assertEqual(student, admin, action)
            self.assertTrue(student)

    def test_the_list_of_actions_an_unknown_one_names_is_what_it_was(self):
        available = canvas_api.handle({'action': 'nope', 'params': {}})['available']
        self.assertIn('files', available)
        self.assertIn('file_content', available)
        self.assertEqual(len(available), 21)


class TheFileContentAction(CanvasApiTestCase):
    def library(self):
        """Every row of the table as a file of the course (ids 1000 and up), and three more: a plain text file, one of another course and one that is gone."""
        files = {1000 + number: file_object(1000 + number, **row['flags']) for number, row in enumerate(TABLE['cases'])}
        files[11] = file_object(11, display_name='Lecture 4.txt', **{'content-type': 'text/plain'})
        files[12] = file_object(12, display_name='Solutions HW5.pdf', hidden=True)
        files[99] = file_object(99, display_name='Other course.pdf')

        def answers(endpoint):
            course = re.fullmatch(r'/courses/1/files/(\d+)', endpoint)
            anywhere = re.fullmatch(r'/files/(\d+)', endpoint)
            if course:
                found = int(course.group(1))
                return dict(files[found]) if found in files and found != 99 else http_error(404)      # 99 is another course's file: the course does not know it
            if anywhere:
                return dict(files[int(anywhere.group(1))])                                              # /files/<id> answers for any file the token can read
            raise AssertionError('a request to ' + endpoint)

        return FakeApi(answers)

    def test_a_student_reads_a_file_they_could_open(self):
        api, reads = self.library(), []
        answer = self.ask(api, 'file_content', {'file_id': '11'}, reads)
        self.assertEqual(answer, {'display_name': 'Lecture 4.txt', 'content_type': 'text/plain', 'content': 'text of Lecture 4.txt', 'truncated': False})
        self.assertEqual(api.calls, [('/courses/1/files/11', None)])                 # asked of the course, one request
        self.assertEqual([name for _, name in reads], ['Lecture 4.txt'])

    def test_every_row_of_the_table_through_the_action(self):
        for number, row in enumerate(TABLE['cases']):
            with self.subTest(row['name']):
                api, reads = self.library(), []
                answer = self.ask(api, 'file_content', {'file_id': str(1000 + number)}, reads)
                if row['skip'] is None:
                    self.assertEqual(answer.get('content'), 'text of case-%d.pdf' % (1000 + number))
                    self.assertEqual(len(reads), 1)
                else:
                    self.assertEqual(answer, {'error': SENTENCE})                  # that and nothing else: no name, no type, no address, no reason
                    self.assertEqual(reads, [])
                    self.assertEqual(api.calls, [('/courses/1/files/%d' % (1000 + number), None)])    # the metadata, and no more of the file

    def test_a_refusal_says_the_same_for_every_reason_and_names_nothing(self):
        said = set()
        for number, row in enumerate(TABLE['cases']):
            if row['skip']:
                said.add(json.dumps(self.ask(self.library(), 'file_content', {'file_id': str(1000 + number)}), sort_keys=True))
        self.assertEqual(said, {json.dumps({'error': SENTENCE})})
        self.assertIn('students', SENTENCE)

    def test_a_hidden_file_by_its_id_reads_nothing_and_gives_nothing_away(self):
        for value in NOT_MAIN:
            self.chat_is_main(value)
            api, reads = self.library(), []
            answer = self.ask(api, 'file_content', {'file_id': '12'}, reads)
            self.assertEqual(answer, {'error': SENTENCE}, repr(value))
            self.assertNotIn('Solutions', json.dumps(answer))
            self.assertEqual(reads, [])
            self.assertEqual(api.calls, [('/courses/1/files/12', None)])

    def test_a_file_the_course_does_not_know_is_refused_in_the_same_words(self):
        for file_id in ('99', '4242'):                                  # another course's, and one that does not exist at all
            api, reads = self.library(), []
            self.assertEqual(self.ask(api, 'file_content', {'file_id': file_id}, reads), {'error': SENTENCE}, file_id)
            self.assertEqual(reads, [])
            self.assertEqual(api.calls, [('/courses/1/files/' + file_id, None)])

    def test_another_failure_of_canvas_is_not_taken_for_a_refusal(self):
        for status in (401, 403, 500):
            api = FakeApi({'/courses/1/files/11': http_error(status)})
            with self.assertRaises(requests.exceptions.HTTPError):
                self.ask(api, 'file_content', {'file_id': '11'})

    def test_a_file_record_that_is_no_record_is_refused_for_a_student(self):
        for odd in (None, [], 'x'):
            self.assertEqual(self.ask(FakeApi({'/courses/1/files/11': odd}), 'file_content', {'file_id': '11'}), {'error': SENTENCE}, repr(odd))

    def test_an_id_that_is_not_a_number_asks_nothing(self):
        for file_id in ('../files/12', '12/../13', '12?', '12#x', '12/entries', ' 12', '12 ', 'abc', '١٢', '1' * 21, '1e3', '-1', '12\n', ['12'], {'a': 1}):
            for value in (None, '1'):                                  # the admin chat's id is checked as well: a model's text never changes which endpoint is asked
                self.chat_is_main(value)
                api = FakeApi({})
                answer = self.ask(api, 'file_content', {'file_id': file_id})
                self.assertIn('Canvas file id', answer['error'], repr(file_id))
                self.assertEqual(api.calls, [], repr(file_id))
        self.assertEqual(self.ask(FakeApi({}), 'file_content', {}), {'error': "file_id required (get from 'files' action)"})
        self.assertEqual(self.ask(FakeApi({}), 'file_content', {'file_id': ''}), {'error': "file_id required (get from 'files' action)"})

    def test_a_number_that_arrives_as_a_number_is_still_an_id(self):
        self.assertEqual(self.ask(self.library(), 'file_content', {'file_id': 11})['content'], 'text of Lecture 4.txt')

    def test_the_admin_chat_reads_any_file_as_it_always_did(self):
        self.chat_is_main('1')
        for file_id in ('11', '12', '99'):                              # a hidden one, and another course's: asked of /files/<id>, as before
            api, reads = self.library(), []
            answer = self.ask(api, 'file_content', {'file_id': file_id}, reads)
            self.assertIn('content', answer, file_id)
            self.assertEqual(api.calls, [('/files/' + file_id, None)])
            self.assertEqual(len(reads), 1)

    def test_the_admin_chats_other_answers_are_what_they_were(self):
        self.chat_is_main('1')
        no_address = FakeApi({'/files/5': {'display_name': 'x.pdf', 'content-type': 'application/pdf', 'size': 1}})
        self.assertEqual(self.ask(no_address, 'file_content', {'file_id': '5'}), {'error': 'No download URL available for this file'})
        with mock.patch.object(canvas_api, 'read_attachment', lambda *a, **k: (None, '[x.pdf: unsupported format]')), \
                mock.patch.object(canvas_api, 'api_get', FakeApi({'/files/5': file_object(5)})):
            self.assertEqual(canvas_api.handle({'action': 'file_content', 'params': {'file_id': '5'}}),
                             {'display_name': 'case-5.pdf', 'content_type': 'application/pdf', 'error': '[x.pdf: unsupported format]'})


@unittest.skipUnless(HAVE_REQUESTS, 'canvas_api.py needs the requests package')
class TheScriptAsTheContainerRunsIt(unittest.TestCase):
    """The real script, with the environment of the MCP server (NANOCLAW_IS_MAIN and the Canvas settings), against a stand-in Canvas on the loopback address.
    Dates are far from any clock: 2999 is ahead of it and 2001 is behind it."""

    FILES = {}
    HITS = []

    @classmethod
    def setUpClass(cls):
        class StandIn(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body, content_type='application/json'):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                path = urlparse(self.path).path
                cls.HITS.append(path)
                if self.headers.get('Authorization') != 'Bearer ' + TOKEN:
                    return self.reply(401, {'errors': [{'message': 'bad token'}]})
                if path == '/api/v1/courses/1/files':
                    return self.reply(200, [cls.FILES[i] for i in sorted(cls.FILES) if i != 99])
                found = re.fullmatch(r'/api/v1/courses/1/files/(\d+)', path)
                if found:
                    wanted = int(found.group(1))
                    return self.reply(200, cls.FILES[wanted]) if wanted in cls.FILES and wanted != 99 else self.reply(404, {'errors': [{'message': 'The specified resource does not exist.'}]})
                found = re.fullmatch(r'/api/v1/files/(\d+)', path)
                if found and int(found.group(1)) in cls.FILES:
                    return self.reply(200, cls.FILES[int(found.group(1))])
                found = re.fullmatch(r'/files/(\d+)/download', path)
                if found and int(found.group(1)) in cls.FILES:
                    return self.reply(200, ('contents of file %s' % found.group(1)).encode(), 'text/plain')
                self.reply(404, {'errors': [{'message': 'not found'}]})

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), StandIn)
        port = cls.server.server_address[1]
        cls.base = 'http://127.0.0.1:%d/api/v1' % port

        def stored(file_id, name, **extra):
            return {'id': file_id, 'display_name': name, 'filename': name, 'content-type': 'text/plain', 'size': 20, 'updated_at': '2026-11-01T00:00:00Z',
                    'url': 'http://127.0.0.1:%d/files/%d/download?verifier=KEY%d' % (port, file_id, file_id), **extra}

        cls.FILES = {file.get('id'): file for file in (
            stored(11, 'lecture-4.txt'),
            stored(12, 'solutions-hw5.txt', hidden=True),
            stored(13, 'draft.txt', locked=True),
            stored(14, 'next-week.txt', unlock_at='2999-01-01T00:00:00Z'),
            stored(15, 'old-handout.txt', lock_at='2001-01-01T00:00:00Z'),
            stored(16, 'notes.txt', unlock_at='2001-01-01T00:00:00Z', lock_at='2999-01-01T00:00:00Z'),
            stored(99, 'other-course.txt'),                              # only /files/<id> knows it
        )}
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def run_script(self, action, params=None, is_main=None, ok=True):
        env = {k: v for k, v in os.environ.items() if k != 'NANOCLAW_IS_MAIN' and k != 'TAI_STUDENT_TZ' and 'proxy' not in k.lower()}
        env.update({'CANVAS_API_TOKEN': TOKEN, 'CANVAS_BASE_URL': self.base, 'CANVAS_COURSE_ID': '1', 'NO_PROXY': '127.0.0.1'})
        if is_main is not None:
            env['NANOCLAW_IS_MAIN'] = is_main
        self.HITS.clear()
        done = subprocess.run([sys.executable, str(HERE / 'canvas_api.py')], input=json.dumps({'action': action, 'params': params or {}}),
                              capture_output=True, text=True, env=env, timeout=60)
        self.assertNotIn(TOKEN, done.stdout + done.stderr)                   # the token is never printed
        if ok:
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return json.loads(done.stdout) if done.stdout.strip() else None, done

    def test_the_listing_follows_the_environment(self):
        for is_main in NOT_MAIN:
            answer, _ = self.run_script('files', is_main=is_main)
            self.assertEqual([f['id'] for f in answer], [11, 16], repr(is_main))
            self.assertNotIn('solutions', json.dumps(answer))
        answer, _ = self.run_script('files', is_main='1')
        self.assertEqual([f['id'] for f in answer], [11, 12, 13, 14, 15, 16])

    def test_a_hidden_file_is_not_read_for_a_student_and_is_for_the_admin(self):
        for file_id in ('12', '13', '14', '15'):
            for is_main in (None, '0'):
                answer, _ = self.run_script('file_content', {'file_id': file_id}, is_main=is_main)
                self.assertEqual(answer, {'error': SENTENCE}, (file_id, is_main))
                self.assertEqual(self.HITS, ['/api/v1/courses/1/files/' + file_id], (file_id, is_main))    # the metadata, and not the file or its address
            answer, _ = self.run_script('file_content', {'file_id': file_id}, is_main='1')
            self.assertEqual(answer['content'], 'contents of file ' + file_id)
            self.assertIn('/files/%s/download' % file_id, self.HITS)

    def test_a_file_a_student_may_open_is_read(self):
        for file_id in ('11', '16'):
            answer, _ = self.run_script('file_content', {'file_id': file_id}, is_main='0')
            self.assertEqual(answer['content'], 'contents of file ' + file_id)
            self.assertEqual(self.HITS, ['/api/v1/courses/1/files/' + file_id, '/files/%s/download' % file_id])

    def test_a_file_of_another_course_is_for_the_admin_chat_only(self):
        answer, _ = self.run_script('file_content', {'file_id': '99'}, is_main='0')
        self.assertEqual(answer, {'error': SENTENCE})
        self.assertEqual(self.HITS, ['/api/v1/courses/1/files/99'])
        answer, _ = self.run_script('file_content', {'file_id': '99'}, is_main='1')
        self.assertEqual(answer['content'], 'contents of file 99')

    def test_an_id_that_climbs_out_of_the_path_never_reaches_canvas(self):
        for is_main in (None, '1'):
            answer, _ = self.run_script('file_content', {'file_id': '../files/12'}, is_main=is_main)
            self.assertIn('Canvas file id', answer['error'])
            self.assertEqual(self.HITS, [])

    def test_a_file_that_is_not_there_for_the_admin_chat_fails_as_it_did(self):
        answer, done = self.run_script('file_content', {'file_id': '4242'}, is_main='1', ok=False)
        self.assertEqual(done.returncode, 1)
        self.assertIn('Canvas API error: 404', answer['error'])


if __name__ == '__main__':
    unittest.main()
