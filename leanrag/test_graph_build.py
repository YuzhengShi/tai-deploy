"""leanrag/graph_build.py: aggregation, clustering and the artifact. The clustering needs numpy and scikit-learn (the agent image has both; the tests that use them are
skipped where they are missing). The model that names clusters is a scripted fake. What is pinned: the same answers give the same ids, every entity lands in one cluster
and every cluster in one theme, a model that fails still leaves named groups, the artifact is JSON (no pickle) and holds no key, and a synthetic graph is never published.
Run: python leanrag/test_graph_build.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.dont_write_bytecode = True

from leanrag import graph_build as gb  # noqa: E402
from leanrag import graph_extract as ge  # noqa: E402
from leanrag.corpus import Chunk, Corpus  # noqa: E402
from leanrag.llm import Completion, FatalLlmError, LlmError  # noqa: E402

try:
    import numpy  # noqa: F401
    import sklearn  # noqa: F401
    HAVE_ML = True
except ImportError:
    HAVE_ML = False


def parsed(entities, relations=(), unit_id="u:d00:p001"):
    unit = ge.Unit(unit_id, "slide", "Deck", ["d00:p001"], [1], {1: "d00:p001"}, "text", "text")
    p = ge.Parsed(entities=[{"name": n, "key": n.lower(), "type": t, "description": d, "chunks": c} for n, t, d, c in entities],
                  relations=[{"head": h, "relation": r, "tail": t, "chunks": c} for h, r, t, c in relations])
    return ge.UnitResult(unit, p)


class Aggregate(unittest.TestCase):
    def test_entities_merge_by_key_and_relations_count_the_units_that_said_them(self):
        results = [parsed([("Circuit Breaker", "pattern", "stops calls", ["d00:p001"]), ("Bulkhead", "pattern", "", ["d00:p002"])], [("circuit breaker", "COMPARED_WITH", "bulkhead", ["d00:p001"])]),
                   parsed([("circuit breaker", "pattern", "stops calls", ["d00:p003"]), ("Bulkhead", "other", "isolates pools", ["d00:p004"])], [("circuit breaker", "COMPARED_WITH", "bulkhead", ["d00:p003"])])]
        entities, relations = gb.aggregate(results)
        self.assertEqual([(e["id"], e["key"], e["name"], e["type"]) for e in entities], [("e0001", "bulkhead", "Bulkhead", "pattern"), ("e0002", "circuit breaker", "Circuit Breaker", "pattern")])
        self.assertEqual(entities[0]["desc"], "isolates pools")
        self.assertEqual(entities[1]["chunks"], ["d00:p001", "d00:p003"])
        self.assertEqual(relations, [{"h": "e0002", "r": "COMPARED_WITH", "t": "e0001", "w": 2, "chunks": ["d00:p001", "d00:p003"]}])

    def test_ids_do_not_depend_on_the_order_the_units_came_in(self):
        a = parsed([("zeta", "other", "", ["d00:p001"]), ("alpha", "other", "", ["d00:p001"])])
        b = parsed([("alpha", "other", "", ["d00:p002"])])
        first = gb.aggregate([a, b])[0]
        second = gb.aggregate([b, a])[0]
        self.assertEqual([(e["id"], e["key"]) for e in first], [(e["id"], e["key"]) for e in second])

    def test_a_unit_that_failed_adds_nothing(self):
        failed = ge.UnitResult(ge.Unit("u:x", "slide", "T", [], [], {}, "", ""), None)
        self.assertEqual(gb.aggregate([failed]), ([], []))


class Scripted:
    model = "scripted"

    def __init__(self, fail=False):
        self.fail, self.prompts = fail, []

    def complete_json(self, system, user, max_tokens=1500):
        self.prompts.append(system.split("\n", 1)[0])
        if self.fail:
            raise LlmError("down")
        if "name-cluster" in system:
            return Completion(text=json.dumps({"name": "Some group", "description": "About the group."}), model="scripted-1")
        return Completion(text=json.dumps({"relation": "enables"}), model="scripted-1")


class Labels(unittest.TestCase):
    def test_a_bundle_is_labelled_by_its_heaviest_type_and_by_the_second_only_when_that_is_close(self):
        self.assertEqual(gb._label([{"r": "USES", "w": 3}, {"r": "USES", "w": 1}, {"r": "PART_OF", "w": 1}]), "USES / PART_OF")    # 1 of 4 is a quarter: both
        self.assertEqual(gb._label([{"r": "USES", "w": 5}, {"r": "PART_OF", "w": 1}]), "USES")                                       # a fifth: the first only
        self.assertEqual(gb._label([{"r": "CAUSES", "w": 1}]), "CAUSES")

    def test_a_compound_label_counts_by_its_parts_and_the_label_is_never_longer_than_two_types(self):
        self.assertEqual(gb._label([{"r": "USES / PART_OF", "w": 2}, {"r": "PART_OF", "w": 3}]), "PART_OF / USES")
        many = [{"r": t, "w": 1} for t in ("CAUSES", "COMPARED_WITH", "USES", "CONTRASTS_WITH", "DEPENDS_ON", "EXAMPLE_OF", "PART_OF", "RELATED_TO")]
        label = gb._label(many)
        self.assertEqual(len(label.split(" / ")), 2)
        self.assertFalse(label.endswith((" ", "/", "_")))                       # not cut in the middle of a word, as a 60-character cut did

    def test_ties_break_alphabetically_so_a_rebuild_gives_the_same_label_whatever_order_the_relations_come_in(self):
        a = gb._label([{"r": "B", "w": 1}, {"r": "A", "w": 1}])
        b = gb._label([{"r": "A", "w": 1}, {"r": "B", "w": 1}])
        self.assertEqual((a, b), ("A / B", "A / B"))

    def test_a_relation_without_a_weight_counts_once(self):
        self.assertEqual(gb._label([{"r": "USES"}, {"r": "USES"}, {"r": "PART_OF"}]), "USES / PART_OF")


class Refuses:
    model = "refuses"

    def complete_json(self, system, user, max_tokens=1500):
        raise FatalLlmError("the plan's quota or balance is used up (code 1308)")


class NamingFailures(unittest.TestCase):
    members = [{"name": n, "desc": ""} for n in "abc"]

    def test_a_refusal_that_stops_everything_is_not_swallowed(self):
        with self.assertRaises(FatalLlmError):
            gb._name_group(Refuses(), self.members, "k001")
        entities = synthetic_entities(2, 4)
        a, b = [e["id"] for e in entities[:4]], [e["id"] for e in entities[4:]]
        rels = [{"h": a[i % 4], "r": "USES", "t": b[i % 4], "w": 1} for i in range(3)]
        group_of = {**{x: "k001" for x in a}, **{x: "k002" for x in b}}
        names = {"k001": {"name": "A", "desc": "a"}, "k002": {"name": "B", "desc": "b"}}
        with self.assertRaises(FatalLlmError):
            gb._cross_relations(rels, group_of, names, Refuses(), gb.BuildParams(tau=3), summarise=True)

    def test_one_failed_answer_falls_back_to_the_items_words_and_is_counted(self):
        stats: dict = {}
        name, desc = gb._name_group(Scripted(fail=True), self.members, "k001", stats)
        self.assertEqual((name, stats), ("a / b / c", {"name_fallbacks": 1}))
        stats = {}
        gb._name_group(Scripted(), self.members, "k001", stats)
        self.assertEqual(stats, {"name_calls": 1})

    def test_groups_of_two_or_fewer_are_not_counted_as_fallbacks_because_no_call_was_meant(self):
        stats: dict = {}
        gb._name_group(Scripted(), self.members[:2], "k001", stats)
        self.assertEqual(stats, {})

    def test_the_manifest_carries_the_naming_counts(self):
        m = gb.manifest_for(Corpus(chunks=[], now="2026-11-11T12:00:00Z"), ge.RunReport(), {"entities": [], "relations": [], "clusters": [], "cluster_relations": [], "themes": [], "theme_relations": []},
                            gb.BuildParams(), Scripted(), synthetic=False, usage={}, naming={"name_calls": 20, "name_fallbacks": 1})
        self.assertEqual(m["graph"]["naming"], {"name_calls": 20, "name_fallbacks": 1})


def synthetic_entities(n_topics=4, per_topic=8):
    """Entities whose names and descriptions share words within a topic, so that a clustering has something to find."""
    vocab = [("cache", "redis memory key value eviction hit miss"), ("thread", "mutex lock goroutine race scheduler"), ("commit", "prepare abort coordinator vote log"), ("monitor", "metric alarm dashboard alert threshold")]
    entities = []
    for t in range(n_topics):
        topic, words = vocab[t]
        w = words.split()
        for k in range(per_topic):
            name = f"{topic} {w[k % len(w)]} {k}"
            entities.append({"id": f"e{len(entities) + 1:04d}", "key": name, "name": name, "type": "concept", "desc": f"{topic} {w[(k + 1) % len(w)]} {w[(k + 2) % len(w)]}", "chunks": [f"d00:p{len(entities) + 1:03d}"]})
    return entities


@unittest.skipUnless(HAVE_ML, "numpy and scikit-learn are not installed here (the agent image has them)")
class Clustering(unittest.TestCase):
    def build(self, client):
        entities = synthetic_entities()
        relations = [{"h": entities[i]["id"], "r": "USES", "t": entities[(i + 9) % len(entities)]["id"], "w": 1, "chunks": []} for i in range(len(entities))]
        return entities, relations, gb.build_graph(entities, relations, client, gb.BuildParams(cluster_size=8))

    def test_every_entity_is_in_one_cluster_and_every_cluster_in_one_theme_and_the_ids_are_contiguous(self):
        entities, relations, graph = self.build(Scripted())
        in_cluster = [m for c in graph["clusters"] for m in c["members"]]
        self.assertEqual(sorted(in_cluster), sorted(e["id"] for e in entities))
        self.assertEqual(len(in_cluster), len(set(in_cluster)))
        self.assertEqual(sorted(c["id"] for c in graph["clusters"]), [f"k{n:03d}" for n in range(1, len(graph["clusters"]) + 1)])
        in_theme = [m for t in graph["themes"] for m in t["members"]]
        self.assertEqual(sorted(in_theme), sorted(c["id"] for c in graph["clusters"]))
        for e in graph["entities"]:
            self.assertIn(e["id"], next(c for c in graph["clusters"] if c["id"] == e["cluster"])["members"])
        for c in graph["clusters"]:
            self.assertIn(c["id"], next(t for t in graph["themes"] if t["id"] == c["theme"])["members"])

    def test_a_cluster_is_mostly_one_topic_when_the_words_say_so(self):
        entities, _, graph = self.build(Scripted())
        topic = {e["id"]: e["name"].split()[0] for e in entities}
        purity = sum(max(sum(1 for m in c["members"] if topic[m] == t) for t in set(topic.values())) for c in graph["clusters"]) / len(entities)
        self.assertGreaterEqual(purity, 0.8)

    def test_the_same_input_gives_the_same_graph(self):
        a = self.build(Scripted())[2]
        b = self.build(Scripted())[2]
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))

    def test_a_model_that_is_down_still_leaves_named_groups(self):
        _, _, graph = self.build(Scripted(fail=True))
        for group in graph["clusters"] + graph["themes"]:
            self.assertTrue(group["name"])
            self.assertTrue(group["desc"])
        self.assertTrue(all(r["r"] for r in graph["cluster_relations"]))

    def test_theme_and_cluster_relation_labels_are_whole_short_labels(self):
        _, _, graph = self.build(Scripted(fail=True))                         # no model label: the labels come from the member relations' own types
        for r in graph["cluster_relations"] + graph["theme_relations"]:
            self.assertLessEqual(len(r["r"].split(" / ")), 2, r)
            self.assertFalse(r["r"].endswith((" ", "/", "_")), r)

    def test_the_build_reports_how_many_names_the_model_gave_and_how_many_fell_back(self):
        stats: dict = {}
        entities = synthetic_entities()
        relations = [{"h": entities[i]["id"], "r": "USES", "t": entities[(i + 9) % len(entities)]["id"], "w": 1, "chunks": []} for i in range(len(entities))]
        graph = gb.build_graph(entities, relations, Scripted(), gb.BuildParams(cluster_size=8), stats=stats)
        self.assertGreaterEqual(stats["name_calls"], len(graph["clusters"]))
        self.assertEqual(stats.get("name_fallbacks", 0), 0)
        down: dict = {}
        gb.build_graph(synthetic_entities(), relations, Scripted(fail=True), gb.BuildParams(cluster_size=8), stats=down)
        self.assertGreater(down["name_fallbacks"], 0)
        self.assertNotIn("name_calls", down)

    def test_a_group_of_two_or_fewer_is_not_sent_to_the_model(self):
        client = Scripted()
        gb._name_group(client, [{"name": "a", "desc": ""}, {"name": "b", "desc": ""}], "k001")
        self.assertEqual(client.prompts, [])
        gb._name_group(client, [{"name": n, "desc": ""} for n in "abc"], "k001")
        self.assertEqual(len(client.prompts), 1)

    def test_cross_cluster_relations_are_summarised_by_the_model_only_from_the_threshold_up(self):
        entities = synthetic_entities(2, 4)
        a, b = [e["id"] for e in entities[:4]], [e["id"] for e in entities[4:]]
        rels = [{"h": a[i % 4], "r": "USES", "t": b[i % 4], "w": 1} for i in range(3)] + [{"h": b[0], "r": "REQUIRES", "t": a[1], "w": 1}]
        group_of = {**{x: "k001" for x in a}, **{x: "k002" for x in b}}
        names = {"k001": {"name": "A", "desc": "a"}, "k002": {"name": "B", "desc": "b"}}
        client = Scripted()
        out = gb._cross_relations(rels, group_of, names, client, gb.BuildParams(tau=3), summarise=True)
        by = {(r["h"], r["t"]): r for r in out}
        self.assertEqual(by[("k001", "k002")]["w"], 3)
        self.assertEqual(by[("k001", "k002")]["r"], "ENABLES")          # 3 >= tau: the model's label
        self.assertEqual(by[("k002", "k001")]["r"], "REQUIRES")         # 1 < tau: the relation's own type
        self.assertEqual(len(client.prompts), 1)


class Artifact(unittest.TestCase):
    def graph(self):
        return {"format": 1, "entities": [], "relations": [], "clusters": [], "cluster_relations": [], "themes": [], "theme_relations": []}

    def test_the_artifact_is_three_json_files_and_a_synthetic_one_is_never_published(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            chunk = Chunk("d00:p001", "slide", "Deck.pdf", "Deck", "w1", 1, "2026-09-07", "Head", "Head\nbody text of the slide")
            corpus = Corpus(chunks=[chunk], now="2026-11-11T12:00:00Z")
            manifest = gb.manifest_for(corpus, ge.RunReport(), self.graph(), gb.BuildParams(), Scripted(), synthetic=True, usage={"calls": 1})
            built = gb.write_artifact(root / "builds" / "x", [chunk], self.graph(), manifest)
            self.assertEqual(sorted(p.name for p in built.iterdir()), ["chunks.jsonl", "graph.json", "manifest.json"])
            self.assertEqual(json.loads((built / "chunks.jsonl").read_text().splitlines()[0])["page"], 1)
            with self.assertRaises(ValueError):
                gb.publish(built, root)
            self.assertFalse((root / "current").exists())

    def test_publishing_keeps_the_previous_graph_and_replaces_the_current_one(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            for tag in ("one", "two", "three"):
                d = gb.write_artifact(root / "builds" / tag, [], self.graph(), {"format": 1, "synthetic": False, "tag": tag})
                gb.publish(d, root)
                self.assertEqual(json.loads((root / "current" / "manifest.json").read_text())["tag"], tag)
            self.assertEqual(json.loads((root / "previous" / "manifest.json").read_text())["tag"], "two")

    def test_the_manifest_records_the_corpus_the_model_and_the_dropped_counts_and_no_key(self):
        with tempfile.TemporaryDirectory():
            corpus = Corpus(chunks=[], now="2026-11-11T12:00:00Z", files={"weeks.json": {"bytes": 3, "sha256": "ab" * 32}}, decks=[{"file": "A.pdf"}])
            client = Scripted()
            m = gb.manifest_for(corpus, ge.RunReport(), self.graph(), gb.BuildParams(), client, synthetic=False, usage={"calls": 2, "models_returned": {"DeepSeek-V4.1-Flash-1017": 2}})
            text = json.dumps(m)
            self.assertEqual(m["extraction"]["prompt_version"], ge.PROMPT_VERSION)
            self.assertEqual(m["extraction"]["model_asked"], "scripted")
            self.assertEqual(m["llm_usage"]["models_returned"], {"DeepSeek-V4.1-Flash-1017": 2})
            self.assertEqual(m["corpus"]["files"]["weeks.json"]["sha256"], "ab" * 32)
            self.assertEqual(m["params"]["cluster_size"], 20)
            for forbidden in ("sk-", "Bearer", "api_key", "Authorization"):
                self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
