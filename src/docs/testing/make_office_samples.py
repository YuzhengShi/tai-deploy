#!/usr/bin/env python3
"""Real Office files for the renderer's smoke (src/docs/smoke.ts): a deck, a document and a workbook, made with python-pptx, python-docx and openpyxl. Those are in the agent image's own environment
(`docker run --rm --entrypoint /opt/leanrag/bin/python tai-agent:live make_office_samples.py <outdir>`), not in this tree's dependencies: nothing here is installed by the repository.

    make_office_samples.py <outdir>

writes into <outdir>
    deck12.pptx        12 slides of a 4:3 deck: a title on each, bullets, a table (slide 4), drawn shapes with text (slide 5), a picture (slide 6)
    report6.docx       6 pages: a heading, text and a page break each, a table (page 3)
    two-sheets.xlsx    two sheets ("Latency" and "Notes") with a header row and a few dozen cells
    photos40.pptx      40 slides that are a photograph each (noise: it does not compress), about 12 MB: what a heavy deck costs
    long150.docx       150 pages of text (the renderer keeps 120)
    and the files that must be refused, each in a way of its own: notoffice.zip (a plain archive), truncated.pptx (a deck cut in half), empty.pptx (no bytes), macro.docx (a VBA project in it),
    many-parts.pptx (3,500 entries), bomb.pptx (an entry that declares a gigabyte), garbage.pptx (the parts of a deck, with text that is not a deck's), encrypted.docx (an entry marked encrypted)
    samples.json       what each file must show: the number of pages, and the words of its titles in the order the pages have them
"""
import json
import os
import struct
import sys
import zipfile
import zlib
from pathlib import Path

SLIDE_TITLES = [
    'Raft Consensus Overview', 'Leader Election', 'Log Replication', 'Cluster Sizes and Quorums', 'Message Flow', 'Picture Slide',
    'Safety Properties', 'Membership Changes', 'Log Compaction', 'Client Interaction', 'Comparison with Paxos', 'Summary and Next Steps',
]
BULLETS = [
    'A replicated log keeps the servers in step',
    'One leader at a time takes the writes',
    'A majority must agree before an entry counts',
]
SECTIONS = ['Introduction', 'Design Decisions', 'Concurrency Model', 'Load Testing Results', 'Failure Handling', 'Conclusions']


PNG_SIGNATURE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])


def _chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF)


def png(width, height):
    """A small RGB picture (a gradient) as PNG bytes, with nothing but the standard library."""
    rows = b''.join(b'\x00' + b''.join(bytes((x * 255 // width, y * 255 // height, 160)) for x in range(width)) for y in range(height))
    return PNG_SIGNATURE + _chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + _chunk(b'IDAT', zlib.compress(rows)) + _chunk(b'IEND', b'')


def make_deck(path, workdir):
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.util import Inches, Pt

    prs = Presentation()
    for number, title in enumerate(SLIDE_TITLES, start=1):
        if number in (4, 5, 6):
            slide = prs.slides.add_slide(prs.slide_layouts[5])  # title only
            slide.shapes.title.text = title
        else:
            slide = prs.slides.add_slide(prs.slide_layouts[1])  # title and content
            slide.shapes.title.text = title
            frame = slide.placeholders[1].text_frame
            frame.text = BULLETS[0]
            for line in BULLETS[1:]:
                frame.add_paragraph().text = line
            frame.add_paragraph().text = 'Slide %d of %d' % (number, len(SLIDE_TITLES))
        if number == 4:
            table = slide.shapes.add_table(4, 3, Inches(1), Inches(2), Inches(8), Inches(2.5)).table
            for r, row in enumerate([('Servers', 'Quorum', 'Failures tolerated'), ('3', '2', '1'), ('5', '3', '2'), ('7', '4', '3')]):
                for c, text in enumerate(row):
                    table.cell(r, c).text = text
        if number == 5:
            leader = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.8), Inches(2.5), Inches(2.4), Inches(1.2))
            leader.text_frame.text = 'Leader'
            arrow = slide.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, Inches(3.4), Inches(2.8), Inches(1.6), Inches(0.6))
            arrow.text_frame.text = 'AppendEntries'
            arrow.text_frame.paragraphs[0].runs[0].font.size = Pt(9)
            follower = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(5.2), Inches(2.4), Inches(2.6), Inches(1.4))
            follower.text_frame.text = 'Follower'
        if number == 6:
            picture = Path(workdir) / 'gradient.png'
            picture.write_bytes(png(240, 160))
            slide.shapes.add_picture(str(picture), Inches(2), Inches(2), Inches(5), Inches(3.3))
    prs.save(path)


def make_report(path):
    from docx import Document

    doc = Document()
    doc.add_heading('Order Service Report', level=0)
    for number, name in enumerate(SECTIONS, start=1):
        doc.add_heading('Section %d: %s' % (number, name), level=1)
        for line in range(6):
            doc.add_paragraph('Paragraph %d of the %s section describes what was built, why it was built that way, and what was measured afterwards.' % (line + 1, name.lower()))
        if number == 3:
            table = doc.add_table(rows=3, cols=3)
            for r, row in enumerate([('Threads', 'Requests', 'p99 latency'), ('10', '1000', '42 ms'), ('100', '10000', '180 ms')]):
                for c, text in enumerate(row):
                    table.cell(r, c).text = text
        if number != len(SECTIONS):
            doc.add_page_break()
    doc.save(path)


def make_photo_deck(path, workdir):
    from pptx import Presentation
    from pptx.util import Inches

    prs = Presentation()
    for number in range(1, 41):
        slide = prs.slides.add_slide(prs.slide_layouts[5])
        slide.shapes.title.text = 'Photograph %d' % number
        picture = Path(workdir) / ('noise%d.png' % number)
        width, height = 360, 270
        raw = b''.join(b'\x00' + os.urandom(width * 3) for _ in range(height))
        picture.write_bytes(PNG_SIGNATURE + _chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + _chunk(b'IDAT', zlib.compress(raw, 1)) + _chunk(b'IEND', b''))
        slide.shapes.add_picture(str(picture), Inches(0.5), Inches(1.5), Inches(9), Inches(6))
        picture.unlink()
    prs.save(path)


def make_long_report(path):
    from docx import Document

    doc = Document()
    for number in range(1, 151):
        doc.add_heading('Page number %d' % number, level=1)
        doc.add_paragraph('The text of page %d, which a long document has, and which only the first hundred and twenty are kept of.' % number)
        if number != 150:
            doc.add_page_break()
    doc.save(path)


def make_hostile(out):
    """The files that must be refused, or turned into a clean failure: none of them is a real document."""
    types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'

    def package(name, entries):
        with zipfile.ZipFile(out / name, 'w', zipfile.ZIP_DEFLATED) as archive:
            for entry, data in entries.items():
                archive.writestr(entry, data)

    with zipfile.ZipFile(out / 'notoffice.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('readme.txt', 'A plain archive with a text file in it.')
        archive.writestr('src/main.go', 'package main')
    raw = (out / 'deck12.pptx').read_bytes()
    (out / 'truncated.pptx').write_bytes(raw[: len(raw) // 2])
    (out / 'empty.pptx').write_bytes(b'')
    package('macro.docx', {'[Content_Types].xml': types, 'word/document.xml': '<w:document/>', 'word/vbaProject.bin': 'not really a project'})
    parts = {'[Content_Types].xml': types, 'ppt/presentation.xml': '<p:presentation/>'}
    parts.update({'ppt/media/part%d.xml' % i: 'x' for i in range(3500)})
    package('many-parts.pptx', parts)
    package('garbage.pptx', {'[Content_Types].xml': types, 'ppt/presentation.xml': 'this is not xml at all', 'ppt/slides/slide1.xml': 'not a slide'})
    package('encrypted.docx', {'[Content_Types].xml': types, 'word/document.xml': '<w:document/>'})
    # (python's zipfile does not write an encrypted entry: the general purpose flag of each record of the central directory is set by hand)
    data = bytearray((out / 'encrypted.docx').read_bytes())
    at = data.find(b'PK' + bytes([1, 2]))
    while at != -1:
        data[at + 8] |= 1
        at = data.find(b'PK' + bytes([1, 2]), at + 4)
    (out / 'encrypted.docx').write_bytes(bytes(data))
    with zipfile.ZipFile(out / 'bomb.pptx', 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', types)
        archive.writestr('ppt/presentation.xml', '<p:presentation/>')
        with archive.open('ppt/media/huge.bin', 'w', force_zip64=True) as entry:
            block = bytes(1024 * 1024)
            for _ in range(1024):
                entry.write(block)


def make_workbook(path):
    from openpyxl import Workbook

    book = Workbook()
    latency = book.active
    latency.title = 'Latency'
    latency.append(['Run', 'Threads', 'p99 latency ms'])
    for run in range(1, 21):
        latency.append([run, 10 * run, 40 + run * 7])
    notes = book.create_sheet('Notes')
    notes.append(['Topic', 'Detail'])
    notes.append(['Saturation', 'Latency climbs once the thread pool is full'])
    notes.append(['Warm up', 'The first runs are slower'])
    book.save(path)


def main(argv):
    out = Path(argv[1])
    out.mkdir(parents=True, exist_ok=True)
    make_deck(out / 'deck12.pptx', out)
    make_report(out / 'report6.docx')
    make_workbook(out / 'two-sheets.xlsx')
    make_photo_deck(out / 'photos40.pptx', out)
    make_long_report(out / 'long150.docx')
    make_hostile(out)
    (out / 'gradient.png').unlink(missing_ok=True)
    manifest = {
        'deck12.pptx': {'pages': len(SLIDE_TITLES), 'titles': SLIDE_TITLES, 'table': ['Servers', 'Quorum', 'Failures', 'tolerated'], 'shapes': ['Leader', 'AppendEntries', 'Follower']},
        'report6.docx': {'pages': len(SECTIONS), 'titles': ['Section %d: %s' % (n, name) for n, name in enumerate(SECTIONS, start=1)]},
        'two-sheets.xlsx': {'sheets': ['Latency', 'Notes'], 'words': ['Threads', 'Topic', 'Saturation']},
        'photos40.pptx': {'pages': 40, 'titles': ['Photograph %d' % n for n in range(1, 41)]},
        'long150.docx': {'pages': 150, 'titles': ['Page number %d' % n for n in range(1, 151)]},
    }
    (out / 'samples.json').write_text(json.dumps(manifest, indent=1), encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
