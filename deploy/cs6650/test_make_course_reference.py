"""deploy/cs6650/make_course_reference.py: the term's course reference from the pages the world publishes. Run: python deploy/cs6650/test_make_course_reference.py"""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('make_course_reference', HERE / 'make_course_reference.py')
mcr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mcr)

WEEKS = {
    'course': 'CS6650 Fall', 'term': 'Fall 2026', 'weeks': {
        'syllabus': {'n': None, 'title': 'Syllabus', 'items': [{'kind': 'doc', 'title': 'Syllabus'}]},
        'w2': {'n': 2, 'title': 'Containers | and <b>more</b>', 'items': [{'kind': 'hw', 'title': 'Homework 2', 'id': 22}, {'kind': 'slides', 'title': 'Day 2.pdf'}]},
        'w1': {'n': 1, 'title': 'Intro to Go', 'items': [{'kind': 'video', 'title': 'Day 1 video'}]},
        'mastery': {'n': None, 'title': 'Mastery Hall', 'items': [{'kind': 'note', 'title': 'Final Mastery', 'text': 'Week of 12/07'}]},
    },
}
HOMEWORK = {'22': {'name': 'Homework 2: MapReduce', 'due_at': '2026-09-28T16:00:00Z', 'unlock_at': '2026-09-21T16:00:00Z', 'student_visible': True},
            '23': {'name': 'Hidden draft', 'due_at': '2026-10-01T16:00:00Z', 'student_visible': False}}
SYLLABUS = {'title': 'Syllabus', 'html': '<h2>Grading</h2><p>Homework &amp; mastery.</p><script>alert(1)</script><p>Office hours</p>'}


class ReferenceTest(unittest.TestCase):
    def test_weeks_in_order_with_their_homework_and_due_dates(self):
        text = mcr.build(WEEKS, HOMEWORK, SYLLABUS, datetime(2026, 11, 2, tzinfo=timezone.utc))
        self.assertLess(text.index('| 1 | Intro to Go |'), text.index('| 2 | Containers'))
        self.assertIn('Homework 2 (due Mon Sep 28 2026 16:00 UTC)', text)
        self.assertIn('slides: Day 2.pdf', text)
        self.assertIn('- Homework 2: MapReduce: due Mon Sep 28 2026 16:00 UTC (opens Mon Sep 21 2026 16:00 UTC)', text)
        self.assertNotIn('Hidden draft', text)
        self.assertIn('- Final Mastery: Week of 12/07', text)

    def test_the_marker_tai_live_looks_for_is_there(self):
        text = mcr.build(WEEKS, HOMEWORK, SYLLABUS, datetime(2026, 11, 2, tzinfo=timezone.utc))
        self.assertIn('Generated from the pages the course publishes', text)               # tai_live.sh ensure_reference greps for this
        self.assertIn('Generated from the pages the course publishes', (HERE / 'tai_live.sh').read_text(encoding='utf-8'))

    def test_markup_and_table_edges_from_the_pages_are_flattened(self):
        text = mcr.build(WEEKS, HOMEWORK, SYLLABUS, datetime(2026, 11, 2, tzinfo=timezone.utc))
        row = [l for l in text.split('\n') if l.startswith('| 2 |')][0]
        self.assertEqual(row.count('|'), 5)
        self.assertNotIn('<b>', text)
        self.assertNotIn('alert(1)', text)
        self.assertIn('Homework & mastery.', text)

    def test_writes_the_file_whole_or_not_at_all(self):
        with tempfile.TemporaryDirectory() as tmp:
            pages = Path(tmp) / 'pages'
            pages.mkdir()
            out = Path(tmp) / 'out' / 'COURSE_REFERENCE.md'
            out.parent.mkdir()
            out.write_text('the old one', encoding='utf-8')
            bad = subprocess.run([sys.executable, str(HERE / 'make_course_reference.py'), str(pages), str(out)], capture_output=True, text=True)
            self.assertEqual(bad.returncode, 1)
            self.assertEqual(out.read_text(encoding='utf-8'), 'the old one')
            (pages / 'weeks.json').write_text(json.dumps(WEEKS), encoding='utf-8')
            (pages / 'homework.json').write_text(json.dumps(HOMEWORK), encoding='utf-8')
            (pages / 'syllabus.json').write_text(json.dumps(SYLLABUS), encoding='utf-8')
            # a page set with no numbered week is no reference: the old file stays
            empty = Path(tmp) / 'empty'
            empty.mkdir()
            (empty / 'weeks.json').write_text(json.dumps({'weeks': {}}), encoding='utf-8')
            (empty / 'homework.json').write_text('{}', encoding='utf-8')
            (empty / 'syllabus.json').write_text('{}', encoding='utf-8')
            self.assertEqual(subprocess.run([sys.executable, str(HERE / 'make_course_reference.py'), str(empty), str(out)], capture_output=True, text=True).returncode, 1)
            self.assertEqual(out.read_text(encoding='utf-8'), 'the old one')


if __name__ == '__main__':
    unittest.main()
