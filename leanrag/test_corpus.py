"""leanrag/corpus.py: what the graph is built from. The rules under test are the ones that keep the graph from knowing more than a student may:
an unreleased week, a hidden or still-locked assignment and an instructor-notes marker never get in; a slide keeps its number.
A fake pages folder and a fake PDF reader stand in for the course world's files; one test makes a real PDF if PyMuPDF is installed (the agent image has it).
Run: python leanrag/test_corpus.py
"""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.dont_write_bytecode = True

from leanrag import corpus as cp  # noqa: E402

NOW = dt.datetime(2026, 11, 11, 12, 0, tzinfo=dt.timezone.utc)
LONG = "x" * 40


def pages_folder(tmp: Path, weeks: dict, homework: dict | None = None, syllabus: dict | None = None, decks: list[str] = ()) -> Path:
    (tmp / "materials-fall2026").mkdir(parents=True, exist_ok=True)
    (tmp / "weeks.json").write_text(json.dumps({"weeks": weeks}), encoding="utf-8")
    (tmp / "homework.json").write_text(json.dumps(homework or {}), encoding="utf-8")
    (tmp / "syllabus.json").write_text(json.dumps(syllabus or {"title": "Syllabus", "html": ""}), encoding="utf-8")
    (tmp / "page-config.json").write_text(json.dumps({"term": "Fall 2026", "released_weeks": "auto"}), encoding="utf-8")
    for name in decks:
        (tmp / "materials-fall2026" / name).write_bytes(b"%PDF fake")
    return tmp


def reader(table: dict):
    return lambda path: table[Path(path).name]


class Released(unittest.TestCase):
    def test_a_released_week_gives_its_slides_with_their_numbers_and_an_unreleased_week_gives_nothing(self):
        with tempfile.TemporaryDirectory() as t:
            weeks = {"w1": {"n": 1, "start": "2026-09-07", "released": True, "items": [{"kind": "slides", "title": "Deck A.pdf", "file": "A.pdf"}]},
                     "w9": {"n": 9, "start": "2026-11-02", "released": False, "items": [{"kind": "slides", "title": "Deck B.pdf", "file": "B.pdf"}]}}
            folder = pages_folder(Path(t), weeks, decks=["A.pdf", "B.pdf"])
            c = cp.load_corpus(folder, NOW, pages_reader=reader({"A.pdf": ["1\nIntro slide " + LONG, "", "3\nThird slide " + LONG], "B.pdf": ["1\nSecret " + LONG]}))
            self.assertEqual([(x.id, x.page, x.week, x.visible_from) for x in c.chunks], [("d00:p001", 1, "w1", "2026-09-07"), ("d00:p003", 3, "w1", "2026-09-07")])
            self.assertEqual(c.decks, [{"file": "A.pdf", "title": "Deck A", "week": "w1", "pages": 3, "chunks": 2}])
            self.assertFalse(any("Secret" in x.text for x in c.chunks))
            self.assertTrue(any("B.pdf" in w for w in c.warnings), c.warnings)     # a deck in the folder that no released week names is said, not read

    def test_a_slide_with_almost_no_text_is_not_a_chunk_but_its_number_is_still_counted(self):
        with tempfile.TemporaryDirectory() as t:
            weeks = {"w1": {"n": 1, "start": "2026-09-07", "items": [{"kind": "slides", "file": "A.pdf"}]}}
            c = cp.load_corpus(pages_folder(Path(t), weeks, decks=["A.pdf"]), NOW, pages_reader=reader({"A.pdf": ["tiny", "2\nA real slide " + LONG]}))
            self.assertEqual([x.page for x in c.chunks], [2])
            self.assertEqual(c.decks[0]["pages"], 2)

    def test_the_heading_is_the_first_line_that_is_not_only_a_number(self):
        self.assertEqual(cp.slide_heading("12\nLoad Balancers\n- one"), "Load Balancers")
        self.assertEqual(cp.slide_heading("12"), "")

    def test_the_deck_title_is_the_stand_ins_rule_without_pdf_and_with_spaces(self):
        self.assertEqual(cp.deck_title({"title": "Day_5_APIs.pdf", "file": "x.pdf"}), "Day 5 APIs")
        self.assertEqual(cp.deck_title({"file": "Goroutines in brief.pdf"}), "Goroutines in brief")


class Assignments(unittest.TestCase):
    def setUp(self):
        self.weeks = {"w2": {"n": 2, "start": "2026-09-14", "released": True, "items": [
            {"kind": "hw", "id": 1, "title": "Open"}, {"kind": "hw", "id": 2, "title": "Hidden"}, {"kind": "hw", "id": 3, "title": "Locked"}, {"kind": "hw", "id": 4, "title": "Unknown to homework.json"}]}}
        self.homework = {"1": {"name": "Homework 1", "description": "<p>Build a <b>thing</b>.</p><p>Second paragraph.</p>", "due_at": "2026-09-21T16:00:00Z"},
                         "2": {"name": "Homework 2", "description": "<p>hidden text</p>", "student_visible": False},
                         "3": {"name": "Homework 3", "description": "<p>locked text</p>", "unlock_at": "2026-11-12T00:00:00Z"}}

    def test_a_hidden_a_locked_and_an_unknown_assignment_are_not_read_and_an_open_one_is_text_without_html(self):
        with tempfile.TemporaryDirectory() as t:
            c = cp.load_corpus(pages_folder(Path(t), self.weeks, self.homework), NOW)
            texts = [x.text for x in c.chunks]
            self.assertEqual(len(c.chunks), 1)
            self.assertIn("Build a thing", texts[0])          # (the stand-in's HTML rule puts a space where a tag was: "thing .")
            self.assertIn("Second paragraph.", texts[0])
            self.assertNotIn("<p>", texts[0])
            self.assertNotIn("<b>", texts[0])
            self.assertEqual((c.chunks[0].kind, c.chunks[0].title), ("homework", "Homework 1 (due 2026-09-21T16:00:00Z)"))
            self.assertFalse(any("hidden text" in x or "locked text" in x for x in texts))

    def test_the_clock_decides_what_is_unlocked(self):
        with tempfile.TemporaryDirectory() as t:
            folder = pages_folder(Path(t), self.weeks, self.homework)
            later = dt.datetime(2026, 11, 12, 0, 0, 1, tzinfo=dt.timezone.utc)
            c = cp.load_corpus(folder, later)
            self.assertTrue(any("locked text" in x.text for x in c.chunks))
            self.assertEqual([x.visible_from for x in c.chunks if "locked text" in x.text], ["2026-11-12T00:00:00Z"])

    def test_the_syllabus_is_chunked_from_its_html(self):
        with tempfile.TemporaryDirectory() as t:
            c = cp.load_corpus(pages_folder(Path(t), {}, syllabus={"title": "Syllabus", "html": "<h1>Grades</h1><p>Homework counts 50 percent.</p>"}), NOW)
            self.assertEqual([(x.id, x.kind, x.week) for x in c.chunks], [("syl:0", "syllabus", "syllabus")])
            self.assertIn("Homework counts 50 percent.", c.chunks[0].text)


class Refusals(unittest.TestCase):
    def test_an_instructor_notes_marker_stops_the_build(self):
        for marker in ("REFSOL", "INSTRUCTOR NOTES"):
            with tempfile.TemporaryDirectory() as t:
                weeks = {"w1": {"n": 1, "start": "2026-09-07", "items": [{"kind": "slides", "file": "A.pdf"}]}}
                with self.assertRaises(cp.CorpusError):
                    cp.load_corpus(pages_folder(Path(t), weeks, decks=["A.pdf"]), NOW, pages_reader=reader({"A.pdf": [f"1\n{marker} do not ship " + LONG]}))

    def test_a_missing_weeks_file_is_an_error_in_words(self):
        with tempfile.TemporaryDirectory() as t:
            with self.assertRaises(cp.CorpusError):
                cp.load_corpus(Path(t), NOW)

    def test_the_files_the_corpus_was_read_from_are_fingerprinted(self):
        with tempfile.TemporaryDirectory() as t:
            weeks = {"w1": {"n": 1, "start": "2026-09-07", "items": [{"kind": "slides", "file": "A.pdf"}]}}
            c = cp.load_corpus(pages_folder(Path(t), weeks, decks=["A.pdf"]), NOW, pages_reader=reader({"A.pdf": ["1\nA " + LONG]}))
            self.assertEqual(set(c.files), {"weeks.json", "homework.json", "syllabus.json", "page-config.json", "materials-fall2026/A.pdf"})
            self.assertEqual(len(c.files["weeks.json"]["sha256"]), 64)
            self.assertEqual(c.page_config["term"], "Fall 2026")


class RealPdf(unittest.TestCase):
    def test_a_real_pdf_is_read_page_by_page(self):
        try:
            import pymupdf
        except ImportError:
            self.skipTest("PyMuPDF is not installed here (the agent image has it)")
        with tempfile.TemporaryDirectory() as t:
            doc = pymupdf.open()
            for text in ("First slide about caching", "Second slide about load balancers"):
                doc.new_page().insert_text((72, 72), text)
            path = Path(t) / "x.pdf"
            doc.save(str(path))
            doc.close()
            pages = cp.deck_pages(path)
            self.assertEqual(len(pages), 2)
            self.assertIn("caching", pages[0])
            self.assertIn("load balancers", pages[1])


if __name__ == "__main__":
    unittest.main()
