"""leanrag/text.py: the words the graph engine searches with. The stemmer must give what the course library's own stemmer gives (src/docs/library-search.ts
`stem`), so that a comparison of the two searches is not a comparison of two stemmers.
Run: python leanrag/test_text.py   (standard library only)
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.dont_write_bytecode = True

from leanrag.text import Bm25, normalize, stem, terms  # noqa: E402

# Generated on 2026-11-11 by running `stem(normalize(word))` of src/docs/library-search.ts over these words (tsx), and copied here.
TS_STEMS = {"304": "304", "replicas": "replica", "replication": "replicat", "replicated": "replicat", "replicate": "replicat", "balancing": "balanc", "balancers": "balancer", "balancer": "balancer", "caches": "cach", "caching": "cach", "cached": "cach", "stateful": "stateful", "stateless": "stateless", "consistency": "consistency", "processes": "process", "process": "process", "classes": "class", "class": "class", "boxes": "box", "box": "box", "buses": "bus", "bus": "bus", "queries": "query", "query": "query", "queue": "queu", "queues": "queu", "queueing": "queu", "goroutines": "goroutin", "goroutine": "goroutin", "threads": "thread", "thread": "thread", "scaling": "scal", "scaled": "scal", "scales": "scal", "scalable": "scalabl", "scalability": "scalability", "observability": "observability", "monitoring": "monitor", "monitors": "monitor", "alarms": "alarm", "alarm": "alarm", "dashboards": "dashboard", "dashboard": "dashboard", "commit": "commit", "commits": "commit", "committed": "committ", "committing": "committ", "coordinator": "coordinator", "coordinators": "coordinator", "crashes": "crash", "crashed": "crash", "crashing": "crash", "transactions": "transact", "transaction": "transact", "partitions": "partit", "partitioned": "partit", "partitioning": "partit", "services": "servic", "service": "servic", "microservices": "microservic", "microservice": "microservic", "consensus": "consensus", "protocols": "protocol", "protocol": "protocol", "failures": "failur", "failure": "failur", "failing": "fail", "failed": "fail", "breaker": "breaker", "breakers": "breaker", "bulkheads": "bulkhead", "bulkhead": "bulkhead", "timeouts": "timeout", "timeout": "timeout", "retries": "retry", "retry": "retry", "retried": "retri", "latency": "latency", "latencies": "latency", "throughput": "throughput", "bandwidth": "bandwidth", "analysis": "analysis", "databases": "databas", "database": "databas", "indexes": "index", "index": "index", "indices": "indic", "ies": "ies", "ing": "ing", "ed": "ed", "ion": "ion", "sses": "ss", "ches": "che", "xes": "xes", "zes": "zes", "ses": "ses", "is": "is", "us": "us", "os": "os", "gas": "gas", "lens": "len", "lies": "lie", "pies": "pie", "tries": "try", "dies": "die", "ties": "tie", "series": "sery", "species": "specy", "addition": "addit", "additions": "addit", "conditions": "condit", "connection": "connect", "connections": "connect", "configuration": "configurat", "configurations": "configurat", "authentication": "authenticat", "authorization": "authorizat", "invalidation": "invalidat", "validation": "validat", "ending": "end", "shipping": "shipp", "running": "runn", "swimming": "swimm", "hopping": "hopp", "hoped": "hop", "hoping": "hop", "tapped": "tapp", "tapping": "tapp", "used": "used", "using": "using", "uses": "use", "user": "user", "users": "user", "cache-aside": "cache asid", "write-through": "write through", "read-through": "read through", "etag": "etag", "etags": "etag", "http": "http", "https": "http"}


class StemParity(unittest.TestCase):
    def test_every_word_stems_as_the_typescript_stemmer_does(self):
        wrong = {w: (want, stem(normalize(w))) for w, want in TS_STEMS.items() if stem(normalize(w)) != want}
        self.assertEqual(wrong, {})
        self.assertEqual(len(TS_STEMS), 140)


class Normalising(unittest.TestCase):
    def test_letters_and_digits_only_lower_case_single_spaces(self):
        self.assertEqual(normalize("  Two-Phase   Commit (2PC)!  "), "two phase commit 2pc")

    def test_accents_ligatures_and_soft_hyphens_do_not_break_words(self):
        self.assertEqual(normalize("Café ﬁnish scal­able"), "cafe finish scalable")

    def test_terms_drop_stop_words_and_one_letter_words_but_keep_digits(self):
        self.assertEqual(terms("How does the circuit breaker work with 2 services?"), ["circuit", "breaker", "work", "2", "servic"])
        self.assertEqual(terms("What is a load balancer", drop_stop=False), ["what", "is", "load", "balancer"])

    def test_terms_keep_repeats_in_order(self):
        self.assertEqual(terms("cache cache aside"), ["cach", "cach", "asid"])


class Ranking(unittest.TestCase):
    def test_a_rarer_term_counts_more_and_scores_only_documents_that_share_a_term(self):
        docs = [terms("circuit breaker pattern"), terms("bulkhead pattern pools"), terms("pattern pattern pattern")]
        bm = Bm25(docs)
        scores = bm.scores(terms("circuit pattern"))
        self.assertEqual(set(scores), {0, 1, 2})
        self.assertGreater(scores[0], scores[1])
        self.assertGreater(scores[0], scores[2])
        self.assertEqual(bm.scores(terms("nothing here")), {})

    def test_an_empty_index_answers_nothing(self):
        self.assertEqual(Bm25([]).scores(["x"]), {})


if __name__ == "__main__":
    unittest.main()
