"""container/scripts/canvas_api.py: week_status, user_contact and the extended student_submission (docs/WEEKLY_BRIEF.md).

canvas_api.py is imported and its handle() is called with the HTTP layer replaced by a fake Canvas (FakeCanvas below answers the endpoints the script
asks for and records every request), so nothing here can reach a real Canvas. One class at the end runs the script as the container runs it (JSON on
stdin, JSON on stdout) against a stand-in server on the loopback address, for the wiring that import cannot show.
Run: python container/scripts/test_week_status.py   (needs the `requests` package, which the agent image has)
"""
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

BASE = 'https://canvas.example.edu/api/v1'
os.environ.update(CANVAS_API_TOKEN='test-token', CANVAS_BASE_URL=BASE, CANVAS_COURSE_ID='1')
os.environ.pop('TAI_STUDENT_TZ', None)
if HAVE_REQUESTS:
    import canvas_api
    from pacific_time import student_zone

NOW = '2026-11-04T20:00:00Z'          # a Wednesday, 12:00 Pacific (daylight time ended on Sunday November 1)
ADA = 7


def assignment(aid, name, unlock, due, published=True, points=100, types=('online_text_entry',), description=None, rubric=None):
    return {'id': aid, 'name': name, 'unlock_at': unlock, 'due_at': due, 'published': published, 'points_possible': points,
            'submission_types': list(types), 'description': description if description is not None else '<p>Requirements of %s.</p>' % name,
            'html_url': 'https://canvas.example.edu/courses/1/assignments/%d' % aid, 'rubric': rubric}


def standard_assignments():
    return [
        assignment(201, 'Homework 5: Load balancing', '2026-10-26T17:00:00Z', '2026-11-02T17:00:00Z'),     # due Mon Nov 2, 9:00 AM PST
        assignment(202, 'Homework 6: Scalability', '2026-11-02T17:00:00Z', '2026-11-09T17:00:00Z',          # due Mon Nov 9, 9:00 AM PST: the open one
                   rubric=[{'id': '_10', 'description': 'Load test design', 'points': 10}, {'id': '_11', 'description': 'Report', 'points': 5}]),
        assignment(203, 'Homework 7: Queues', '2026-11-09T17:00:00Z', '2026-11-16T17:00:00Z'),              # not unlocked yet
        assignment(204, 'Hidden draft', '2026-11-02T17:00:00Z', '2026-11-06T17:00:00Z', published=False),
        assignment(205, 'Midterm Mastery Part 1', '2026-10-07T17:00:00Z', '2026-10-14T17:00:00Z'),          # due three weeks ago
        assignment(206, 'Reading response', None, None),
        assignment(207, 'Class participation', None, '2026-11-10T17:00:00Z', points=10, types=('online_url',)),   # no unlock date: runs from a week before it is due
    ]


def standard_modules():
    return [
        {'id': 1, 'name': 'Week 7! Almost there', 'items': [{'type': 'Assignment', 'content_id': 201}]},
        {'id': 2, 'name': 'Week 8! We are over half way!', 'items': [{'type': 'File', 'content_id': 9}, {'type': 'Assignment', 'content_id': 202}]},
    ]


class FakeCanvas:
    """What Canvas answers, and a record of what was asked."""

    def __init__(self):
        self.calls = []
        self.unexpected = []
        self.assignments = standard_assignments()
        self.modules = standard_modules()
        self.details = {}                 # assignment id -> fields the detail has and the list has not
        self.submissions = {}             # (assignment id, user id) -> a submission, or an HTTP status
        self.profiles = {}                # user id -> a profile, or an HTTP status
        self.course_users = {}            # user id -> a course user record, or an HTTP status
        self.fail = {}                    # path -> HTTP status
        self.on_request = None

    def route(self, path, params):
        self.calls.append((path, params))
        if self.on_request:
            self.on_request()
        if path in self.fail:
            return self.fail[path], {'errors': [{'message': 'broken'}]}
        if path == '/courses/1/assignments':
            return 200, self.assignments
        if path == '/courses/1/modules':
            return 200, self.modules
        m = re.fullmatch(r'/courses/1/assignments/(\d+)', path)
        if m:
            found = [a for a in self.assignments if str(a['id']) == m.group(1)]
            return (200, dict(found[0], **self.details.get(int(m.group(1)), {}))) if found else (404, {'errors': 'not found'})
        m = re.fullmatch(r'/courses/1/assignments/(\d+)/submissions/(\d+)', path)
        if m:
            got = self.submissions.get((int(m.group(1)), int(m.group(2))), 404)
            return (got, {'errors': 'x'}) if isinstance(got, int) else (200, got)
        m = re.fullmatch(r'/users/(\d+)/profile', path)
        if m:
            got = self.profiles.get(int(m.group(1)), 404)
            return (got, {'errors': 'x'}) if isinstance(got, int) else (200, got)
        m = re.fullmatch(r'/courses/1/users/(\d+)', path)
        if m:
            got = self.course_users.get(int(m.group(1)), 404)
            return (got, {'errors': 'x'}) if isinstance(got, int) else (200, got)
        self.unexpected.append(path)
        return 404, {'errors': 'not found'}

    def get(self, url, headers=None, params=None, timeout=None):
        assert url.startswith(BASE), 'a request to somewhere that is not Canvas: ' + url[:60]
        status, body = self.route(url[len(BASE):], params)
        return FakeResponse(status, body)

    def paths(self):
        return [p for p, _ in self.calls]


class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self.text = json.dumps(body)
        self.headers = {}

    def raise_for_status(self):
        if self.status_code >= 400:
            error = requests.exceptions.HTTPError('HTTP %d' % self.status_code)
            error.response = self
            raise error


def submission(**fields):
    base = {'user_id': ADA, 'workflow_state': 'unsubmitted', 'submitted_at': None, 'late': False, 'missing': False, 'score': None, 'grade': None,
            'attempt': None, 'submission_type': None, 'submission_comments': [], 'excused': False}
    base.update(fields)
    return base


@unittest.skipUnless(HAVE_REQUESTS, 'canvas_api.py needs the requests package')
class Base(unittest.TestCase):
    def setUp(self):
        self.world = FakeCanvas()
        patcher = mock.patch.object(canvas_api.requests, 'get', self.world.get)
        patcher.start()
        self.addCleanup(patcher.stop)
        saved = os.environ.pop('TAI_STUDENT_TZ', None)
        if saved is not None:
            self.addCleanup(os.environ.__setitem__, 'TAI_STUDENT_TZ', saved)

    def ask(self, action, **params):
        return canvas_api.handle({'action': action, 'params': params})

    def week(self, **params):
        params.setdefault('user_id', str(ADA))
        params.setdefault('now', NOW)
        return self.ask('week_status', **params)

    def by_id(self, answer):
        return {a['id']: a for a in answer['assignments']}


class WindowAndSelection(Base):
    def test_without_a_named_assignment_the_open_one_due_first_is_primary_and_the_week_is_every_assignment_running_now(self):
        answer = self.week()
        self.assertEqual([(a['id'], a['primary']) for a in answer['assignments']], [('201', False), ('202', True), ('207', False)])     # by due date
        self.assertEqual(answer['window'], {'since': '2026-10-28T20:00:00Z', 'until': NOW})
        # not here: 203 (not unlocked), 204 (not published), 205 (due three weeks ago), 206 (no dates)
        self.assertEqual(set(self.by_id(answer)), {'201', '207', '202'})

    def test_the_week_is_the_name_and_number_of_the_module_that_holds_the_primary_assignment(self):
        self.assertEqual(self.week()['week'], {'number': 8, 'title': 'Week 8! We are over half way!'})
        self.assertEqual(self.week(assignment_id='201')['week'], {'number': 7, 'title': 'Week 7! Almost there'})

    def test_a_module_that_names_no_week_gives_a_title_and_no_number_and_no_module_gives_none(self):
        self.world.modules[1]['name'] = 'Mastery review'
        self.assertEqual(self.week()['week'], {'number': None, 'title': 'Mastery review'})
        self.world.modules = []
        self.assertIsNone(self.week()['week'])

    def test_when_nothing_is_open_the_assignment_most_recently_due_is_primary(self):
        answer = self.week(now='2026-11-20T20:00:00Z')
        self.assertEqual([a['id'] for a in answer['assignments'] if a['primary']], ['203'])          # 203 was due Nov 16, the latest: 202 and the rest are older
        self.assertEqual(answer['assignments'][-1]['id'], '203')

    def test_a_named_assignment_is_primary_and_the_window_starts_at_its_unlock_date_when_that_is_earlier_than_a_week_ago(self):
        answer = self.week(assignment_id='201')
        self.assertEqual([a['id'] for a in answer['assignments'] if a['primary']], ['201'])
        self.assertEqual(answer['window']['since'], '2026-10-26T17:00:00Z')

    def test_the_window_never_reaches_back_more_than_21_days(self):
        self.world.assignments[0]['unlock_at'] = '2026-08-01T17:00:00Z'
        self.assertEqual(self.week(assignment_id='201')['window']['since'], '2026-10-14T20:00:00Z')

    def test_a_named_assignment_that_is_not_unlocked_is_in_the_week_anyway_and_the_window_is_a_week(self):
        answer = self.week(assignment_id='203')
        self.assertIn('203', self.by_id(answer))
        self.assertTrue(self.by_id(answer)['203']['primary'])
        self.assertEqual(answer['window']['since'], '2026-10-28T20:00:00Z')
        self.assertEqual(len(answer['assignments']), 4)                                              # 201, 207, 202 and 203

    def test_a_name_that_is_not_in_the_course_falls_back_to_the_default(self):
        self.assertEqual([a['id'] for a in self.week(assignment_id='999')['assignments'] if a['primary']], ['202'])

    def test_at_most_four_assignments_and_the_ones_due_closest_to_the_primary_stay(self):
        self.world.assignments += [assignment(208, 'Extra A', '2026-11-01T17:00:00Z', '2026-11-08T17:00:00Z'), assignment(209, 'Extra B', '2026-11-02T17:00:00Z', '2026-11-11T17:00:00Z')]
        answer = self.week()
        ids = [a['id'] for a in answer['assignments']]
        self.assertEqual(len(ids), 4)
        self.assertEqual(ids, ['208', '202', '207', '209'])                                          # 201 (a week before the primary) is the one that goes; sorted by due date
        self.assertIn('202', ids)

    def test_an_assignment_with_no_unlock_date_runs_for_the_week_before_it_is_due(self):
        self.world.assignments.append(assignment(210, 'Quiz', None, '2026-11-13T17:00:00Z'))        # starts Nov 6: not yet
        self.world.assignments.append(assignment(211, 'Old quiz', None, '2026-10-30T17:00:00Z'))    # started Oct 23, due 5 days ago: in
        ids = [a['id'] for a in self.week()['assignments']]
        self.assertNotIn('210', ids)
        self.assertIn('211', ids)

    def test_the_unlock_date_plays_no_part_in_the_default_a_published_assignment_due_first_is_the_primary(self):
        # the rule is the one the TypeScript side uses on a list that has no unlock date (weekly-brief.ts pickPrimaryAssignment)
        self.world.assignments.append(assignment(212, 'Quiz that opens on Friday', '2026-11-06T17:00:00Z', '2026-11-07T17:00:00Z'))
        self.assertEqual([a['id'] for a in self.week()['assignments'] if a['primary']], ['212'])
        self.assertEqual(canvas_api.pick_primary(self.world.assignments, '', canvas_api.parse_utc(NOW))['id'], 212)

    def test_the_course_on_the_thursday_of_the_live_check_has_homework_7_as_its_primary(self):
        # names and dates of the owner's live check of 2026-11-05 (the ids, the older homework and the leftovers' other dates are made up)
        self.world.assignments = [
            assignment(1001, 'Homework 5: Load balancing', '2026-10-12T17:00:00Z', '2026-10-19T16:00:00Z'),
            assignment(1002, 'Homework 6: Scalability?', '2026-10-19T16:00:00Z', '2026-10-26T16:00:00Z'),
            assignment(1003, 'Midterm Mastery Part 2', '2026-10-28T17:00:00Z', '2026-11-02T17:00:00Z'),
            assignment(1004, 'Homework 7: Cost savings?!', '2026-11-02T17:00:00Z', '2026-11-09T17:00:00Z'),
            assignment(1005, 'Final Project Details', None, None),
            assignment(1006, 'Spring leftover: Homework 1', None, '2026-02-09T17:00:00Z', published=False),
            assignment(1007, 'Spring leftover: Final', None, '2026-11-06T17:00:00Z', published=False),
        ]
        answer = self.week(now='2026-11-05T20:00:00Z')
        self.assertEqual([(a['name'], a['primary']) for a in answer['assignments']], [('Midterm Mastery Part 2', False), ('Homework 7: Cost savings?!', True)])
        self.assertEqual(answer['window'], {'since': '2026-10-29T20:00:00Z', 'until': '2026-11-05T20:00:00Z'})
        # the same without a day's difference: the midterm is what the old default of start_mock_interview would have centred on
        self.assertEqual(canvas_api.pick_primary(self.world.assignments, '', canvas_api.parse_utc('2026-11-05T20:00:00Z'))['id'], 1004)

    def test_no_assignments_at_all_is_an_empty_answer_with_a_week_long_window(self):
        self.world.assignments = []
        self.assertEqual(self.week(), {'window': {'since': '2026-10-28T20:00:00Z', 'until': NOW}, 'week': None, 'assignments': []})

    def test_the_list_failing_is_an_error_the_caller_can_report(self):
        self.world.fail['/courses/1/assignments'] = 500
        with self.assertRaises(requests.exceptions.HTTPError):
            self.week()


class Fields(Base):
    def test_every_assignment_has_exactly_the_fields_of_the_brief(self):
        a = self.week()['assignments'][0]
        self.assertEqual(list(a), ['id', 'name', 'primary', 'unlockAt', 'dueAt', 'due', 'points', 'requirements', 'status', 'statusLine', 'submission'])
        self.assertEqual((a['id'], a['name'], a['unlockAt'], a['dueAt'], a['points']), ('201', 'Homework 5: Load balancing', '2026-10-26T17:00:00Z', '2026-11-02T17:00:00Z', 100))

    def test_due_says_the_pacific_time_and_how_far_away_it_is_counted_from_the_given_now(self):
        due = {a['id']: a['due'] for a in self.week()['assignments']}
        self.assertEqual(due, {'201': 'Mon Nov 2, 9:00 AM PST (2 days ago)', '202': 'Mon Nov 9, 9:00 AM PST (in 5 days)', '207': 'Tue Nov 10, 9:00 AM PST (in 6 days)'})
        self.world.assignments[0]['due_at'] = None
        self.world.assignments[0]['unlock_at'] = '2026-10-30T17:00:00Z'
        self.assertEqual(self.by_id(self.week(assignment_id='201'))['201']['due'], 'no due date')

    def test_a_student_in_another_zone_gets_their_own_clock_in_due(self):
        if student_zone('Pacific/Auckland') is None:
            self.skipTest('no time zone data for Pacific/Auckland on this machine')
        os.environ['TAI_STUDENT_TZ'] = 'Pacific/Auckland'
        self.addCleanup(os.environ.pop, 'TAI_STUDENT_TZ', None)
        self.assertEqual(self.by_id(self.week())['202']['due'], 'Mon Nov 9, 9:00 AM PST (in 5 days; on your clock: Tue Nov 10, 6:00 AM (Pacific/Auckland, UTC+13))')

    def test_requirements_are_plain_text_and_cut_at_2500_for_the_primary_and_600_for_the_others(self):
        self.world.assignments[1]['description'] = '<h1>Goal</h1><p>' + ('Scale it. ' * 600) + '</p><script>alert(1)</script>'
        self.world.assignments[0]['description'] = '<p>' + ('word ' * 400) + '</p>'
        got = self.by_id(self.week())
        self.assertTrue(got['202']['requirements'].startswith('Goal Scale it.'))
        self.assertLessEqual(len(got['202']['requirements']), 2500)
        self.assertGreater(len(got['202']['requirements']), 2400)
        self.assertTrue(got['202']['requirements'].endswith('\u2026'))
        self.assertNotIn('<', got['202']['requirements'].replace('alert(1)', ''))
        self.assertLessEqual(len(got['201']['requirements']), 600)
        self.assertGreater(len(got['201']['requirements']), 500)

    def test_the_detail_of_the_primary_assignment_supplies_what_the_list_left_out(self):
        self.world.assignments[1]['description'] = None
        self.world.details[202] = {'description': '<p>The full text.</p>'}
        self.assertEqual(self.by_id(self.week())['202']['requirements'], 'The full text.')
        self.assertIn('/courses/1/assignments/202', self.world.paths())

    def test_control_characters_and_bidi_overrides_are_gone_from_every_text(self):
        self.world.assignments[1]['name'] = 'Homework\x00 6\u202e'
        self.world.assignments[1]['description'] = '<p>Do\x07 this\x1b[31m now\u202a \x7f ok</p>'
        self.world.submissions[(202, ADA)] = submission(workflow_state='submitted', submitted_at='2026-11-03T22:00:00Z', submission_type='online_text_entry',
                                                        body='<p>my\x00 answer\u2066 \x85here\x9b\x80!</p>', score=None,
                                                        submission_comments=[{'author_id': 99, 'comment': 'nice\x00\x08 work\u202e', 'created_at': '2026-11-04T01:00:00Z'}])
        a = self.by_id(self.week())['202']
        blob = json.dumps(a, ensure_ascii=False)
        self.assertEqual(a['name'], 'Homework 6')
        self.assertEqual(a['requirements'], 'Do this[31m now ok')
        self.assertEqual(a['submission']['text'], 'my answer here!')
        self.assertEqual(a['submission']['comments'][0]['text'], 'nice work')
        self.assertIsNone(re.search('[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]', blob))

    def test_the_points_are_a_number_or_none(self):
        self.world.assignments[0]['points_possible'] = None
        self.assertIsNone(self.by_id(self.week())['201']['points'])
        self.world.assignments[0]['points_possible'] = 12.5
        self.assertEqual(self.by_id(self.week())['201']['points'], 12.5)


class StatusSentences(Base):
    """One test per sentence the interviewer may be handed: submission_status of canvas_api, with the Pacific times and the whole sentence."""
    CLOCK = canvas_api.parse_utc(NOW) if HAVE_REQUESTS else None
    A = {'id': 1, 'points_possible': 100, 'due_at': '2026-11-02T17:00:00Z', 'submission_types': ['online_text_entry']}

    def status(self, sub, a=None, now=None):
        return canvas_api.submission_status(a or self.A, sub, now or self.CLOCK)

    def test_graded_on_time(self):
        self.assertEqual(self.status(submission(workflow_state='graded', submitted_at='2026-11-01T20:30:00Z', score=88, grade='88', attempt=1)),
                         ('graded', 'Submitted Sun Nov 1, 12:30 PM PST, on time; graded 88 of 100'))

    def test_graded_late_with_a_second_attempt_and_a_half_point(self):
        self.assertEqual(self.status(submission(workflow_state='graded', submitted_at='2026-11-03T20:30:00Z', late=True, score=70.5, grade='70.5', attempt=2)),
                         ('graded', 'Submitted Tue Nov 3, 12:30 PM PST (attempt 2), late; graded 70.5 of 100'))

    def test_graded_by_a_word_when_the_assignment_has_no_points(self):
        a = dict(self.A, points_possible=0)
        self.assertEqual(self.status(submission(workflow_state='graded', submitted_at='2026-11-01T20:30:00Z', grade='complete'), a),
                         ('graded', 'Submitted Sun Nov 1, 12:30 PM PST, on time; graded complete'))

    def test_graded_with_no_submission_on_record(self):
        self.assertEqual(self.status(submission(workflow_state='graded', score=50, grade='50')), ('graded', 'No submission is on record; graded 50 of 100'))

    def test_excused(self):
        self.assertEqual(self.status(submission(excused=True)), ('graded', 'Excused: the instructor excused this assignment'))

    def test_submitted_on_time_and_not_graded_yet(self):
        self.assertEqual(self.status(submission(workflow_state='submitted', submitted_at='2026-11-01T20:30:00Z', attempt=1)),
                         ('submitted', 'Submitted Sun Nov 1, 12:30 PM PST, on time; not graded yet'))

    def test_submitted_and_waiting_for_review(self):
        self.assertEqual(self.status(submission(workflow_state='pending_review', submitted_at='2026-11-01T20:30:00Z'))[1],
                         'Submitted Sun Nov 1, 12:30 PM PST, on time; waiting for review')

    def test_submitted_with_no_due_date_does_not_say_on_time(self):
        a = dict(self.A, due_at=None)
        self.assertEqual(self.status(submission(workflow_state='submitted', submitted_at='2026-11-01T20:30:00Z'), a)[1], 'Submitted Sun Nov 1, 12:30 PM PST; not graded yet')

    def test_late_and_not_graded_yet_says_when_it_was_due(self):
        self.assertEqual(self.status(submission(workflow_state='submitted', submitted_at='2026-11-03T20:30:00Z', late=True, attempt=3)),
                         ('late', 'Submitted Tue Nov 3, 12:30 PM PST (attempt 3), late (it was due Mon Nov 2, 9:00 AM PST); not graded yet'))

    def test_missing_when_canvas_says_so_or_when_it_was_due_and_nothing_came(self):
        expect = ('missing', 'Missing: it was due Mon Nov 2, 9:00 AM PST (2 days ago) and nothing was submitted')
        self.assertEqual(self.status(submission(missing=True)), expect)
        self.assertEqual(self.status(submission(missing=False)), expect)
        self.assertEqual(self.status(submission(missing=True), dict(self.A, due_at=None)), ('missing', 'Missing: Canvas marks it missing and nothing was submitted'))

    def test_not_submitted_yet_says_when_it_is_due(self):
        a = dict(self.A, due_at='2026-11-09T17:00:00Z')
        self.assertEqual(self.status(submission(), a), ('not_submitted', 'Not submitted yet; due Mon Nov 9, 9:00 AM PST (in 5 days)'))
        self.assertEqual(self.status(submission(), dict(a, due_at=None)), ('not_submitted', 'Not submitted yet (no due date)'))

    def test_an_extension_the_student_has_counts_over_the_assignments_due_date(self):
        extended = submission(cached_due_date='2026-11-09T17:00:00Z')
        self.assertEqual(self.status(extended)[0], 'not_submitted')                                    # the assignment's own date (Nov 2) has passed
        self.assertEqual(self.status(submission())[0], 'missing')

    def test_unknown_when_canvas_would_not_give_the_submission(self):
        self.assertEqual(self.status(None), ('unknown', "Status unknown: Canvas did not return this student's submission"))

    def test_unknown_when_there_is_nothing_to_submit_online(self):
        for types in (['on_paper'], ['none'], ['not_graded']):
            self.assertEqual(self.status(submission(), dict(self.A, submission_types=types)), ('unknown', 'No online submission is expected for this assignment'), types)

    def test_graded_wins_over_the_kind_of_assignment(self):
        a = dict(self.A, submission_types=['on_paper'])
        self.assertEqual(self.status(submission(workflow_state='graded', score=9, grade='9'), a)[0], 'graded')


class SubmissionsInTheAnswer(Base):
    def test_each_assignment_carries_its_status_and_the_submission_it_was_read_from(self):
        self.world.submissions[(201, ADA)] = submission(workflow_state='graded', submitted_at='2026-11-01T20:30:00Z', score=88, grade='88', attempt=1,
                                                        submission_type='online_text_entry', body='<p>Repo: https://github.com/ada/hw5-lb</p>')
        self.world.submissions[(202, ADA)] = submission(workflow_state='submitted', submitted_at='2026-11-03T22:00:00Z', attempt=2, submission_type='online_url',
                                                        url='https://github.khoury.northeastern.edu/ada/hw6-scale')
        self.world.submissions[(207, ADA)] = submission()
        got = self.by_id(self.week())
        self.assertEqual((got['201']['status'], got['201']['statusLine']), ('graded', 'Submitted Sun Nov 1, 12:30 PM PST, on time; graded 88 of 100'))
        self.assertEqual((got['202']['status'], got['202']['statusLine']), ('submitted', 'Submitted Tue Nov 3, 2:00 PM PST (attempt 2), on time; not graded yet'))
        self.assertEqual((got['207']['status'], got['207']['submission']['submittedAt']), ('not_submitted', None))
        s = got['201']['submission']
        self.assertEqual(list(s), ['submittedAt', 'late', 'missing', 'score', 'grade', 'attempt', 'type', 'links', 'text', 'comments', 'rubric'])
        self.assertEqual((s['submittedAt'], s['late'], s['missing'], s['score'], s['grade'], s['attempt'], s['type']),
                         ('2026-11-01T20:30:00Z', False, False, 88, '88', 1, 'online_text_entry'))
        self.assertEqual((s['links'], s['text']), (['https://github.com/ada/hw5-lb'], 'Repo: https://github.com/ada/hw5-lb'))
        self.assertEqual(got['202']['submission']['links'], ['https://github.khoury.northeastern.edu/ada/hw6-scale'])
        self.assertEqual(got['202']['submission']['text'], 'Submission URL: https://github.khoury.northeastern.edu/ada/hw6-scale')

    def test_a_submission_canvas_will_not_give_is_unknown_and_the_rest_are_still_there(self):
        self.world.submissions[(201, ADA)] = 500
        self.world.submissions[(202, ADA)] = submission(workflow_state='submitted', submitted_at='2026-11-03T22:00:00Z', submission_type='online_text_entry', body='x')
        got = self.by_id(self.week())
        self.assertEqual((got['201']['status'], got['201']['submission']), ('unknown', None))
        self.assertEqual(got['201']['statusLine'], "Status unknown: Canvas did not return this student's submission")
        self.assertEqual(got['202']['status'], 'submitted')

    def test_text_is_cut_at_1500_for_the_primary_and_600_for_the_others_and_at_most_five_links(self):
        body = '<p>' + ' '.join('https://github.com/ada/repo%d' % i for i in range(8)) + ' ' + ('z' * 3000) + '</p>'
        for aid in (201, 202):
            self.world.submissions[(aid, ADA)] = submission(workflow_state='submitted', submitted_at='2026-11-01T20:30:00Z', submission_type='online_text_entry', body=body)
        got = self.by_id(self.week())
        self.assertEqual(len(got['202']['submission']['text']), 1500)
        self.assertEqual(len(got['201']['submission']['text']), 600)
        self.assertEqual(len(got['202']['submission']['links']), 5)
        self.assertEqual(got['202']['submission']['links'][0], 'https://github.com/ada/repo0')

    def test_comments_are_oldest_first_at_most_five_300_characters_and_say_only_who_wrote_them_in_a_word(self):
        comments = [{'author_id': 99, 'author_name': 'Prof Secret Name', 'comment': 'c%d ' % i + 'q' * 400, 'created_at': '2026-11-03T1%d:00:00Z' % i} for i in range(7)]
        comments.append({'author_id': ADA, 'comment': 'student says hi', 'created_at': '2026-11-03T09:00:00Z'})
        comments.append({'comment': 'nobody wrote this', 'created_at': '2026-11-03T08:00:00Z'})
        self.world.submissions[(202, ADA)] = submission(workflow_state='submitted', submitted_at='2026-11-03T22:00:00Z', submission_comments=list(reversed(comments)))
        got = self.by_id(self.week())['202']['submission']['comments']
        self.assertEqual(len(got), 5)
        self.assertEqual([c['at'] for c in got], sorted(c['at'] for c in got))
        self.assertEqual([c['from'] for c in got], ['teacher'] * 5)
        self.assertTrue(all(len(c['text']) <= 300 for c in got))
        self.assertTrue(got[-1]['text'].startswith('c6 q'))
        self.assertNotIn('Secret', json.dumps(got))
        self.assertEqual(list(got[0]), ['at', 'from', 'text'])

    def test_the_student_and_a_comment_without_an_author_are_told_apart_from_the_teachers(self):
        self.world.submissions[(202, ADA)] = submission(workflow_state='submitted', submitted_at='2026-11-03T22:00:00Z', submission_comments=[
            {'author_id': ADA, 'comment': 'mine', 'created_at': '2026-11-03T10:00:00Z'}, {'author_id': 99, 'comment': 'theirs', 'created_at': '2026-11-03T11:00:00Z'},
            {'comment': 'anon', 'created_at': '2026-11-03T12:00:00Z'}])
        self.assertEqual([c['from'] for c in self.by_id(self.week())['202']['submission']['comments']], ['student', 'teacher', 'other'])

    def test_rubric_lines_name_the_criterion_the_points_and_the_comment(self):
        self.world.submissions[(202, ADA)] = submission(workflow_state='graded', submitted_at='2026-11-03T22:00:00Z', score=13, grade='13', rubric_assessment={
            '_10': {'points': 8, 'comments': 'Good ramp-up'}, '_11': {'points': 5}, '_99': {'points': 3, 'comments': 'a criterion the rubric does not describe'}})
        self.assertEqual(self.by_id(self.week())['202']['submission']['rubric'], ['Load test design: 8/10 - Good ramp-up', 'Report: 5/5'])

    def test_at_most_eight_rubric_lines(self):
        criteria = [{'id': '_%d' % i, 'description': 'Criterion %d' % i, 'points': 10} for i in range(12)]
        self.world.assignments[1]['rubric'] = criteria
        self.world.submissions[(202, ADA)] = submission(workflow_state='graded', submitted_at='2026-11-03T22:00:00Z', score=50, grade='50',
                                                        rubric_assessment={c['id']: {'points': 5} for c in criteria})
        lines = self.by_id(self.week())['202']['submission']['rubric']
        self.assertEqual(len(lines), 8)
        self.assertEqual(lines[0], 'Criterion 0: 5/10')

    def test_an_upload_gives_the_file_names_and_never_downloads_or_shows_the_download_address(self):
        self.world.submissions[(202, ADA)] = submission(workflow_state='submitted', submitted_at='2026-11-03T22:00:00Z', submission_type='online_upload', attachments=[
            {'filename': 'hw6.zip', 'display_name': 'hw6.zip', 'url': 'https://canvas.example.edu/files/9/download?download_frd=1&verifier=SECRETKEY'},
            {'filename': 'report.pdf', 'url': 'https://canvas.example.edu/files/10/download?verifier=SECRETKEY2'}])
        answer = self.week()
        self.assertEqual(self.by_id(answer)['202']['submission']['text'], 'Uploaded files: hw6.zip, report.pdf')
        self.assertNotIn('SECRETKEY', json.dumps(answer))
        self.assertEqual(self.world.unexpected, [])                                                      # nothing was fetched that is not the API's own

    def test_a_github_link_in_a_comment_is_a_link_of_the_submission(self):
        self.world.submissions[(202, ADA)] = submission(workflow_state='submitted', submitted_at='2026-11-03T22:00:00Z', submission_type='online_upload', submission_comments=[
            {'author_id': ADA, 'comment': 'code is at https://github.com/ada/hw6-final thanks', 'created_at': '2026-11-03T22:05:00Z'}])
        self.assertEqual(self.by_id(self.week())['202']['submission']['links'], ['https://github.com/ada/hw6-final'])

    def test_the_students_own_due_date_replaces_the_assignments_in_that_assignments_entry(self):
        self.world.submissions[(201, ADA)] = submission(cached_due_date='2026-11-09T17:00:00Z')
        got = self.by_id(self.week())['201']
        self.assertEqual((got['dueAt'], got['status']), ('2026-11-09T17:00:00Z', 'not_submitted'))
        self.assertEqual(got['due'], 'Mon Nov 9, 9:00 AM PST (in 5 days)')

    def test_it_costs_the_list_the_modules_the_detail_and_one_submission_each_at_most_seven_requests(self):
        for aid in (201, 202, 207):
            self.world.submissions[(aid, ADA)] = submission()
        self.week()
        self.assertEqual(self.world.paths(), ['/courses/1/assignments', '/courses/1/modules', '/courses/1/assignments/202',
                                              '/courses/1/assignments/201/submissions/7', '/courses/1/assignments/202/submissions/7', '/courses/1/assignments/207/submissions/7'])
        self.assertLessEqual(len(self.world.calls), 7)                       # the most there can be: four submissions


class Budget(Base):
    def test_when_the_time_is_used_up_the_rest_is_unknown_not_missing_and_the_window_and_assignments_still_come(self):
        clock = {'t': 0.0}

        def tick():
            clock['t'] += 4.0                                                                           # every request takes four seconds

        self.world.on_request = tick
        real = canvas_api.Budget
        with mock.patch.object(canvas_api, 'Budget', lambda seconds: real(seconds, clock=lambda: clock['t'])):
            answer = self.week()                                                                        # 11 s: the list (4), the modules (8), the detail (12: it started in time)
        self.assertEqual(self.world.paths(), ['/courses/1/assignments', '/courses/1/modules', '/courses/1/assignments/202'])
        self.assertEqual([(a['id'], a['status'], a['submission']) for a in answer['assignments']], [('201', 'unknown', None), ('202', 'unknown', None), ('207', 'unknown', None)])
        self.assertEqual(answer['week']['number'], 8)
        self.assertEqual(answer['window']['until'], NOW)

    def test_one_failing_request_does_not_stop_the_others(self):
        self.world.fail['/courses/1/modules'] = 500
        self.world.fail['/courses/1/assignments/202'] = 500
        answer = self.week()
        self.assertIsNone(answer['week'])
        self.assertEqual(len(answer['assignments']), 3)
        self.assertIn('Homework 6', self.by_id(answer)['202']['requirements'])                          # the list's copy of the description

    def test_the_request_timeout_is_cut_to_six_seconds(self):
        saved = canvas_api.TIMEOUT
        try:
            canvas_api.TIMEOUT = 15
            self.week()
            self.assertEqual(canvas_api.TIMEOUT, 6)
        finally:
            canvas_api.TIMEOUT = saved


class Arguments(Base):
    def test_the_user_id_is_required_and_digits_and_nothing_is_asked_of_canvas_without_it(self):
        for bad in ('', 'abc', '7/../8', '7?x=1', ' 7'):
            self.assertIn('error', self.ask('week_status', user_id=bad), repr(bad))
        self.assertIn('error', self.ask('week_status'))
        self.assertEqual(self.world.calls, [])

    def test_the_assignment_id_must_be_digits_too(self):
        self.assertIn('error', self.week(assignment_id='../x'))
        self.assertEqual(self.world.calls, [])

    def test_an_unreadable_now_is_the_clock(self):
        answer = self.week(now='soon')
        self.assertRegex(answer['window']['until'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')


class UserContact(Base):
    def test_the_profile_gives_name_email_and_login_and_is_the_only_request_when_it_is_enough(self):
        self.world.profiles[ADA] = {'id': ADA, 'name': 'Ada Lovelace', 'primary_email': 'ada@example.com', 'login_id': 'lovelace.a'}
        self.assertEqual(self.ask('user_contact', user_id=str(ADA)), {'name': 'Ada Lovelace', 'email': 'ada@example.com', 'login_id': 'lovelace.a'})
        self.assertEqual(self.world.paths(), ['/users/7/profile'])

    def test_when_the_profile_is_not_allowed_the_course_record_is_used(self):
        self.world.profiles[ADA] = 403
        self.world.course_users[ADA] = {'id': ADA, 'name': 'Ada Lovelace', 'email': 'ada@example.com', 'login_id': 'lovelace.a'}
        self.assertEqual(self.ask('user_contact', user_id=str(ADA)), {'name': 'Ada Lovelace', 'email': 'ada@example.com', 'login_id': 'lovelace.a'})
        self.assertEqual(self.world.paths(), ['/users/7/profile', '/courses/1/users/7'])
        self.assertEqual(self.world.calls[1][1], {'include[]': 'email'})

    def test_a_profile_without_an_email_is_completed_from_the_course_record(self):
        self.world.profiles[ADA] = {'name': 'Ada Lovelace', 'primary_email': None, 'login_id': 'lovelace.a'}
        self.world.course_users[ADA] = {'name': 'A. Lovelace', 'email': 'ada@example.com'}
        self.assertEqual(self.ask('user_contact', user_id=str(ADA)), {'name': 'Ada Lovelace', 'email': 'ada@example.com', 'login_id': 'lovelace.a'})

    def test_when_nothing_can_be_read_everything_is_none_and_it_is_not_an_error(self):
        self.assertEqual(self.ask('user_contact', user_id=str(ADA)), {'name': None, 'email': None, 'login_id': None})

    def test_only_a_numeric_id_is_looked_up(self):
        for bad in ('', '7/profile', '../8', 'me'):
            self.assertIn('error', self.ask('user_contact', user_id=bad), repr(bad))
        self.assertEqual(self.world.calls, [])

    def test_the_text_it_returns_is_clean_and_bounded(self):
        self.world.profiles[ADA] = {'name': 'Ada\x00 Love\u202elace', 'primary_email': 'ada@example.com\x07', 'login_id': 'x' * 500}
        got = self.ask('user_contact', user_id=str(ADA))
        self.assertEqual((got['name'], got['email']), ('Ada Lovelace', 'ada@example.com'))
        self.assertLessEqual(len(got['login_id']), 200)


class ExistingActions(Base):
    def test_student_submission_keeps_its_keys_and_adds_four(self):
        self.world.submissions[(202, ADA)] = submission(workflow_state='submitted', submitted_at='2026-11-03T22:00:00Z', attempt=2, late=False, missing=False, score=None,
                                                        submission_type='online_text_entry', body='<p>Docker, https://github.com/ada/hw6</p>', rubric_assessment={'_10': {'points': 8}},
                                                        submission_comments=[{'author_id': ADA, 'comment': 'see https://github.com/ada/hw6-extra', 'created_at': '2026-11-03T22:01:00Z'}])
        got = self.ask('student_submission', assignment_id='202', user_id=str(ADA))
        for key in ('submission_type', 'submitted_at', 'score', 'grade', 'late', 'full_text', 'github_urls', 'google_docs_urls', 'attachment_notes', 'rubric_assessment'):
            self.assertIn(key, got, key)
        self.assertEqual((got['missing'], got['workflow_state'], got['attempt']), (False, 'submitted', 2))
        self.assertEqual(got['comments'], [{'at': '2026-11-03T22:01:00Z', 'role': 'student', 'text': 'see https://github.com/ada/hw6-extra'}])
        self.assertEqual(got['github_urls'], ['https://github.com/ada/hw6', 'https://github.com/ada/hw6-extra'])
        self.assertEqual(got['full_text'], 'Docker, https://github.com/ada/hw6')

    def test_assignments_and_my_grades_are_what_they_were(self):
        listed = self.ask('assignments')
        self.assertEqual(list(listed[0]), ['id', 'name', 'due_at', 'due_pacific', 'due_relative', 'points_possible', 'submission_types', 'html_url', 'published'])
        self.world.submissions[(201, ADA)] = submission(score=5, grade='5')
        self.assertEqual(self.ask('my_grades', user_id=str(ADA))[0]['score'], 5)

    def test_the_unknown_action_message_lists_the_new_actions(self):
        listed = self.ask('nope')['available']
        self.assertIn('week_status', listed)
        self.assertIn('user_contact', listed)

    def test_due_fields_without_now_still_counts_from_the_clock(self):
        self.assertTrue(canvas_api.due_fields('2020-01-01T17:00:00Z')['due_relative'].startswith('was due'))


class StandInCanvas(BaseHTTPRequestHandler):
    world = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        status, body = self.world.route(parsed.path[len('/api/v1'):].rstrip('/'), None)
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@unittest.skipUnless(HAVE_REQUESTS, 'canvas_api.py needs the requests package')
class TheScriptAsTheContainerRunsIt(unittest.TestCase):
    """The same answers through stdin and stdout, against a stand-in server: the wiring (action names, JSON, exit code) that importing the file skips."""

    @classmethod
    def setUpClass(cls):
        cls.world = FakeCanvas()
        cls.world.submissions[(202, ADA)] = submission(workflow_state='submitted', submitted_at='2026-11-03T22:00:00Z', submission_type='online_text_entry', body='hello')
        cls.world.profiles[ADA] = {'name': 'Ada Lovelace', 'primary_email': 'ada@example.com', 'login_id': 'lovelace.a'}
        StandInCanvas.world = cls.world
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), StandInCanvas)
        cls.base = 'http://127.0.0.1:%d/api/v1' % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def run_script(self, action, params):
        env = {k: v for k, v in os.environ.items() if k != 'TAI_STUDENT_TZ' and 'proxy' not in k.lower()}
        env.update({'CANVAS_API_TOKEN': 'test-token', 'CANVAS_BASE_URL': self.base, 'CANVAS_COURSE_ID': '1', 'NO_PROXY': '127.0.0.1'})
        done = subprocess.run([sys.executable, str(HERE / 'canvas_api.py')], input=json.dumps({'action': action, 'params': params}), capture_output=True, text=True, env=env, timeout=60)
        return done.returncode, json.loads(done.stdout)

    def test_week_status_and_user_contact_through_the_script(self):
        code, answer = self.run_script('week_status', {'user_id': str(ADA), 'now': NOW})
        self.assertEqual(code, 0)
        self.assertEqual([(a['id'], a['status']) for a in answer['assignments']], [('201', 'unknown'), ('202', 'submitted'), ('207', 'unknown')])
        self.assertEqual(answer['week']['number'], 8)
        code, answer = self.run_script('user_contact', {'user_id': str(ADA)})
        self.assertEqual((code, answer['email']), (0, 'ada@example.com'))

    def test_a_failing_assignment_list_is_an_error_with_a_non_zero_exit(self):
        self.world.fail['/courses/1/assignments'] = 500
        try:
            code, answer = self.run_script('week_status', {'user_id': str(ADA), 'now': NOW})
        finally:
            del self.world.fail['/courses/1/assignments']
        self.assertEqual(code, 1)
        self.assertIn('Canvas API error: 500', answer['error'])


if __name__ == '__main__':
    unittest.main()
