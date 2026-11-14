"""leanrag/graph_extract.py: units, what is kept of a model's answer, and the resumable cache. The model is a scripted fake; nothing is sent anywhere.
What the tests pin: an entity the text does not support is dropped, a relation needs both ends, a cited slide outside the unit is replaced, an answer
that is not JSON is asked again once and then recorded as failed, a run that is stopped keeps what it did, and a second run costs nothing.
Run: python leanrag/test_graph_extract.py   (standard library only)
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.dont_write_bytecode = True

from leanrag import graph_extract as ge  # noqa: E402
from leanrag.corpus import Chunk  # noqa: E402
from leanrag.llm import BudgetExceeded, Completion, FatalLlmError, LlmError, Usage  # noqa: E402


def slide(deck_no: int, page: int, text: str, deck: str = "Deck.pdf") -> Chunk:
    return Chunk(f"d{deck_no:02d}:p{page:03d}", "slide", deck, "Deck", "w1", page, "2026-09-07", text.split("\n")[0], text)


def hw(text: str) -> Chunk:
    return Chunk("hw:1:0", "homework", "", "Homework 1", "w2", 0, "", "", text)


CIRCUIT = slide(0, 1, "Circuit Breaker Pattern\nA circuit breaker stops calls to a failing service when errors are frequent.")
BULK = slide(0, 2, "Bulkhead Pattern\nA bulkhead isolates thread pools so that one slow service cannot use every thread.")


class Units(unittest.TestCase):
    def test_slides_of_one_deck_are_grouped_up_to_the_limits_and_other_chunks_stand_alone(self):
        chunks = [slide(0, n, f"Slide {n}\n" + "word " * 30) for n in range(1, 8)] + [slide(1, 1, "Other deck\nbody text here", deck="Other.pdf"), hw("Homework text here")]
        units = ge.make_units(chunks, max_chars=900, max_pages=4)
        self.assertEqual([u.pages for u in units], [[1, 2, 3, 4], [5, 6, 7], [1], []])
        self.assertEqual([u.kind for u in units], ["slide", "slide", "slide", "homework"])
        self.assertTrue(units[0].text.startswith("[Slide 1]\nSlide 1"))
        self.assertIn("\n\n[Slide 2]\n", units[0].text)
        self.assertEqual(units[0].page_chunk, {1: "d00:p001", 2: "d00:p002", 3: "d00:p003", 4: "d00:p004"})
        self.assertTrue(units[3].text.startswith("[Assignment text: Homework 1]"))

    def test_a_slide_that_would_pass_the_character_limit_starts_a_new_unit(self):
        units = ge.make_units([slide(0, 1, "A\n" + "x " * 300), slide(0, 2, "B\n" + "y " * 300)], max_chars=900, max_pages=4)
        self.assertEqual([u.pages for u in units], [[1], [2]])

    def test_the_prompt_tells_the_model_to_use_only_the_text_and_holds_the_text_once(self):
        system, user = ge.build_prompt(ge.make_units([CIRCUIT])[0])
        self.assertIn("Use ONLY what the text says", system)
        self.assertEqual(user.count("A circuit breaker stops calls"), 1)
        self.assertIn("JSON", system)
        self.assertTrue(system.startswith("TASK: extract-graph"))


def answer(entities, relations=()):
    return json.dumps({"entities": entities, "relations": list(relations)})


class Parsing(unittest.TestCase):
    def setUp(self):
        self.unit = ge.make_units([CIRCUIT, BULK])[0]

    def test_a_supported_entity_is_kept_with_its_slides_and_a_relation_between_kept_entities_too(self):
        raw = answer([{"name": "Circuit Breaker", "type": "pattern", "description": "stops calls to a failing service", "slides": [1]},
                      {"name": "bulkhead", "type": "pattern", "description": "", "slides": [2]}],
                     [{"head": "circuit breaker", "relation": "compared with", "tail": "Bulkhead", "slides": [1, 2]}])
        p = ge.parse_response(raw, self.unit)
        self.assertEqual([(e["name"], e["key"], e["type"], e["chunks"]) for e in p.entities], [("Circuit Breaker", "circuit breaker", "pattern", ["d00:p001"]), ("bulkhead", "bulkhead", "pattern", ["d00:p002"])])
        self.assertEqual(p.relations, [{"head": "circuit breaker", "relation": "COMPARED_WITH", "tail": "bulkhead", "chunks": ["d00:p001", "d00:p002"]}])

    def test_an_entity_the_text_does_not_support_is_dropped(self):
        p = ge.parse_response(answer([{"name": "Paxos", "type": "protocol", "description": "a consensus protocol", "slides": [1]}, {"name": "circuit breaker"}], []), self.unit)
        self.assertEqual([e["name"] for e in p.entities], ["circuit breaker"])
        self.assertEqual(p.dropped["ungrounded"], 1)

    def test_half_of_the_words_of_a_name_must_be_in_the_text(self):
        p = ge.parse_response(answer([{"name": "thread pool isolation"}, {"name": "quantum thread banana"}]), self.unit)
        self.assertEqual([e["name"] for e in p.entities], ["thread pool isolation"])          # 2 of 3 words are there; 1 of 3 is not enough

    def test_a_relation_needs_both_ends_and_two_different_ones(self):
        raw = answer([{"name": "circuit breaker"}], [{"head": "circuit breaker", "relation": "USES", "tail": "paxos"}, {"head": "circuit breaker", "relation": "USES", "tail": "circuit breaker"}])
        p = ge.parse_response(raw, self.unit)
        self.assertEqual(p.relations, [])
        self.assertEqual(p.dropped["no_endpoint"], 2)

    def test_an_unknown_relation_type_becomes_related_to_and_an_unknown_entity_type_other(self):
        raw = answer([{"name": "circuit breaker", "type": "gadget"}, {"name": "bulkhead"}], [{"head": "circuit breaker", "relation": "loves", "tail": "bulkhead"}])
        p = ge.parse_response(raw, self.unit)
        self.assertEqual(p.entities[0]["type"], "other")
        self.assertEqual(p.relations[0]["relation"], "RELATED_TO")

    def test_a_slide_that_is_not_in_the_unit_is_replaced_by_all_of_the_units_slides(self):
        p = ge.parse_response(answer([{"name": "circuit breaker", "slides": [99]}, {"name": "bulkhead"}]), self.unit)
        self.assertEqual(p.entities[0]["chunks"], ["d00:p001", "d00:p002"])
        self.assertEqual(p.entities[1]["chunks"], ["d00:p001", "d00:p002"])
        self.assertEqual(p.notes, {"slides_replaced": 1, "slides_uncited": 1})          # one cited a slide that is not there, one cited none

    def test_a_good_citation_is_not_counted_and_a_homework_unit_never_is(self):
        good = ge.parse_response(answer([{"name": "circuit breaker", "slides": [1]}]), self.unit)
        self.assertEqual(good.notes, {"slides_replaced": 0, "slides_uncited": 0})
        homework = ge.parse_response(answer([{"name": "circuit breaker"}]), ge.make_units([hw("Build a circuit breaker for the service.")])[0])
        self.assertEqual(homework.notes, {"slides_replaced": 0, "slides_uncited": 0})

    def test_two_names_with_the_same_stems_are_one_entity_and_the_first_description_is_kept(self):
        p = ge.parse_response(answer([{"name": "Circuit breaker", "slides": [1], "description": ""}, {"name": "circuit breakers", "slides": [2], "description": "stops calls"}]), self.unit)
        self.assertEqual(len(p.entities), 1)
        self.assertEqual((p.entities[0]["description"], p.entities[0]["chunks"]), ("stops calls", ["d00:p001", "d00:p002"]))

    def test_the_limits_hold(self):
        many = [{"name": f"thread pool {n}"} for n in range(40)]
        p = ge.parse_response(answer(many, []), self.unit)
        self.assertLessEqual(len(p.entities), ge.MAX_ENTITIES)
        long = ge.parse_response(answer([{"name": "circuit breaker", "description": "x" * 1000}], []), self.unit)
        self.assertEqual(len(long.entities[0]["description"]), ge.MAX_DESC_CHARS)

    def test_what_is_not_the_object_asked_for_is_none_and_fences_are_accepted(self):
        for bad in ("", "no braces", "{broken", "[1, 2]", '{"entities": 3}'):
            self.assertIsNone(ge.parse_response(bad, self.unit), bad)
        fenced = "```json\n" + answer([{"name": "circuit breaker"}], []) + "\n```"
        self.assertEqual(len(ge.parse_response(fenced, self.unit).entities), 1)

    def test_a_homework_unit_has_no_slides_and_cites_its_one_chunk(self):
        unit = ge.make_units([hw("Build a circuit breaker for the service.")])[0]
        p = ge.parse_response(answer([{"name": "circuit breaker", "slides": [3]}]), unit)
        self.assertEqual(p.entities[0]["chunks"], ["hw:1:0"])


class Scripted:
    """A fake model: answers from a list (a string, or an exception to raise) and counts its calls."""
    model = "scripted"

    def __init__(self, *items):
        self.items, self.calls, self.usage = list(items), 0, Usage()

    def complete_json(self, system, user, max_tokens=1500):
        self.calls += 1
        item = self.items.pop(0) if len(self.items) > 1 else self.items[0]
        if isinstance(item, Exception):
            raise item
        self.usage.calls += 1
        return Completion(text=item, model="scripted-1", prompt_tokens=10, completion_tokens=5)


GOOD = answer([{"name": "circuit breaker", "slides": [1]}], [])


class Running(unittest.TestCase):
    def units(self):
        """Four units (one slide each)."""
        return ge.make_units([slide(0, n, f"Slide {n}\ncircuit breaker text " + "w" * 30) for n in range(1, 4)] + [slide(1, 1, "Other\ncircuit breaker body " + "w" * 30, deck="Other.pdf")], max_pages=1)

    def test_a_second_run_costs_nothing_and_gives_the_same_entities(self):
        with tempfile.TemporaryDirectory() as t:
            cache = Path(t) / "c.jsonl"
            units = self.units()
            first, model = ge.run_extraction(units, Scripted(GOOD), cache), Scripted(GOOD)
            second = ge.run_extraction(units, model, cache)
            self.assertEqual(model.calls, 0)
            self.assertTrue(all(r.cached for r in second.results))
            self.assertEqual(first.counts()["entities_kept"], second.counts()["entities_kept"])
            self.assertTrue(first.complete and second.complete)
            self.assertEqual(second.counts()["completion_tokens"], first.counts()["completion_tokens"])     # the cache keeps what each answer cost
            self.assertEqual(first.counts()["completion_tokens"], 5 * len(units))
            self.assertEqual(first.counts()["notes"], {"slides_replaced": 2, "slides_uncited": 0})        # GOOD cites slide 1: right for two of the four units, outside the other two

    def test_the_cache_is_keyed_by_the_model_and_by_the_text(self):
        with tempfile.TemporaryDirectory() as t:
            cache = Path(t) / "c.jsonl"
            units = self.units()
            ge.run_extraction(units, Scripted(GOOD), cache)
            other = Scripted(GOOD)
            other.model = "another-model"
            ge.run_extraction(units, other, cache)
            self.assertEqual(other.calls, len(units))                    # another model is another set of answers
            changed = ge.make_units([slide(0, 1, "Slide 1\ncircuit breaker text changed " + "w" * 30)])
            third = Scripted(GOOD)
            ge.run_extraction(changed, third, cache)
            self.assertEqual(third.calls, 1)

    def test_an_answer_that_is_not_json_is_asked_again_once_then_recorded_as_failed_and_not_asked_a_third_time(self):
        with tempfile.TemporaryDirectory() as t:
            cache = Path(t) / "c.jsonl"
            units = self.units()[:1]
            model = Scripted("not json", GOOD)
            report = ge.run_extraction(units, model, cache)
            self.assertEqual((model.calls, report.counts()["ok"]), (2, 1))   # the second ask got a good answer
            model2 = Scripted("still not json")
            cache2 = Path(t) / "c2.jsonl"
            report2 = ge.run_extraction(units, model2, cache2)
            self.assertEqual((model2.calls, report2.counts()["failed"]), (2, 1))
            again = Scripted(GOOD)
            ge.run_extraction(units, again, cache2)
            self.assertEqual(again.calls, 0)                               # a failed unit is not paid for again ...
            retry = Scripted(GOOD)
            ge.run_extraction(units, retry, cache2, retry_failed=True)
            self.assertEqual(retry.calls, 1)                               # ... unless asked

    def test_a_failed_answer_is_kept_whole_and_read_again_so_a_later_parser_recovers_it_with_no_request(self):
        with tempfile.TemporaryDirectory() as t:
            cache = Path(t) / "c.jsonl"
            unit = self.units()[:1][0]
            long_text = "not json at all " * 400                                      # about 6,400 characters: more than the 2,000 that used to be kept
            report = ge.run_extraction([unit], Scripted(long_text), cache)
            self.assertEqual(report.counts()["failed"], 1)
            record = ge.load_cache(cache)[ge.cache_key("scripted", unit)]
            self.assertTrue(record["failed"])
            self.assertEqual(record["raw"], long_text)                                # the whole answer, not its first 2,000 characters
            # an earlier parser did not accept this answer; a later one does (here: the same record, with an answer that parses)
            record["raw"] = GOOD
            with open(cache, "w", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
            model = Scripted(GOOD)
            again = ge.run_extraction([unit], model, cache)
            self.assertEqual((model.calls, again.counts()["ok"], again.counts()["failed"]), (0, 1, 0))
            self.assertTrue(again.results[0].cached)
            # and one that still does not parse stays failed, with no request unless asked
            record["raw"] = "still not json"
            with open(cache, "w", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
            model2 = Scripted(GOOD)
            still = ge.run_extraction([unit], model2, cache)
            self.assertEqual((model2.calls, still.counts()["failed"]), (0, 1))

    def test_a_budget_stops_the_run_and_keeps_what_was_done(self):
        with tempfile.TemporaryDirectory() as t:
            cache = Path(t) / "c.jsonl"
            units = self.units()
            model = Scripted(GOOD, GOOD, BudgetExceeded("input-token budget used: 5 of 5"))
            report = ge.run_extraction(units, model, cache, workers=1)
            self.assertFalse(report.complete)
            self.assertIn("budget", report.stopped_because)
            self.assertEqual(len(ge.load_cache(cache)), 2)
            resume = Scripted(GOOD)
            done = ge.run_extraction(units, resume, cache, workers=1)
            self.assertTrue(done.complete)
            self.assertEqual(resume.calls, len(units) - 2)                 # only the missing units are asked

    def test_a_refused_key_stops_the_whole_run(self):
        with tempfile.TemporaryDirectory() as t:
            model = Scripted(FatalLlmError("the API refused the key (HTTP 401)"))
            report = ge.run_extraction(self.units(), model, Path(t) / "c.jsonl", workers=1)
            self.assertFalse(report.complete)
            self.assertIn("refused the key", report.stopped_because)
            self.assertEqual(model.calls, 1)

    def test_one_unit_that_fails_for_another_reason_does_not_stop_the_others(self):
        with tempfile.TemporaryDirectory() as t:
            model = Scripted(LlmError("could not reach the API (URLError)"), GOOD)
            report = ge.run_extraction(self.units(), model, Path(t) / "c.jsonl", workers=1)
            self.assertEqual(report.counts()["failed"], 1)
            self.assertEqual(report.counts()["ok"], 3)
            self.assertTrue(report.complete)

    def test_units_the_api_never_answered_are_not_cached_so_the_next_run_asks_them_again(self):
        with tempfile.TemporaryDirectory() as t:
            cache = Path(t) / "c.jsonl"
            units = self.units()
            report = ge.run_extraction(units, Scripted(LlmError("could not reach the API (URLError)"), GOOD, GOOD, GOOD), cache, workers=1)
            self.assertEqual((report.counts()["failed"], report.counts()["ok"]), (1, 3))
            self.assertEqual(len(ge.load_cache(cache)), 3)                  # the three answers, and nothing for the unit that got none
            again = Scripted(GOOD)
            second = ge.run_extraction(units, again, cache, workers=1)
            self.assertEqual(again.calls, 1)                                 # only that unit, and without --retry-failed
            self.assertEqual(second.counts()["ok"], 4)

    def test_five_units_in_a_row_that_get_no_answer_stop_the_run_with_the_cache_kept(self):
        with tempfile.TemporaryDirectory() as t:
            units = ge.make_units([slide(0, n, f"Slide {n}\ncircuit breaker text " + "w" * 30) for n in range(1, 10)], max_pages=1)
            model = Scripted(LlmError("could not reach the API (URLError)"))
            report = ge.run_extraction(units, model, Path(t) / "c.jsonl", workers=1)
            self.assertFalse(report.complete)
            self.assertIn("5 requests in a row failed", report.stopped_because)
            self.assertEqual(model.calls, ge.API_FAILURES_STOP)              # it did not wait out the other four units
            # a success in between starts the count again: three failures, an answer, three failures, an answer is not "five in a row" (it would be, if nothing reset the count)
            f = LlmError("x")
            model2 = Scripted(f, f, f, GOOD, f, f, f, GOOD)
            report2 = ge.run_extraction(units[:8], model2, Path(t) / "d.jsonl", workers=1)
            self.assertTrue(report2.complete, report2.stopped_because)
            self.assertEqual((report2.counts()["ok"], report2.counts()["failed"]), (2, 6))

    def test_an_answers_cost_is_summed_over_its_requests_and_is_the_same_when_it_comes_from_the_cache(self):
        with tempfile.TemporaryDirectory() as t:
            cache = Path(t) / "c.jsonl"
            units = self.units()[:1]
            first = ge.run_extraction(units, Scripted("not json", GOOD), cache)        # asked twice: the reply was not JSON the first time
            self.assertEqual(first.records(), [{"model": "scripted-1", "prompt_tokens": 20, "completion_tokens": 10, "cache_hit_tokens": 0, "attempts": 2}])
            second = ge.run_extraction(units, Scripted(GOOD), cache)
            self.assertTrue(second.results[0].cached)
            self.assertEqual(second.records(), first.records())
            from leanrag.llm import sum_usage
            self.assertEqual(sum_usage(second.records())["calls"], 2)

    def test_a_half_written_last_line_of_the_cache_is_ignored(self):
        with tempfile.TemporaryDirectory() as t:
            cache = Path(t) / "c.jsonl"
            ge.run_extraction(self.units()[:1], Scripted(GOOD), cache)
            with open(cache, "a", encoding="utf-8") as f:
                f.write('{"key": "abc", "raw": "{trunc')
            self.assertEqual(len(ge.load_cache(cache)), 1)


class StandIn(unittest.TestCase):
    def test_the_heuristic_model_runs_the_pipeline_without_a_network_and_says_what_it_is(self):
        with tempfile.TemporaryDirectory() as t:
            units = ge.make_units([slide(0, 1, "Caching\n- Redis stores results\n- Memcached stores results\nmore words here"), hw("Build a cache for the service.")])
            model = ge.HeuristicClient()
            report = ge.run_extraction(units, model, Path(t) / "c.jsonl")
            self.assertEqual(model.model, "heuristic-fake")
            self.assertTrue(report.complete)
            self.assertGreater(report.counts()["entities_kept"], 0)


if __name__ == "__main__":
    unittest.main()
