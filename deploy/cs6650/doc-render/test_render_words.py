"""deploy/cs6650/doc-render/render-words.py: pdftotext's -bbox-layout output in, one words file for each page out.
Run: python deploy/cs6650/doc-render/test_render_words.py

The first fixture is what poppler 25.03 (the renderer image's) really printed for a three page PDF made for the purpose: page 1 has two lines with "Alpha" at (72, 700) points of a letter
page, page 2 is turned a quarter (/Rotate 90) and page 3 has a crop box of 400 x 300 points. Everything the script reads comes from a file nobody trusts, so the rest of the cases are the
ways such a file can be odd: entities, numbers that are not numbers, a page that is cut off, more words than a page may keep, lines that are far too long.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "render-words.py"

HEAD = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n</head>\n<body>\n<doc>\n'
TAIL = '</doc>\n</body>\n</html>\n'

REAL = HEAD + '''  <page width="612.000000" height="792.000000">
    <flow>
      <block xMin="72.000000" yMin="74.768000" xMax="276.096000" yMax="96.968000">
        <line xMin="72.000000" yMin="74.768000" xMax="276.096000" yMax="96.968000">
          <word xMin="72.000000" yMin="74.768000" xMax="133.368000" yMax="96.968000">Alpha</word>
          <word xMin="140.040000" yMin="74.768000" xMax="189.408000" yMax="96.968000">Beta</word>
          <word xMin="196.080000" yMin="74.768000" xMax="276.096000" yMax="96.968000">gamma</word>
        </line>
      </block>
    </flow>
    <flow>
      <block xMin="72.000000" yMin="183.384000" xMax="160.044000" yMax="194.484000">
        <line xMin="72.000000" yMin="183.384000" xMax="160.044000" yMax="194.484000">
          <word xMin="72.000000" yMin="183.384000" xMax="110.688000" yMax="194.484000">second</word>
          <word xMin="114.024000" yMin="183.384000" xMax="132.696000" yMax="194.484000">line</word>
          <word xMin="136.032000" yMin="183.384000" xMax="160.044000" yMax="194.484000">here</word>
        </line>
      </block>
    </flow>
  </page>
  <page width="612.000000" height="792.000000">
    <flow>
      <block xMin="695.032000" yMin="72.000000" xMax="717.232000" yMax="286.776000">
        <line xMin="695.032000" yMin="72.000000" xMax="717.232000" yMax="286.776000">
          <word xMin="695.032000" yMin="72.000000" xMax="717.232000" yMax="156.048000">Rotated</word>
          <word xMin="695.032000" yMin="162.720000" xMax="717.232000" yMax="216.096000">page</word>
          <word xMin="695.032000" yMin="222.768000" xMax="717.232000" yMax="286.776000">words</word>
        </line>
      </block>
    </flow>
  </page>
  <page width="400.000000" height="300.000000">
    <flow>
      <block xMin="72.000000" yMin="82.768000" xMax="234.720000" yMax="104.968000">
        <line xMin="72.000000" yMin="82.768000" xMax="234.720000" yMax="104.968000">
          <word xMin="72.000000" yMin="82.768000" xMax="164.040000" yMax="104.968000">Cropped</word>
          <word xMin="170.712000" yMin="82.768000" xMax="234.720000" yMax="104.968000">words</word>
        </line>
      </block>
    </flow>
  </page>
''' + TAIL


def word(x0, y0, x1, y1, text):
    return f'<word xMin="{x0}" yMin="{y0}" xMax="{x1}" yMax="{y1}">{text}</word>'


def page(words, width=600, height=800, lines=True):
    body = "\n".join(words)
    inner = f"<line xMin=\"0\" yMin=\"0\" xMax=\"1\" yMax=\"1\">\n{body}\n</line>" if lines else body
    return f'  <page width="{width}" height="{height}">\n<flow>\n<block>\n{inner}\n</block>\n</flow>\n  </page>\n'


class RenderWordsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name)

    def run_script(self, text, *args, raw=None, outdir=None):
        data = raw if raw is not None else text.encode("utf-8")
        argv = [sys.executable, "-I", str(SCRIPT), str(outdir or self.out), *args]
        done = subprocess.run(argv, input=data, capture_output=True, timeout=60)
        return done

    def words_file(self, number):
        return json.loads((self.out / f"w{number:03d}.json").read_text(encoding="utf-8"))

    def files(self):
        return sorted(p.name for p in self.out.iterdir())

    def test_the_real_output_of_three_pages_becomes_three_files_with_fractions_and_lines(self):
        done = self.run_script(REAL, "3", "0,90,0")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, b"")                                                    # it prints nothing
        self.assertEqual(self.files(), ["w001.json", "w002.json", "w003.json"])
        first = self.words_file(1)
        self.assertEqual([w[4] for w in first["words"]], ["Alpha", "Beta", "gamma", "second", "line", "here"])
        self.assertEqual(first["lines"], [[0, 2], [3, 5]])
        alpha = first["words"][0]
        self.assertEqual(alpha, [round(72 / 612, 4), round(74.768 / 792, 4), round(133.368 / 612, 4), round(96.968 / 792, 4), "Alpha"])
        for entry in first["words"]:                                                           # every number is a fraction of the page, four decimals at most
            for n in entry[:4]:
                self.assertTrue(0 <= n <= 1 and round(n, 4) == n, entry)
        cropped = self.words_file(3)
        self.assertEqual(cropped["words"][0][:4], [round(72 / 400, 4), round(82.768 / 300, 4), round(164.04 / 400, 4), round(104.968 / 300, 4)])   # the crop box's size, not the media box's

    def test_a_page_turned_a_quarter_is_measured_in_the_turned_frame(self):
        # pdftotext prints this page as 612 x 792 but its words are in the turned 792 x 612 frame (x up to 717)
        done = self.run_script(REAL, "3", "0,90,0")
        self.assertEqual(done.returncode, 0, done.stderr)
        turned = self.words_file(2)["words"]
        self.assertEqual(turned[0], [round(695.032 / 792, 4), round(72 / 612, 4), round(717.232 / 792, 4), round(156.048 / 612, 4), "Rotated"])
        self.assertTrue(all(w[2] < 1 for w in turned), "none of them is pushed against the edge")
        # told nothing about the turn, the same words run off the page and are clamped: this is what the list of rotations is for
        plain = tempfile.TemporaryDirectory()
        self.addCleanup(plain.cleanup)
        self.assertEqual(self.run_script(REAL, "3", outdir=plain.name).returncode, 0)
        clamped = json.loads((Path(plain.name) / "w002.json").read_text(encoding="utf-8"))["words"]
        self.assertTrue(all(w[0] == 1 for w in clamped))
        # 270 turns the same way; 180 and 0 do not change the size
        for rotation, swapped in (("270", True), ("180", False), ("0", False)):
            other = tempfile.TemporaryDirectory()
            self.addCleanup(other.cleanup)
            self.assertEqual(self.run_script(REAL, "3", f"0,{rotation},0", outdir=other.name).returncode, 0)
            got = json.loads((Path(other.name) / "w002.json").read_text(encoding="utf-8"))["words"][0]
            self.assertEqual(got[2] < 1, swapped, rotation)

    def test_entities_are_read_as_the_characters_they_stand_for(self):
        text = HEAD + page([word(10, 10, 50, 20, "R&amp;D"), word(60, 10, 90, 20, "a&lt;b"), word(100, 10, 140, 20, "it&#39;s"), word(150, 10, 190, 20, "&quot;q&quot;")]) + TAIL
        self.assertEqual(self.run_script(text, "1").returncode, 0)
        self.assertEqual([w[4] for w in self.words_file(1)["words"]], ["R&D", "a<b", "it's", '"q"'])

    def test_a_page_with_no_text_is_an_empty_list_and_a_word_that_is_not_text_is_dropped(self):
        text = HEAD + '  <page width="600.000000" height="800.000000">\n  </page>\n' + page([word(1, 1, 2, 2, "  "), word(3, 3, 4, 4, "kept")]) + TAIL
        self.assertEqual(self.run_script(text, "2").returncode, 0)
        self.assertEqual(self.words_file(1), {"words": [], "lines": []})
        self.assertEqual([w[4] for w in self.words_file(2)["words"]], ["kept"])

    def test_numbers_that_are_not_numbers_drop_the_word_and_a_size_that_is_not_a_size_drops_the_pages_words(self):
        text = (
            HEAD
            + page([word("nan", 1, 2, 3, "nan"), word("inf", 1, 2, 3, "inf"), word("1e999", 1, 2, 3, "huge"), word("x", 1, 2, 3, "text"), word(10, 10, 20, 20, "good")])
            + page([word(10, 10, 20, 20, "lost")], width="nan", height=800)
            + page([word(10, 10, 20, 20, "lost")], width=0, height=800)
            + page([word(10, 10, 20, 20, "lost")], width=-5, height=800)
            + TAIL
        )
        self.assertEqual(self.run_script(text, "4").returncode, 0)
        self.assertEqual([w[4] for w in self.words_file(1)["words"]], ["good"])
        for n in (2, 3, 4):
            self.assertEqual(self.words_file(n)["words"], [], n)

    def test_boxes_outside_the_page_are_clamped_not_dropped(self):
        text = HEAD + page([word(-50, -10, 700, 900, "wide")], width=600, height=800) + TAIL
        self.assertEqual(self.run_script(text, "1").returncode, 0)
        self.assertEqual(self.words_file(1)["words"], [[0, 0, 1, 1, "wide"]])

    def test_at_most_four_thousand_words_are_kept_and_the_lines_are_cut_to_match(self):
        many = [word(i % 500, 10, i % 500 + 1, 20, f"w{i}") for i in range(4005)]
        text = HEAD + '  <page width="600" height="800">\n' + "".join(f'<line xMin="0" yMin="0" xMax="1" yMax="1">\n{w}\n</line>\n' for w in many) + "  </page>\n" + TAIL
        self.assertEqual(self.run_script(text, "1").returncode, 0)
        got = self.words_file(1)
        self.assertEqual(len(got["words"]), 4000)
        self.assertEqual(got["lines"][-1], [3999, 3999])
        self.assertEqual(len(got["lines"]), 4000)
        # inside a line that crosses the cap the line stops at the cap
        crossing = HEAD + page([word(1, 1, 2, 2, f"c{i}") for i in range(4010)]) + TAIL
        out2 = tempfile.TemporaryDirectory()
        self.addCleanup(out2.cleanup)
        self.assertEqual(self.run_script(crossing, "1", outdir=out2.name).returncode, 0)
        got = json.loads((Path(out2.name) / "w001.json").read_text(encoding="utf-8"))
        self.assertEqual((len(got["words"]), got["lines"]), (4000, [[0, 3999]]))

    def test_pages_past_the_limit_are_not_written_and_an_input_cut_off_inside_a_page_keeps_what_was_read(self):
        three = HEAD + page([word(1, 1, 2, 2, "one")]) + page([word(1, 1, 2, 2, "two")]) + page([word(1, 1, 2, 2, "three")]) + TAIL
        self.assertEqual(self.run_script(three, "2").returncode, 0)
        self.assertEqual(self.files(), ["w001.json", "w002.json"])
        cut = tempfile.TemporaryDirectory()
        self.addCleanup(cut.cleanup)
        half = HEAD + page([word(1, 1, 2, 2, "one")]) + '  <page width="600" height="800">\n<flow>\n<block>\n<line>\n' + word(1, 1, 2, 2, "partial") + "\n"
        self.assertEqual(self.run_script(half, "5", outdir=cut.name).returncode, 0)
        self.assertEqual(sorted(p.name for p in Path(cut.name).iterdir()), ["w001.json", "w002.json"])
        self.assertEqual(json.loads((Path(cut.name) / "w002.json").read_text(encoding="utf-8"))["words"][0][4], "partial")

    def test_words_with_no_line_elements_have_no_lines_and_the_host_makes_them_from_the_boxes(self):
        text = HEAD + page([word(1, 1, 2, 2, "a"), word(3, 1, 4, 2, "b")], lines=False) + TAIL
        self.assertEqual(self.run_script(text, "1").returncode, 0)
        self.assertEqual(self.words_file(1)["lines"], [])
        self.assertEqual(len(self.words_file(1)["words"]), 2)

    def test_hostile_input_is_bounded_and_never_becomes_a_path_or_a_crash(self):
        evil = HEAD.encode() + b"\xff\xfe\x00\x80" * 50 + b"\n" + (b"x" * 300_000) + b"\n" + page([word(1, 1, 2, 2, "../../etc/passwd"), word(1, 1, 2, 2, "ok")]).encode() + TAIL.encode()
        done = self.run_script("", "1", raw=evil)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.files(), ["w001.json"])                                          # only the file it was told to write
        self.assertEqual([w[4] for w in self.words_file(1)["words"]], ["../../etc/passwd", "ok"])   # a word is text, never a name
        # a single line of a million bytes is read in pieces and ignored
        big = HEAD.encode() + b'<page width="600" height="800"><word xMin="1" yMin="1" xMax="2" yMax="2">' + b"A" * 1_000_000 + b"</word></page>\n"
        again = tempfile.TemporaryDirectory()
        self.addCleanup(again.cleanup)
        self.assertEqual(self.run_script("", "1", raw=big, outdir=again.name).returncode, 0)
        self.assertEqual(len(os.listdir(again.name)) <= 1, True)

    def test_a_directory_that_is_not_there_and_a_limit_that_is_not_a_number_are_refused(self):
        self.assertEqual(self.run_script(REAL, "3", outdir=self.out / "nope").returncode, 2)
        self.assertEqual(self.run_script(REAL, "many").returncode, 2)
        self.assertEqual(subprocess.run([sys.executable, "-I", str(SCRIPT)], input=b"", capture_output=True, timeout=30).returncode, 2)
        self.assertEqual(self.files(), [])


if __name__ == "__main__":
    unittest.main()
