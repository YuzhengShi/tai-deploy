"""leanrag/query.py: with the graph switch off the tool answers exactly as it did before this work. The switch is the host's: it mounts a built graph and the container hands the
MCP server LEANRAG_GRAPH_DIR (src/leanrag-graph.ts, container/agent-runner/src/mcp-servers.ts); without that variable nothing of the graph engine runs. And a graph that cannot be read
must not take the tool down: it answers from the stand-in as before.
Run: python leanrag/test_off_switch.py   (needs boto3, networkx and numpy, which leanrag/query.py imports and the agent image has)
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.dont_write_bytecode = True

try:
    from leanrag import query as q
except ImportError:
    q = None

from leanrag.fixture_artifact import write_fixture  # noqa: E402

CORPUS = [{"kind": "slides", "title": "Day 4", "where": "slides 12-13", "text": "Raft elects a leader among replicas.", "week": "w4"},
          {"kind": "slides", "title": "Day 5", "where": "slides 31", "text": "A load balancer spreads requests across servers.", "week": "w5"}]


@unittest.skipIf(q is None, "boto3, networkx or numpy is not installed here (the agent image has them)")
class Switch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "stub_corpus.json").write_text(json.dumps(CORPUS), encoding="utf-8")
        self.saved_dir, q._LEANRAG_DIR = q._LEANRAG_DIR, self.root
        os.environ.pop("LEANRAG_GRAPH_DIR", None)

    def tearDown(self):
        q._LEANRAG_DIR = self.saved_dir
        os.environ.pop("LEANRAG_GRAPH_DIR", None)
        self.tmp.cleanup()

    def stub(self, question):
        from leanrag.stub_query import query_stub
        return query_stub(self.root / "stub_corpus.json", question, difficulty="auto", top_k=10)

    def test_off_the_stand_in_answers_and_nothing_of_the_graph_engine_is_imported(self):
        sys.modules.pop("leanrag.graph_query", None)
        result = q.query_knowledge("how does raft elect a leader")
        self.assertEqual(result, self.stub("how does raft elect a leader"))
        self.assertNotIn("engine", result)
        self.assertNotIn("leanrag.graph_query", sys.modules)

    def test_an_empty_variable_is_off_too(self):
        os.environ["LEANRAG_GRAPH_DIR"] = ""
        self.assertEqual(q.query_knowledge("load balancer"), self.stub("load balancer"))

    def test_on_the_graph_answers(self):
        os.environ["LEANRAG_GRAPH_DIR"] = str(write_fixture(self.root / "graph"))
        result = q.query_knowledge("stateless services", difficulty="auto", top_k=5)
        self.assertEqual(result["engine"], "graph")
        self.assertEqual(result["source_texts"][0]["deck"], "Deck Two.pdf")

    def test_a_graph_that_cannot_be_read_falls_back_to_the_stand_in_without_an_error(self):
        for broken in (self.root / "nothing-here", write_fixture(self.root / "synthetic", synthetic=True)):
            os.environ["LEANRAG_GRAPH_DIR"] = str(broken)
            with self.assertLogs("leanrag.query", level="WARNING") as logs:
                result = q.query_knowledge("load balancer")
            self.assertEqual(result, self.stub("load balancer"))
            self.assertIn("graph engine unavailable", logs.output[0])


if __name__ == "__main__":
    unittest.main()
