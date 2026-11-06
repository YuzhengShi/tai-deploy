"""container/scripts/github_api.py: `commits` with since / until / limit, and `activity` (docs/WEEKLY_BRIEF.md).

github_api.py is imported and its handle() is called with the HTTP layer replaced by a fake GitHub (FakeGitHub below answers the endpoints the script
asks for the way GitHub does, filters and all, and records every request), so nothing here can reach GitHub. One class at the end runs the script as
the container runs it (JSON on stdin, JSON on stdout) against a stand-in server on the loopback address.
Run: python container/scripts/test_github_activity.py   (needs the `requests` package, which the agent image has)
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
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

try:
    import requests
    HAVE_REQUESTS = True
except ImportError:
    HAVE_REQUESTS = False

GHE = 'https://ghe.example.edu/api/v3'
PUBLIC = 'https://api.github.com'
os.environ.update(GITHUB_TOKEN='ghe-token', GITHUB_BASE_URL=GHE, GITHUB_TOKEN_PUBLIC='pub-token', GITHUB_BASE_URL_PUBLIC=PUBLIC)
if HAVE_REQUESTS:
    import github_api

SINCE = '2026-10-28T20:00:00Z'
UNTIL = '2026-11-04T20:00:00Z'
OWNER = 'ada-l'


def repo(name, owner, pushed, updated=None):
    return {'name': name, 'full_name': '%s/%s' % (owner, name), 'owner': {'login': owner}, 'html_url': 'https://ghe.example.edu/%s/%s' % (owner, name),
            'pushed_at': pushed, 'updated_at': updated or pushed, 'private': False}


def commit(sha, date, message, login=OWNER, files=None, author_date=None):
    return {'sha': sha, 'date': date, 'author_date': author_date or date, 'message': message, 'login': login, 'files': files if files is not None else [
        {'filename': 'main.go', 'status': 'modified', 'additions': 10, 'deletions': 2, 'patch': '@@ -1 +1 @@\n+' + 'x' * 600}]}


class FakeGitHub:
    """GitHub: repositories by full name with their commits; commits are filtered by author, since and until and cut to per_page like the real thing."""

    def __init__(self):
        self.calls = []
        self.repos = {}                 # full name -> {'repo': {...}, 'commits': [...], 'status': HTTP status or None, 'detail_status': {sha: status}}
        self.listing_status = None
        self.on_request = None
        self.ignore_per_page = False    # a server that sends more than was asked for

    def add(self, info, commits=(), status=None):
        self.repos[info['full_name']] = {'repo': info, 'commits': list(commits), 'status': status, 'detail_status': {}}

    def get(self, url, headers=None, params=None, timeout=None):
        which = 'public' if url.startswith(PUBLIC) else 'ghe' if url.startswith(GHE) else None
        assert which, 'a request to somewhere that is not GitHub: ' + url[:60]
        path = url[len(PUBLIC if which == 'public' else GHE):]
        self.calls.append({'host': which, 'path': path, 'params': dict(params or {}), 'auth': (headers or {}).get('Authorization')})
        if self.on_request:
            self.on_request()
        status, body, link = self.route(path, dict(params or {}))
        return FakeResponse(status, body, link)

    def route(self, path, params):
        m = re.fullmatch(r'/users/([^/]+)/repos', path)
        if m:
            if self.listing_status:
                return self.listing_status, {'message': 'Not Found'}, ''
            owned = [e['repo'] for e in self.repos.values()]
            owned.sort(key=lambda r: r['pushed_at'], reverse=True)
            return 200, owned, '<%s/users/x/repos?page=2>; rel="next"' % GHE
        m = re.fullmatch(r'/repos/([^/]+)/([^/]+)', path)
        if m:
            entry = self.repos.get('%s/%s' % m.groups())
            return (200, entry['repo'], '') if entry else (404, {'message': 'Not Found'}, '')
        m = re.fullmatch(r'/repos/([^/]+)/([^/]+)/commits', path)
        if m:
            entry = self.repos.get('%s/%s' % m.groups())
            if not entry:
                return 404, {'message': 'Not Found'}, ''
            if entry['status']:
                return entry['status'], {'message': 'Git Repository is empty.'}, ''
            found = [c for c in entry['commits']
                     if (not params.get('author') or c['login'] == params['author'])
                     and (not params.get('since') or c['date'] >= params['since']) and (not params.get('until') or c['date'] <= params['until'])]
            found.sort(key=lambda c: c['date'], reverse=True)
            return 200, [self.listed(entry['repo'], c) for c in (found if self.ignore_per_page else found[:int(params.get('per_page', 30))])], '<%s/x?page=2>; rel="next"' % GHE
        m = re.fullmatch(r'/repos/([^/]+)/([^/]+)/commits/([0-9a-f]+)', path)
        if m:
            entry = self.repos.get('%s/%s' % m.groups()[:2])
            if entry and m.group(3) in entry['detail_status']:
                return entry['detail_status'][m.group(3)], {'message': 'broken'}, ''
            found = [c for c in (entry['commits'] if entry else []) if c['sha'] == m.group(3)]
            if not found:
                return 404, {'message': 'Not Found'}, ''
            return 200, dict(self.listed(entry['repo'], found[0]), files=found[0]['files'], stats={'total': 12}), ''
        return 404, {'message': 'Not Found'}, ''

    @staticmethod
    def listed(info, c):
        return {'sha': c['sha'], 'html_url': '%s/commit/%s' % (info['html_url'], c['sha']), 'author': {'login': c['login']},
                'commit': {'message': c['message'], 'author': {'name': 'Name of %s' % c['login'], 'date': c['author_date']},
                           'committer': {'name': 'Name of %s' % c['login'], 'date': c['date']}}}

    def paths(self, kind=None):
        return [c['path'] for c in self.calls if kind is None or c['path'].endswith(kind)]


class FakeResponse:
    def __init__(self, status, body, link=''):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)
        self.headers = {'Link': link} if link else {}

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            error = requests.exceptions.HTTPError('HTTP %d' % self.status_code)
            error.response = self
            raise error


def standard_world():
    world = FakeGitHub()
    world.add(repo('hw6-scalability', OWNER, '2026-11-03T21:00:00Z'), [
        commit('3d1f0a99b2c4e5f60718293a4b5c6d7e8f901234', '2026-11-03T20:11:00Z', 'Add worker pool\n\nUses a WaitGroup so the handler can return early', author_date='2026-10-30T09:00:00Z'),   # written on the 30th, rebased (committed) on the 3rd
        commit('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', '2026-11-02T18:00:00Z', 'Initial HW6 skeleton'),
        commit('0000000000000000000000000000000000000001', '2026-10-20T10:00:00Z', 'Before the window')])
    world.add(repo('hw5-load-balancer', OWNER, '2026-10-30T10:00:00Z'), [commit('b00b1e5b00b1e5b00b1e5b00b1e5b00b1e5b00b1', '2026-10-29T10:00:00Z', 'Fix health checks')])
    world.add(repo('team-project', 'cs6650-org', '2026-11-04T10:00:00Z'), [
        commit('c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00', '2026-11-04T09:00:00Z', 'Add metrics'),
        commit('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '2026-11-04T08:00:00Z', "Bob's private change", login='bob-k')])
    world.add(repo('old-stuff', OWNER, '2026-09-01T10:00:00Z', updated='2026-11-04T19:00:00Z'), [commit('0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0ld0', '2026-09-01T10:00:00Z', 'Old')])
    world.add(repo('empty-new', OWNER, '2026-11-04T12:00:00Z'), status=409)
    return world


@unittest.skipUnless(HAVE_REQUESTS, 'github_api.py needs the requests package')
class Base(unittest.TestCase):
    def setUp(self):
        self.world = standard_world()
        patcher = mock.patch.object(github_api.requests, 'get', self.world.get)
        patcher.start()
        self.addCleanup(patcher.stop)

    def ask(self, action, **params):
        return github_api.handle({'action': action, 'params': dict(params)})

    def activity(self, **params):
        params.setdefault('owner', OWNER)
        params.setdefault('since', SINCE)
        params.setdefault('until', UNTIL)
        return self.ask('activity', **params)


class Commits(Base):
    def test_since_until_and_limit_reach_github_and_the_answer_has_the_keys_it_always_had(self):
        got = self.ask('commits', owner=OWNER, repo='hw6-scalability', since=SINCE, until='2026-11-04T20:00:00.000Z', limit='1')
        self.assertEqual(len(got), 1)
        self.assertEqual(list(got[0]), ['sha', 'message', 'author', 'date', 'url'])
        self.assertEqual((got[0]['sha'], got[0]['date'], got[0]['author']), ('3d1f0a99', '2026-10-30T09:00:00Z', 'Name of ada-l'))     # `commits` has always given the author date
        query = self.world.calls[-1]['params']
        self.assertEqual((query['since'], query['until'], query['per_page']), (SINCE, UNTIL, 1))              # the date-times are sent in one form, with the zone
        self.assertEqual(len(self.world.calls), 1)                                                            # one page: the limit is the length of the answer

    def test_the_answer_is_never_longer_than_the_limit_even_from_a_server_that_sends_more(self):
        self.world.ignore_per_page = True
        self.assertEqual(len(self.ask('commits', owner=OWNER, repo='hw6-scalability', limit='2')), 2)

    def test_without_them_nothing_is_added_to_the_request(self):
        got = self.ask('commits', owner=OWNER, repo='hw6-scalability')
        self.assertEqual(len(got), 3)
        self.assertEqual(self.world.calls[-1]['params'], {'per_page': 20})

    def test_the_limit_is_at_most_100_and_a_word_is_the_default(self):
        self.ask('commits', owner=OWNER, repo='hw6-scalability', limit='5000')
        self.assertEqual(self.world.calls[-1]['params']['per_page'], 100)
        self.ask('commits', owner=OWNER, repo='hw6-scalability', limit='many')
        self.assertEqual(self.world.calls[-1]['params']['per_page'], 20)
        self.ask('commits', owner=OWNER, repo='hw6-scalability', limit='0')
        self.assertEqual(self.world.calls[-1]['params']['per_page'], 1)

    def test_a_date_that_is_not_one_is_an_error_and_nothing_is_asked(self):
        for key in ('since', 'until'):
            got = self.ask('commits', owner=OWNER, repo='hw6-scalability', **{key: 'yesterday'})
            self.assertIn(key, got['error'])
        self.assertEqual(self.world.calls, [])

    def test_author_path_and_sha_still_work(self):
        self.ask('commits', owner='cs6650-org', repo='team-project', author='bob-k', path='src', sha='main')
        self.assertEqual(self.world.calls[-1]['params'], {'per_page': 20, 'author': 'bob-k', 'path': 'src', 'sha': 'main'})


class Activity(Base):
    def test_the_repositories_pushed_to_in_the_window_newest_first_with_their_commits(self):
        got = self.activity()
        self.assertEqual((got['since'], got['until']), (SINCE, UNTIL))
        self.assertEqual([r['name'] for r in got['repos']], ['team-project', 'hw6-scalability', 'hw5-load-balancer'])      # empty-new has none, old-stuff was pushed in September
        self.assertEqual([(r['count'], r['own']) for r in got['repos']], [(1, False), (2, True), (1, True)])
        self.assertEqual(got['total'], 4)
        self.assertEqual(list(got['repos'][1]), ['name', 'full_name', 'url', 'updated_at', 'own', 'count', 'commits'])
        self.assertEqual(got['repos'][1]['full_name'], 'ada-l/hw6-scalability')
        self.assertNotIn('note', got)

    def test_a_commit_is_a_short_sha_the_date_it_was_committed_and_a_one_line_message(self):
        got = self.activity()
        first = got['repos'][1]['commits'][0]
        self.assertEqual((first['sha'], first['date']), ('3d1f0a99', '2026-11-03T20:11:00Z'))
        self.assertEqual(first['message'], 'Add worker pool | Uses a WaitGroup so the handler can return early')
        self.assertNotIn('Before the window', json.dumps(got))

    def test_commits_carry_no_author_name_or_login(self):
        blob = json.dumps(self.activity())
        self.assertNotIn('Name of', blob)
        self.assertNotIn('"author"', blob)
        self.assertNotIn('bob-k', blob)

    def test_in_a_repository_the_account_does_not_own_only_its_own_commits_are_asked_for_and_in_its_own_all_of_them(self):
        got = self.activity()
        queries = {c['path']: c['params'] for c in self.world.calls if c['path'].endswith('/commits')}
        self.assertEqual(queries['/repos/cs6650-org/team-project/commits']['author'], OWNER)
        self.assertNotIn('author', queries['/repos/ada-l/hw6-scalability/commits'])
        self.assertEqual([c['message'] for c in got['repos'][0]['commits']], ['Add metrics'])
        self.assertNotIn("Bob's private change", json.dumps(got))

    def test_the_repository_list_is_one_page_sorted_by_when_it_was_pushed_to(self):
        self.activity()
        listing = [c for c in self.world.calls if c['path'] == '/users/ada-l/repos']
        self.assertEqual(len(listing), 1)                                                                     # GitHub offered a second page: it was not asked for
        self.assertEqual(listing[0]['params'], {'type': 'all', 'sort': 'pushed', 'direction': 'desc', 'per_page': 100})

    def test_a_repository_is_chosen_by_when_it_was_pushed_to_not_by_when_it_was_updated(self):
        got = self.activity()
        self.assertNotIn('old-stuff', [r['name'] for r in got['repos']])                                      # updated this week (an issue, a star), pushed in September
        self.assertNotIn('/repos/ada-l/old-stuff/commits', self.world.paths())

    def test_at_most_max_repos_of_them(self):
        got = self.activity(max_repos='2')
        self.assertEqual([r['name'] for r in got['repos']], ['team-project', 'hw6-scalability'])              # empty-new is the newest and has nothing: it does not use one of the two places
        self.assertNotIn('/repos/ada-l/hw5-load-balancer/commits', self.world.paths())
        self.assertEqual(len([p for p in self.world.paths() if p.endswith('/commits')]), 3)                  # empty-new, team-project, hw6-scalability

    def test_files_only_for_the_newest_commits_of_all_the_repositories(self):
        got = self.activity(detail='2')
        commits = [c for r in got['repos'] for c in r['commits']]
        with_files = {c['message'][:20]: bool(c['files']) for c in commits}
        self.assertEqual(with_files, {'Add metrics': True, 'Add worker pool | Us': True, 'Initial HW6 skeleton': False, 'Fix health checks': False})
        detailed = [p for p in self.world.paths() if re.search(r'/commits/[0-9a-f]{40}$', p)]
        self.assertEqual(len(detailed), 2)

    def test_the_default_is_four_commits_with_files_and_zero_asks_for_none(self):
        self.assertEqual(len([p for p in self.world.paths() if re.search(r'/commits/[0-9a-f]{40}$', p)]), 0)
        self.activity()
        self.assertEqual(len([p for p in self.world.paths() if re.search(r'/commits/[0-9a-f]{40}$', p)]), 4)
        self.world.calls.clear()
        got = self.activity(detail='0')
        self.assertEqual([p for p in self.world.paths() if re.search(r'/commits/[0-9a-f]{40}$', p)], [])
        self.assertTrue(all(c['files'] == [] for r in got['repos'] for c in r['commits']))

    def test_a_file_is_a_name_a_status_the_lines_and_a_patch_of_at_most_300_characters_and_a_commit_gives_at_most_eight(self):
        many = [{'filename': 'f%d.go' % i, 'status': 'added', 'additions': i, 'deletions': 0, 'patch': 'p' * 900} for i in range(12)]
        self.world.repos['ada-l/hw5-load-balancer']['commits'][0]['files'] = many
        got = self.activity(detail='8')
        c = [c for r in got['repos'] if r['name'] == 'hw5-load-balancer' for c in r['commits']][0]
        self.assertEqual(len(c['files']), 8)
        self.assertEqual(c['files_total'], 12)
        self.assertEqual(list(c['files'][0]), ['name', 'status', 'additions', 'deletions', 'patch'])
        self.assertEqual(len(c['files'][0]['patch']), 300)
        self.assertEqual((c['files'][3]['name'], c['files'][3]['additions']), ('f3.go', 3))

    def test_a_repository_that_cannot_be_read_is_left_out_and_the_others_still_come(self):
        self.world.repos['ada-l/hw6-scalability']['status'] = 500
        got = self.activity()
        self.assertEqual([r['name'] for r in got['repos']], ['team-project', 'hw5-load-balancer'])
        self.assertEqual(got['note'], 'a repository could not be read')

    def test_an_empty_repository_is_not_worth_a_note(self):
        self.assertNotIn('note', self.activity())                                                             # empty-new answered 409

    def test_a_commit_whose_files_cannot_be_read_is_listed_without_them(self):
        self.world.repos['cs6650-org/team-project']['detail_status']['c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'] = 500
        got = self.activity()
        self.assertEqual(got['repos'][0]['commits'][0]['files'], [])
        self.assertEqual(got['note'], 'the files of a commit could not be read')

    def test_more_commits_than_max_commits_are_cut_and_said(self):
        self.world.add(repo('busy', OWNER, '2026-11-04T15:00:00Z'), [commit('%040x' % i, '2026-11-04T%02d:00:00Z' % (i % 24), 'work %d' % i) for i in range(1, 9)])
        got = self.activity(max_commits='5', max_repos='1')
        busy = got['repos'][0]
        self.assertEqual((busy['name'], busy['count'], busy.get('more')), ('busy', 5, True))
        self.assertEqual(self.world.calls[1]['params']['per_page'], 6)                                         # one more than wanted, to know there are more
        self.assertIn('more commits in the window than are listed', got['note'])

    def test_a_named_repo_is_read_even_when_it_was_not_pushed_to_in_the_window(self):
        got = self.activity(repo='old-stuff', since='2026-08-01T00:00:00Z')
        self.assertEqual([r['name'] for r in got['repos']], ['old-stuff'])
        self.assertIn('/repos/ada-l/old-stuff', self.world.paths())
        self.assertNotIn('/users/ada-l/repos', self.world.paths())

    def test_a_repo_that_does_not_exist_is_an_error_the_caller_can_report(self):
        with self.assertRaises(requests.exceptions.HTTPError):
            self.activity(repo='nothing-here')

    def test_an_account_that_is_not_on_this_host_is_an_error_not_an_empty_answer(self):
        self.world.listing_status = 404
        with self.assertRaises(requests.exceptions.HTTPError):
            self.activity()

    def test_nobody_with_no_repository_pushed_to_has_an_empty_answer(self):
        got = self.activity(since='2026-12-01T00:00:00Z', until='2026-12-08T00:00:00Z')
        self.assertEqual((got['total'], got['repos']), (0, []))


class Arguments(Base):
    def test_the_owner_and_the_repo_are_names_and_nothing_is_asked_with_anything_else(self):
        for owner in ('', '../x', 'a/b', 'ada l', 'x?y=1', '-ada'):
            self.assertIn('owner', self.activity(owner=owner)['error'], repr(owner))
        self.assertIn('repo', self.activity(repo='../x')['error'])
        self.assertIn('repo', self.activity(repo='a/b')['error'])
        self.assertEqual(self.world.calls, [])

    def test_the_window_is_two_date_times_in_order(self):
        for bad in ({'since': ''}, {'until': 'now'}, {'since': '2026-13-45T00:00:00Z'}, {'since': UNTIL, 'until': SINCE}):
            self.assertIn('error', self.activity(**bad), bad)
        self.assertEqual(self.world.calls, [])

    def test_date_times_in_other_zones_and_with_fractions_are_understood(self):
        got = self.activity(since='2026-10-28T13:00:00-07:00', until='2026-11-04T20:00:00.123Z')
        self.assertEqual((got['since'], got['until']), (SINCE, UNTIL))

    def test_the_limits_are_clamped(self):
        got = self.activity(max_repos='99', max_commits='9999', detail='99')
        self.assertEqual(len(got['repos']), 3)
        commit_queries = [c['params'] for c in self.world.calls if c['path'].endswith('/commits')]
        self.assertTrue(all(q['per_page'] == 51 for q in commit_queries))                                     # max_commits 50, plus one to see whether there are more
        self.assertLessEqual(len([p for p in self.world.paths() if re.search(r'/commits/[0-9a-f]{40}$', p)]), 8)

    def test_a_word_where_a_number_belongs_is_the_default(self):
        self.activity(max_repos='lots', max_commits='x', detail='y')
        commit_queries = [c['params'] for c in self.world.calls if c['path'].endswith('/commits')]
        self.assertTrue(all(q['per_page'] == 16 for q in commit_queries))

    def test_the_unknown_action_message_lists_activity(self):
        self.assertIn('activity', self.ask('nope')['available'])


class Hosts(Base):
    def test_the_configured_host_and_its_token_are_the_default_and_github_com_has_its_own(self):
        self.world.repos = {}
        self.activity()
        self.assertEqual({(c['host'], c['auth']) for c in self.world.calls}, {('ghe', 'Bearer ghe-token')})
        self.world.calls.clear()
        self.activity(host='github.com')
        self.assertEqual({(c['host'], c['auth']) for c in self.world.calls}, {('public', 'Bearer pub-token')})

    def test_without_a_token_for_the_host_it_is_an_error_and_nothing_is_asked(self):
        with mock.patch.object(github_api, 'TOKEN_PUBLIC', ''):
            got = self.ask('activity', owner=OWNER, since=SINCE, until=UNTIL, host='github.com')
        self.assertIn('No token', got['error'])
        self.assertEqual(self.world.calls, [])


class Budget(Base):
    def test_when_the_time_is_used_up_it_answers_with_what_it_has_and_says_so(self):
        clock = {'t': 0.0}

        def tick():
            clock['t'] += 4.0                                                                                 # every request takes four seconds

        self.world.on_request = tick
        real = github_api.Budget
        with mock.patch.object(github_api, 'Budget', lambda seconds: real(seconds, clock=lambda: clock['t'])):
            got = self.activity()                                                                             # 11 s: the list (4), the first repository (8), the second (12)
        self.assertEqual(got['note'], 'the time ran out before every repository was read; the time ran out before the files of every recent commit were read')
        self.assertEqual([r['name'] for r in got['repos']], ['team-project'])
        self.assertEqual(len(self.world.calls), 3)                                                            # the list, empty-new (409), team-project: the third started in time

    def test_the_request_timeout_is_cut_to_six_seconds(self):
        saved = github_api.TIMEOUT
        try:
            github_api.TIMEOUT = 15
            self.activity()
            self.assertEqual(github_api.TIMEOUT, 6)
        finally:
            github_api.TIMEOUT = saved


class StandInGitHub(BaseHTTPRequestHandler):
    world = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        status, body, _ = self.world.route(parsed.path, params)
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@unittest.skipUnless(HAVE_REQUESTS, 'github_api.py needs the requests package')
class TheScriptAsTheContainerRunsIt(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.world = standard_world()
        StandInGitHub.world = cls.world
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), StandInGitHub)
        cls.base = 'http://127.0.0.1:%d' % cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def run_script(self, action, params):
        env = {k: v for k, v in os.environ.items() if 'proxy' not in k.lower()}
        env.update({'GITHUB_TOKEN': 'test-token', 'GITHUB_BASE_URL': self.base, 'NO_PROXY': '127.0.0.1'})
        done = subprocess.run([sys.executable, str(HERE / 'github_api.py')], input=json.dumps({'action': action, 'params': params}), capture_output=True, text=True, env=env, timeout=60)
        return done.returncode, json.loads(done.stdout)

    def test_activity_through_the_script(self):
        code, got = self.run_script('activity', {'owner': OWNER, 'since': SINCE, 'until': UNTIL})
        self.assertEqual(code, 0)
        self.assertEqual([r['name'] for r in got['repos']], ['team-project', 'hw6-scalability', 'hw5-load-balancer'])
        self.assertEqual(got['total'], 4)

    def test_an_unknown_account_is_an_error_with_a_non_zero_exit(self):
        self.world.listing_status = 404
        try:
            code, got = self.run_script('activity', {'owner': OWNER, 'since': SINCE, 'until': UNTIL})
        finally:
            self.world.listing_status = None
        self.assertEqual(code, 1)
        self.assertIn('GitHub API error: 404', got['error'])


if __name__ == '__main__':
    unittest.main()
