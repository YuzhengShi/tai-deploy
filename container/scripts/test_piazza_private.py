"""container/scripts/piazza_query.py: PRIVATE posts (a student's question to the teaching staff only) are never returned, by any action.

Measured on the live forum on 2026-11-06: the TA account the tool uses sees private posts (5 of 200 recent threads), with `status` 'private' on the feed item and on the post, and with
their words. A student's container would read another student's private question through recent_posts, search, get_post, get_by_tag or get_pinned. Synthetic people only; the
fixture is the one of test_piazza_student_activity.py (a fake Piazza network that answers through `_rpc.request`).
Run: python container/scripts/test_piazza_private.py
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_piazza_student_activity as fixture  # noqa: E402
from test_piazza_student_activity import ADA, BOB, Base, event, item, post, version  # noqa: E402

WORDS = ('PRIVATE-SUBJECT', 'PRIVATE-BODY', 'ADA-PRIVATE-SUBJECT', 'ADA-PRIVATE-BODY', 'private-only-tag')
PRIVATE_IDS = (201, 202)


def private_item(nr, uid, tags, when, **more):
    return dict(item(nr, 'question', tags, [event('create', when, uid)]), status='private', **more)


def private_post(nr, uid, subject, body, when, tags):
    return dict(post(nr, [version(uid, subject, body, when)], kind='question'), status='private', tags=tags)


class PrivatePosts(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # the fake network of the other test file only has get_feed, get_users and get_post: the other actions need these two
        fixture.FakeNetwork.iter_all_posts = lambda self, limit=None: (self.get_post(i['nr']) for i in self.world.items[:limit])
        fixture.FakeNetwork.search_feed = lambda self, query: {'feed': list(self.world.items)}

    @classmethod
    def tearDownClass(cls):
        for name in ('iter_all_posts', 'search_feed'):
            if hasattr(fixture.FakeNetwork, name):
                delattr(fixture.FakeNetwork, name)
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        w = self.world
        # Bob's private question, pinned and tagged so that every listing action would reach it; and Ada's own private question
        w.items.insert(0, private_item(201, BOB, ['hw6', 'private-only-tag'], '2026-11-03T12:00:00Z', pin=1))
        w.posts[201] = private_post(201, BOB, 'PRIVATE-SUBJECT', 'PRIVATE-BODY: please look at my grade', '2026-11-03T12:00:00Z', ['hw6', 'private-only-tag'])
        w.items.insert(0, private_item(202, ADA, ['hw6'], '2026-11-03T13:00:00Z'))
        w.posts[202] = private_post(202, ADA, 'ADA-PRIVATE-SUBJECT', 'ADA-PRIVATE-BODY about a personal matter', '2026-11-03T13:00:00Z', ['hw6'])
        # a public, pinned post that must keep working
        w.items = [dict(i, pin=1) if i.get('nr') == 101 else i for i in w.items]

    def run_action(self, action, **params):
        return self.query.handle({'action': action, 'params': params})

    def assert_clean(self, answer):
        blob = json.dumps(answer)
        for word in WORDS:
            self.assertNotIn(word, blob, 'a private post leaked through: %r' % word)

        def ids(thing):
            if isinstance(thing, dict):
                for key, value in thing.items():
                    if key == 'id':
                        yield value
                    yield from ids(value)
            elif isinstance(thing, list):
                for value in thing:
                    yield from ids(value)
        self.assertEqual([i for i in ids(answer) if i in PRIVATE_IDS], [], 'the id of a private post leaked through')

    def test_get_post_refuses_a_private_post_and_still_answers_a_public_one(self):
        refused = self.run_action('get_post', post_id='201')
        self.assertIn('private', refused['error'])
        self.assert_clean(refused)
        self.assertIn('error', self.run_action('get_post', post_id='202'))                    # a student's OWN private post is not repeated either
        self.assertEqual(self.run_action('get_post', post_id='101')['id'], 101)

    def test_recent_posts_leaves_private_ones_out(self):
        answer = self.run_action('recent_posts', limit='30')
        self.assert_clean(answer)
        self.assertIn(101, [p['id'] for p in answer['posts']])

    def test_search_leaves_private_ones_out(self):
        answer = self.run_action('search', query='hw6')
        self.assert_clean(answer)
        self.assertIn(101, [p['id'] for p in answer['posts']])

    def test_search_checks_the_post_too_when_the_feed_item_carries_no_status(self):
        # a search result that does not say (an older answer shape): the post fetched afterwards says it
        self.world.items = [{k: v for k, v in i.items() if k != 'status'} for i in self.world.items]
        answer = self.run_action('search', query='hw6')
        self.assert_clean(answer)
        self.assertIn(101, [p['id'] for p in answer['posts']])

    def test_get_by_tag_leaves_private_ones_out(self):
        answer = self.run_action('get_by_tag', tag='hw6')
        self.assert_clean(answer)
        self.assertIn(101, [p['id'] for p in answer['posts']])
        self.assertEqual(self.run_action('get_by_tag', tag='private-only-tag')['posts'], [])

    def test_get_pinned_leaves_private_ones_out(self):
        answer = self.run_action('get_pinned')
        self.assert_clean(answer)
        self.assertEqual([p['id'] for p in answer['posts']], [101])

    def test_list_tags_does_not_name_a_tag_only_a_private_post_carries(self):
        tags = {t['name']: t['count'] for t in self.run_action('list_tags')['tags']}
        self.assertNotIn('private-only-tag', tags)
        self.assertIn('hw6', tags)
        self.assertEqual(tags['hw6'], sum(1 for i in self.world.items if 'hw6' in i['tags'] and i.get('status') != 'private'))

    def test_student_activity_does_not_count_or_quote_the_students_own_private_post(self):
        answer = self.ask(email='ada@example.com')
        self.assert_clean(answer)
        self.assertTrue(answer['matched'])
        self.assertEqual(answer['counts'], {'posted': 4, 'followups': 2, 'answers': 1})        # exactly what the fixture's tests expect without any private post (109, 105, 101, 108 | 103, 101 | 102)
        self.assertNotIn(202, [p['id'] for p in answer['posts']])

    def test_nothing_any_action_answers_holds_a_private_word(self):
        for action, params in (('recent_posts', {'limit': '40'}), ('search', {'query': 'x'}), ('get_pinned', {}), ('get_by_tag', {'tag': 'hw6'}), ('list_tags', {}),
                               ('get_post', {'post_id': '201'}), ('get_post', {'post_id': '202'})):
            self.assert_clean(self.run_action(action, **params))
        self.assert_clean(self.ask(email='bob@example.com'))

    def test_is_private_reads_the_status_only(self):
        q = self.query
        for yes in ({'status': 'private'}, {'status': 'Private'}, {'status': ' PRIVATE'.strip()}):
            self.assertTrue(q.is_private(yes), yes)
        for no in ({'status': 'active'}, {'status': None}, {}, {'type': 'private'}, None, 'private', ['private']):
            self.assertFalse(q.is_private(no), no)


if __name__ == '__main__':
    unittest.main()
