"""deploy/cs6650/doc-render/office-kind.py: which kind of Office file a zip is, from the names of its entries alone.
Run: python deploy/cs6650/doc-render/test_office_kind.py

Everything the script reads is a file nobody trusts, so the cases are the ways such a file can be: the three kinds, an archive that is not Office, a package of two kinds, one with macros, one with
a part missing, no bytes, a file cut in the middle, a text file, too many entries, entries that declare far more than they hold, an entry marked encrypted, and a file whose data is damaged but whose
directory is not (the script must say what it is without ever reading an entry).
"""
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "office-kind.py"
TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'


class OfficeKindTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def package(self, name, entries):
        path = self.dir / name
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for entry, data in entries.items():
                archive.writestr(entry, data)
        return path

    def run_script(self, path, *extra):
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), str(path), *extra], capture_output=True, text=True, timeout=60)
        return result.returncode, result.stdout, result.stderr

    def patch_central(self, path, offset, fmt, value):
        """Sets a field of every record of the central directory (the signature PK 1 2) to `value`."""
        data = bytearray(Path(path).read_bytes())
        at = data.find(b"PK\x01\x02")
        while at != -1:
            struct.pack_into(fmt, data, at + offset, value)
            at = data.find(b"PK\x01\x02", at + 4)
        Path(path).write_bytes(bytes(data))

    def test_the_three_kinds_by_the_folder_of_their_parts_and_nothing_else_is_printed(self):
        for name, entries, kind in (
            ("a.pptx", {"[Content_Types].xml": TYPES, "ppt/presentation.xml": "<p/>", "ppt/slides/slide1.xml": "<s/>"}, "pptx"),
            ("a.docx", {"[Content_Types].xml": TYPES, "word/document.xml": "<w/>"}, "docx"),
            ("a.xlsx", {"[Content_Types].xml": TYPES, "xl/workbook.xml": "<x/>", "xl/worksheets/sheet1.xml": "<s/>"}, "xlsx"),
        ):
            code, out, err = self.run_script(self.package(name, entries))
            self.assertEqual((code, out, err), (0, kind + "\n", ""), name)

    def test_the_name_of_the_file_is_never_what_decides(self):
        # a deck under the name of a document, and under a neutral name: the entries say what it is
        path = self.package("report.docx", {"[Content_Types].xml": TYPES, "ppt/presentation.xml": "<p/>"})
        self.assertEqual(self.run_script(path)[:2], (0, "pptx\n"))
        neutral = self.dir / "source.bin"
        neutral.write_bytes(path.read_bytes())
        self.assertEqual(self.run_script(neutral)[:2], (0, "pptx\n"))

    def test_an_archive_that_is_not_an_office_file_is_refused_with_3(self):
        cases = {
            "plain.zip": {"readme.txt": "hello", "src/main.go": "package main"},
            "opendocument.odp": {"mimetype": "application/vnd.oasis.opendocument.presentation", "content.xml": "<c/>"},
            "no-types.pptx": {"ppt/presentation.xml": "<p/>"},
            "two-kinds.zip": {"[Content_Types].xml": TYPES, "word/document.xml": "<w/>", "ppt/presentation.xml": "<p/>"},
            "no-kind.zip": {"[Content_Types].xml": TYPES, "docProps/core.xml": "<c/>"},
        }
        for name, entries in cases.items():
            self.assertEqual(self.run_script(self.package(name, entries))[:2], (3, ""), name)

    def test_a_vba_project_or_a_macro_sheet_is_refused_with_6(self):
        for name, extra in (("macro.docx", "word/vbaProject.bin"), ("loud.pptx", "ppt/VBAPROJECT.BIN"), ("sheet.xlsx", "xl/macrosheets/sheet1.xml")):
            entries = {"[Content_Types].xml": TYPES, "word/document.xml": "<w/>", extra: "x"}
            self.assertEqual(self.run_script(self.package(name, entries))[:2], (6, ""), name)

    def test_a_package_whose_main_part_is_missing_is_damaged_not_another_kind(self):
        path = self.package("headless.pptx", {"[Content_Types].xml": TYPES, "ppt/slides/slide1.xml": "<s/>"})
        self.assertEqual(self.run_script(path)[:2], (7, ""))

    def test_no_bytes_a_text_file_and_a_cut_file_are_unreadable_with_7(self):
        empty = self.dir / "empty.pptx"
        empty.write_bytes(b"")
        text = self.dir / "text.pptx"
        text.write_text("This is plain text with a .pptx name. " * 20, encoding="utf-8")
        whole = self.package("whole.pptx", {"[Content_Types].xml": TYPES, "ppt/presentation.xml": "<p/>" * 400, "ppt/media/a.bin": os.urandom(4000)}).read_bytes()
        cut = self.dir / "cut.pptx"
        cut.write_bytes(whole[: len(whole) // 2])
        short = self.dir / "short.pptx"
        short.write_bytes(b"PK\x03\x04")
        for path in (empty, text, cut, short, self.dir / "not-there.pptx"):
            self.assertEqual(self.run_script(path)[:2], (7, ""), path.name)

    def test_more_entries_than_the_limit_are_refused_with_4_before_the_zip_module_reads_them(self):
        entries = {"[Content_Types].xml": TYPES, "ppt/presentation.xml": "<p/>"}
        entries.update({"ppt/media/part%d.xml" % i: "x" for i in range(3500)})
        self.assertEqual(self.run_script(self.package("many.pptx", entries))[:2], (4, ""))
        # exactly at the limit minus one is fine
        entries = {"[Content_Types].xml": TYPES, "ppt/presentation.xml": "<p/>"}
        entries.update({"ppt/media/part%d.xml" % i: "x" for i in range(2990)})
        self.assertEqual(self.run_script(self.package("fits.pptx", entries))[:2], (0, "pptx\n"))

    def test_a_directory_far_larger_than_its_entries_need_is_refused_with_4(self):
        path = self.package("fat.pptx", {"[Content_Types].xml": TYPES, "ppt/presentation.xml": "<p/>"})
        data = bytearray(path.read_bytes())
        at = data.rfind(b"PK\x05\x06")
        struct.pack_into("<I", data, at + 12, 50 * 1024 * 1024)  # the end record says the directory is 50 MB
        path.write_bytes(bytes(data))
        self.assertEqual(self.run_script(path)[:2], (4, ""))

    def test_entries_that_declare_far_more_than_they_hold_are_refused_with_5(self):
        one = self.package("one.pptx", {"[Content_Types].xml": TYPES, "ppt/presentation.xml": "<p/>"})
        self.patch_central(one, 24, "<I", 250 * 1024 * 1024)  # every entry declares 250 MB: each is over the limit of one entry
        self.assertEqual(self.run_script(one)[:2], (5, ""))
        many = self.package("many.docx", dict({"[Content_Types].xml": TYPES, "word/document.xml": "<w/>"}, **{"word/media/m%d.bin" % i: "x" for i in range(10)}))
        self.patch_central(many, 24, "<I", 100 * 1024 * 1024)  # each is allowed alone; twelve of them are 1.2 GB together
        self.assertEqual(self.run_script(many)[:2], (5, ""))

    def test_an_entry_marked_encrypted_is_refused_with_8(self):
        path = self.package("secret.docx", {"[Content_Types].xml": TYPES, "word/document.xml": "<w/>"})
        self.patch_central(path, 8, "<H", 1)
        self.assertEqual(self.run_script(path)[:2], (8, ""))

    def test_it_reads_the_names_and_never_the_content_of_an_entry(self):
        path = self.package("damaged.pptx", {"[Content_Types].xml": TYPES, "ppt/presentation.xml": "<p/>" * 200, "ppt/media/a.bin": os.urandom(3000)})
        data = bytearray(path.read_bytes())
        for i in range(40, 400):  # the data of the first entries, behind their local headers: not the directory at the end
            data[i] ^= 0xFF
        path.write_bytes(bytes(data))
        damaged = False
        try:
            with zipfile.ZipFile(path) as archive:
                damaged = archive.testzip() is not None
        except zipfile.BadZipFile:
            damaged = True
        self.assertTrue(damaged)  # (reading the entries would have found it)
        self.assertEqual(self.run_script(path)[:2], (0, "pptx\n"))

    def test_the_wrong_number_of_arguments_is_a_refusal_not_a_crash(self):
        result = subprocess.run([sys.executable, "-I", str(SCRIPT)], capture_output=True, text=True, timeout=30)
        self.assertEqual((result.returncode, result.stdout), (3, ""))
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), "a", "b"], capture_output=True, text=True, timeout=30)
        self.assertEqual((result.returncode, result.stdout), (3, ""))


if __name__ == "__main__":
    unittest.main()
