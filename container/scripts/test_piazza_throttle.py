"""container/scripts/piazza_throttle.py and piazza_query.py. Run: python container/scripts/test_piazza_throttle.py

The Piazza library is not installed where this runs (it is in the agent image), so piazza_query is imported against a stand-in that is built
the way the library is: a network whose requests all go through `_rpc.request`, which answers a dict, and a get_post that raises when the dict has an error.
"""
import importlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from piazza_throttle import OutOfTime, Throttle, install, is_too_fast, reply_too_fast  # noqa: E402

TOO_FAST = {"result": None, "error": "Sorry, too fast -- please wait a second and try again.", "aid": "x"}


class Clock:
    """Time that only moves when something sleeps, so that a test of a minute takes no time."""

    def __init__(self, start=1_000_000.0):
        self.now = start
        self.slept = []

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(round(seconds, 3))
        self.now += seconds

    def advance(self, seconds):
        self.now += seconds


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.state = os.path.join(self.dir.name, 'throttle.json')
        self.clock = Clock()

    def throttle(self, **kwargs):
        return Throttle(state_file=self.state, clock=self.clock.time, sleep=self.clock.sleep, **kwargs)


def sender(*replies):
    """A send() that answers the given replies in turn (an Exception is raised), and counts how often it was called."""
    queue = list(replies)
    calls = []

    def send():
        calls.append(1)
        reply = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(reply, Exception):
            raise reply
        return reply

    send.calls = calls
    return send


class Pacing(Base):
    def test_the_first_request_goes_at_once_and_the_next_waits_for_the_gap(self):
        throttle = self.throttle()
        throttle.request(sender({"result": 1}))
        self.assertEqual(self.clock.slept, [])
        throttle.request(sender({"result": 2}))
        self.assertEqual(self.clock.slept, [0.12])

    def test_the_gap_holds_across_processes_because_every_tool_call_is_one(self):
        self.throttle().request(sender({"result": 1}))
        self.clock.advance(0.05)
        self.throttle().request(sender({"result": 2}))               # a new Throttle, as a new process makes one: it reads the file
        self.assertEqual(self.clock.slept, [0.07])
        self.clock.advance(5)
        self.throttle().request(sender({"result": 3}))
        self.assertEqual(self.clock.slept, [0.07])                   # long enough ago: no wait

    def test_a_state_file_that_cannot_be_read_or_written_changes_nothing_else(self):
        throttle = Throttle(state_file=os.path.join(self.dir.name, 'missing', 'dir', 'state.json'), clock=self.clock.time, sleep=self.clock.sleep)
        self.assertEqual(throttle.request(sender({"result": 1})), {"result": 1})
        self.assertEqual(throttle.request(sender({"result": 2})), {"result": 2})
        Path(self.state).write_text('not json')
        self.assertEqual(self.throttle().request(sender({"result": 3})), {"result": 3})


class TooFast(Base):
    def test_a_too_fast_reply_is_waited_out_and_the_request_sent_again(self):
        throttle = self.throttle()
        send = sender(TOO_FAST, TOO_FAST, {"result": "the post"})
        self.assertEqual(throttle.request(send), {"result": "the post"})
        self.assertEqual(len(send.calls), 3)
        self.assertEqual([s for s in self.clock.slept if s >= 1], [1.3, 2.6])      # a second and a bit, then twice that
        self.assertEqual(throttle.waited_out, 2)

    def test_after_one_the_gap_stays_wide_for_two_minutes_for_every_process(self):
        self.throttle().request(sender(TOO_FAST, {"result": 1}))
        before = len(self.clock.slept)
        self.throttle().request(sender({"result": 2}))                # a later process
        self.assertAlmostEqual(self.clock.slept[before], 1.1, places=2)          # the wide gap, not the small one
        self.clock.advance(125)
        slept = len(self.clock.slept)
        self.throttle().request(sender({"result": 3}))
        self.assertEqual(len(self.clock.slept), slept)                # two minutes on: back to the small gap, and it has long passed

    def test_a_too_fast_in_the_text_of_an_error_is_waited_out_too(self):
        error = Exception('Could not get post 882.\nResponse: ' + json.dumps(TOO_FAST))
        send = sender(error, {"result": "the post"})
        self.assertEqual(self.throttle().request(send), {"result": "the post"})
        self.assertEqual(len(send.calls), 2)

    def test_any_other_error_goes_up_at_once_and_is_not_sent_again(self):
        send = sender(ValueError('boom'))
        with self.assertRaises(ValueError):
            self.throttle().request(send)
        self.assertEqual(len(send.calls), 1)
        self.assertEqual(self.clock.slept, [])

    def test_a_reply_with_another_error_is_the_caller_s_to_read(self):
        reply = {"result": None, "error": "post does not exist"}
        send = sender(reply)
        self.assertIs(self.throttle().request(send), reply)
        self.assertEqual(len(send.calls), 1)

    def test_after_three_retries_the_last_answer_is_what_the_caller_gets(self):
        send = sender(TOO_FAST)
        self.assertEqual(self.throttle().request(send), TOO_FAST)
        self.assertEqual(len(send.calls), 4)                          # the first and three more
        failing = sender(Exception('Could not get post 1.\n' + json.dumps(TOO_FAST)))
        with self.assertRaises(Exception) as caught:
            self.throttle().request(failing)
        self.assertTrue(is_too_fast(caught.exception))
        self.assertEqual(len(failing.calls), 4)

    def test_it_knows_a_too_fast_when_it_sees_one(self):
        self.assertTrue(reply_too_fast(TOO_FAST))
        self.assertTrue(is_too_fast('Sorry, TOO FAST -- please wait'))
        self.assertFalse(reply_too_fast({"result": 1}))
        self.assertFalse(reply_too_fast(None))
        self.assertFalse(reply_too_fast("too fast"))                  # only a dict with an error is a reply that says so


class Budget(Base):
    def test_a_lookup_that_has_used_its_time_stops_with_out_of_time_and_not_after_the_tool_gave_up_on_it(self):
        throttle = self.throttle(budget=2.0)
        self.assertFalse(throttle.out_of_time())
        with self.assertRaises(OutOfTime):
            throttle.request(sender(TOO_FAST))                        # waits 1.3 s, and the next wait (2.6 s) would not fit in the 2 s
        self.assertLessEqual(throttle.elapsed(), 2.0)
        self.clock.advance(3)
        self.assertTrue(throttle.out_of_time())

    def test_the_default_gives_the_script_24_seconds_of_the_tool_s_30(self):
        self.assertEqual(Throttle(state_file=self.state).budget, 24.0)


class Install(Base):
    def test_every_request_of_the_network_goes_through_the_throttle(self):
        sent = []

        class Rpc:
            def request(self, method, data=None, **kwargs):
                sent.append(method)
                return TOO_FAST if len(sent) == 1 else {"result": method}

        network = types.SimpleNamespace(_rpc=Rpc())
        throttle = self.throttle()
        self.assertTrue(install(throttle, network))
        self.assertEqual(network._rpc.request('content.get', {'cid': 1}), {"result": "content.get"})
        self.assertEqual(sent, ['content.get', 'content.get'])        # the too-fast one was sent again
        self.assertEqual(throttle.waited_out, 1)

    def test_a_network_that_is_not_built_like_that_is_left_alone(self):
        self.assertFalse(install(self.throttle(), types.SimpleNamespace()))
        self.assertFalse(install(self.throttle(), types.SimpleNamespace(_rpc=types.SimpleNamespace())))


# --- piazza_query against a stand-in for the library ---------------------------------------------------------------------------------------


class FakeRequestError(Exception):
    pass


class FakeNetwork:
    """Built the way the library's Network is: every request goes through self._rpc.request, which answers a dict."""

    def __init__(self, world):
        self.world = world
        self._rpc = types.SimpleNamespace(request=self._request)

    def _request(self, method, data=None, **kwargs):
        self.world.requests.append((method, (data or {}).get('cid')))
        answer = self.world.answer(method, data or {})
        return answer

    def get_post(self, cid):
        reply = self._rpc.request('content.get', {'cid': cid})
        if reply.get('error'):
            raise FakeRequestError('Could not get post {}.\nResponse: {}'.format(cid, json.dumps(reply)))
        return reply['result']

    def get_feed(self, limit=100, offset=0):
        reply = self._rpc.request('network.get_my_feed', {'limit': limit, 'offset': offset})
        if reply.get('error'):
            raise FakeRequestError('Could not get feed.\nResponse: {}'.format(json.dumps(reply)))
        return reply['result']

    def search_feed(self, query):
        return self._rpc.request('network.search', {'query': query})['result']

    def iter_all_posts(self, limit=None, sleep=0):
        feed = self.get_feed(limit=limit, offset=0)
        for item in feed['feed'][:limit]:
            yield self.get_post(item['id'])


class World:
    """What Piazza answers: a feed, the posts, and a script of requests it refuses as too fast."""

    def __init__(self, n=5, tag='proposal'):
        self.requests = []
        self.feed_ids = list(range(1, n + 1))                      # what the feed lists; a post can be in the feed and not be readable
        self.posts = {i: {'nr': i, 'id': 'cid%d' % i, 'type': 'note', 'tags': [tag], 'history': [{'subject': 'Idea %d' % i, 'content': '<p>We build thing %d.</p>' % i}], 'children': [], 'created': '2026-10-30T00:00:00Z'} for i in range(1, n + 1)}
        self.refuse = lambda method, data, count: False           # count: how many content.get requests so far
        self.refused = 0
        self.gets = 0

    def answer(self, method, data):
        if method == 'content.get':
            self.gets += 1
            if self.refuse(method, data, self.gets):
                self.refused += 1
                return dict(TOO_FAST)
            cid = data['cid']
            key = cid if isinstance(cid, int) else int(str(cid).replace('cid', ''))
            if key not in self.posts:
                return {'result': None, 'error': 'post does not exist'}
            return {'result': self.posts[key], 'error': None}
        if method == 'network.get_my_feed':
            if data.get('offset'):
                return {'result': {'feed': []}, 'error': None}      # the feed is one page long
            return {'result': {'feed': [{'nr': i, 'id': 'cid%d' % i, 'tags': ['proposal'], 'pin': i == 2} for i in self.feed_ids]}, 'error': None}
        if method == 'network.search':
            return {'result': [{'nr': i, 'id': 'cid%d' % i} for i in self.feed_ids]}
        return {'result': None, 'error': 'unknown method ' + method}


class QueryTest(Base):
    @classmethod
    def setUpClass(cls):
        cls.saved = {k: os.environ.get(k) for k in ('PIAZZA_EMAIL', 'PIAZZA_PASSWORD', 'PIAZZA_NETWORK_ID')}
        os.environ.update(PIAZZA_EMAIL='ta@example.com', PIAZZA_PASSWORD='pw', PIAZZA_NETWORK_ID='net1')
        cls.library = types.ModuleType('piazza_api')

        class Piazza:
            world = None
            logins = 0

            def user_login(self, email=None, password=None):
                Piazza.logins += 1

            def network(self, nid):
                return FakeNetwork(Piazza.world)

        cls.library.Piazza = Piazza
        cls.had = sys.modules.get('piazza_api')
        sys.modules['piazza_api'] = cls.library
        sys.modules.pop('piazza_query', None)
        cls.query = importlib.import_module('piazza_query')

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop('piazza_query', None)
        if cls.had is None:
            sys.modules.pop('piazza_api', None)
        else:
            sys.modules['piazza_api'] = cls.had
        for key, value in cls.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def setUp(self):
        super().setUp()
        self.world = World()
        self.library.Piazza.world = self.world
        self.library.Piazza.logins = 0
        self.query.new_throttle = lambda: self.throttle()

    def ask(self, action, **params):
        return self.query.handle({'action': action, 'params': params})

    def test_a_tag_is_read_in_full_when_piazza_never_complains(self):
        out = self.ask('get_by_tag', tag='proposal')
        self.assertEqual(out['count'], 5)
        self.assertEqual(out['tag'], 'proposal')
        self.assertNotIn('stopped_early', out)
        self.assertEqual(out['posts'][0]['subject'], 'Idea 1')
        self.assertEqual(out['posts'][0]['content'], 'We build thing 1.')
        self.assertEqual(self.library.Piazza.logins, 1)

    def test_a_too_fast_in_the_middle_is_waited_out_and_no_post_is_lost(self):
        self.world.refuse = lambda method, data, count: count in (2, 3)          # the second and third request of the lookup are refused
        out = self.ask('get_by_tag', tag='proposal')
        self.assertEqual(out['count'], 5)
        self.assertNotIn('skipped', out)
        self.assertEqual(self.world.refused, 2)
        self.assertTrue(any(s >= 1 for s in self.clock.slept))                   # it really waited

    def test_when_the_time_runs_out_it_returns_the_posts_it_has_and_says_it_stopped(self):
        self.world.refuse = lambda method, data, count: count >= 3               # from the third request on Piazza refuses everything
        self.query.new_throttle = lambda: self.throttle(budget=6.0)
        out = self.ask('get_by_tag', tag='proposal')
        self.assertEqual([p['id'] for p in out['posts']], [1, 2])
        self.assertTrue(out['stopped_early'])
        self.assertIn('Piazza asked us to slow down', out['note'])               # it did wait out a "too fast": that is why
        self.assertIn('ask again in a minute', out['note'])
        self.assertLessEqual(self.clock.now - 1_000_000.0, 6.5)                  # and it did not go on past its time

    def test_a_lookup_that_ran_out_of_time_without_any_too_fast_does_not_blame_piazza(self):
        self.query.new_throttle = lambda: self.throttle(budget=0.5, gap=0.3)    # a slow lookup: the small gaps alone use the time
        out = self.ask('get_by_tag', tag='proposal')
        self.assertTrue(out['stopped_early'])
        self.assertLess(out['count'], 5)
        self.assertIn('the time for this lookup ran out', out['note'])
        self.assertNotIn('slow down', out['note'])

    def test_the_budget_is_24_seconds_and_a_voice_call_can_make_it_shorter(self):
        saved = os.environ.get('PIAZZA_BUDGET_SECONDS')
        try:
            os.environ.pop('PIAZZA_BUDGET_SECONDS', None)
            self.assertEqual(self.query.budget_seconds(), 24.0)
            os.environ['PIAZZA_BUDGET_SECONDS'] = '10'
            self.assertEqual(self.query.budget_seconds(), 10.0)
            os.environ['PIAZZA_BUDGET_SECONDS'] = '999'
            self.assertEqual(self.query.budget_seconds(), 24.0)                  # never longer than the tool allows a script
            os.environ['PIAZZA_BUDGET_SECONDS'] = '0'
            self.assertEqual(self.query.budget_seconds(), 2.0)                   # nor so short that nothing can be read
            os.environ['PIAZZA_BUDGET_SECONDS'] = 'soon'
            self.assertEqual(self.query.budget_seconds(), 24.0)
        finally:
            if saved is None:
                os.environ.pop('PIAZZA_BUDGET_SECONDS', None)
            else:
                os.environ['PIAZZA_BUDGET_SECONDS'] = saved

    def test_one_post_that_cannot_be_read_is_left_out_and_counted_not_the_whole_answer(self):
        del self.world.posts[3]                                                  # still in the feed, but Piazza says it does not exist
        out = self.ask('get_by_tag', tag='proposal')
        self.assertEqual(out['count'], 4)
        self.assertEqual(out['skipped'], 1)
        self.assertNotIn('stopped_early', out)

    def test_one_post_is_tried_again_and_then_told_in_words_that_say_not_to_ask_again(self):
        ok = self.ask('get_post', post_id='2')
        self.assertEqual(ok['id'], 2)
        self.world.refuse = lambda method, data, count: True                     # Piazza refuses everything now
        self.world.gets = 0
        out = self.ask('get_post', post_id='2')
        self.assertIn('Do not ask Piazza for this again for a minute', out['error'])
        self.assertEqual(self.world.gets, 4)                                      # the first request and the three that were sent again, no more
        self.assertNotIn('Could not get post', out['error'])                      # not the library's text: it reads as "try again"

    def test_a_post_that_does_not_exist_is_an_error_at_once_and_is_not_sent_again(self):
        out = self.ask('get_post', post_id='99')
        self.assertTrue(out['error'].startswith('Failed to get post 99'))
        self.assertEqual(self.world.gets, 1)

    def test_the_pinned_posts_and_a_search_are_read_the_same_way(self):
        pinned = self.ask('get_pinned')
        self.assertEqual([p['id'] for p in pinned['posts']], [2])
        found = self.ask('search', query='thing')
        self.assertEqual(found['count'], 5)
        self.assertEqual(found['query'], 'thing')

    def test_recent_posts_keeps_what_it_read_when_piazza_refuses_part_way(self):
        self.world.refuse = lambda method, data, count: count >= 3
        self.query.new_throttle = lambda: self.throttle(budget=100.0, retries=0)   # no waiting out here: the refusal stands
        out = self.ask('recent_posts', limit='5')
        self.assertEqual(out['count'], 2)
        self.assertTrue(out['stopped_early'])

    def test_recent_posts_with_nothing_read_is_still_an_error(self):
        self.world.refuse = lambda method, data, count: True
        self.query.new_throttle = lambda: self.throttle(retries=0)
        with self.assertRaises(Exception):
            self.ask('recent_posts', limit='5')

    def test_the_tags_and_the_numbers_are_unchanged(self):
        self.assertEqual(self.ask('list_tags')['tags'], [{'name': 'proposal', 'count': 5}])
        self.assertIn('error', self.ask('nope'))
        self.assertEqual(self.ask('get_by_tag')['error'].split('.')[0], 'tag parameter required')


if __name__ == '__main__':
    unittest.main()
