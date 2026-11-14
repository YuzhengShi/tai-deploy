"""leanrag/mcp_server.py: how a result becomes the text the model reads. Two things: the graph engine's text keeps the shape the host reads (`### Source Course Materials`, one
`**Source: <file>**` line per document, which container/agent-runner/src/progress.ts turns into the chips of the page), and the OLD formatter's text is byte for byte what it was
(the golden string below was made by the formatter of git HEAD before this work: with the graph switch off nothing the model reads changes).
Run: python leanrag/test_mcp_format.py   (needs the `mcp` package, which the agent image has)
"""
import datetime as dt
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.dont_write_bytecode = True

try:
    from leanrag import mcp_server as ms
except ImportError:                      # no `mcp` package here
    ms = None

from leanrag import graph_query as gq  # noqa: E402
from leanrag.fixture_artifact import write_fixture  # noqa: E402

# the regular expression of progress.ts knowledgeChips
CHIP = re.compile(r"^\*\*Source: (.+?)\*\*[ \t]*$", re.M)
NOW = dt.datetime(2026, 11, 11, 12, 0, tzinfo=dt.timezone.utc)

LEGACY_RESULT = {
    "difficulty": "entity",
    "seed_entities": [{"name": "Raft", "score": 1.0}, {"name": "slides: Day 4 (slides 12-13)", "score": 0.72}],
    "entities": [{"name": "Raft", "layer": 0, "description": "a consensus protocol"}, {"name": "Week 4", "layer": 1, "description": ""}],
    "relations": [{"head": "Raft", "tail": "Week 4", "relation": "part of"}],
    "source_texts": [{"source_file": "slides: Day 4 (slides 12-13)", "text": "Raft elects a leader."}, {"source_file": "slides: Day 4 (slides 12-13)", "text": "dup file is skipped"},
                     {"source_file": "homework: Homework 2 (Homework)", "text": "x" * 700}],
}
LEGACY_GOLDEN = ("## LeanRAG Knowledge Retrieval (difficulty: entity)\n\n### Most Relevant Concepts\n- **Raft** (relevance: 1.00)\n- **slides: Day 4 (slides 12-13)** (relevance: 0.72)\n\n"
                 "### Concepts in Context\n- [entity] **Raft**: a consensus protocol\n- [cluster] **Week 4**\n\n### Relationships\n- Raft --[part of]--> Week 4\n\n"
                 "### Source Course Materials\n**Source: slides: Day 4 (slides 12-13)**\n```\nRaft elects a leader.\n```\n\n**Source: homework: Homework 2 (Homework)**\n```\n"
                 + "x" * 600 + "...\n```\n")


@unittest.skipIf(ms is None, "the mcp package is not installed here (the agent image has it)")
class Legacy(unittest.TestCase):
    def test_the_old_formatter_gives_exactly_what_it_gave_before(self):
        self.assertEqual(ms._format_context(LEGACY_RESULT), LEGACY_GOLDEN)

    def test_a_result_without_the_graph_marker_is_still_formatted_by_the_old_formatter(self):
        calls = []
        saved = ms._query_knowledge
        ms._query_knowledge = lambda q, difficulty="auto", top_k=10: (calls.append((q, difficulty, top_k)), LEGACY_RESULT)[1]
        try:
            self.assertEqual(ms.query_knowledge("what is raft", "auto", 5), LEGACY_GOLDEN)
        finally:
            ms._query_knowledge = saved
        self.assertEqual(calls, [("what is raft", "auto", 5)])


@unittest.skipIf(ms is None, "the mcp package is not installed here (the agent image has it)")
class GraphText(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.index = gq.GraphIndex(write_fixture(Path(cls.tmp.name) / "g"))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def text(self, question, **kw):
        return ms._format_graph_context(self.index.query(question, now=NOW, **kw))

    def test_one_source_line_per_deck_in_rank_order_with_the_slide_numbers_under_it(self):
        t = self.text("How does a circuit breaker differ from a bulkhead?")
        self.assertIn("### Source Course Materials", t)
        self.assertEqual(CHIP.findall(t)[0], "Deck One.pdf")
        self.assertEqual(len(CHIP.findall(t)), len(set(CHIP.findall(t))))
        self.assertIn("[slide 1, week 1]", t)
        self.assertIn("[slide 2, week 1]", t)
        self.assertIn("A circuit breaker stops calls", t)

    def test_the_concepts_the_relations_and_the_level_are_in_the_text(self):
        t = self.text("How does a circuit breaker differ from a bulkhead?")
        self.assertTrue(t.startswith("## Course Knowledge (slide-level retrieval, level: cluster)"))
        self.assertIn("- **circuit breaker** (relevance: 1.00)", t)
        self.assertIn("- circuit breaker --[COMPARED_WITH]--> bulkhead", t)
        self.assertIn("- [cluster] **Resilience patterns**", t)

    def test_an_assignment_text_is_marked_and_its_document_is_a_source_line_too(self):
        t = self.text("homework 4 circuit breaker")
        self.assertIn("**Source: Homework 4**", t)
        self.assertIn("[assignment text]", t)

    def test_nothing_found_says_so_and_has_no_source_line(self):
        t = self.text("zebra xylophone")
        self.assertIn("Nothing in the released course material matched", t)
        self.assertEqual(CHIP.findall(t), [])

    def test_a_long_slide_is_cut_and_the_whole_answer_stays_under_its_cap(self):
        long = {"engine": "graph", "difficulty": "entity", "seed_entities": [], "entities": [], "relations": [],
                "source_texts": [{"source_file": f"Deck {n}.pdf", "deck": f"Deck {n}.pdf", "title": f"Deck {n}", "page": 1, "week": "w1", "kind": "slide", "score": 1.0, "via": [], "text": "y" * 2000} for n in range(30)]}
        t = ms._format_graph_context(long)
        self.assertLessEqual(len(t), ms._MAX_GRAPH_CHARS + 1500)
        self.assertIn("more passages not shown", t)
        self.assertNotIn("y" * (ms._MAX_SLIDE_CHARS + 5), t)
        self.assertEqual(len(CHIP.findall(t)), len(set(CHIP.findall(t))))

    def test_the_tool_uses_the_graph_text_for_a_graph_result(self):
        saved = ms._query_knowledge
        ms._query_knowledge = lambda q, difficulty="auto", top_k=10: self.index.query(q, now=NOW)
        try:
            out = ms.query_knowledge("stateless services")
        finally:
            ms._query_knowledge = saved
        self.assertIn("Course Knowledge (slide-level retrieval", out)
        self.assertIn("**Source: Deck Two.pdf**", out)

    def test_a_week_label_is_a_number_when_the_week_is_one(self):
        self.assertEqual((ms._week_label("w4"), ms._week_label("syllabus"), ms._week_label("")), ("week 4", "syllabus", ""))


if __name__ == "__main__":
    unittest.main()
