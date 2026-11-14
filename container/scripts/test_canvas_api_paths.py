"""container/scripts/canvas_api.py: a value a caller supplies never changes the path of a Canvas request (docs/SECURITY.md, "Opening documents, the view and the course
library").

The script carries the instructor's token and builds its request paths from text (`/courses/1/pages/<page_url>`). `requests` reads that text as a URL: `../files/12`
climbs out of `pages/` into a hidden file's metadata, `77/submissions/999?` puts another student's submission into the path and the bound user into the query, and
`%2e%2e/...` goes out as a literal `..`. So a value is not repaired, it is refused, in one plain sentence, and nothing is asked of Canvas. Five layers, none of which
reaches a real Canvas:
  - the evidence: what `requests` PREPARES (nothing is sent) for those values, which is why the rule is a refusal and not an encoding;
  - path_segment and checked_endpoint alone, on tables of good and hostile ids and slugs;
  - every action that reads a parameter into a path, through handle() with a fake api_get that records every endpoint: each hostile value is refused (the admin chat's
    call too) and asks nothing, each good value reaches exactly the path it always did; then EVERY action under EVERY parameter the script reads, all hostile at once, so
    that a parameter added later that reaches a path unchecked fails here;
  - the backstop in the real api_get (requests.get replaced by a recorder): a path with `..`, `?`, `#`, `%`, a backslash, a space is not sent, whoever built it;
  - the real script as the container runs it (JSON on stdin and stdout, the MCP server's environment) against a stand-in Canvas on the loopback address that SERVES the
    hidden file and another student's work, to see that they are never asked for (a control shows the stand-in does answer for them when it is asked).
Run: python container/scripts/test_canvas_api_paths.py   (needs the `requests` package, which the agent image has)
"""
import copy
import json
import os
import re
import subprocess
import sys
import threading
import unicodedata
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import quote, unquote, urlsplit

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

# The exact words of a refusal, written out here (not read from the script): "<name> must be <what>"
SENTENCE = {
    'assignment_id': "assignment_id must be a Canvas assignment id (digits, from the 'assignments' action)",
    'user_id': "user_id must be a Canvas user id (digits)",
    'topic_id': "topic_id must be a Canvas discussion topic id (digits, from the 'discussions' action)",
    'module_id': "module_id must be a Canvas module id (digits, from the 'modules' action)",
    'file_id': "file_id must be a Canvas file id (digits, from the 'files' action)",
    'page_url': "page_url must be the url slug of a page as the 'pages' and 'modules' actions give it, one short name such as 'week-8-intro' (no '/', '?', '#', '%', '..' or space)",
}

# What each action says when the parameter is missing or empty: it was always so, and the tool's fixtures and the progress chips read these texts
REQUIRED = {
    ('assignment_detail', 'assignment_id'): 'assignment_id required',
    ('submissions', 'assignment_id'): 'assignment_id required',
    ('student_submission', 'assignment_id'): 'assignment_id and user_id required',
    ('student_submission', 'user_id'): 'assignment_id and user_id required',
    ('my_grades', 'user_id'): 'user_id required (bound automatically for students)',
    ('discussion_detail', 'topic_id'): 'topic_id required',
    ('discussion_entries', 'topic_id'): 'topic_id required',
    ('module_items', 'module_id'): 'module_id required',
    ('page_detail', 'page_url'): 'page_url required (the url slug, not full URL)',
    ('file_content', 'file_id'): "file_id required (get from 'files' action)",
}

# (action, the parameter under test, the other parameters the action needs, the endpoint a good value reaches (the value goes where {} is), the query it always sent)
ROWS = [
    ('assignment_detail', 'assignment_id', {}, '/courses/1/assignments/{}', {'include[]': 'rubric'}),
    ('submissions', 'assignment_id', {}, '/courses/1/assignments/{}/submissions', {'per_page': 50, 'include[]': 'user'}),
    ('student_submission', 'assignment_id', {'user_id': '1001'}, '/courses/1/assignments/{}/submissions/1001',
     {'include[]': ['submission_history', 'submission_comments', 'rubric_assessment']}),
    ('student_submission', 'user_id', {'assignment_id': '77'}, '/courses/1/assignments/77/submissions/{}',
     {'include[]': ['submission_history', 'submission_comments', 'rubric_assessment']}),
    ('my_grades', 'user_id', {}, '/courses/1/assignments/5/submissions/{}', None),
    ('discussion_detail', 'topic_id', {}, '/courses/1/discussion_topics/{}', None),
    ('discussion_entries', 'topic_id', {}, '/courses/1/discussion_topics/{}/entries', {'per_page': 50}),
    ('module_items', 'module_id', {}, '/courses/1/modules/{}/items', {'per_page': 50}),
    ('page_detail', 'page_url', {}, '/courses/1/pages/{}', None),
    ('file_content', 'file_id', {}, '/courses/1/files/{}', None),
]
PARENTS = {                         # asked first, outside the admin chat, for the same value: a student's rule judges the topic or the module before what is in it
    'discussion_entries': '/courses/1/discussion_topics/{}',
    'module_items': '/courses/1/modules/{}',
}
ANSWERS = {                         # what the fake Canvas says to the good calls: just enough for the action to finish
    '/courses/1/assignments': [{'id': 5, 'name': 'HW', 'due_at': None}],
    '/courses/1/assignments/77': {'id': 77, 'name': 'HW', 'due_at': None},
}

HOSTILE_IDS = [
    '..', '../files/12', '12/../13', '77/submissions/999?', '77/submissions/999?x=1', '12?', '12#x', '#', '?', '/', '12/', '/12', '12/entries', '1/2',
    '%2e%2e', '%2E%2E/files/12', '%2f', '12%2f13', '%32', '12%00', '12%',
    ' 12', '12 ', '12\n', '12\r\n', '1 2', '\t', 'abc', 'self', 'sis_user_id:7', 'null', 'True',
    '١٢', '１２', '²', '12​',                                     # digits of other scripts, a superscript, a zero-width space
    '1e3', '-1', '+1', '1.5', '0x10', '1_0', '12;', '12\x00', '12\\13', '1' * 21,
]
HOSTILE_NOT_STRINGS = [True, 1.5, -5, 10 ** 21, [12], ['12'], {'id': 12}, float('nan'), float('inf')]
EMPTY = ['', None, 0, False, [], {}]               # what an action reads as "not given" (every one is falsy)
NOT_GIVEN_FOR_THE_HELPER = ['', None, False, [], {}]   # the same for path_segment itself, which takes the number 0 for the digit 0 (handle() has asked `not value` before it comes to it)
GOOD_IDS = ['77', 77, '0', '007', '1' * 20, 10 ** 19]

HOSTILE_SLUGS = [
    '..', '.', '...', 'a..b', '..a', 'a..', '../files/12', '..\\files\\12', 'a/b', '/a', 'a/', 'a\\b',
    'x?', 'x?include[]=y', 'x#y', '#', '?', '%', 'a%', '%2e%2e', '%2E%2E', '.%2e', '%2e.', '%2e%2e/files/12', '..%2ffiles%2f12', '%2e%2e%2ffiles%2f12', '%2f', '%252e%252e', 'a%20b',
    'a b', ' a', 'a ', 'a\tb', 'a\nb', 'a\r', 'a\x00b', 'a\x1fb', 'a\x7fb', 'a\x85b',
    'a b', 'a b', 'a　b', 'a​b', 'a‮b', 'a⁦b', 'a﻿b', 'a\ud800b', 'ab',     # no-break space, line separator, ideographic space, zero-width, bidi, BOM, a lone surrogate, private use
    'x' * (200 + 1),
    'https://canvas.example.edu/courses/1/pages/raft-reading', 'courses/1/files/12', 'raft-reading?x=1', 'raft-reading#top',
    # look-alikes that no category test sees (all Po) and NFKC folds into / . ? # % or a backslash: fullwidth and small forms, two dot leaders, an ellipsis
    '／', 'a／b', '．', '．．', 'a．．b', '．．／files／12', '․', '‥', '…', '？', 'a？b', '＃', 'a＃b',
    '％', 'a％b', '＼', 'a＼b', '﹖', '﹟', '﹪', '﹨',
]
HOSTILE_SLUGS_NOT_STRINGS = [True, 1.5, ['a'], {'a': 1}, float('nan')]
GOOD_SLUGS = ['week-8-intro', 'circuit-breakers', 'raft-reading', 'front_page', 'Week-8', 'v1.2-notes', 'a.b', 'a.', '.a', '~a', 'a;b', 'x' * 200, '第1周', 'café', 'café', 'ﬁle', '１２',
              '1234', 1234]


class Recorder:
    """api_get with a record of every (endpoint, params); `answers` is endpoint -> answer, and anything else is {}. It never raises."""

    def __init__(self, answers=None):
        self.answers = answers or {}
        self.calls = []

    def __call__(self, endpoint, params=None):
        self.calls.append((endpoint, params))
        return copy.deepcopy(self.answers.get(endpoint, {}))


@unittest.skipUnless(HAVE_REQUESTS, 'canvas_api.py needs the requests package')
class Base(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop('NANOCLAW_IS_MAIN', None)

    def view(self, is_main):
        """The environment the MCP server hands its scripts: None is no variable at all, '1' the admin chat."""
        if is_main is None:
            os.environ.pop('NANOCLAW_IS_MAIN', None)
        else:
            os.environ['NANOCLAW_IS_MAIN'] = is_main

    def ask(self, api, action, params=None):
        """handle() with api_get replaced; a file is never read or downloaded here."""
        with mock.patch.object(canvas_api, 'api_get', api), \
                mock.patch.object(canvas_api, 'read_attachment', lambda url, filename, content_type, size=0: ('text of ' + filename, None)), \
                mock.patch.object(canvas_api, 'download_file', side_effect=AssertionError('a file was downloaded')):
            return canvas_api.handle({'action': action, 'params': params or {}})


class WhyAValueIsRefusedAndNotRepaired(Base):
    """What `requests` prepares for a value put into a path as it is (nothing is sent): the evidence for the rule, and for not encoding. The numbers are those of
    requests 2.33.0 with urllib3 2.7.0; if a newer pair differs, the refusal still holds, and this is where to see what changed."""

    def prepared(self, tail):
        return requests.Request('GET', BASE + tail).prepare()

    def test_dot_dot_climbs_out_of_the_pages_into_any_files_metadata(self):
        self.assertEqual(urlsplit(self.prepared('/courses/1/pages/../files/456').url).path, '/api/v1/courses/1/files/456')
        self.assertEqual(urlsplit(self.prepared('/courses/1/assignments/../files/456').url).path, '/api/v1/courses/1/files/456')
        self.assertEqual(urlsplit(self.prepared('/courses/1/pages/..').url).path, '/api/v1/courses/1/')                  # the course itself
        self.assertEqual(urlsplit(self.prepared('/courses/1/pages/.').url).path, '/api/v1/courses/1/pages/')             # the listing: a list, where an object was meant

    def test_percent_encoded_dots_are_sent_as_a_literal_dot_dot(self):
        # requests decodes %2e AFTER it has removed the dot segments, so the request goes out with a real `..` in it for a server or a proxy to act on
        for value in ('%2e%2e', '%2E%2E', '.%2e', '%2e.'):
            self.assertEqual(urlsplit(self.prepared('/courses/1/pages/' + value + '/files/456').url).path, '/api/v1/courses/1/pages/../files/456', value)

    def test_an_encoded_slash_goes_out_encoded_for_the_server_to_decode(self):
        self.assertEqual(urlsplit(self.prepared('/courses/1/pages/..%2ffiles%2f456').url).path, '/api/v1/courses/1/pages/..%2Ffiles%2F456')
        self.assertEqual(urlsplit(self.prepared('/courses/1/pages/%2e%2e%2ffiles%2f456').url).path, '/api/v1/courses/1/pages/..%2Ffiles%2F456')

    def test_a_question_mark_starts_the_query_and_a_hash_is_cut(self):
        sent = urlsplit(self.prepared('/courses/1/assignments/77/submissions/999?/submissions/1001').url)
        self.assertEqual(sent.path, '/api/v1/courses/1/assignments/77/submissions/999')                      # another student's submission
        self.assertEqual(sent.query, '/submissions/1001')                                                    # and the bound user is only a query now
        self.assertEqual(urlsplit(self.prepared('/courses/1/pages/x?include[]=y').url).path, '/api/v1/courses/1/pages/x')

    def test_encoding_the_value_would_not_be_enough(self):
        # quote(safe='') leaves `.` and `..` alone, and requests removes them all the same
        self.assertEqual(quote('..', safe=''), '..')
        self.assertEqual(urlsplit(self.prepared('/courses/1/pages/' + quote('..', safe='')).url).path, '/api/v1/courses/1/')

    def test_look_alikes_are_real_and_no_category_test_sees_them(self):
        # why the slug rule is applied to the NFKC fold as well: anything that folds compatibility forms reads these as the characters they look like
        for look_alike, plain in (('／', '/'), ('．．', '..'), ('．', '.'), ('？', '?'), ('＃', '#'), ('％', '%'), ('＼', '\\'), ('‥', '..'), ('…', '...')):
            self.assertEqual(unicodedata.normalize('NFKC', look_alike), plain, ascii(look_alike))
            self.assertNotIn(unicodedata.category(look_alike[0])[0], 'CZ', ascii(look_alike))
            # requests itself only percent-encodes them; it is whatever folds them later (a proxy, a server) that would read a slash or a `..`
            self.assertEqual(urlsplit(self.prepared('/courses/1/pages/' + look_alike).url).path, '/api/v1/courses/1/pages/' + quote(look_alike), ascii(look_alike))

    def test_the_refusal_stands_whatever_the_pair_of_versions_does(self):
        # every hostile slug and every hostile id is refused before a request exists, so none of the above can happen
        for value in HOSTILE_SLUGS:
            with self.assertRaises(canvas_api.Refused, msg=repr(value)):
                canvas_api.path_segment('page_url', value)
        for value in HOSTILE_IDS:
            with self.assertRaises(canvas_api.Refused, msg=repr(value)):
                canvas_api.path_segment('assignment_id', value)


class PathSegment(Base):
    def test_a_good_id_is_its_digits(self):
        for value in GOOD_IDS:
            for name in ('assignment_id', 'user_id', 'topic_id', 'module_id', 'file_id'):
                self.assertEqual(canvas_api.path_segment(name, value), str(value), (name, value))

    def test_a_hostile_id_is_refused_in_the_words_of_its_name(self):
        for name in ('assignment_id', 'user_id', 'topic_id', 'module_id', 'file_id'):
            for value in HOSTILE_IDS + HOSTILE_NOT_STRINGS + NOT_GIVEN_FOR_THE_HELPER:
                with self.assertRaises(canvas_api.Refused, msg=(name, value)) as raised:
                    canvas_api.path_segment(name, value)
                self.assertEqual(str(raised.exception), SENTENCE[name])

    def test_a_good_slug_is_itself(self):
        for value in GOOD_SLUGS:
            self.assertEqual(canvas_api.path_segment('page_url', value), str(value), repr(value))

    def test_a_hostile_slug_is_refused(self):
        for value in HOSTILE_SLUGS + HOSTILE_SLUGS_NOT_STRINGS + NOT_GIVEN_FOR_THE_HELPER:
            with self.assertRaises(canvas_api.Refused, msg=repr(value)) as raised:
                canvas_api.path_segment('page_url', value)
            self.assertEqual(str(raised.exception), SENTENCE['page_url'])

    def test_the_edges_of_the_rules(self):
        self.assertEqual(canvas_api.path_segment('user_id', '1' * 20), '1' * 20)
        with self.assertRaises(canvas_api.Refused):
            canvas_api.path_segment('user_id', '1' * 21)
        self.assertEqual(canvas_api.path_segment('page_url', 'x' * 200), 'x' * 200)
        with self.assertRaises(canvas_api.Refused):
            canvas_api.path_segment('page_url', 'x' * 201)
        for ok in ('a.b', 'a.', '.a', 'a.b.c'):                    # a dot inside a name is a name; only `..` and a lone `.` are not
            self.assertEqual(canvas_api.path_segment('page_url', ok), ok)

    def test_a_json_number_is_its_digits_and_a_boolean_is_nothing(self):
        self.assertEqual(canvas_api.path_segment('assignment_id', 77), '77')
        for value in (True, False):
            with self.assertRaises(canvas_api.Refused):
                canvas_api.path_segment('assignment_id', value)

    def test_an_id_is_ascii_digits_not_every_scripts(self):
        # \d matches these; the old _DIGITS of week_status did
        for value in ('٣', '٧٧', '７７', '१२'):
            self.assertIsNotNone(re.fullmatch(r'\d+', value), value)                              # (what the old rule accepted)
            with self.assertRaises(canvas_api.Refused, msg=value):
                canvas_api.path_segment('user_id', value)

    def test_a_trailing_newline_is_no_digit(self):
        with self.assertRaises(canvas_api.Refused):
            canvas_api.path_segment('assignment_id', '77\n')

    def test_a_name_that_is_not_a_path_parameter_is_a_bug_not_a_refusal(self):
        with self.assertRaises(KeyError):
            canvas_api.path_segment('quiz_id', '5')

    def test_every_path_parameter_has_its_sentence_here(self):
        self.assertEqual(sorted(canvas_api.PATH_PARAMS), sorted(SENTENCE))


class CheckedEndpoint(Base):
    def test_an_honest_endpoint_passes_as_it_is(self):
        for endpoint in ('/courses/1/assignments', '/courses/1/assignments/77/submissions/1001', '/users/7/profile', '/files/12', '/courses/1', '/courses/1/pages/week-8-intro',
                         '/courses/1/pages/第1周', '/courses/1/pages/café', '/courses/1/pages/v1.2-notes', '/courses/sis_course_id:CS6650/assignments'):
            self.assertEqual(canvas_api.checked_endpoint(endpoint), endpoint)

    def test_a_climb_a_query_a_fragment_a_percent_a_space_or_a_control_character_is_refused(self):
        for endpoint in ('/courses/1/pages/../files/12', '/courses/1/pages/..', '/courses/1/pages/.', '/courses/1/./pages', '/../files/12', '/courses/1/pages/x?y', '/courses/1/pages/x#y',
                         '/courses/1/pages/%2e%2e/files/12', '/courses/1/pages/%2f', '/courses/1/pages/a\\b', '/courses/1/pages/a b', '/courses/1/pages/a\nb', '/courses/1/pages/a\x00b',
                         '/courses/1/pages/a​b', '/courses/1/pages/a b', '/courses/1/pages/．．', '/courses/1/pages/．．／files／12', '/courses/1/pages/‥',
                         '/courses/1/pages/a？b', '/courses/1/pages/a＃b', '/courses/1/pages/a％b', '/courses/1/pages/a＼b',
                         'courses/1', '', '//x', None, 5, ['/courses/1']):
            with self.subTest(endpoint=endpoint):
                if endpoint == '//x':
                    self.assertEqual(canvas_api.checked_endpoint(endpoint), endpoint)              # an empty segment is not a climb: left to Canvas, as before
                    continue
                with self.assertRaises(canvas_api.Refused):
                    canvas_api.checked_endpoint(endpoint)


class EveryActionThatReadsAParameterIntoAPath(Base):
    def test_a_hostile_value_is_refused_and_nothing_is_asked(self):
        for action, name, others, _, _ in ROWS:
            hostile = HOSTILE_SLUGS + HOSTILE_SLUGS_NOT_STRINGS if name == 'page_url' else HOSTILE_IDS + HOSTILE_NOT_STRINGS
            for is_main in (None, '1'):                    # the admin chat's calls are refused as well: a model's text never changes which endpoint is asked
                self.view(is_main)
                for value in hostile:
                    with self.subTest(action=action, name=name, value=value, is_main=is_main):
                        api = Recorder()
                        answer = self.ask(api, action, dict(others, **{name: value}))
                        self.assertEqual(answer, {'error': SENTENCE[name]})
                        self.assertEqual(api.calls, [])

    def test_a_missing_or_empty_value_says_what_it_always_said(self):
        for action, name, others, _, _ in ROWS:
            for value in EMPTY:
                with self.subTest(action=action, name=name, value=value):
                    api = Recorder()
                    self.assertEqual(self.ask(api, action, dict(others, **{name: value})), {'error': REQUIRED[(action, name)]})
                    self.assertEqual(api.calls, [])
            api = Recorder()
            self.assertEqual(self.ask(api, action, dict(others)), {'error': REQUIRED[(action, name)]})                  # not given at all
            self.assertEqual(api.calls, [])

    def test_a_good_value_reaches_the_path_it_always_did_with_the_query_it_always_sent(self):
        for action, name, others, path, query in ROWS:
            if action == 'file_content':
                continue                                    # a file is judged on its metadata as well, and read: its own test below
            values = GOOD_SLUGS if name == 'page_url' else GOOD_IDS
            for is_main in (None, '1'):
                self.view(is_main)
                for value in values:
                    with self.subTest(action=action, name=name, value=value, is_main=is_main):
                        api = Recorder(ANSWERS)
                        answer = self.ask(api, action, dict(others, **{name: value}))
                        self.assertNotIn('error', answer if isinstance(answer, dict) else {})
                        asked = path.format(str(value))
                        expected = [('/courses/1/assignments', {'per_page': 50, 'order_by': 'due_at'}), (asked, query)] if action == 'my_grades' else [(asked, query)]
                        if is_main is None and action in PARENTS:                 # the same value, in the same place of the path: nothing else is asked
                            expected.insert(0, (PARENTS[action].format(str(value)), None))
                        self.assertEqual(api.calls, expected)

    def test_a_student_reads_a_good_file_id_from_the_course_and_the_admin_chat_from_files(self):
        meta = {'display_name': 'a.txt', 'content-type': 'text/plain', 'size': 3, 'url': 'https://canvas.example.edu/files/11/download'}
        for value in GOOD_IDS:
            for is_main, endpoint in ((None, '/courses/1/files/%s' % value), ('1', '/files/%s' % value)):
                self.view(is_main)
                api = Recorder({endpoint: meta})
                self.assertEqual(self.ask(api, 'file_content', {'file_id': value})['content'], 'text of a.txt', (value, is_main))
                self.assertEqual(api.calls, [(endpoint, None)], (value, is_main))

    def test_the_two_cases_the_probe_found(self):
        for is_main in (None, '1'):
            self.view(is_main)
            api = Recorder()
            self.assertEqual(self.ask(api, 'page_detail', {'page_url': '../files/456'}), {'error': SENTENCE['page_url']})
            self.assertEqual(self.ask(api, 'student_submission', {'assignment_id': '77/submissions/999?', 'user_id': '1001'}), {'error': SENTENCE['assignment_id']})
            self.assertEqual(self.ask(api, 'assignment_detail', {'assignment_id': '../files/456'}), {'error': SENTENCE['assignment_id']})
            self.assertEqual(self.ask(api, 'discussion_detail', {'topic_id': '../files/456'}), {'error': SENTENCE['topic_id']})
            self.assertEqual(api.calls, [])

    def test_the_bound_user_cannot_be_walked_round_through_the_assignment(self):
        # access.ts binds user_id; only a path that is exactly /assignments/<digits>/submissions/<the bound digits> keeps it bound
        api = Recorder()
        for assignment_id in ('77/submissions/999?', '77/submissions/999#', '77/submissions/999/../1001', '77%2fsubmissions%2f999%3f', '77/../78'):
            self.assertEqual(self.ask(api, 'student_submission', {'assignment_id': assignment_id, 'user_id': '1001'}), {'error': SENTENCE['assignment_id']}, assignment_id)
        self.assertEqual(api.calls, [])
        self.ask(api, 'student_submission', {'assignment_id': '77', 'user_id': '1001'})
        self.assertEqual([endpoint for endpoint, _ in api.calls], ['/courses/1/assignments/77/submissions/1001'])

    def test_my_grades_refuses_a_bad_user_before_the_first_request(self):
        # not after the list of assignments: that would cost a request and turn every row into "Could not fetch submission"
        api = Recorder(ANSWERS)
        self.assertEqual(self.ask(api, 'my_grades', {'user_id': '1001/../999'}), {'error': SENTENCE['user_id']})
        self.assertEqual(api.calls, [])

    def test_week_status_and_user_contact_read_ascii_digits_only(self):
        # they keep their own sentences; what they accept is the same set of ids as everywhere (the old rule took the digits of every script)
        for value in ('٣', '７', '१२', '7/../8', '7?x=1', '7\n'):
            for action, name, others in (('week_status', 'user_id', {}), ('user_contact', 'user_id', {}), ('week_status', 'assignment_id', {'user_id': '7'})):
                api = Recorder()
                answer = self.ask(api, action, dict(others, **{name: value}))
                self.assertEqual(list(answer), ['error'], (action, name, value))
                self.assertEqual(api.calls, [], (action, name, value))
        api = Recorder()
        self.assertEqual(self.ask(api, 'user_contact', {'user_id': '7'}), {'name': None, 'email': None, 'login_id': None})
        self.assertEqual([endpoint for endpoint, _ in api.calls], ['/users/7/profile', '/courses/1/users/7'])


class NoActionPutsAHostileValueIntoAPath(Base):
    """Every action of the script, once for each hostile value, with EVERY parameter the script reads set to it at the same time. Whatever an action asks, the
    endpoint has no trace of the value and passes the check api_get makes. A parameter that is added later and reaches a path unchecked fails here."""

    CANARIES = ['CANARY/../files/12', 'CANARY?x=1', 'CANARY#x', '..%2fCANARY', '%2e%2e/CANARY', 'CANARY/submissions/999?', 'CANARY\\x', 'CANARY x', 'CANARY\n', '../CANARY',
                'CANARY／..', '．．/CANARY', 'CANARY？x']

    def parameter_names(self):
        source = Path(canvas_api.__file__).read_text(encoding='utf-8')
        return sorted(set(re.findall(r"params\.get\(\s*['\"](\w+)['\"]", source)))

    def test_the_script_reads_the_parameters_this_test_knows(self):
        self.assertEqual(self.parameter_names(), ['assignment_id', 'budget_seconds', 'file_id', 'module_id', 'now', 'page_url', 'topic_id', 'user_id'])

    def test_no_endpoint_carries_a_hostile_value(self):
        names = self.parameter_names()
        actions = canvas_api.handle({'action': 'nope', 'params': {}})['available']
        self.assertEqual(len(actions), 21)
        for action in actions:
            for is_main in (None, '1'):
                self.view(is_main)
                for canary in self.CANARIES:
                    api = Recorder()
                    try:
                        self.ask(api, action, {name: canary for name in names})
                    except Exception:                                  # an action may fall over on the empty answers: only what it asked matters here
                        pass
                    for endpoint, params in api.calls:
                        with self.subTest(action=action, canary=canary, endpoint=endpoint):
                            self.assertNotIn('CANARY', endpoint)
                            self.assertEqual(canvas_api.checked_endpoint(endpoint), endpoint)
                            self.assertNotIn('CANARY', json.dumps(params, default=str))


class TheBackstopInApiGet(Base):
    """The real api_get, with requests.get replaced by a recorder: whatever built the endpoint, a path that climbs or starts a query is not sent."""

    class Response:
        def __init__(self, body, headers=None):
            self.status_code = 200
            self.text = json.dumps(body)
            self.headers = headers or {}

        def raise_for_status(self):
            pass

    def run_api_get(self, endpoint, params=None, bodies=None):
        sent = []
        queue = list(bodies or [({}, {})])

        def fake_get(url, headers=None, params=None, timeout=None):
            sent.append(url)
            body, headers = queue.pop(0)
            return TheBackstopInApiGet.Response(body, headers)

        with mock.patch.object(canvas_api.requests, 'get', fake_get):
            try:
                result = canvas_api.api_get(endpoint, params)
            except canvas_api.Refused as refusal:
                return sent, refusal
        return sent, result

    def test_a_path_that_climbs_or_starts_a_query_is_never_sent(self):
        for endpoint in ('/courses/1/pages/../files/12', '/courses/1/pages/%2e%2e/files/12', '/courses/1/pages/..%2ffiles%2f12', '/courses/1/assignments/77/submissions/999?/submissions/1001',
                         '/courses/1/pages/x#y', '/courses/1/pages/a\\b', '/courses/1/pages/a b', '/courses/1/pages/a\nb', '/courses/1/pages/.', '/courses/1/pages/..',
                         '/courses/1/pages/．．/files/12', '/courses/1/pages/a？b'):
            sent, outcome = self.run_api_get(endpoint)
            self.assertEqual(sent, [], endpoint)
            self.assertIsInstance(outcome, canvas_api.Refused, endpoint)

    def test_an_honest_path_is_sent_as_it_was_built(self):
        for endpoint in ('/courses/1/assignments', '/courses/1/pages/week-8-intro', '/courses/1/pages/第1周', '/courses/1/assignments/77/submissions/1001'):
            sent, outcome = self.run_api_get(endpoint, {'per_page': 50})
            self.assertEqual(sent, [BASE + endpoint], endpoint)
            self.assertEqual(outcome, {})

    def test_the_address_of_the_next_page_is_canvas_own_and_followed_as_it_is(self):
        link = '<https://canvas.example.edu/api/v1/courses/1/assignments?page=2&per_page=50>; rel="next"'
        sent, outcome = self.run_api_get('/courses/1/assignments', {'per_page': 50}, bodies=[([{'id': 1}], {'Link': link}), ([{'id': 2}], {})])
        self.assertEqual(sent, [BASE + '/courses/1/assignments', 'https://canvas.example.edu/api/v1/courses/1/assignments?page=2&per_page=50'])
        self.assertEqual(outcome, [{'id': 1}, {'id': 2}])

    def test_a_course_that_is_not_a_plain_name_is_refused_as_an_answer_and_nothing_is_sent(self):
        # the course is the operator's setting: a path built from it goes through the same check, and handle() says it in one sentence
        sent = []
        with mock.patch.object(canvas_api, 'COURSE_ID', '1/../2'), mock.patch.object(canvas_api.requests, 'get', lambda *a, **k: sent.append(a)):
            answer = canvas_api.handle({'action': 'assignments', 'params': {}})
        self.assertEqual(list(answer), ['error'])
        self.assertIn('was not sent', answer['error'])
        self.assertEqual(sent, [])

    def test_the_course_may_be_the_course_name_canvas_accepts(self):
        sent, outcome = self.run_api_get('/courses/sis_course_id:CS6650/assignments')
        self.assertEqual(sent, [BASE + '/courses/sis_course_id:CS6650/assignments'])


@unittest.skipUnless(HAVE_REQUESTS, 'canvas_api.py needs the requests package')
class TheScriptAsTheContainerRunsIt(unittest.TestCase):
    """The real script, with the environment of the MCP server (NANOCLAW_IS_MAIN and the Canvas settings), against a stand-in Canvas on the loopback address that
    answers for the hidden file (/courses/1/files/12) and for another student's work (/assignments/77/submissions/999) when it is asked."""

    HITS = []        # the path of every request that arrived, as it was sent
    TARGETS = []     # the same with the query
    SECRET_FILE = 'HIDDEN-FILE-KEY-12'
    SECRET_WORK = 'OTHER-STUDENTS-WORK'

    @classmethod
    def setUpClass(cls):
        class StandIn(BaseHTTPRequestHandler):
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
                path = urlsplit(self.path).path
                cls.HITS.append(path)
                cls.TARGETS.append(self.path)
                if self.headers.get('Authorization') != 'Bearer ' + TOKEN:
                    return self.reply(401, {'errors': [{'message': 'bad token'}]})
                found = re.fullmatch(r'/api/v1/courses/1/(.*)', path)
                if not found:
                    return self.reply(404, {'errors': [{'message': 'not found'}]})
                rest = found.group(1)
                if rest == 'files/12':                                  # what `../files/12` used to reach
                    return self.reply(200, {'id': 12, 'display_name': 'solutions.pdf', 'hidden': True, 'content-type': 'text/plain', 'size': 3,
                                            'url': 'http://127.0.0.1/files/12/download?verifier=' + cls.SECRET_FILE})
                if rest == 'assignments':
                    return self.reply(200, [{'id': 77, 'name': 'HW', 'due_at': '2026-11-09T17:00:00Z', 'points_possible': 10, 'submission_types': ['online_text_entry'], 'published': True}])
                if rest == 'assignments/77':
                    return self.reply(200, {'id': 77, 'name': 'HW', 'due_at': '2026-11-09T17:00:00Z', 'description': '<p>Do it.</p>', 'rubric': None})
                if rest == 'assignments/77/submissions':
                    return self.reply(200, [{'user_id': 1001, 'score': 9}, {'user_id': 999, 'score': 3}])
                found = re.fullmatch(r'assignments/77/submissions/(\d+)', rest)
                if found:
                    mine = found.group(1) == '1001'
                    return self.reply(200, {'user_id': int(found.group(1)), 'submission_type': 'online_text_entry', 'score': 9 if mine else 3, 'submission_comments': [],
                                            'body': '<p>%s</p>' % ('Ada own work' if mine else cls.SECRET_WORK)})
                found = re.fullmatch(r'discussion_topics/(\d+)(/entries)?', rest)
                if found:
                    return self.reply(200, [{'id': 1, 'user_id': 7, 'message': '<p>hello</p>'}] if found.group(2) else {'id': int(found.group(1)), 'title': 'Topic'})
                found = re.fullmatch(r'modules/(\d+)/items', rest)
                if found:
                    return self.reply(200, [{'id': 1, 'title': 'Reading', 'type': 'Page', 'page_url': 'week-8-intro'}])
                found = re.fullmatch(r'modules/(\d+)', rest)
                if found:
                    return self.reply(200, {'id': int(found.group(1)), 'name': 'Week 9', 'published': True})
                found = re.fullmatch(r'pages/([^/]+)', rest)
                if found:
                    slug = unquote(found.group(1))
                    return self.reply(200, {'url': slug, 'title': 'Page ' + slug, 'body': '<p>Body of %s</p>' % slug, 'updated_at': '2026-11-01T00:00:00Z'})
                self.reply(404, {'errors': [{'message': 'not found'}]})

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), StandIn)
        cls.base = 'http://127.0.0.1:%d/api/v1' % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.HITS.clear()
        self.TARGETS.clear()

    def run_script(self, action, params=None, is_main=None, check=True):
        env = {k: v for k, v in os.environ.items() if k not in ('NANOCLAW_IS_MAIN', 'TAI_STUDENT_TZ') and 'proxy' not in k.lower()}
        env.update({'CANVAS_API_TOKEN': TOKEN, 'CANVAS_BASE_URL': self.base, 'CANVAS_COURSE_ID': '1', 'NO_PROXY': '127.0.0.1'})
        if is_main is not None:
            env['NANOCLAW_IS_MAIN'] = is_main
        done = subprocess.run([sys.executable, str(HERE / 'canvas_api.py')], input=json.dumps({'action': action, 'params': params or {}}),
                              capture_output=True, text=True, env=env, timeout=60)
        self.assertNotIn(TOKEN, done.stdout + done.stderr)                   # the token is never printed
        if check:
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)  # a refusal is an answer, not a failure
        return (json.loads(done.stdout) if done.stdout.strip() else None), done

    def test_control_the_stand_in_does_answer_for_what_a_climbing_value_used_to_reach(self):
        auth = {'Authorization': 'Bearer ' + TOKEN}
        with requests.Session() as session:
            session.trust_env = False                                        # the loopback address, whatever proxy this machine is set up with
            hidden = session.get(self.base + '/courses/1/files/12', headers=auth, timeout=15).json()
            other = session.get(self.base + '/courses/1/assignments/77/submissions/999', headers=auth, timeout=15).json()
        self.assertEqual(hidden['hidden'], True)
        self.assertIn(self.SECRET_FILE, hidden['url'])
        self.assertIn(self.SECRET_WORK, other['body'])
        # ... and a request the old script would have made for the two values: the same paths
        for tail in ('/courses/1/pages/../files/12', '/courses/1/assignments/77/submissions/999?/submissions/1001'):
            prepared = requests.Request('GET', self.base + tail).prepare()
            self.assertIn(urlsplit(prepared.url).path, ('/api/v1/courses/1/files/12', '/api/v1/courses/1/assignments/77/submissions/999'))

    ATTACKS = [
        ('page_detail', {'page_url': '../files/12'}, 'page_url'),
        ('page_detail', {'page_url': '%2e%2e/files/12'}, 'page_url'),
        ('page_detail', {'page_url': '..%2ffiles%2f12'}, 'page_url'),
        ('page_detail', {'page_url': 'week-8-intro?x=1'}, 'page_url'),
        ('page_detail', {'page_url': '．．／files／12'}, 'page_url'),
        ('assignment_detail', {'assignment_id': '../files/12'}, 'assignment_id'),
        ('discussion_detail', {'topic_id': '../files/12'}, 'topic_id'),
        ('discussion_entries', {'topic_id': '5/../../files/12'}, 'topic_id'),
        ('module_items', {'module_id': '9/../../files/12'}, 'module_id'),
        ('student_submission', {'assignment_id': '77/submissions/999?', 'user_id': '1001'}, 'assignment_id'),
        ('student_submission', {'assignment_id': '77', 'user_id': '1001/../999'}, 'user_id'),
        ('my_grades', {'user_id': '1001/../999'}, 'user_id'),
        ('file_content', {'file_id': '../files/12'}, 'file_id'),
        ('submissions', {'assignment_id': '77/submissions/999?'}, 'assignment_id'),
    ]

    def test_a_hostile_value_is_refused_in_one_sentence_and_nothing_reaches_canvas(self):
        jobs = [(action, params, name, is_main) for action, params, name in self.ATTACKS for is_main in (None, '1')]
        with ThreadPoolExecutor(max_workers=6) as pool:
            done = list(pool.map(lambda job: self.run_script(job[0], job[1], is_main=job[3], check=False), jobs))
        for (action, params, name, is_main), (answer, run) in zip(jobs, done):         # what leaked first, then what Canvas was asked, then the words
            self.assertNotIn(self.SECRET_FILE, run.stdout, (action, params, is_main))
            self.assertNotIn(self.SECRET_WORK, run.stdout, (action, params, is_main))
        self.assertEqual(self.HITS, [], 'Canvas was asked: %s' % self.TARGETS)
        for (action, params, name, is_main), (answer, run) in zip(jobs, done):
            self.assertEqual(run.returncode, 0, (action, params, is_main, run.stdout))
            self.assertEqual(answer, {'error': SENTENCE[name]}, (action, params, is_main))

    def test_good_values_reach_the_paths_they_always_did(self):
        cases = [
            ('assignment_detail', {'assignment_id': '77'}, ['/api/v1/courses/1/assignments/77']),
            ('student_submission', {'assignment_id': '77', 'user_id': '1001'}, ['/api/v1/courses/1/assignments/77/submissions/1001']),
            ('discussion_detail', {'topic_id': '5'}, ['/api/v1/courses/1/discussion_topics/5']),
            ('discussion_entries', {'topic_id': '5'}, ['/api/v1/courses/1/discussion_topics/5/entries']),
            ('module_items', {'module_id': '9'}, ['/api/v1/courses/1/modules/9/items']),
            ('page_detail', {'page_url': 'week-8-intro'}, ['/api/v1/courses/1/pages/week-8-intro']),
            ('page_detail', {'page_url': 'v1.2-notes'}, ['/api/v1/courses/1/pages/v1.2-notes']),
            ('page_detail', {'page_url': '第1周'}, ['/api/v1/courses/1/pages/' + quote('第1周')]),
            ('my_grades', {'user_id': '1001'}, ['/api/v1/courses/1/assignments', '/api/v1/courses/1/assignments/77/submissions/1001']),
        ]
        parents = {'discussion_entries': '/api/v1/courses/1/discussion_topics/5', 'module_items': '/api/v1/courses/1/modules/9'}      # a student's call asks for the topic or the module first
        for action, params, hits in cases:
            for is_main in (None, '1'):
                self.HITS.clear()
                answer, _ = self.run_script(action, params, is_main=is_main)
                self.assertNotIn('error', answer if isinstance(answer, dict) else {}, (action, params))
                self.assertEqual(self.HITS, ([parents[action]] if is_main is None and action in parents else []) + hits, (action, params, is_main))
        answer, _ = self.run_script('student_submission', {'assignment_id': '77', 'user_id': '1001'})
        self.assertEqual(answer['full_text'], 'Ada own work')
        answer, _ = self.run_script('page_detail', {'page_url': '第1周'})
        self.assertEqual((answer['url'], answer['body']), ('第1周', 'Body of 第1周'))

    def test_a_number_that_arrives_as_a_number_is_still_an_id(self):
        answer, _ = self.run_script('assignment_detail', {'assignment_id': 77})
        self.assertEqual(answer['id'], 77)
        self.assertEqual(self.HITS, ['/api/v1/courses/1/assignments/77'])


if __name__ == '__main__':
    unittest.main()
