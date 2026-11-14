#!/usr/bin/env python3
"""The words of each page of a PDF, from the output of `pdftotext -bbox-layout` read on stdin (docs/DOCUMENTS.md).

    pdftotext -bbox-layout -enc UTF-8 -f 1 -l N file.pdf - | python3 -I render-words.py <outdir> [maxPages [rotations]]

writes <outdir>/w001.json, w002.json ... one for each page, each

    {"words": [[x0, y0, x1, y1, "text"], ...], "lines": [[first, last], ...]}

Boxes are fractions of the page as it is SHOWN (0 to 1, four decimals), x to the right and y downwards, so they are the same at any zoom. pdftotext puts the words of a page that is turned a
quarter (pdfinfo's `rot: 90` or `270`) in the turned frame but prints the page's size from before the turn: `rotations` (a comma separated list, one number for each page, from pdfinfo) says
which pages those are, and their width and height change places here. Words are in the reading order pdftotext found (its flows,
blocks and lines); `lines` are inclusive index ranges into `words`. At most MAX_WORDS words are kept for a page and the lines are cut to match (the host's validateWords refuses a page
that has more). A page with no text layer (a scan) gets an empty list.

The input is read line by line and a page is written when its end is seen, so the memory used is one page, whatever the size of the document. It is parsed with regular expressions and
html.unescape (no XML parser). It comes from a file nobody trusts: a line is read in pieces of at most MAX_LINE bytes, every number is checked, nothing in it is ever used as a path, and
the only files this writes are the w<3 digits>.json of pages 1 to maxPages in the directory it was given. Everything it prints is data the host does not believe: it prints nothing.
"""
import html
import json
import math
import os
import re
import sys

MAX_WORDS = 4000
MAX_LINE = 65536
MAX_PAGES = 500

# one pattern for every tag that matters, so that the order of tags on a line is the order of the text
TOKEN = re.compile(
    r'<page\s+width="([^"]*)"\s+height="([^"]*)"\s*>'
    r'|(</page>)'
    r'|(<line\b[^>]*>)'
    r'|(</line>)'
    r'|<word\s+xMin="([^"]*)"\s+yMin="([^"]*)"\s+xMax="([^"]*)"\s+yMax="([^"]*)"\s*>([^<]*)</word>'
)


def number(text):
    """A finite float from text, or None."""
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def fraction(value, size):
    """value / size as a fraction of the page, clamped to 0..1 and rounded to four decimals."""
    return round(min(1.0, max(0.0, value / size)), 4)


class Page:
    def __init__(self, width, height):
        self.width = width
        self.height = height
        self.words = []
        self.lines = []
        self.first = None  # index of the first word of the line being read
        self.count = 0  # words seen, kept or not

    def start_line(self):
        self.first = len(self.words)

    def end_line(self):
        if self.first is not None and len(self.words) > self.first:
            self.lines.append([self.first, len(self.words) - 1])
        self.first = None

    def add_word(self, x0, y0, x1, y1, text):
        self.count += 1
        if len(self.words) >= MAX_WORDS:
            return
        text = html.unescape(text).strip()
        if not text or self.width is None:
            return
        self.words.append([fraction(x0, self.width), fraction(y0, self.height), fraction(x1, self.width), fraction(y1, self.height), text])

    def result(self):
        if self.first is not None:  # a line that was never closed
            self.end_line()
        return {'words': self.words, 'lines': self.lines}


def write(outdir, number_, page):
    path = os.path.join(outdir, 'w%03d.json' % number_)
    body = json.dumps(page.result(), ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    with open(path, 'wb') as handle:
        handle.write(body)


def main(argv):
    if len(argv) < 2 or not os.path.isdir(argv[1]):
        return 2
    outdir = argv[1]
    try:
        max_pages = max(1, min(MAX_PAGES, int(argv[2]))) if len(argv) > 2 else MAX_PAGES
    except ValueError:
        return 2
    rotations = [int(part) if part.isdigit() else 0 for part in argv[3].split(',')[:MAX_PAGES]] if len(argv) > 3 else []
    page = None
    number_ = 0
    reader = sys.stdin.buffer
    while True:
        raw = reader.readline(MAX_LINE)
        if not raw:
            break
        for match in TOKEN.finditer(raw.decode('utf-8', 'replace')):
            width, height, page_end, line_start, line_end, x0, y0, x1, y1, text = match.groups()
            if width is not None:
                number_ += 1
                if number_ > max_pages:
                    page = None
                    return 0
                w, h = number(width), number(height)
                if number_ <= len(rotations) and rotations[number_ - 1] in (90, 270):
                    w, h = h, w
                page = Page(w, h) if w and h and w > 0 and h > 0 else Page(None, None)  # (a page whose size is not a size keeps no words)
            elif page is None:
                continue
            elif page_end is not None:
                write(outdir, number_, page)
                page = None
            elif line_start is not None:
                page.start_line()
            elif line_end is not None:
                page.end_line()
            elif x0 is not None:
                a, b, c, d = number(x0), number(y0), number(x1), number(y1)
                if None not in (a, b, c, d):
                    page.add_word(a, b, c, d, text)
    if page is not None and 1 <= number_ <= max_pages:  # the input stopped inside a page (a timeout): what was read of it is kept
        write(outdir, number_, page)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
