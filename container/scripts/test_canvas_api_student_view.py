"""container/scripts/canvas_api.py: a student is shown only what a student sees of the course in Canvas (docs/SECURITY.md, "Opening documents, the view and the course
library"). The sibling of test_canvas_api_student_files.py, which does the same for `files` and `file_content`.

The script carries the instructor's token, and the instructor also sees what Canvas keeps from students: an assignment or a page that is not published, an assignment
before its unlock date, an announcement whose posting is delayed, a module that is locked, a module item that is a hidden file. Outside the admin chat (NANOCLAW_IS_MAIN is
exactly "1" there: container/agent-runner/src/access.ts) every other action applies the student's rule itself: what a student could not see is left out of a listing whole
(no name, no count), and an id asked for by hand answers with one plain sentence, the same whether the thing is hidden or Canvas does not know it. Four layers, none of
which can reach a real Canvas:
  - the rules alone (why_assignment_hidden, why_page_hidden, why_topic_hidden, why_module_hidden, why_item_hidden, OpenableFiles), on tables with the edges: a date that is
    exactly now, a flag that is not exactly true, a record that is no record;
  - every action through handle() with a fake api_get that records every request: what a student gets, what the admin chat gets (as before, with the requests it always
    made), the exact sentences, which requests are made and which are not (a hidden thing is judged and never read further), that only a 404 is "Canvas does not know it";
  - the accounting: every action the script answers has its place in a table here, so that an action added later cannot arrive without a decision;
  - the real script as the container runs it (JSON on stdin and stdout, the environment of the MCP server) against a stand-in Canvas on the loopback address that SERVES
    the hidden things when it is asked (a control shows it does), to see that they never reach the answer.
Run: python container/scripts/test_canvas_api_student_view.py   (needs the `requests` package, which the agent image has)
"""
import calendar
import contextlib
import copy
import io
import json
import os
import re
import subprocess
import sys
import threading
import unittest
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

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
    from pacific_time import pacific

NOW = '2026-11-07T12:00:00Z'
NOW_MS = calendar.timegm((2026, 11, 7, 12, 0, 0)) * 1000
NOT_MAIN = (None, '', '0', 'true', 'yes', 'TRUE', ' 1', '1 ', '01', 'main')   # everything that is not exactly "1"
AHEAD, PAST = '2026-12-01T08:00:00Z', '2026-10-01T08:00:00Z'                      # a date that is ahead of NOW, and one that is behind it
SENTENCE = {                                                                      # the exact words a student's call is given, written out here and not read from the script
    'assignment': 'This assignment is not available to students.',
    'page': 'This page is not available to students.',
    'discussion': 'This discussion or announcement is not available to students.',
    'module': 'This module is not available to students.',
    'not_open_note': 'Not open to students yet: it unlocks Tue Dec 1, 12:00 AM PST. Its description and rubric are not shown until then.',     # unlock_at AHEAD, as Pacific time
    'replies': 'This discussion shows its replies only to students who have posted in it, and this tool cannot tell whether this student has: they can read them in Canvas.',
}


def seconds_after_now(seconds):
    """The ISO text of the moment `seconds` after NOW (negative: before)."""
    return canvas_api.iso_z(canvas_api.parse_utc(NOW) + timedelta(seconds=seconds))


def http_error(status):
    response = requests.Response()
    response.status_code = status
    return requests.exceptions.HTTPError('HTTP %d' % status, response=response)


class FakeApi:
    """api_get with the answers of a table of endpoint -> answer (an Exception is raised, a function is called with the params), and a record of every request. An endpoint
    it does not know fails the test: a request nobody expected is a finding."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def __call__(self, endpoint, params=None):
        self.calls.append((endpoint, params))
        if endpoint not in self.answers:
            raise AssertionError('a request nobody expected: %s %r' % (endpoint, params))
        got = self.answers[endpoint]
        if isinstance(got, Exception):
            raise got
        got = got(params) if callable(got) else copy.deepcopy(got)
        if isinstance(got, Exception):
            raise got
        return got

    def endpoints(self):
        return [endpoint for endpoint, _ in self.calls]


# ── the course, as Canvas describes it to the instructor's token ──────────────────────────────────────────────────────────────────────────────────────

def assignment(aid, name, **extra):
    return {'id': aid, 'name': name, 'due_at': '2026-11-09T17:00:00Z', 'unlock_at': None, 'lock_at': None, 'points_possible': 10, 'submission_types': ['online_text_entry'],
            'html_url': 'https://canvas.example.edu/courses/1/assignments/%d' % aid, 'published': True, 'workflow_state': 'published', 'description': '<p>Text of %s.</p>' % name, **extra}


def page(url, title, **extra):
    return {'url': url, 'title': title, 'updated_at': '2026-11-01T00:00:00Z', 'published': True, 'body': '<p>Body of %s.</p>' % title, **extra}


def topic(tid, title, **extra):
    return {'id': tid, 'title': title, 'message': '<p>Message of %s.</p>' % title, 'posted_at': '2026-11-01T00:00:00Z', 'published': True, 'workflow_state': 'active',
            'delayed_post_at': None, 'locked': False, 'lock_at': None, **extra}


def module_item(iid, title, kind, **extra):
    return {'id': iid, 'title': title, 'type': kind, 'content_id': iid * 10, 'external_url': None, 'html_url': 'https://canvas.example.edu/courses/1/modules/items/%d' % iid,
            'page_url': None, 'published': True, **extra}


def course_file(fid, name, **extra):
    return {'id': fid, 'display_name': name, 'filename': name, 'content-type': 'application/pdf', 'size': 1000, 'updated_at': '2026-11-01T00:00:00Z',
            'url': 'https://canvas.example.edu/files/%d/download?verifier=KEY%d' % (fid, fid), **extra}


ASSIGNMENTS = [
    assignment(11, 'HW1 Docker'),
    assignment(12, 'SECRET-DRAFT next week', published=False, workflow_state='unpublished'),
    assignment(13, 'HW2 Raft', unlock_at=AHEAD),
    assignment(14, 'SECRET-OVERRIDE for two students', only_visible_to_overrides=True),
    assignment(15, 'HW0 Warm-up', lock_at=PAST, unlock_at=PAST),
]
ASSIGNMENT_OBJECT_EXTRAS = {                  # what the instructor's copy of one assignment carries besides what a student has
    'needs_grading_count': 12, 'needs_grading_count_by_section': [{'section_id': 1, 'needs_grading_count': 12}], 'has_submitted_submissions': True, 'unpublishable': False,
    'submissions_download_url': 'https://canvas.example.edu/courses/1/assignments/11/submissions?zip=1', 'locked_for_user': False, 'lock_info': {'x': 1},
    'lock_explanation': 'x', 'can_submit': False, 'secure_params': 'a.b.c', 'overrides': [{'student_ids': [1001]}], 'all_dates': [{'base': True}], 'assignment_visibility': [1001, 1002],
    'moderated_grading': False, 'grader_count': 1, 'final_grader_id': 5, 'post_manually': True, 'score_statistics': {'mean': 7}, 'muted': True, 'original_course_id': 9,
    'integration_data': {'a': 1}, 'sis_assignment_id': 'S1', 'in_closed_grading_period': False, 'can_duplicate': True, 'only_visible_to_overrides': False, 'has_overrides': True,
}
DETAIL_OBJECT_KEYS = {'id', 'name', 'description', 'due_at', 'unlock_at', 'lock_at', 'points_possible', 'submission_types', 'html_url', 'published', 'workflow_state', 'rubric',
                      'grading_type', 'allowed_extensions', 'course_id', 'rubric_settings', 'external_tool_tag_attributes', 'discussion_topic'}              # what a student's assignment_detail keeps of the fake object below (the script adds three more)

PAGES = [
    page('syllabus-notes', 'Syllabus notes'),
    page('draft-week-9', 'SECRET-DRAFT page', published=False),
    page('hidden-by-flag', 'SECRET-FLAGGED page', hide_from_students=True),
    page('later', 'SECRET-SCHEDULED page', publish_at=AHEAD),
    page('old', 'Old guide', publish_at=PAST),
]

TOPICS = [
    topic(21, 'Welcome'),
    topic(22, 'SECRET-DELAYED announcement', delayed_post_at=AHEAD, workflow_state='post_delayed', is_announcement=True),
    topic(23, 'SECRET-DRAFT topic', published=False, workflow_state='unpublished'),
    topic(24, 'SECRET-SECTION topic', is_section_specific=True),
    topic(25, 'Closed discussion', locked=True, lock_at=PAST),
    topic(26, 'Posted a moment ago', delayed_post_at=PAST, workflow_state='post_delayed'),
    topic(27, 'SECRET-GRADED for some', assignment={'id': 9, 'published': True, 'only_visible_to_overrides': True}),
]
ANNOUNCEMENT_IDS = (21, 22, 26)               # the topics that are announcements in the fake course (the listing is asked with only_announcements)

FILES = [course_file(101, 'slides.pdf'), course_file(102, 'solutions.pdf', hidden=True), course_file(104, 'draft.pdf', locked=True)]


def modules_world():
    many = [module_item(400 + n, 'Reading %d' % n, 'Page', page_url='reading-%d' % n) for n in range(25)]
    return [
        {'id': 31, 'name': 'Week 8', 'position': 1, 'items_count': 7, 'published': True, 'items': [
            module_item(311, 'Intro page', 'Page', page_url='intro'),
            module_item(312, 'Open slides', 'File', content_id=101),
            module_item(313, 'SECRET-HIDDEN-FILE item', 'File', content_id=102),
            module_item(314, 'SECRET-NOT-IN-LISTING item', 'File', content_id=103),
            module_item(315, 'HW1 item', 'Assignment', content_id=11),
            module_item(316, 'SECRET-DRAFT item', 'Page', page_url='draft', published=False),
            module_item(317, 'Reading', 'SubHeader'),
        ]},
        {'id': 32, 'name': 'SECRET-UNPUBLISHED module', 'position': 2, 'items_count': 1, 'published': False, 'items': [module_item(321, 'SECRET-IN-UNPUBLISHED', 'Page', page_url='x')]},
        {'id': 33, 'name': 'SECRET-LOCKED module', 'position': 3, 'items_count': 1, 'published': True, 'unlock_at': AHEAD, 'items': [module_item(331, 'SECRET-IN-LOCKED', 'Page', page_url='y')]},
        {'id': 34, 'name': 'Big week', 'position': 4, 'items_count': 25, 'published': True, 'items': many},
        {'id': 35, 'name': 'Items left out', 'position': 5, 'items_count': 9, 'published': True},
    ]


@unittest.skipUnless(HAVE_REQUESTS, 'canvas_api.py needs the requests package')
class CanvasApiTestCase(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop('NANOCLAW_IS_MAIN', None)
        os.environ.pop('TAI_STUDENT_TZ', None)                                     # (a due_local key would be one more key in every row)
        clock = mock.patch.object(canvas_api, 'now_ms', lambda: NOW_MS)
        clock.start()
        self.addCleanup(clock.stop)

    def chat_is_main(self, value):
        """The environment the MCP server hands its scripts: None is no variable at all, '1' the admin chat."""
        if value is None:
            os.environ.pop('NANOCLAW_IS_MAIN', None)
        else:
            os.environ['NANOCLAW_IS_MAIN'] = value

    def ask(self, api, action, params=None):
        """handle() with api_get replaced; a file is never downloaded here, and the token is never in what is printed or returned."""
        with mock.patch.object(canvas_api, 'api_get', api), mock.patch.object(canvas_api, 'download_file', side_effect=AssertionError('a file was downloaded')):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                answer = canvas_api.handle({'action': action, 'params': params or {}})
            self.assertNotIn(TOKEN, out.getvalue())
            self.assertNotIn(TOKEN, json.dumps(answer, default=str))
            return answer

    def assertNoSecret(self, answer, msg=None):
        self.assertNotIn('SECRET', json.dumps(answer, default=str), msg)


# ── the rules alone ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

class TheRulesAlone(CanvasApiTestCase):
    def test_an_assignment_a_student_cannot_see(self):
        cases = [
            ({}, None), ({'published': True}, None), ({'published': None}, None), ({'published': 'false'}, None), ({'published': 0}, None),     # only exactly false counts
            ({'published': False}, 'not published'), ({'workflow_state': 'unpublished'}, 'not published'), ({'workflow_state': 'deleted'}, 'not published'),
            ({'workflow_state': 'duplicating'}, 'not published'), ({'workflow_state': 'published'}, None), ({'workflow_state': None}, None), ({'workflow_state': 5}, None),
            ({'only_visible_to_overrides': True}, 'assigned to some students or sections only'), ({'only_visible_to_overrides': 'true'}, None),
            ({'only_visible_to_overrides': False}, None), ({'only_visible_to_overrides': 1}, None),
            ({'published': True, 'only_visible_to_overrides': True}, 'assigned to some students or sections only'),
            ({'published': False, 'only_visible_to_overrides': True}, 'not published'),
            ({'unlock_at': AHEAD}, None), ({'lock_at': PAST}, None),                                   # the dates do not hide an assignment: a locked one is listed, a closed one is read
            ({'locked_for_user': True}, None), ({'locked': True}, None),                               # computed for the token's user: not read
        ]
        for fields, expected in cases:
            with self.subTest(fields):
                self.assertEqual(canvas_api.why_assignment_hidden(assignment(1, 'x', **fields)), expected)
        self.assertIsNone(canvas_api.why_assignment_hidden({}))                                        # a record that says nothing is not hidden: only what Canvas says counts
        for thing in (None, [], [assignment(1, 'x')], 'assignment', 7, True):
            self.assertEqual(canvas_api.why_assignment_hidden(thing), 'not an assignment record', repr(thing))

    def test_an_assignment_that_has_not_opened_yet(self):
        later, now_ = seconds_after_now(1), seconds_after_now(0)
        for fields, locked in (({'unlock_at': AHEAD}, True), ({'unlock_at': later}, True), ({'unlock_at': now_}, False), ({'unlock_at': PAST}, False), ({'unlock_at': None}, False),
                               ({'unlock_at': 'soon'}, False), ({'unlock_at': ''}, False), ({'unlock_at': 12345}, False), ({}, False), ({'lock_at': PAST}, False),
                               ({'unlock_at': '2026-11-08'}, True), ({'unlock_at': '2026-11-07T04:00:01-08:00'}, True), ({'unlock_at': '2026-11-07T04:00:00-08:00'}, False)):
            with self.subTest(fields):
                self.assertEqual(canvas_api.why_assignment_locked(fields, NOW_MS) is not None, locked)
                self.assertEqual(canvas_api.unlock_ahead_ms(fields, NOW_MS) is not None, locked)
        self.assertEqual(canvas_api.why_assignment_locked({'unlock_at': AHEAD}, NOW_MS), 'not open yet (unlocks 2026-12-01)')

    def test_the_sentence_for_an_assignment_asked_for_by_id(self):
        self.assertIsNone(canvas_api.sentence_for_assignment(assignment(1, 'x')))
        self.assertIsNone(canvas_api.sentence_for_assignment(assignment(1, 'x', lock_at=PAST)))                         # closed, still read
        self.assertIsNone(canvas_api.sentence_for_assignment(assignment(1, 'x', unlock_at=AHEAD)))                      # not open yet: not refused, its words are withheld (not_open_note)
        for thing in (None, {'published': False}, {'only_visible_to_overrides': True}, 'x', [], {'published': False, 'unlock_at': AHEAD}):
            self.assertEqual(canvas_api.sentence_for_assignment(thing), SENTENCE['assignment'], repr(thing))            # hidden, and Canvas does not know it (None): the same words

    def test_the_note_of_an_assignment_that_has_not_opened(self):
        tail = ' Its description and rubric are not shown until then.'
        for fields in ({}, {'unlock_at': None}, {'unlock_at': PAST}, {'unlock_at': seconds_after_now(0)}, {'unlock_at': 'soon'}, {'lock_at': PAST}):
            self.assertIsNone(canvas_api.not_open_note(fields, NOW_MS), fields)                                         # open, or no date that reads: no note
        self.assertEqual(canvas_api.not_open_note(assignment(1, 'x', unlock_at=AHEAD), NOW_MS), SENTENCE['not_open_note'])
        self.assertEqual(canvas_api.not_open_note({'unlock_at': seconds_after_now(1)}, NOW_MS), 'Not open to students yet: it unlocks Sat Nov 7, 4:00 AM PST.' + tail)
        self.assertEqual(canvas_api.not_open_note({'unlock_at': '2026-11-08'}, NOW_MS), 'Not open to students yet: it unlocks Sat Nov 7, 4:00 PM PST.' + tail)
        self.assertEqual(canvas_api.not_open_note({'unlock_at': '9999-12-31T23:59:59Z'}, NOW_MS), 'Not open to students yet: it unlocks Fri Dec 31, 3:59 PM PST.' + tail)
        with mock.patch.object(canvas_api, 'pacific_of_ms', lambda ms: None):                                           # no date that can be told: the note says so without one
            self.assertEqual(canvas_api.not_open_note({'unlock_at': AHEAD}, NOW_MS), 'Not open to students yet.' + tail)

    def test_the_words_of_an_assignment_a_student_is_not_given_before_it_opens(self):
        self.assertEqual(set(canvas_api.ASSIGNMENT_TEXT_FIELDS), {'description', 'rubric', 'rubric_settings', 'discussion_topic', 'external_tool_tag_attributes'})
        self.assertEqual(set(canvas_api.ASSIGNMENT_TEXT_FIELDS) - canvas_api.STUDENT_ASSIGNMENT_FIELDS, set())          # they are all fields a student's assignment_detail keeps once it is open

    def test_a_page_a_student_cannot_see(self):
        cases = [
            ({}, None), ({'published': True}, None), ({'published': False}, 'not published'), ({'published': 'false'}, None), ({'published': None}, None),
            ({'hide_from_students': True}, 'not published'), ({'hide_from_students': 'true'}, None), ({'hide_from_students': False}, None),
            ({'workflow_state': 'unpublished'}, 'not published'), ({'workflow_state': 'deleted'}, 'not published'), ({'workflow_state': 'active'}, None),
            ({'publish_at': AHEAD}, 'to be published 2026-12-01'), ({'publish_at': PAST}, None), ({'publish_at': seconds_after_now(0)}, None),
            ({'publish_at': seconds_after_now(1)}, 'to be published 2026-11-07'), ({'publish_at': 'soon'}, None), ({'publish_at': None}, None),
            ({'locked_for_user': True}, None),                                                                          # computed for the token's user: not read
        ]
        for fields, expected in cases:
            with self.subTest(fields):
                self.assertEqual(canvas_api.why_page_hidden(fields, NOW_MS), expected)
        for thing in (None, [], 'page', 7, True):
            self.assertEqual(canvas_api.why_page_hidden(thing, NOW_MS), 'not a page record', repr(thing))

    def test_a_topic_a_student_cannot_see(self):
        cases = [
            ({}, None), ({'published': True}, None), ({'published': False}, 'not published'), ({'published': 'false'}, None),
            ({'workflow_state': 'unpublished'}, 'not published'), ({'workflow_state': 'deleted'}, 'not published'), ({'workflow_state': 'active'}, None),
            ({'workflow_state': 'locked'}, None),
            ({'delayed_post_at': AHEAD}, 'posting is delayed until 2026-12-01'), ({'delayed_post_at': PAST}, None), ({'delayed_post_at': seconds_after_now(0)}, None),
            ({'delayed_post_at': seconds_after_now(1)}, 'posting is delayed until 2026-11-07'), ({'delayed_post_at': 'soon'}, None), ({'delayed_post_at': None}, None),
            ({'workflow_state': 'post_delayed'}, 'posting is delayed'),
            ({'workflow_state': 'post_delayed', 'delayed_post_at': AHEAD}, 'posting is delayed until 2026-12-01'),
            ({'workflow_state': 'post_delayed', 'delayed_post_at': PAST}, None),                                       # a date that has passed counts over a state that has not caught up
            ({'workflow_state': 'post_delayed', 'delayed_post_at': 'soon'}, 'posting is delayed'),
            ({'is_section_specific': True}, 'for some sections only'), ({'is_section_specific': 'true'}, None), ({'is_section_specific': False}, None),
            ({'locked': True}, None), ({'lock_at': PAST}, None), ({'locked': True, 'lock_at': PAST}, None),             # a closed topic is read, not hidden
            ({'locked_for_user': True}, None), ({'user_can_see_posts': False}, None), ({'require_initial_post': True}, None),
            ({'assignment': {'published': False}}, 'its assignment is not available to students'),
            ({'assignment': {'only_visible_to_overrides': True}}, 'its assignment is not available to students'),
            ({'assignment': {'published': True}}, None), ({'assignment': None}, None), ({'assignment': 'x'}, None), ({'assignment': {}}, None),
        ]
        for fields, expected in cases:
            with self.subTest(fields):
                self.assertEqual(canvas_api.why_topic_hidden(fields, NOW_MS), expected)
        for thing in (None, [], 'topic', 7, True):
            self.assertEqual(canvas_api.why_topic_hidden(thing, NOW_MS), 'not a discussion record', repr(thing))

    def test_a_module_a_student_is_not_shown(self):
        cases = [
            ({}, None), ({'published': True}, None), ({'published': False}, 'not published'), ({'published': 'false'}, None), ({'workflow_state': 'unpublished'}, 'not published'),
            ({'workflow_state': 'deleted'}, 'not published'), ({'workflow_state': 'active'}, None),
            ({'unlock_at': AHEAD}, 'locked until 2026-12-01'), ({'unlock_at': PAST}, None), ({'unlock_at': seconds_after_now(0)}, None),
            ({'unlock_at': seconds_after_now(1)}, 'locked until 2026-11-07'), ({'unlock_at': 'soon'}, None), ({'unlock_at': None}, None),
            ({'published': False, 'unlock_at': AHEAD}, 'not published'),
        ]
        for fields, expected in cases:
            with self.subTest(fields):
                self.assertEqual(canvas_api.why_module_hidden(fields, NOW_MS), expected)
        for thing in (None, [], 'module', 7, True):
            self.assertEqual(canvas_api.why_module_hidden(thing, NOW_MS), 'not a module record', repr(thing))

    def test_a_module_item_a_student_is_not_shown(self):
        class Files:
            def __contains__(self, file_id):
                return file_id == 101
        files = Files()
        for item, expected in (({'type': 'Page'}, None), ({'type': 'Page', 'published': True}, None), ({'type': 'Page', 'published': False}, 'not published'),
                               ({'type': 'Page', 'published': 'false'}, None), ({'type': 'SubHeader'}, None), ({'type': 'File', 'content_id': 101}, None),
                               ({'type': 'File', 'content_id': 102}, 'a file a student could not open'), ({'type': 'File'}, 'a file a student could not open'),
                               ({'type': 'File', 'content_id': 101, 'published': False}, 'not published'), ({'type': 'Assignment', 'content_id': 102}, None),
                               ({'type': 'file', 'content_id': 102}, None)):
            with self.subTest(item):
                self.assertEqual(canvas_api.why_item_hidden(item, files), expected)
        self.assertIsNone(canvas_api.why_item_hidden({'type': 'File', 'content_id': 102}))                     # no listing to judge a file by: it is judged like any other item
        for thing in (None, [], 'item', 7, True):
            self.assertEqual(canvas_api.why_item_hidden(thing, files), 'not an item record', repr(thing))

    def test_the_files_a_student_could_open_are_asked_of_canvas_once_and_only_when_needed(self):
        listing = [course_file(101, 'a'), course_file(102, 'b', hidden=True), course_file(103, 'c', locked=True), course_file(104, 'd', unlock_at=AHEAD), course_file(105, 'e', lock_at=PAST),
                   course_file(106, 'f', unlock_at=PAST, lock_at=AHEAD), None, 'x']
        api = FakeApi({'/courses/1/files': listing})
        with mock.patch.object(canvas_api, 'api_get', api):
            files = canvas_api.OpenableFiles('1', NOW_MS)
            self.assertEqual(api.calls, [])                                                    # nothing is asked until a File item has to be judged
            self.assertEqual([n in files for n in (101, '101', 102, 103, 104, 105, 106, 107, None)], [True, True, False, False, False, False, True, False, False])
        self.assertEqual(api.calls, [('/courses/1/files', {'per_page': 100, 'sort': 'updated_at', 'order': 'desc'})])         # once, for all of those
        for odd in ({}, None, 'x', {'errors': 'x'}):
            with mock.patch.object(canvas_api, 'api_get', FakeApi({'/courses/1/files': odd})):
                self.assertNotIn(101, canvas_api.OpenableFiles('1', NOW_MS), repr(odd))        # a listing that is no list leaves no file open

    def test_the_other_dates_are_read_as_the_files_dates_are(self):
        # one reader for every date of the course (instant_ms): offsets, a day alone, text that is no date is no limit
        for text, ahead in (('2026-11-07T12:00:01Z', True), ('2026-11-07T12:00:00Z', False), ('2026-11-07T12:00:00.5Z', True), ('2026-11-07T20:00:00+08:00', False),
                            ('2026-11-07T20:00:01+08:00', True), ('2026-11-08', True), ('not a date', False), (None, False), (12345, False), ('', False)):
            with self.subTest(text):
                self.assertEqual(canvas_api.unlock_ahead_ms({'unlock_at': text}, NOW_MS) is not None, ahead)
                self.assertEqual(canvas_api.why_page_hidden({'publish_at': text}, NOW_MS) is not None, ahead)
                self.assertEqual(canvas_api.why_topic_hidden({'delayed_post_at': text}, NOW_MS) is not None, ahead)
                self.assertEqual(canvas_api.why_module_hidden({'unlock_at': text}, NOW_MS) is not None, ahead)

    def test_the_helpers_of_time(self):
        self.assertEqual(canvas_api.utc_ms(canvas_api.parse_utc(NOW)), NOW_MS)
        self.assertEqual(canvas_api.pacific_of_ms(NOW_MS), 'Sat Nov 7, 4:00 AM PST')
        self.assertEqual(canvas_api.pacific_of_ms(canvas_api.instant_ms('2026-07-01T20:30:00Z')), 'Wed Jul 1, 1:30 PM PDT')
        self.assertIsNone(canvas_api.pacific_of_ms(10 ** 18))

    def test_who_is_a_student_is_decided_by_exactly_one_text(self):
        for value in NOT_MAIN:
            self.chat_is_main(value)
            self.assertTrue(canvas_api.student_view(), repr(value))
            self.assertEqual(canvas_api.visible_to_students([{'published': False}, {}], canvas_api.why_assignment_hidden), [{}], repr(value))
        self.chat_is_main('1')
        self.assertFalse(canvas_api.student_view())
        self.assertEqual(canvas_api.visible_to_students([{'published': False}, {}], canvas_api.why_assignment_hidden), [{'published': False}, {}])

    def test_the_assignment_fields_a_student_keeps_hold_what_the_consumers_read(self):
        # who reads assignment_detail: start_mock_interview (description), the voice's compactAssignmentDetail (name, id, due_at, submission_types, points_possible, description,
        # html_url; due_local and rubric_criteria are added by the script afterwards), the progress chips (name, html_url), and the model, which reads the whole object
        read = {'id', 'name', 'description', 'due_at', 'submission_types', 'points_possible', 'html_url', 'rubric', 'unlock_at', 'lock_at', 'published', 'allowed_extensions',
                'grading_type', 'allowed_attempts', 'peer_reviews', 'group_category_id', 'course_id'}
        self.assertEqual(read - canvas_api.STUDENT_ASSIGNMENT_FIELDS, set())
        # and nothing that is the instructor's, or computed for the token's user
        self.assertEqual(set(ASSIGNMENT_OBJECT_EXTRAS) & canvas_api.STUDENT_ASSIGNMENT_FIELDS, set())
        self.assertEqual(canvas_api.STUDENT_ASSIGNMENT_FIELDS & {'needs_grading_count', 'has_submitted_submissions', 'submissions_download_url', 'secure_params', 'overrides',
                                                                 'all_dates', 'assignment_visibility', 'locked_for_user', 'lock_info', 'lock_explanation', 'can_submit'}, set())


# ── every action, through handle() with a fake api_get that records every request ───────────────────────────────────────────────────────────────────

ASSIGNMENT_KEYS = ['id', 'name', 'due_at', 'due_pacific', 'due_relative', 'points_possible', 'submission_types', 'html_url', 'published']


class TheAssignmentActions(CanvasApiTestCase):
    def listing(self, path='/courses/1/assignments'):
        return FakeApi({path: [dict(a) for a in ASSIGNMENTS]})

    def test_assignments_a_student_gets_the_ones_they_see_and_nothing_that_says_what_was_left_out(self):
        for value in NOT_MAIN:
            self.chat_is_main(value)
            api = self.listing()
            answer = self.ask(api, 'assignments')
            self.assertEqual([a['id'] for a in answer], [11, 13, 15], repr(value))                 # 13 has not opened, 15 has closed: Canvas lists both
            self.assertEqual([list(a) for a in answer], [ASSIGNMENT_KEYS] * 3)                      # the shape of a row is what it always was
            self.assertNoSecret(answer)
            self.assertEqual(api.calls, [('/courses/1/assignments', {'per_page': 50, 'order_by': 'due_at'})])        # the same one request

    def test_assignments_the_admin_chat_gets_every_one_as_before(self):
        self.chat_is_main('1')
        api = self.listing()
        answer = self.ask(api, 'assignments')
        self.assertEqual([a['id'] for a in answer], [11, 12, 13, 14, 15])
        self.assertEqual([list(a) for a in answer], [ASSIGNMENT_KEYS] * 5)
        self.assertEqual(api.calls, [('/courses/1/assignments', {'per_page': 50, 'order_by': 'due_at'})])

    def test_upcoming_is_judged_the_same_way(self):
        endpoint = '/courses/1/assignments'
        api = self.listing(endpoint)
        self.assertEqual([a['id'] for a in self.ask(api, 'upcoming')], [11, 13, 15])
        self.assertEqual(api.calls, [(endpoint, {'bucket': 'upcoming', 'per_page': 20, 'order_by': 'due_at'})])
        self.chat_is_main('1')
        self.assertEqual([a['id'] for a in self.ask(self.listing(endpoint), 'upcoming')], [11, 12, 13, 14, 15])

    def test_a_listing_with_nothing_a_student_may_see_is_empty_not_an_error(self):
        api = FakeApi({'/courses/1/assignments': [assignment(1, 'x', published=False), assignment(2, 'y', only_visible_to_overrides=True)]})
        self.assertEqual(self.ask(api, 'assignments'), [])

    def test_something_in_the_listing_that_is_no_assignment_is_dropped_for_a_student(self):
        api = FakeApi({'/courses/1/assignments': [None, 'x', [], assignment(5, 'real')]})
        self.assertEqual([a['id'] for a in self.ask(api, 'assignments')], [5])

    def detail_api(self):
        objects = {a['id']: dict(ASSIGNMENT_OBJECT_EXTRAS, **a, rubric=[{'id': '_1', 'description': 'Design', 'long_description': 'long', 'points': 5, 'ratings': [{'description': 'full', 'points': 5}]}],
                                 grading_type='points', allowed_extensions=['pdf'], course_id=1, rubric_settings={'id': 1, 'title': 'WORDS-RUBRIC-TITLE', 'points_possible': 5},
                                 external_tool_tag_attributes={'url': 'https://tool.example/WORDS-LAUNCH'}, discussion_topic=topic(40, 'WORDS-TOPIC of the assignment')) for a in ASSIGNMENTS}
        answers = {'/courses/1/assignments/%d' % n: objects[n] for n in objects}
        answers['/courses/1/assignments/99'] = http_error(404)                                   # an id Canvas does not know in this course
        for code in (401, 403, 500):
            answers['/courses/1/assignments/9%d' % code] = http_error(code)
        return FakeApi(answers)

    def test_assignment_detail_a_student_gets_the_assignment_with_the_fields_a_student_has(self):
        api = self.detail_api()
        got = self.ask(api, 'assignment_detail', {'assignment_id': '11'})
        self.assertEqual(set(got), DETAIL_OBJECT_KEYS | {'due_pacific', 'due_relative', 'rubric_criteria'})                  # exactly these: not one field of the instructor's
        self.assertEqual(got['description'], '<p>Text of HW1 Docker.</p>')
        self.assertEqual(got['due_pacific'], 'Mon Nov 9, 9:00 AM PST')
        self.assertEqual(got['rubric_criteria'], [{'id': '_1', 'description': 'Design', 'long_description': 'long', 'points': 5, 'ratings': [{'description': 'full', 'points': 5}]}])
        self.assertEqual(api.calls, [('/courses/1/assignments/11', {'include[]': 'rubric'})])                              # the one request it always made

    def test_assignment_detail_a_graded_discussions_topic_goes_when_a_student_could_not_see_it(self):
        topics = {'seen': topic(21, 'Seen topic'), 'delayed': topic(22, 'SECRET-DELAYED topic', delayed_post_at=AHEAD, workflow_state='post_delayed'),
                  'draft': topic(23, 'SECRET-DRAFT topic', published=False), 'section': topic(24, 'SECRET-SECTION topic', is_section_specific=True)}
        for name, embedded in topics.items():
            api = FakeApi({'/courses/1/assignments/11': dict(ASSIGNMENTS[0], discussion_topic=embedded)})
            got = self.ask(api, 'assignment_detail', {'assignment_id': '11'})
            self.assertEqual(('discussion_topic' in got), name == 'seen', name)
            self.assertNoSecret(got, name)
            if name == 'seen':
                self.assertEqual(got['discussion_topic']['title'], 'Seen topic')
        got = self.ask(FakeApi({'/courses/1/assignments/11': dict(ASSIGNMENTS[0])}), 'assignment_detail', {'assignment_id': '11'})            # not a graded discussion: no key, no error
        self.assertNotIn('discussion_topic', got)
        self.chat_is_main('1')
        api = FakeApi({'/courses/1/assignments/11': dict(ASSIGNMENTS[0], discussion_topic=topics['delayed'])})
        self.assertEqual(self.ask(api, 'assignment_detail', {'assignment_id': '11'})['discussion_topic']['title'], 'SECRET-DELAYED topic')           # the admin chat keeps it

    def test_assignment_detail_the_admin_chat_gets_the_whole_object_as_before(self):
        self.chat_is_main('1')
        api = self.detail_api()
        got = self.ask(api, 'assignment_detail', {'assignment_id': '12'})                       # even an unpublished one
        self.assertEqual(got['name'], 'SECRET-DRAFT next week')
        for key in ASSIGNMENT_OBJECT_EXTRAS:
            self.assertIn(key, got, key)
        self.assertEqual(got['due_pacific'], 'Mon Nov 9, 9:00 AM PST')
        self.assertEqual(api.calls, [('/courses/1/assignments/12', {'include[]': 'rubric'})])

    def test_assignment_detail_a_hidden_assignment_and_one_canvas_does_not_know_are_answered_in_the_same_words(self):
        for assignment_id in ('12', '14', '99'):                                              # unpublished, for some students only, not in this course
            for value in NOT_MAIN:
                self.chat_is_main(value)
                api = self.detail_api()
                answer = self.ask(api, 'assignment_detail', {'assignment_id': assignment_id})
                self.assertEqual(answer, {'error': SENTENCE['assignment']}, (assignment_id, value))        # that and nothing else: no name, no date, no reason
                self.assertEqual(api.calls, [('/courses/1/assignments/' + assignment_id, {'include[]': 'rubric'})])

    def test_assignment_detail_one_that_has_not_opened_gives_its_facts_and_a_note_and_none_of_its_words_and_no_error(self):
        api = self.detail_api()
        answer = self.ask(api, 'assignment_detail', {'assignment_id': '13'})
        self.assertNotIn('error', answer)               # start_mock_interview prints every {"error"} a lookup answered under "Context errors": this assignment goes on quietly
        self.assertEqual((answer['id'], answer['name'], answer['due_at'], answer['unlock_at'], answer['points_possible']), (13, 'HW2 Raft', '2026-11-09T17:00:00Z', AHEAD, 10))
        self.assertEqual(answer['due_pacific'], 'Mon Nov 9, 9:00 AM PST')
        self.assertEqual(answer['note'], SENTENCE['not_open_note'])
        for key in ('description', 'rubric', 'rubric_criteria', 'rubric_settings', 'discussion_topic', 'external_tool_tag_attributes'):
            self.assertNotIn(key, answer, key)
        text = json.dumps(answer)
        for words in ('Text of HW2', 'WORDS', 'Design'):
            self.assertNotIn(words, text, words)
        self.assertEqual(str(answer.get('description') or answer.get('body') or ''), '')            # what start_mock_interview reads of it: the spec is simply absent
        self.assertEqual(set(answer), DETAIL_OBJECT_KEYS - set(canvas_api.ASSIGNMENT_TEXT_FIELDS) | {'due_pacific', 'due_relative', 'note'})
        self.assertEqual(api.calls, [('/courses/1/assignments/13', {'include[]': 'rubric'})])
        self.chat_is_main('1')
        self.assertIn('WORDS-TOPIC', json.dumps(self.ask(self.detail_api(), 'assignment_detail', {'assignment_id': '13'})))       # the admin chat has all of it

    def test_assignment_detail_one_that_has_closed_is_read_as_a_student_reads_it(self):
        self.assertEqual(self.ask(self.detail_api(), 'assignment_detail', {'assignment_id': '15'})['name'], 'HW0 Warm-up')

    def test_assignment_detail_only_a_404_is_taken_for_does_not_know(self):
        for code in (401, 403, 500):
            with self.assertRaises(requests.exceptions.HTTPError, msg=code):
                self.ask(self.detail_api(), 'assignment_detail', {'assignment_id': '9%d' % code})
        self.chat_is_main('1')
        with self.assertRaises(requests.exceptions.HTTPError):                                 # the admin chat fails on a 404 as it always did
            self.ask(self.detail_api(), 'assignment_detail', {'assignment_id': '99'})

    def test_assignment_detail_an_object_that_is_no_record_is_not_given_to_a_student(self):
        for odd in (None, [], 'x', 5):
            self.assertEqual(self.ask(FakeApi({'/courses/1/assignments/5': odd}), 'assignment_detail', {'assignment_id': '5'}), {'error': SENTENCE['assignment']}, repr(odd))

    def test_my_grades_has_no_row_and_makes_no_request_for_an_assignment_a_student_cannot_see(self):
        def submissions(n):
            return {'/courses/1/assignments/%d/submissions/1001' % n: {'score': n, 'grade': str(n), 'late': False, 'missing': False, 'submitted_at': None}}
        answers = {'/courses/1/assignments': [dict(a) for a in ASSIGNMENTS]}
        for n in (11, 12, 13, 14, 15):
            answers.update(submissions(n))
        api = FakeApi(answers)
        got = self.ask(api, 'my_grades', {'user_id': '1001'})
        self.assertEqual([row['assignment'] for row in got], ['HW1 Docker', 'HW2 Raft', 'HW0 Warm-up'])
        self.assertNoSecret(got)
        self.assertEqual(api.endpoints(), ['/courses/1/assignments'] + ['/courses/1/assignments/%d/submissions/1001' % n for n in (11, 13, 15)])
        self.chat_is_main('1')
        api = FakeApi(answers)
        self.assertEqual(len(self.ask(api, 'my_grades', {'user_id': '1001'})), 5)
        self.assertEqual(len(api.calls), 6)


class TheWeekStatusAction(CanvasApiTestCase):
    """week_status (the weekly brief) reads the same list, and its tested design stays: the unlock date plays no part in WHICH assignment is the week's (test_week_status.py)."""

    def world(self):
        assignments = [
            assignment(41, 'HW6', unlock_at='2026-11-02T17:00:00Z', due_at='2026-11-09T17:00:00Z'),
            assignment(42, 'SECRET-DRAFT', published=False, unlock_at='2026-11-02T17:00:00Z', due_at='2026-11-08T09:00:00Z', description='<p>SECRET-DRAFT-TEXT</p>'),
            assignment(43, 'Quiz that opens tomorrow', unlock_at='2026-11-08T17:00:00Z', due_at='2026-11-08T23:00:00Z', description='<p>SECRET-QUIZ-TEXT</p>'),
            assignment(44, 'SECRET-OVERRIDE', only_visible_to_overrides=True, unlock_at='2026-11-02T17:00:00Z', due_at='2026-11-10T17:00:00Z', description='<p>SECRET-OVERRIDE-TEXT</p>'),
        ]
        modules = [{'id': 1, 'name': 'SECRET Week 99', 'published': False, 'items': [{'type': 'Assignment', 'content_id': 41}]},
                   {'id': 2, 'name': 'Week 8! We are over half way!', 'items': [{'type': 'File', 'content_id': 9}, {'type': 'Assignment', 'content_id': 43, 'published': False},
                                                                              {'type': 'Assignment', 'content_id': 41}]},
                   {'id': 3, 'name': 'Week 9 (locked)', 'unlock_at': AHEAD, 'items': [{'type': 'Assignment', 'content_id': 43}]}]
        answers = {'/courses/1/assignments': assignments, '/courses/1/modules': modules}
        for a in assignments:
            answers['/courses/1/assignments/%d' % a['id']] = dict(a, description=a['description'] + '<p>(detail)</p>')
            answers['/courses/1/assignments/%d/submissions/7' % a['id']] = http_error(404)
        return FakeApi(answers)

    def week(self, api, **params):
        params.setdefault('user_id', '7')
        params.setdefault('now', NOW)
        return self.ask(api, 'week_status', params)

    def test_an_assignment_that_is_not_published_or_is_for_some_students_is_not_in_the_week_not_even_when_named(self):
        for named in ('', '42', '44'):
            api = self.world()
            answer = self.week(api, **({'assignment_id': named} if named else {}))
            self.assertNoSecret(answer, named)
            self.assertEqual([a['id'] for a in answer['assignments']], ['43', '41'], named)                    # by due date; the named one that is hidden falls back to the default
            self.assertNotIn('/courses/1/assignments/42', api.endpoints())
            self.assertNotIn('/courses/1/assignments/44', api.endpoints())

    def test_the_admin_chat_still_finds_an_unpublished_assignment_by_its_id(self):
        self.chat_is_main('1')
        answer = self.week(self.world(), assignment_id='42')
        draft = {a['id']: a for a in answer['assignments']}['42']
        self.assertTrue(draft['primary'])
        self.assertIn('SECRET-DRAFT-TEXT', draft['requirements'])

    def test_an_assignment_that_has_not_opened_is_still_the_weeks_but_its_text_is_withheld_and_not_asked_for(self):
        api = self.world()
        answer = self.week(api)
        first = answer['assignments'][0]
        self.assertEqual((first['id'], first['primary'], first['name']), ('43', True, 'Quiz that opens tomorrow'))     # the earliest due, as the design says: the unlock date plays no part
        self.assertEqual(first['requirements'], '')                              # the brief leaves an empty `requirements` out: the spec is simply absent
        self.assertNotIn('error', json.dumps(answer).lower())                    # and nothing in the answer reads as an error: the brief and the interview go on quietly
        self.assertEqual(first['unlockAt'], '2026-11-08T17:00:00Z')
        self.assertNotIn('SECRET-QUIZ-TEXT', json.dumps(answer))
        self.assertNotIn('/courses/1/assignments/43', api.endpoints())                                         # its detail (the text) is not even asked for
        self.assertIn('Text of HW6.', answer['assignments'][1]['requirements'])                                # one that has opened keeps its text

    def test_the_week_judges_the_unlock_date_at_its_own_now_and_a_moment_that_is_now_is_open(self):
        # the clock of the test case says 2026-11-07 12:00 whatever `now` is: the week is judged at the `now` it was given, like every other date of its answer
        for now, withheld in (('2026-11-08T16:59:59Z', True), ('2026-11-08T17:00:00Z', False), ('2026-11-08T17:00:01Z', False), ('2026-11-07T12:00:00Z', True)):
            api = self.world()
            first = self.week(api, now=now)['assignments'][0]
            self.assertEqual((first['id'], first['primary']), ('43', True), now)
            self.assertEqual(first['requirements'], '' if withheld else 'SECRET-QUIZ-TEXT (detail)', now)
            self.assertEqual('/courses/1/assignments/43' in api.endpoints(), not withheld, now)         # the detail is asked for only when the text is a student's

    def test_the_admin_chat_gets_the_text_of_one_that_has_not_opened_and_asks_for_its_detail(self):
        self.chat_is_main('1')
        api = self.world()
        answer = self.week(api)
        self.assertIn('SECRET-QUIZ-TEXT', answer['assignments'][0]['requirements'])
        self.assertIn('/courses/1/assignments/43', api.endpoints())

    def test_the_week_is_named_by_a_module_a_student_sees(self):
        # 41 is in an unpublished module and in a published one: the published one names the week; 43's own module items are hidden or in a locked module
        self.assertEqual(self.week(self.world(), assignment_id='41')['week'], {'number': 8, 'title': 'Week 8! We are over half way!'})
        self.assertIsNone(self.week(self.world(), assignment_id='43')['week'])                                 # item unpublished, and the other module is locked
        self.chat_is_main('1')
        self.assertEqual(self.week(self.world(), assignment_id='43')['week'], {'number': 8, 'title': 'Week 8! We are over half way!'})

    def test_it_costs_the_requests_it_always_did_no_listing_of_files_among_them(self):
        api = self.world()
        self.week(api, assignment_id='41')                                       # the week is 41 alone: 43 has not started, so it is no more than the week's primary
        self.assertEqual(api.endpoints(), ['/courses/1/assignments', '/courses/1/modules', '/courses/1/assignments/41', '/courses/1/assignments/41/submissions/7'])
        api = self.world()
        self.week(api)                                                           # the default: 43 is the primary (no detail: it has not opened), and 41 is in the week
        self.assertEqual(api.endpoints(), ['/courses/1/assignments', '/courses/1/modules', '/courses/1/assignments/43/submissions/7', '/courses/1/assignments/41/submissions/7'])


# ── pages ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

class ThePageActions(CanvasApiTestCase):
    def world(self):
        answers = {'/courses/1/pages': [dict(p) for p in PAGES]}
        for p in PAGES:
            answers['/courses/1/pages/' + p['url']] = dict(p)
        answers['/courses/1/pages/gone'] = http_error(404)
        for code in (401, 403, 500):
            answers['/courses/1/pages/e%d' % code] = http_error(code)
        return FakeApi(answers)

    def test_pages_a_student_gets_the_published_ones_and_nothing_that_says_what_was_left_out(self):
        for value in NOT_MAIN:
            self.chat_is_main(value)
            api = self.world()
            answer = self.ask(api, 'pages')
            self.assertEqual([p['url'] for p in answer], ['syllabus-notes', 'old'], repr(value))
            self.assertEqual([list(p) for p in answer], [['url', 'title', 'updated_at', 'published']] * 2)
            self.assertNoSecret(answer)
            self.assertEqual(api.calls, [('/courses/1/pages', {'per_page': 50, 'sort': 'title'})])

    def test_pages_the_admin_chat_gets_every_page_as_before(self):
        self.chat_is_main('1')
        self.assertEqual([p['url'] for p in self.ask(self.world(), 'pages')], [p['url'] for p in PAGES])

    def test_page_detail_a_student_reads_a_page_they_see_and_gets_one_sentence_for_the_rest(self):
        api = self.world()
        got = self.ask(api, 'page_detail', {'page_url': 'syllabus-notes'})
        self.assertEqual(got, {'url': 'syllabus-notes', 'title': 'Syllabus notes', 'body': 'Body of Syllabus notes.', 'updated_at': '2026-11-01T00:00:00Z'})
        self.assertEqual(api.calls, [('/courses/1/pages/syllabus-notes', None)])
        for slug in ('draft-week-9', 'hidden-by-flag', 'later', 'gone'):                          # the last is a page Canvas does not know
            api = self.world()
            answer = self.ask(api, 'page_detail', {'page_url': slug})
            self.assertEqual(answer, {'error': SENTENCE['page']}, slug)
            self.assertEqual(api.calls, [('/courses/1/pages/' + slug, None)])

    def test_page_detail_the_admin_chat_reads_any_page_as_before(self):
        self.chat_is_main('1')
        for slug in ('syllabus-notes', 'draft-week-9', 'hidden-by-flag', 'later'):
            self.assertEqual(self.ask(self.world(), 'page_detail', {'page_url': slug})['body'], 'Body of %s.' % [p for p in PAGES if p['url'] == slug][0]['title'])
        with self.assertRaises(requests.exceptions.HTTPError):
            self.ask(self.world(), 'page_detail', {'page_url': 'gone'})

    def test_page_detail_only_a_404_is_taken_for_does_not_know(self):
        for code in (401, 403, 500):
            with self.assertRaises(requests.exceptions.HTTPError, msg=code):
                self.ask(self.world(), 'page_detail', {'page_url': 'e%d' % code})

    def test_page_detail_an_object_that_is_no_record_is_not_given_to_a_student(self):
        for odd in (None, [], 'x'):
            self.assertEqual(self.ask(FakeApi({'/courses/1/pages/p': odd}), 'page_detail', {'page_url': 'p'}), {'error': SENTENCE['page']}, repr(odd))


# ── discussions and announcements ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

class TheTopicActions(CanvasApiTestCase):
    def world(self, **entries_for):
        def listing(params):
            only = (params or {}).get('only_announcements') == 'true'
            return [dict(t) for t in TOPICS if not only or t['id'] in ANNOUNCEMENT_IDS]
        answers = {'/courses/1/discussion_topics': listing}
        for t in TOPICS:
            answers['/courses/1/discussion_topics/%d' % t['id']] = dict(t)
            answers['/courses/1/discussion_topics/%d/entries' % t['id']] = [{'id': 1, 'user_id': 1001, 'message': '<p>Reply of one student.</p>', 'created_at': '2026-11-02T00:00:00Z'}]
        answers['/courses/1/discussion_topics/99'] = http_error(404)
        answers['/courses/1/discussion_topics/99/entries'] = http_error(404)
        for code in (401, 403, 500):
            answers['/courses/1/discussion_topics/9%d' % code] = http_error(code)
        answers.update(entries_for)
        return FakeApi(answers)

    def test_discussions_a_student_gets_the_ones_they_see(self):
        for value in NOT_MAIN:
            self.chat_is_main(value)
            api = self.world()
            answer = self.ask(api, 'discussions')
            self.assertEqual([d['id'] for d in answer], [21, 25, 26], repr(value))                  # a closed topic and one whose posting date has passed are read
            self.assertEqual([list(d) for d in answer], [['id', 'title', 'message', 'posted_at']] * 3)
            self.assertNoSecret(answer)
            self.assertEqual(api.calls, [('/courses/1/discussion_topics', {'per_page': 20})])

    def test_announcements_a_student_gets_only_the_ones_that_are_posted(self):
        for value in NOT_MAIN:
            self.chat_is_main(value)
            api = self.world()
            answer = self.ask(api, 'announcements')
            self.assertEqual([a['id'] for a in answer], [21, 26], repr(value))                      # 22's posting is delayed
            self.assertEqual([list(a) for a in answer], [['id', 'title', 'message', 'posted_at']] * 2)
            self.assertNoSecret(answer)
            self.assertEqual(api.calls, [('/courses/1/discussion_topics', {'only_announcements': 'true', 'per_page': 20})])

    def test_the_admin_chat_gets_every_topic_and_announcement_as_before(self):
        self.chat_is_main('1')
        self.assertEqual([d['id'] for d in self.ask(self.world(), 'discussions')], [t['id'] for t in TOPICS])
        self.assertEqual([a['id'] for a in self.ask(self.world(), 'announcements')], [21, 22, 26])

    def test_discussion_detail_a_student_reads_a_topic_they_see_as_canvas_describes_it(self):
        for tid in (21, 25, 26):
            api = self.world()
            got = self.ask(api, 'discussion_detail', {'topic_id': str(tid)})
            self.assertEqual(got, [t for t in TOPICS if t['id'] == tid][0])
            self.assertEqual(api.calls, [('/courses/1/discussion_topics/%d' % tid, None)])

    def test_discussion_detail_a_hidden_topic_an_announcement_by_its_id_and_an_unknown_id_are_answered_in_the_same_words(self):
        for tid in ('22', '23', '24', '27', '99'):                                                  # the delayed announcement, a draft, a section's, a graded one for some, unknown
            for value in NOT_MAIN:
                self.chat_is_main(value)
                api = self.world()
                self.assertEqual(self.ask(api, 'discussion_detail', {'topic_id': tid}), {'error': SENTENCE['discussion']}, (tid, value))
                self.assertEqual(api.calls, [('/courses/1/discussion_topics/' + tid, None)])

    def test_discussion_detail_the_admin_chat_reads_any_topic_as_before(self):
        self.chat_is_main('1')
        for tid in (22, 23, 24, 27):
            self.assertEqual(self.ask(self.world(), 'discussion_detail', {'topic_id': str(tid)})['title'], [t for t in TOPICS if t['id'] == tid][0]['title'])

    def test_discussion_detail_only_a_404_is_taken_for_does_not_know(self):
        for code in (401, 403, 500):
            with self.assertRaises(requests.exceptions.HTTPError, msg=code):
                self.ask(self.world(), 'discussion_detail', {'topic_id': '9%d' % code})

    def test_discussion_entries_are_asked_for_after_the_topic_is_judged(self):
        api = self.world()
        answer = self.ask(api, 'discussion_entries', {'topic_id': '21'})
        self.assertEqual(answer, [{'id': 1, 'user_id': 1001, 'user_name': None, 'message': 'Reply of one student.', 'created_at': '2026-11-02T00:00:00Z'}])
        self.assertEqual(api.calls, [('/courses/1/discussion_topics/21', None), ('/courses/1/discussion_topics/21/entries', {'per_page': 50})])

    def test_discussion_entries_of_a_hidden_topic_are_never_asked_for(self):
        for tid in ('22', '23', '24', '27', '99'):
            api = self.world()
            self.assertEqual(self.ask(api, 'discussion_entries', {'topic_id': tid}), {'error': SENTENCE['discussion']}, tid)
            self.assertEqual(api.calls, [('/courses/1/discussion_topics/' + tid, None)], tid)               # the topic, and no more

    def test_discussion_entries_of_a_topic_that_shows_its_replies_only_to_those_who_posted_are_not_given(self):
        api = self.world(**{'/courses/1/discussion_topics/21': dict(TOPICS[0], require_initial_post=True)})
        self.assertEqual(self.ask(api, 'discussion_entries', {'topic_id': '21'}), {'error': SENTENCE['replies']})
        self.assertEqual(api.calls, [('/courses/1/discussion_topics/21', None)])
        for flag in (False, None, 'true', 1):                                                                # only exactly true counts
            api = self.world(**{'/courses/1/discussion_topics/21': dict(TOPICS[0], require_initial_post=flag)})
            rows = self.ask(api, 'discussion_entries', {'topic_id': '21'})
            self.assertEqual([r['id'] for r in rows] if isinstance(rows, list) else rows, [1], repr(flag))          # the replies themselves, not a one-key answer that says no

    def test_discussion_entries_of_an_anonymous_discussion_have_no_author(self):
        for state, hidden in (('full_anonymity', True), ('partial_anonymity', True), (None, False), ('', False)):
            api = self.world(**{'/courses/1/discussion_topics/21': dict(TOPICS[0], anonymous_state=state),
                                '/courses/1/discussion_topics/21/entries': [{'id': 1, 'user_id': 1001, 'user': {'display_name': 'Ada'}, 'message': '<p>x</p>', 'created_at': 'c'}]})
            row = self.ask(api, 'discussion_entries', {'topic_id': '21'})[0]
            self.assertEqual((row['user_id'], row['user_name']), (None, None) if hidden else (1001, 'Ada'), state)

    def test_discussion_entries_the_admin_chat_asks_for_the_entries_alone_and_sees_every_author(self):
        self.chat_is_main('1')
        api = self.world(**{'/courses/1/discussion_topics/22/entries': [{'id': 1, 'user_id': 1001, 'user': {'display_name': 'Ada'}, 'message': '<p>x</p>', 'created_at': 'c'}]})
        self.assertEqual(self.ask(api, 'discussion_entries', {'topic_id': '22'}), [{'id': 1, 'user_id': 1001, 'user_name': 'Ada', 'message': 'x', 'created_at': 'c'}])
        self.assertEqual(api.calls, [('/courses/1/discussion_topics/22/entries', {'per_page': 50})])

    def test_discussion_entries_only_a_404_is_taken_for_does_not_know(self):
        for code in (401, 403, 500):
            with self.assertRaises(requests.exceptions.HTTPError, msg=code):
                self.ask(self.world(), 'discussion_entries', {'topic_id': '9%d' % code})
        api = self.world(**{'/courses/1/discussion_topics/21/entries': http_error(500)})                  # a visible topic whose replies fail: that is Canvas failing
        with self.assertRaises(requests.exceptions.HTTPError):
            self.ask(api, 'discussion_entries', {'topic_id': '21'})


# ── modules ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

class TheModuleActions(CanvasApiTestCase):
    def world(self, modules=None, files=FILES):
        modules = modules_world() if modules is None else modules
        answers = {'/courses/1/modules': modules, '/courses/1/files': files}
        for m in modules:
            answers['/courses/1/modules/%d' % m['id']] = {k: v for k, v in m.items() if k != 'items'}
            answers['/courses/1/modules/%d/items' % m['id']] = list(m.get('items') or [])
        answers['/courses/1/modules/99'] = http_error(404)
        answers['/courses/1/modules/99/items'] = http_error(404)
        for code in (401, 403, 500):
            answers['/courses/1/modules/9%d' % code] = http_error(code)
        return FakeApi(answers)

    def test_modules_a_student_gets_the_modules_and_items_they_see(self):
        for value in NOT_MAIN:
            self.chat_is_main(value)
            api = self.world()
            answer = self.ask(api, 'modules')
            self.assertEqual([m['id'] for m in answer], [31, 34, 35], repr(value))                  # unpublished and locked modules are left out whole
            self.assertEqual([list(m) for m in answer], [['id', 'name', 'position', 'items_count', 'items']] * 3)
            self.assertEqual([i['title'] for i in answer[0]['items']], ['Intro page', 'Open slides', 'HW1 item', 'Reading'])
            self.assertEqual([list(i) for i in answer[0]['items']], [['title', 'type', 'content_id', 'external_url', 'html_url', 'page_url']] * 4)
            self.assertNoSecret(answer)

    def test_modules_the_count_is_of_the_items_a_student_sees(self):
        answer = self.ask(self.world(), 'modules')
        self.assertEqual(answer[0]['items_count'], 4)                                               # Canvas says 7: three of them are hidden
        self.assertEqual((len(answer[1]['items']), answer[1]['items_count']), (20, 25))             # the listing shows twenty items, the count is of all that a student sees
        self.assertEqual((answer[2]['items'], answer[2]['items_count']), ([], None))                # Canvas left the items out: its count would include the hidden ones

    def test_modules_the_files_a_student_could_open_are_asked_of_canvas_once(self):
        api = self.world()
        self.ask(api, 'modules')
        self.assertEqual(api.calls, [('/courses/1/modules', {'include[]': 'items', 'per_page': 50}), ('/courses/1/files', {'per_page': 100, 'sort': 'updated_at', 'order': 'desc'})])

    def test_modules_with_no_file_item_ask_for_no_files(self):
        modules = [m for m in modules_world() if m['id'] in (34, 35)]
        api = self.world(modules)
        self.ask(api, 'modules')
        self.assertEqual(api.endpoints(), ['/courses/1/modules'])
        no_file_in_a_visible_module = [dict(m, items=[i for i in m['items'] if i['type'] != 'File']) if m['id'] == 31 else m for m in modules_world()]
        api = self.world(no_file_in_a_visible_module)
        self.ask(api, 'modules')
        self.assertEqual(api.endpoints(), ['/courses/1/modules'])

    def test_modules_a_file_item_is_judged_by_the_rule_of_files(self):
        for flags, shown in (({}, True), ({'hidden': True}, False), ({'locked': True}, False), ({'unlock_at': AHEAD}, False), ({'lock_at': PAST}, False),
                             ({'unlock_at': PAST, 'lock_at': AHEAD}, True), ({'hidden': 'true'}, True)):
            module = [{'id': 5, 'name': 'M', 'published': True, 'items': [module_item(51, 'F', 'File', content_id=101)]}]
            api = self.world(module, [course_file(101, 'f', **flags)])
            self.assertEqual(len(self.ask(api, 'modules')[0]['items']), 1 if shown else 0, flags)

    def test_modules_the_admin_chat_gets_every_module_and_item_as_before(self):
        self.chat_is_main('1')
        api = self.world()
        answer = self.ask(api, 'modules')
        self.assertEqual([m['id'] for m in answer], [31, 32, 33, 34, 35])
        self.assertEqual([i['title'] for i in answer[0]['items']][:3], ['Intro page', 'Open slides', 'SECRET-HIDDEN-FILE item'])
        self.assertEqual([m['items_count'] for m in answer], [7, 1, 1, 25, 9])                      # Canvas's own counts
        self.assertEqual(len(answer[1]['items']), 1)
        self.assertEqual(len(answer[3]['items']), 20)
        self.assertEqual(api.calls, [('/courses/1/modules', {'include[]': 'items', 'per_page': 50})])    # one request: no listing of files

    def test_module_items_a_student_gets_the_items_they_see_after_the_module_is_judged(self):
        api = self.world()
        answer = self.ask(api, 'module_items', {'module_id': '31'})
        self.assertEqual([i['title'] for i in answer], ['Intro page', 'Open slides', 'HW1 item', 'Reading'])
        self.assertEqual([list(i) for i in answer], [['id', 'title', 'type', 'content_id', 'external_url', 'html_url', 'page_url']] * 4)
        self.assertNoSecret(answer)
        self.assertEqual(api.calls, [('/courses/1/modules/31', None), ('/courses/1/modules/31/items', {'per_page': 50}), ('/courses/1/files', {'per_page': 100, 'sort': 'updated_at', 'order': 'desc'})])

    def test_module_items_of_a_module_with_no_file_item_ask_for_no_files(self):
        api = self.world()
        self.assertEqual(len(self.ask(api, 'module_items', {'module_id': '34'})), 25)
        self.assertEqual(api.endpoints(), ['/courses/1/modules/34', '/courses/1/modules/34/items'])

    def test_module_items_a_module_that_is_hidden_lists_nothing_and_says_the_same_as_one_canvas_does_not_know(self):
        for module_id in ('32', '33', '99'):                                                         # unpublished, locked until a date, unknown
            for value in NOT_MAIN:
                self.chat_is_main(value)
                api = self.world()
                self.assertEqual(self.ask(api, 'module_items', {'module_id': module_id}), {'error': SENTENCE['module']}, (module_id, value))
                self.assertEqual(api.calls, [('/courses/1/modules/' + module_id, None)])             # the module, and not its items

    def test_module_items_the_admin_chat_gets_every_item_with_the_one_request_it_always_made(self):
        self.chat_is_main('1')
        api = self.world()
        self.assertEqual(len(self.ask(api, 'module_items', {'module_id': '31'})), 7)
        self.assertEqual([i['title'] for i in self.ask(self.world(), 'module_items', {'module_id': '32'})], ['SECRET-IN-UNPUBLISHED'])        # an unpublished module's item, in the admin chat
        self.assertEqual(api.calls, [('/courses/1/modules/31/items', {'per_page': 50})])

    def test_module_items_only_a_404_is_taken_for_does_not_know(self):
        for code in (401, 403, 500):
            with self.assertRaises(requests.exceptions.HTTPError, msg=code):
                self.ask(self.world(), 'module_items', {'module_id': '9%d' % code})


# ── the actions that have no student's rule, and the accounting ──────────────────────────────────────────────────────────────────────────────────

class TheActionsThatAreLeftAlone(CanvasApiTestCase):
    def test_the_syllabus_is_the_same_in_every_view(self):
        course = {'name': 'CS6650', 'syllabus_body': '<p>Week 1: <a href="https://canvas.example.edu/courses/1/files/12/download">Syllabus</a></p>'}
        answers = []
        for value in (None, '0', '1'):
            self.chat_is_main(value)
            api = FakeApi({'/courses/1': course})
            answers.append(self.ask(api, 'syllabus'))
            self.assertEqual(api.calls, [('/courses/1', {'include[]': 'syllabus_body'})])
        self.assertEqual(answers[0], answers[1])
        self.assertEqual(answers[0], answers[2])
        self.assertEqual(answers[0], {'course_name': 'CS6650', 'syllabus': 'Week 1: Syllabus'})                 # the link is a tag: only its words are text

    def test_every_action_has_its_place_in_this_table(self):
        # What the student's rule does with each action of the script. An action that is added to the script without a row here fails this test: it needs a decision.
        # rule       the student's rule is applied here (the tests above)
        # files      the rule of the files (test_canvas_api_student_files.py)
        # bound      about one student: the host binds the user (access.ts); what it returns is that student's own
        # refused    lists the class: refused by the host to every container but the admin chat (access.ts CANVAS_RESTRICTED_ACTIONS); nothing here filters its rows
        # nothing    nothing in it is kept from a student
        table = {
            'assignments': 'rule', 'upcoming': 'rule', 'assignment_detail': 'rule', 'my_grades': 'rule', 'week_status': 'rule', 'pages': 'rule', 'page_detail': 'rule',
            'discussions': 'rule', 'announcements': 'rule', 'discussion_detail': 'rule', 'discussion_entries': 'rule', 'modules': 'rule', 'module_items': 'rule',
            'files': 'files', 'file_content': 'files',
            'student_submission': 'bound', 'user_contact': 'bound',
            'grades': 'refused', 'users': 'refused', 'submissions': 'refused',
            'syllabus': 'nothing',
        }
        available = canvas_api.handle({'action': 'nope', 'params': {}})['available']
        self.assertEqual(sorted(table), sorted(available))
        self.assertEqual(len(available), 21)

    def test_the_actions_the_host_refuses_are_the_ones_the_table_says(self):
        source = (HERE.parent / 'agent-runner' / 'src' / 'access.ts')
        if not source.exists():
            self.skipTest('access.ts is not beside the scripts')
        text = source.read_text(encoding='utf-8')
        restricted = re.search(r"CANVAS_RESTRICTED_ACTIONS[^=]*=\s*new Set\(\[([^\]]*)\]", text)
        identity = re.search(r"CANVAS_IDENTITY_ACTIONS[^=]*=\s*new Set\(\[([^\]]*)\]", text)
        self.assertEqual(sorted(re.findall(r"'(\w+)'", restricted.group(1))), ['grades', 'submissions', 'users'])
        self.assertEqual(sorted(re.findall(r"'(\w+)'", identity.group(1))), ['my_grades', 'student_submission'])


# ── the real script, against a stand-in Canvas that serves what a student may not have ──────────────────────────────────────────────────────────────

@unittest.skipUnless(HAVE_REQUESTS, 'canvas_api.py needs the requests package')
class TheScriptAsTheContainerRunsIt(unittest.TestCase):
    """The real script with the environment of the MCP server, against a stand-in Canvas on the loopback address. The stand-in answers for the hidden things when it is
    asked (a control shows it does): what a student's call must show is that none of it reaches the answer. Dates are far from any clock: 2999 is ahead of it and 2001 is
    behind it."""

    HITS = []

    @classmethod
    def setUpClass(cls):
        far, long_ago = '2999-01-01T00:00:00Z', '2001-01-01T00:00:00Z'
        cls.assignments = [assignment(11, 'HW1 Docker'), assignment(12, 'SECRET-DRAFT', published=False), assignment(13, 'HW2 opens later', unlock_at=far),
                           assignment(14, 'SECRET-OVERRIDE', only_visible_to_overrides=True), assignment(15, 'HW0 closed', lock_at=long_ago)]
        cls.pages = [page('open', 'Open page'), page('draft', 'SECRET-DRAFT page', published=False), page('later', 'SECRET-LATER page', publish_at=far)]
        cls.topics = [topic(21, 'Welcome'), topic(22, 'SECRET-DELAYED announcement', delayed_post_at=far, workflow_state='post_delayed'),
                      topic(23, 'SECRET-DRAFT topic', published=False), topic(24, 'Closed topic', locked=True, lock_at=long_ago)]
        cls.announcement_ids = (21, 22)
        cls.files = [course_file(101, 'slides.pdf'), course_file(102, 'solutions.pdf', hidden=True)]
        cls.modules = [
            {'id': 31, 'name': 'Week 8', 'position': 1, 'items_count': 4, 'published': True, 'items': [
                module_item(311, 'Intro page', 'Page', page_url='open'), module_item(312, 'Open slides', 'File', content_id=101),
                module_item(313, 'SECRET-HIDDEN-FILE item', 'File', content_id=102), module_item(314, 'SECRET-DRAFT item', 'Page', page_url='draft', published=False)]},
            {'id': 32, 'name': 'SECRET-UNPUBLISHED module', 'position': 2, 'items_count': 0, 'published': False, 'items': []},
            {'id': 33, 'name': 'SECRET-LOCKED module', 'position': 3, 'items_count': 0, 'published': True, 'unlock_at': far, 'items': []},
        ]

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
                parts = urlparse(self.path)
                path, query = parts.path, parse_qs(parts.query)
                cls.HITS.append(path)
                if self.headers.get('Authorization') != 'Bearer ' + TOKEN:
                    return self.reply(401, {'errors': [{'message': 'bad token'}]})
                found = re.fullmatch(r'/api/v1/courses/1(?:/(.*))?', path)
                if not found:
                    return self.reply(404, {'errors': [{'message': 'not found'}]})
                rest = found.group(1)
                none = {'errors': [{'message': 'The specified resource does not exist.'}]}

                def one(items, key, value, extra=None):
                    for item in items:
                        if str(item.get(key)) == value:
                            return self.reply(200, dict(item, **(extra or {})))
                    return self.reply(404, none)
                if rest is None:
                    return self.reply(200, {'name': 'CS6650', 'syllabus_body': '<p>Syllabus text.</p>'})
                if rest == 'assignments':
                    return self.reply(200, cls.assignments)
                match = re.fullmatch(r'assignments/(\d+)', rest)
                if match:
                    return one([dict(ASSIGNMENT_OBJECT_EXTRAS, **a) for a in cls.assignments], 'id', match.group(1))
                match = re.fullmatch(r'assignments/(\d+)/submissions/(\d+)', rest)
                if match:
                    return self.reply(200, {'score': 5, 'grade': '5', 'late': False, 'missing': False, 'submitted_at': None})
                if rest == 'pages':
                    return self.reply(200, cls.pages)
                match = re.fullmatch(r'pages/([^/]+)', rest)
                if match:
                    return one(cls.pages, 'url', match.group(1))
                if rest == 'discussion_topics':
                    only = query.get('only_announcements') == ['true']
                    return self.reply(200, [t for t in cls.topics if not only or t['id'] in cls.announcement_ids])
                match = re.fullmatch(r'discussion_topics/(\d+)', rest)
                if match:
                    return one(cls.topics, 'id', match.group(1))
                match = re.fullmatch(r'discussion_topics/(\d+)/entries', rest)
                if match:
                    return self.reply(200, [{'id': 1, 'user_id': 7, 'message': '<p>A reply.</p>', 'created_at': '2026-11-01T00:00:00Z'}])
                if rest == 'modules':
                    return self.reply(200, cls.modules)
                match = re.fullmatch(r'modules/(\d+)', rest)
                if match:
                    return one([{k: v for k, v in m.items() if k != 'items'} for m in cls.modules], 'id', match.group(1))
                match = re.fullmatch(r'modules/(\d+)/items', rest)
                if match:
                    return self.reply(200, [i for m in cls.modules if str(m['id']) == match.group(1) for i in m['items']])
                if rest == 'files':
                    return self.reply(200, cls.files)
                self.reply(404, none)

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), StandIn)
        cls.base = 'http://127.0.0.1:%d/api/v1' % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def run_script(self, action, params=None, is_main=None):
        env = {k: v for k, v in os.environ.items() if k not in ('NANOCLAW_IS_MAIN', 'TAI_STUDENT_TZ') and 'proxy' not in k.lower()}
        env.update({'CANVAS_API_TOKEN': TOKEN, 'CANVAS_BASE_URL': self.base, 'CANVAS_COURSE_ID': '1', 'NO_PROXY': '127.0.0.1'})
        if is_main is not None:
            env['NANOCLAW_IS_MAIN'] = is_main
        self.HITS.clear()
        done = subprocess.run([sys.executable, str(HERE / 'canvas_api.py')], input=json.dumps({'action': action, 'params': params or {}}), capture_output=True, text=True, env=env,
                              timeout=60)
        self.assertNotIn(TOKEN, done.stdout + done.stderr)                   # the token is never printed
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)      # a refusal is an answer, not a failure
        return json.loads(done.stdout)

    LISTS = ['assignments', 'upcoming', 'pages', 'discussions', 'announcements', 'modules']
    BY_ID = [('assignment_detail', {'assignment_id': '12'}), ('assignment_detail', {'assignment_id': '14'}),
             ('page_detail', {'page_url': 'draft'}), ('page_detail', {'page_url': 'later'}), ('discussion_detail', {'topic_id': '22'}), ('discussion_detail', {'topic_id': '23'}),
             ('discussion_entries', {'topic_id': '22'}), ('module_items', {'module_id': '32'}), ('module_items', {'module_id': '33'})]

    def test_control_the_stand_in_does_serve_what_a_student_must_not_get(self):
        auth = {'Authorization': 'Bearer ' + TOKEN}
        with requests.Session() as session:
            session.trust_env = False                                        # the loopback address, whatever proxy this machine is set up with
            for tail in ('/courses/1/assignments/12', '/courses/1/pages/draft', '/courses/1/discussion_topics/22', '/courses/1/modules/32'):
                self.assertIn('SECRET', json.dumps(session.get(self.base + tail, headers=auth, timeout=15).json()), tail)
            self.assertIn('SECRET', json.dumps(session.get(self.base + '/courses/1/modules', headers=auth, timeout=15).json()))

    def test_no_listing_a_student_gets_names_anything_hidden(self):
        for action in self.LISTS:
            for is_main in (None, '0') if action != 'assignments' else NOT_MAIN:
                answer = self.run_script(action, is_main=is_main)
                self.assertNotIn('SECRET', json.dumps(answer), (action, is_main))
                self.assertTrue(answer, (action, is_main))                    # and something is left: the things a student sees
            self.assertIn('SECRET', json.dumps(self.run_script(action, is_main='1')), action)       # the admin chat sees all of it, as before

    def test_what_a_student_asks_for_by_id_is_one_sentence(self):
        sentences = {'assignment_detail': SENTENCE['assignment'], 'page_detail': SENTENCE['page'], 'discussion_detail': SENTENCE['discussion'],
                     'discussion_entries': SENTENCE['discussion'], 'module_items': SENTENCE['module']}
        for action, params in self.BY_ID:
            for is_main in (None, '0'):
                answer = self.run_script(action, params, is_main=is_main)
                self.assertEqual(answer, {'error': sentences[action]}, (action, params, is_main))
                self.assertNotIn('SECRET', json.dumps(answer))
            admin = self.run_script(action, params, is_main='1')                                       # the instructor's own view: the thing itself
            self.assertNotIn('error', admin if isinstance(admin, dict) else {}, (action, params))

    def test_an_assignment_that_has_not_opened_is_answered_without_its_words_and_without_an_error(self):
        for is_main in (None, '0'):
            answer = self.run_script('assignment_detail', {'assignment_id': '13'}, is_main=is_main)
            self.assertNotIn('error', answer, is_main)                     # the mock interview prints an error under "Context errors": there is none to print
            self.assertEqual(answer['name'], 'HW2 opens later')
            self.assertEqual(answer['note'], 'Not open to students yet: it unlocks %s. Its description and rubric are not shown until then.' % pacific('2999-01-01T00:00:00Z'))
            self.assertNotIn('description', answer)
            self.assertNotIn('Text of HW2', json.dumps(answer))
            self.assertEqual(self.HITS, ['/api/v1/courses/1/assignments/13'])
        admin = self.run_script('assignment_detail', {'assignment_id': '13'}, is_main='1')
        self.assertIn('Text of HW2', admin['description'])                 # the admin chat has the words

    def test_the_things_a_student_sees_are_read_in_every_view(self):
        for action, params, key, value in (('assignment_detail', {'assignment_id': '11'}, 'name', 'HW1 Docker'), ('assignment_detail', {'assignment_id': '15'}, 'name', 'HW0 closed'),
                                           ('page_detail', {'page_url': 'open'}, 'title', 'Open page'), ('discussion_detail', {'topic_id': '24'}, 'title', 'Closed topic')):
            for is_main in (None, '1'):
                self.assertEqual(self.run_script(action, params, is_main=is_main)[key], value, (action, params, is_main))
        self.assertEqual([row['message'] for row in self.run_script('discussion_entries', {'topic_id': '21'}, is_main=None)], ['A reply.'])
        self.assertEqual([i['title'] for i in self.run_script('module_items', {'module_id': '31'}, is_main=None)], ['Intro page', 'Open slides'])

    def test_a_student_asks_canvas_for_what_it_needs_and_no_more(self):
        self.run_script('assignments', is_main=None)
        self.assertEqual(self.HITS, ['/api/v1/courses/1/assignments'])
        self.run_script('modules', is_main=None)
        self.assertEqual(self.HITS, ['/api/v1/courses/1/modules', '/api/v1/courses/1/files'])                 # one listing of the files, for the File items
        self.run_script('modules', is_main='1')
        self.assertEqual(self.HITS, ['/api/v1/courses/1/modules'])
        self.run_script('discussion_entries', {'topic_id': '21'}, is_main=None)
        self.assertEqual(self.HITS, ['/api/v1/courses/1/discussion_topics/21', '/api/v1/courses/1/discussion_topics/21/entries'])
        self.run_script('discussion_entries', {'topic_id': '22'}, is_main=None)
        self.assertEqual(self.HITS, ['/api/v1/courses/1/discussion_topics/22'])                              # judged, and its replies not asked for
        self.run_script('module_items', {'module_id': '33'}, is_main=None)
        self.assertEqual(self.HITS, ['/api/v1/courses/1/modules/33'])
        self.run_script('my_grades', {'user_id': '1001'}, is_main=None)
        self.assertEqual(self.HITS, ['/api/v1/courses/1/assignments'] + ['/api/v1/courses/1/assignments/%d/submissions/1001' % n for n in (11, 13, 15)])
        self.run_script('syllabus', is_main=None)
        self.assertEqual(self.HITS, ['/api/v1/courses/1'])

    def test_an_unknown_id_is_one_sentence_for_a_student_and_a_failure_for_the_admin_chat_as_before(self):
        answer = self.run_script('assignment_detail', {'assignment_id': '4242'}, is_main=None)
        self.assertEqual(answer, {'error': SENTENCE['assignment']})
        env = {k: v for k, v in os.environ.items() if k != 'TAI_STUDENT_TZ' and 'proxy' not in k.lower()}
        env.update({'CANVAS_API_TOKEN': TOKEN, 'CANVAS_BASE_URL': self.base, 'CANVAS_COURSE_ID': '1', 'NO_PROXY': '127.0.0.1', 'NANOCLAW_IS_MAIN': '1'})
        done = subprocess.run([sys.executable, str(HERE / 'canvas_api.py')], input=json.dumps({'action': 'assignment_detail', 'params': {'assignment_id': '4242'}}),
                              capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(done.returncode, 1)
        self.assertIn('Canvas API error: 404', json.loads(done.stdout)['error'])


if __name__ == '__main__':
    unittest.main()
