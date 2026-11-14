"""leanrag/graph_query.py: the query engine, over the small made-up artifact of fixture_artifact.py. Standard library only; no model, no embedding, no network (a test makes any
connection raise). What is pinned: results are ranked by relevance (not by id), a chunk a student may not read yet is never returned, the graph brings in a slide the words alone
miss, a comparison question gets both sides, the two channels (slides, assignment texts) do not crowd each other, and the levels add the clusters and themes they should.
Run: python leanrag/test_graph_query.py
"""
import datetime as dt
import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.dont_write_bytecode = True

from leanrag import graph_query as gq  # noqa: E402
from leanrag.fixture_artifact import write_fixture  # noqa: E402

NOW = dt.datetime(2026, 11, 11, 12, 0, tzinfo=dt.timezone.utc)


def refuse_network(*args, **kwargs):
    raise AssertionError("the query path opened a network connection")


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = write_fixture(Path(cls.tmp.name) / "graph")
        cls.index = gq.GraphIndex(cls.root)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def ask(self, question, mode="hybrid", now=NOW, **kw):
        return self.index.query(question, mode=mode, now=now, **kw)

    @staticmethod
    def ids(result):
        return [(s["deck"] or s["title"], s["page"]) for s in result["source_texts"]]


class Ranking(Base):
    def test_the_slide_that_answers_is_first_not_the_first_by_id(self):
        r = self.ask("What are stateless services?")
        self.assertEqual(self.ids(r)[0], ("Deck Two.pdf", 2))                    # d01:p002; d00:p001 is first by id
        self.assertEqual(r["source_texts"][0]["kind"], "slide")

    def test_every_result_carries_its_deck_page_week_and_a_score_that_does_not_rise_down_the_list(self):
        r = self.ask("circuit breaker bulkhead cache timeout service")
        slides = [s for s in r["source_texts"] if s["kind"] == "slide"]
        self.assertTrue(slides)
        for s in slides:
            self.assertTrue(s["deck"].endswith(".pdf") and s["page"] >= 1 and s["week"].startswith("w"))
        self.assertEqual([s["score"] for s in slides], sorted((s["score"] for s in slides), reverse=True))

    def test_at_most_three_slides_come_from_one_deck(self):
        r = self.ask("pattern cache timeout bulkhead circuit service retries", top_k=10)
        per_deck = [s["deck"] for s in r["source_texts"] if s["kind"] == "slide"]
        self.assertEqual(sum(1 for c in self.index.chunks if c["deck"] == "Deck One.pdf"), 4)      # four slides of this deck match, and only three may come
        self.assertEqual(per_deck.count("Deck One.pdf"), 3)

    def test_a_question_with_no_matching_word_gives_nothing_and_does_not_fail(self):
        for q in ("", "the of and", "zebra xylophone"):
            r = self.ask(q)
            self.assertEqual((r["source_texts"], r["seed_entities"]), ([], []), q)

    def test_the_same_question_gives_the_same_answer(self):
        self.assertEqual(json.dumps(self.ask("circuit breaker"), sort_keys=True), json.dumps(self.ask("circuit breaker"), sort_keys=True))

    def test_top_k_is_clamped(self):
        self.assertEqual(len([s for s in self.ask("service pattern cache", top_k=0)["source_texts"] if s["kind"] == "slide"]), 1)
        self.assertLessEqual(len(self.ask("service pattern cache", top_k=999)["source_texts"]), 30 + gq.TEXTS)


class TheGraphAddsEvidence(Base):
    def test_a_slide_the_words_miss_is_found_through_an_entity(self):
        words_only = self.ask("stateless service", mode="bm25")
        with_graph = self.ask("stateless service", mode="entity")
        self.assertNotIn(("Deck One.pdf", 4), self.ids(words_only))            # the caching slide never says "stateless"
        self.assertIn(("Deck One.pdf", 4), self.ids(with_graph))               # but the entity "stateless service" was extracted from it
        hit = next(s for s in with_graph["source_texts"] if s["page"] == 4)
        self.assertIn("stateless service", hit["via"])

    def test_a_comparison_brings_both_sides_and_the_relation_between_them(self):
        r = self.ask("How does a circuit breaker differ from a bulkhead?")
        top3 = self.ids(r)[:3]
        self.assertIn(("Deck One.pdf", 1), top3)
        self.assertIn(("Deck One.pdf", 2), top3)
        self.assertIn({"head": "circuit breaker", "relation": "COMPARED_WITH", "tail": "bulkhead", "weight": 2}, r["relations"])
        self.assertEqual(r["difficulty"], "cluster")                           # the word "differ"

    def test_the_neighbours_of_the_anchors_are_listed_as_context(self):
        r = self.ask("circuit breaker", mode="entity")
        names = [e["name"] for e in r["entities"] if e["layer"] == 0]
        self.assertEqual(names[0], "circuit breaker")
        self.assertIn("bulkhead", names)                                       # COMPARED_WITH
        self.assertIn("timeout", names)                                        # ENABLES


class Levels(Base):
    def test_a_forced_level_adds_the_groups_it_names_and_no_more(self):
        entity = self.ask("circuit breaker", difficulty="entity")
        cluster = self.ask("circuit breaker", difficulty="cluster")
        theme = self.ask("circuit breaker", difficulty="theme")
        self.assertEqual({e["layer"] for e in entity["entities"]}, {0})
        self.assertEqual({e["layer"] for e in cluster["entities"]}, {0, 1})
        self.assertEqual({e["layer"] for e in theme["entities"]}, {0, 1, 2})
        self.assertIn("Resilience patterns", [e["name"] for e in cluster["entities"]])
        self.assertIn("Resilience and scale", [e["name"] for e in theme["entities"]])
        self.assertIn({"head": "Resilience patterns", "relation": "SUPPORTS", "tail": "Scaling services", "weight": 3, "layer": 1}, cluster["relations"])
        self.assertEqual(entity["source_texts"], cluster["source_texts"])      # the level changes the context, not the evidence

    def test_auto_reads_the_question(self):
        self.assertEqual(self.ask("what is a circuit breaker")["difficulty"], "entity")
        self.assertEqual(self.ask("difference between a cache and a load balancer")["difficulty"], "cluster")
        self.assertEqual(self.ask("give me an overview of resilience")["difficulty"], "theme")
        self.assertEqual(self.ask("circuit breaker", difficulty="nonsense")["difficulty"], "entity")


class Release(Base):
    def test_a_slide_of_a_week_that_has_not_opened_is_never_returned(self):
        before = dt.datetime(2026, 11, 2, 7, 59, tzinfo=dt.timezone.utc)        # 23:59 on 1 November, Pacific
        after = dt.datetime(2026, 11, 2, 8, 0, tzinfo=dt.timezone.utc)          # midnight on 2 November, Pacific (UTC-8 after the clocks went back)
        self.assertNotIn(("Deck Three.pdf", 1), self.ids(self.ask("Raft consensus leader", now=before)))
        self.assertIn(("Deck Three.pdf", 1), self.ids(self.ask("Raft consensus leader", now=after)))

    def test_a_chunk_far_in_the_future_is_hidden_in_every_mode_and_its_entity_does_not_leak_it(self):
        for mode in ("bm25", "entity", "hybrid"):
            r = self.ask("sharding splits data", mode=mode)
            self.assertNotIn(("Deck Four.pdf", 1), self.ids(r), mode)
            self.assertFalse(any("Sharding splits data" in s["text"] for s in r["source_texts"]), mode)
        later = dt.datetime(2027, 1, 2, tzinfo=dt.timezone.utc)
        self.assertIn(("Deck Four.pdf", 1), self.ids(self.ask("sharding splits data", now=later)))

    def test_an_assignment_text_is_hidden_until_its_unlock_time(self):
        early = dt.datetime(2026, 9, 28, 15, 59, tzinfo=dt.timezone.utc)
        self.assertFalse(any(s["kind"] == "homework" for s in self.ask("homework 4 assignment", now=early)["source_texts"]))
        self.assertTrue(any(s["kind"] == "homework" for s in self.ask("homework 4 assignment", now=dt.datetime(2026, 9, 28, 16, 0, tzinfo=dt.timezone.utc))["source_texts"]))

    def test_a_visible_from_it_cannot_read_is_not_shown(self):
        self.assertFalse(gq.visible("not a date", NOW))
        self.assertTrue(gq.visible("", NOW))

    def test_the_evaluation_can_pin_the_clock(self):
        os.environ["LEANRAG_NOW"] = "2026-10-01T00:00:00Z"
        try:
            self.assertEqual(gq.now_utc(), dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc))
            self.assertNotIn(("Deck Three.pdf", 1), self.ids(self.index.query("Raft consensus leader")))
        finally:
            del os.environ["LEANRAG_NOW"]


class Channels(Base):
    def test_an_assignment_text_does_not_push_the_slides_out_and_comes_after_them_unless_the_question_is_about_assignments(self):
        r = self.ask("circuit breaker bulkhead cache load balancer")
        kinds = [s["kind"] for s in r["source_texts"]]
        self.assertEqual(kinds[0], "slide")
        self.assertEqual(kinds, sorted(kinds, key=lambda k: k != "slide"))     # slides first, texts after
        self.assertLessEqual(kinds.count("homework") + kinds.count("syllabus"), gq.TEXTS)

    def test_a_question_about_the_assignment_puts_its_text_first(self):
        r = self.ask("homework 4 circuit breaker")
        self.assertEqual(r["source_texts"][0]["kind"], "homework")
        self.assertTrue(any(s["kind"] == "slide" for s in r["source_texts"]))

    def test_the_syllabus_answers_a_question_about_grading(self):
        r = self.ask("how much is the final project worth")
        self.assertEqual(r["source_texts"][0]["kind"], "syllabus")


class Safety(Base):
    def test_a_query_opens_no_network_connection(self):
        saved = (socket.socket.connect, socket.create_connection)
        socket.socket.connect, socket.create_connection = refuse_network, refuse_network
        try:
            self.assertTrue(self.ask("circuit breaker bulkhead")["source_texts"])
        finally:
            socket.socket.connect, socket.create_connection = saved

    def test_an_artifact_that_is_missing_unreadable_or_the_wrong_format_is_an_error_in_words(self):
        with tempfile.TemporaryDirectory() as t:
            with self.assertRaises(gq.GraphError):
                gq.GraphIndex(Path(t))
            root = write_fixture(Path(t) / "a")
            (root / "graph.json").write_text("{not json", encoding="utf-8")
            with self.assertRaises(gq.GraphError):
                gq.GraphIndex(root)
            root2 = write_fixture(Path(t) / "b")
            (root2 / "manifest.json").write_text(json.dumps({"format": 2}), encoding="utf-8")
            with self.assertRaises(gq.GraphError):
                gq.GraphIndex(root2)

    def test_a_synthetic_graph_is_not_served_unless_the_caller_says_it_is_for_testing(self):
        with tempfile.TemporaryDirectory() as t:
            root = write_fixture(Path(t) / "s", synthetic=True)
            with self.assertRaises(gq.GraphError):
                gq.GraphIndex(root)
            self.assertTrue(gq.GraphIndex(root, allow_synthetic=True).query("circuit breaker", now=NOW)["source_texts"])

    def test_the_index_is_kept_per_artifact_and_made_again_when_its_manifest_changes(self):
        with tempfile.TemporaryDirectory() as t:
            root = write_fixture(Path(t) / "k")
            first = gq.load_index(root)
            self.assertIs(first, gq.load_index(root))
            manifest = json.loads((root / "manifest.json").read_text())
            manifest["built_at"] = "2026-11-12T00:00:00Z-and-a-longer-value"
            (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertIsNot(first, gq.load_index(root))

    def test_query_graph_reads_the_mode_from_the_environment_and_defaults_to_hybrid(self):
        os.environ["LEANRAG_MODE"] = "bm25"
        try:
            self.assertEqual(gq.query_graph(self.root, "circuit breaker", now=NOW)["mode"], "bm25")
        finally:
            del os.environ["LEANRAG_MODE"]
        self.assertEqual(gq.query_graph(self.root, "circuit breaker", now=NOW)["mode"], "hybrid")

    def test_the_manifest_can_choose_the_mode_that_is_served_and_a_bad_value_means_hybrid(self):
        with tempfile.TemporaryDirectory() as t:
            root = write_fixture(Path(t) / "m")
            for value, want in (("bm25", "bm25"), ("entity", "entity"), ("nonsense", "hybrid"), (None, "hybrid")):
                manifest = {"format": 1, "synthetic": False, "built_at": f"2026-11-11T00:00:00Z-{value}"}
                if value is not None:
                    manifest["default_mode"] = value
                (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                self.assertEqual(gq.query_graph(root, "circuit breaker", now=NOW)["mode"], want, value)
            os.environ["LEANRAG_MODE"] = "entity"                                  # the evaluation's override beats the manifest
            try:
                self.assertEqual(gq.query_graph(root, "circuit breaker", now=NOW)["mode"], "entity")
            finally:
                del os.environ["LEANRAG_MODE"]

    def test_every_number_that_decides_a_ranking_is_in_the_config_the_evaluation_records(self):
        cfg = gq.engine_config()
        self.assertEqual(cfg["per_group"], gq.PER_GROUP)
        self.assertEqual(set(cfg["weights"]), {"hybrid", "entity", "bm25"})
        json.dumps(cfg)


class Profiles(Base):
    """v1 is the engine that was frozen and run on the first test set: it stays what it was. v2 splits a comparison; v2cal also calibrates the graph signal."""

    def test_v2_is_the_default_and_v1_s_config_hash_is_still_the_one_the_first_test_run_recorded(self):
        import hashlib
        self.assertEqual(gq.DEFAULT_PROFILE, "v2")           # rule R1 of the second round
        self.assertEqual(hashlib.sha256(json.dumps(gq.engine_config("v1"), sort_keys=True).encode()).hexdigest()[:16], "255d88ce18e4b132")
        self.assertEqual(gq.engine_config(), gq.engine_config("v2"))

    def test_each_profile_has_a_config_of_its_own_that_names_what_it_changes(self):
        import hashlib
        hashes = {n: hashlib.sha256(json.dumps(gq.engine_config(n), sort_keys=True).encode()).hexdigest() for n in gq.PROFILES}
        self.assertEqual(len(set(hashes.values())), len(gq.PROFILES))
        for name in ("v2", "v2cal"):
            cfg = gq.engine_config(name)
            self.assertEqual(cfg["profile"], name)
            self.assertTrue(cfg["compare_split"])
            self.assertEqual(cfg["split_patterns"], [p.pattern for p in gq.SPLIT_PATTERNS])
            json.dumps(cfg)
        self.assertEqual(gq.engine_config("v2cal")["graph"], "calibrated")
        self.assertEqual(gq.engine_config("v2")["graph"], "relative")

    def test_the_profile_comes_from_the_argument_then_the_environment_and_a_bad_name_is_the_default(self):
        self.assertEqual(gq.resolve_profile("v1"), "v1")
        self.assertEqual(gq.resolve_profile("nonsense"), gq.DEFAULT_PROFILE)
        os.environ["LEANRAG_PROFILE"] = "v2cal"
        try:
            self.assertEqual(gq.resolve_profile(), "v2cal")
            self.assertEqual(gq.resolve_profile("v1"), "v1")        # the argument wins
        finally:
            del os.environ["LEANRAG_PROFILE"]
        self.assertEqual(gq.resolve_profile(), gq.DEFAULT_PROFILE)

    def test_a_question_that_is_not_a_comparison_is_ranked_the_same_by_v1_and_v2(self):
        for question in ("What is the cache-aside pattern?", "Explain stateless services", "how do retries and timeouts help when a service is slow"):
            for mode in ("bm25", "entity", "hybrid"):
                self.assertEqual(self.ids(self.ask(question, mode=mode, profile="v1")), self.ids(self.ask(question, mode=mode, profile="v2")), (question, mode))

    def test_the_default_profile_is_what_a_call_without_a_profile_gets(self):
        q = "How does a circuit breaker differ from a bulkhead?"
        self.assertEqual(self.ids(self.ask(q)), self.ids(self.ask(q, profile=gq.DEFAULT_PROFILE)))
        self.assertEqual(self.ids(self.ask(q, profile="v1")), self.ids(self.ask(q, profile="v1")))


class Comparisons(unittest.TestCase):
    def test_the_usual_ways_of_asking_for_a_comparison_give_two_sides(self):
        cases = {
            "How does a circuit breaker differ from a bulkhead?": [["circuit", "breaker"], ["bulkhead"]],
            "How is a forward proxy different from a reverse proxy?": [["forward", "proxy"], ["revers", "proxy"]],
            "Compare virtual machines and containers.": [["virtual", "machin"], ["container"]],
            "How does a monolith compare to a microservices architecture?": [["monolith"], ["microservic", "architectur"]],
            "What's the difference between a write-through cache and a write-behind cache?": [["writ", "through", "cach"], ["writ", "behind", "cach"]],
            "When would I scale a service up versus scale it out?": [["scal", "servic", "up"], ["scal", "out"]],
            "SQL vs. NoSQL": [["sql"], ["nosql"]],
        }
        for question, sides in cases.items():
            self.assertEqual(gq.split_sides(question), sides, question)

    def test_a_question_that_is_not_a_comparison_or_whose_sides_are_the_same_is_not_split(self):
        for question in ("What is the cache-aside pattern?", "What are the three pillars of observability?", "", "versus", "Compare cache and cache"):
            self.assertIsNone(gq.split_sides(question), question)

    def test_a_side_that_has_no_content_word_is_not_a_side(self):
        for question in ("what versus containers", "containers versus the", "How is it different from that?"):
            self.assertIsNone(gq.split_sides(question), question)

    def test_interleave_takes_each_list_in_turn_skips_what_is_taken_and_stops_at_top_k(self):
        a = [(1, .9), (2, .8), (3, .7)]
        b = [(10, .9), (1, .8), (11, .7)]
        c = [(2, .9), (20, .5)]
        self.assertEqual([p for p, _ in gq.interleave([a, b, c], 10)], [1, 10, 2, 3, 11, 20])
        self.assertEqual([p for p, _ in gq.interleave([a, b, c], 4)], [1, 10, 2, 3])
        self.assertEqual(gq.interleave([[], []], 5), [])
        self.assertEqual([p for p, _ in gq.interleave([a], 2)], [1, 2])

    def test_a_deck_that_is_all_about_one_side_no_longer_hides_the_other_side(self):
        """Six slides of one deck are about the circuit breaker (and each mentions the bulkhead once, so the word is not rare) and one is about the bulkhead: with three
        slides to a deck the bulkhead slide never appears in v1, because three of the circuit breaker slides fill the deck's places."""
        with tempfile.TemporaryDirectory() as tmp:
            root = write_fixture(Path(tmp) / "graph")
            lines = (root / "chunks.jsonl").read_text(encoding="utf-8").splitlines()
            kept = [line for line in lines if json.loads(line)["id"] != "d00:p003"]
            for n in range(5, 11):
                kept.append(json.dumps({"id": f"d00:p{n:03d}", "kind": "slide", "deck": "Deck One.pdf", "title": "Deck One", "week": "w1", "page": n, "visible_from": "2026-09-07",
                                        "heading": f"Circuit Breaker Example {n}", "text": f"{n}\nCircuit Breaker Example {n}\nA circuit breaker opens when the breaker trips. The circuit breaker closes again later, unlike a bulkhead."}))
            (root / "chunks.jsonl").write_text("\n".join(kept) + "\n", encoding="utf-8")
            index = gq.GraphIndex(root)
            question = "How does a circuit breaker differ from a bulkhead?"
            bulkhead = ("Deck One.pdf", 2)
            for mode in ("bm25", "hybrid"):
                v1 = [(s["deck"], s["page"]) for s in index.query(question, mode=mode, now=NOW, profile="v1")["source_texts"] if s["kind"] == "slide"]
                v2 = [(s["deck"], s["page"]) for s in index.query(question, mode=mode, now=NOW, profile="v2")["source_texts"] if s["kind"] == "slide"]
                self.assertNotIn(bulkhead, v1, f"v1 {mode}: the cap should hide the bulkhead slide in this deck")
                self.assertIn(bulkhead, v2[:3], f"v2 {mode}: the bulkhead slide must be among the first three")
                self.assertEqual(len(v2), len(set(v2)), "no slide twice")
                circuit = [p for p in v2 if p[0] == "Deck One.pdf" and p != bulkhead]
                self.assertTrue(circuit, "the circuit breaker side is still answered")

    @staticmethod
    def _crowded_with_a_comparison_slide(root: Path) -> None:
        """Six slides of Deck One about the circuit breaker alone (none says bulkhead), and a slide of Deck Two that names both and is about neither."""
        lines = (root / "chunks.jsonl").read_text(encoding="utf-8").splitlines()
        kept = [line for line in lines if json.loads(line)["id"] != "d00:p003"]
        for n in range(5, 11):
            kept.append(json.dumps({"id": f"d00:p{n:03d}", "kind": "slide", "deck": "Deck One.pdf", "title": "Deck One", "week": "w1", "page": n, "visible_from": "2026-09-07",
                                    "heading": f"Circuit Breaker Example {n}", "text": f"{n}\nCircuit Breaker Example {n}\nA circuit breaker opens when the breaker trips. The circuit breaker closes again later."}))
        kept.append(json.dumps({"id": "d01:p003", "kind": "slide", "deck": "Deck Two.pdf", "title": "Deck Two", "week": "w2", "page": 3, "visible_from": "2026-09-14",
                                "heading": "Isolating failures", "text": "3\nIsolating failures\nA circuit breaker stops calls. A bulkhead keeps pools apart."}))
        (root / "chunks.jsonl").write_text("\n".join(kept) + "\n", encoding="utf-8")

    def test_the_slide_that_names_both_sides_is_kept_among_the_first_three_by_the_whole_question_s_own_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = write_fixture(Path(tmp) / "graph")
            self._crowded_with_a_comparison_slide(root)
            result = gq.GraphIndex(root).query("How does a circuit breaker differ from a bulkhead?", mode="bm25", now=NOW, profile="v2")
            first_three = [(s["deck"], s["page"]) for s in result["source_texts"] if s["kind"] == "slide"][:3]
            self.assertIn(("Deck One.pdf", 2), first_three)          # the bulkhead's own slide
            self.assertIn(("Deck Two.pdf", 3), first_three)          # the one that names both: the side lists put it fourth, the whole question's list third

    def test_a_side_cannot_take_more_than_three_slides_from_one_deck(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = write_fixture(Path(tmp) / "graph")
            self._crowded_with_a_comparison_slide(root)
            result = gq.GraphIndex(root).query("How does a circuit breaker differ from a bulkhead?", mode="bm25", now=NOW, profile="v2", top_k=10)
            pages = [s["page"] for s in result["source_texts"] if s["kind"] == "slide" and s["deck"] == "Deck One.pdf"]
            self.assertLessEqual(len([p for p in pages if p in (1, 5, 6, 7, 8, 9, 10)]), 3, pages)      # the circuit breaker's slides: the cap holds for that side's list

    def test_a_comparison_in_v2_still_obeys_the_release_clock_and_the_slide_channel(self):
        with tempfile.TemporaryDirectory() as tmp:
            index = gq.GraphIndex(write_fixture(Path(tmp) / "graph"))
            early = dt.datetime(2026, 9, 8, tzinfo=dt.timezone.utc)                  # only Deck One is open
            result = index.query("How does a load balancer differ from a bulkhead?", mode="hybrid", now=early, profile="v2")
            decks = {s["deck"] for s in result["source_texts"] if s["kind"] == "slide"}
            self.assertEqual(decks, {"Deck One.pdf"})
            self.assertNotIn("Deck Two.pdf", decks)
            self.assertNotIn("Deck Four.pdf", {s["deck"] for s in result["source_texts"]})


class Calibration(Base):
    def test_a_weak_anchor_stays_weak_in_v2cal_and_is_the_best_slide_in_v1(self):
        """A long question that only mentions the bulkhead in passing: v1 normalises the graph signal by its own best (so the one slide the weak anchor points at gets
        the full weight); v2cal weighs the anchor by the share of the question it holds."""
        q = "bulkhead with a whole lot of other words like zebra giraffe lion tiger elephant monkey"
        q_terms = list(dict.fromkeys(gq.terms(q)))
        ok = [True] * len(self.index.chunks)
        v1 = self.index._evidence(q_terms, "hybrid", ok, gq.PROFILES["v1"])
        cal = self.index._evidence(q_terms, "hybrid", ok, gq.PROFILES["v2cal"])
        self.assertTrue(v1["entity_part"] and cal["entity_part"])
        self.assertEqual(max(gq._normalise(dict(v1["entity_part"])).values()), 1.0)       # relative: the best is always 1.0
        self.assertLess(max(cal["entity_part"].values()), 0.5)                          # calibrated: a small share of the question, a small signal
        self.assertTrue(all(0.0 <= v <= 1.0 for v in cal["entity_part"].values()))

    def test_the_best_slide_of_a_weak_graph_signal_scores_about_its_text_alone_in_v2cal_and_the_full_weight_in_v1(self):
        q = "bulkhead with a whole lot of other words like zebra giraffe lion tiger elephant monkey"
        q_terms = list(dict.fromkeys(gq.terms(q)))
        ok = [True] * len(self.index.chunks)
        slides = {i for i, c in enumerate(self.index.chunks) if c["kind"] == "slide"}
        top_v1 = self.index._rank(slides, self.index._evidence(q_terms, "hybrid", ok, gq.PROFILES["v1"]), "hybrid", gq.PROFILES["v1"])[0][1]
        top_cal = self.index._rank(slides, self.index._evidence(q_terms, "hybrid", ok, gq.PROFILES["v2cal"]), "hybrid", gq.PROFILES["v2cal"])[0][1]
        self.assertGreaterEqual(top_v1, 0.9 - 1e-9)          # 0.5 of the text, 0.4 of a graph signal scaled up to 1.0, a little for the neighbours
        self.assertLess(top_cal, 0.65)           # 0.5 of the text and a small graph signal

    def test_the_spread_of_an_entity_over_the_slides_it_points_at(self):
        self.assertEqual(gq._spread(4, 0.5), 2.0)            # v1: the square root
        self.assertEqual(gq._spread(9, 0.5), 3.0)
        self.assertEqual(gq._spread(8, 1.0), 8.0)
        self.assertAlmostEqual(gq._spread(16, 0.25), 2.0)

    def test_v1_adds_up_the_anchors_that_point_at_a_slide_and_the_calibrated_engine_takes_the_best_one(self):
        q_terms = list(dict.fromkeys(gq.terms("cache-aside and stateless services")))
        ok = [True] * len(self.index.chunks)
        p4 = self.index.chunk_at["d00:p004"]                  # cited by two anchors: cache-aside, stateless service
        added = self.index._evidence(q_terms, "hybrid", ok, gq.PROFILES["v1"])["entity_part"][p4]
        best = self.index._evidence(q_terms, "hybrid", ok, {**gq.PROFILES["v1"], "agg": "max"})["entity_part"][p4]
        self.assertGreater(added, best)
        self.assertEqual(gq.PROFILES["v1"]["agg"], "sum")
        self.assertEqual(gq.PROFILES["v2cal"]["agg"], "max")

    def test_an_anchor_that_holds_most_of_the_question_keeps_a_strong_signal_in_v2cal(self):
        q_terms = list(dict.fromkeys(gq.terms("cache-aside pattern")))
        ok = [True] * len(self.index.chunks)
        cal = self.index._evidence(q_terms, "hybrid", ok, gq.PROFILES["v2cal"])
        self.assertGreater(max(cal["entity_part"].values()), 0.5)

    def test_v2cal_answers_every_mode_and_keeps_the_same_shape(self):
        for mode in ("bm25", "entity", "hybrid"):
            r = self.ask("circuit breaker versus bulkhead", mode=mode, profile="v2cal")
            self.assertEqual(set(r), {"engine", "mode", "difficulty", "now", "seed_entities", "entities", "relations", "source_texts"})
            self.assertTrue(r["source_texts"])


if __name__ == "__main__":
    unittest.main()
