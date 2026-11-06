#!/usr/bin/env python3
"""make_course_reference.py PAGES_DIR OUT_FILE: groups/global/COURSE_REFERENCE.md for the term the world publishes.

The reference the fork inherited is the Spring 2026 course: its weekly topics, its homework numbering ("HW3 = Terraform") and its lecture
notes. A student of this term who is told that is told something false. This writes the same kind of page from what the world already
publishes to students (weeks.json, homework.json, syllabus.json under PAGES_DIR: the weekly loop keeps them current), so it is the term
that is running. Plain standard library: it runs on the host, nightly, with the corpus (tai_live.sh corpus), and on the PC.
"""
import html
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

MARK = 'Generated from the pages the course publishes to students'


def text_of(markup, limit):
    """HTML to one paragraph of plain text, cut at a word."""
    markup = re.sub(r'(?is)<(script|style).*?>.*?</\1>', ' ', markup or '')
    markup = re.sub(r'(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr)>', '\n', markup)
    plain = html.unescape(re.sub(r'<[^>]+>', ' ', markup))
    plain = re.sub(r'[ \t\r\f\v]+', ' ', plain)
    plain = re.sub(r'\n\s*\n+', '\n\n', plain).strip()
    if len(plain) <= limit:
        return plain
    return plain[:limit].rsplit(' ', 1)[0] + ' ...'


def cell(value, limit=90):
    value = re.sub(r'[|<>`\r\n]+', ' ', str(value or ''))
    value = re.sub(r'\s+', ' ', value).strip()
    return value if len(value) <= limit else value[:limit].rsplit(' ', 1)[0] + ' ...'


def when(iso):
    if not iso:
        return 'no date'
    try:
        parsed = datetime.fromisoformat(str(iso).replace('Z', '+00:00')).astimezone(timezone.utc)
    except ValueError:
        return 'no date'
    return parsed.strftime('%a %b %d %Y %H:%M UTC')


def build(weeks, homework, syllabus, now):
    course = weeks.get('course') or 'the course'
    term = cell(weeks.get('term') or '', 60)
    out = [
        '# Course Reference',
        '',
        '%s (%s). %s, %s. Canvas is authoritative for dates: use canvas_query for the'
        % (cell(course, 80), term or 'this term', MARK, now.strftime('%Y-%m-%d')),
        'real due dates; this page is the map of the term (what each week is about and which homework belongs to it). It replaced the',
        'earlier term\'s reference: anything you remember about another term\'s weeks or homework numbering does not apply here.',
        '',
        '## Weekly Topics',
        '',
        '| Week | Topic | Homework | Materials |',
        '|---|---|---|---|',
    ]
    rows = {}
    for key, week in weeks.get('weeks', {}).items():
        if week.get('n') is None:
            continue
        hws = []
        materials = []
        for item in week.get('items', []):
            kind = item.get('kind')
            if kind == 'hw':
                due = (homework.get(str(item.get('id'))) or {}).get('due_at') or item.get('due_at')
                hws.append('%s (due %s)' % (cell(item.get('title'), 70), when(due)))
            elif kind in ('video', 'slides', 'link'):
                materials.append('%s: %s' % (kind, cell(item.get('title'), 60)))
        rows[week['n']] = '| %s | %s | %s | %s |' % (week['n'], cell(week.get('title'), 80), '; '.join(hws) or '-', '; '.join(materials[:6]) or '-')
    out += [rows[n] for n in sorted(rows)]
    out += ['', '## Homework', '']
    listed = sorted(homework.items(), key=lambda kv: (kv[1].get('due_at') or '9999', kv[1].get('name') or ''))
    for _, hw in listed:
        if hw.get('student_visible') is False:
            continue
        out.append('- %s: due %s (opens %s)' % (cell(hw.get('name'), 90), when(hw.get('due_at')), when(hw.get('unlock_at'))))
    final = [i for week in weeks.get('weeks', {}).values() for i in week.get('items', []) if i.get('kind') == 'note']
    for note in final:
        out.append('- %s: %s' % (cell(note.get('title'), 60), cell(note.get('text'), 160)))
    out += ['', '## Syllabus', '', text_of((syllabus or {}).get('html'), 4500) or '(not published)', '']
    out += [
        '## Reading Student Files',
        '',
        'A file a student attaches in the chat is saved under /workspace/group/uploads/ and named at the end of their message; the start of a',
        'text or code file is already in the message. Read the rest with your read tool (PDF, Word, Excel and PowerPoint files with',
        '/opt/leanrag/bin/python3 /opt/scripts/convert_office.py <file>). A picture is read with read_image_text (its path is in the message): that gives you its',
        'text only. Unless the message says you can look at the picture (with look_at_image), you cannot see charts, diagrams or what a screen looks like: say so when the',
        'question is about that, and if nothing could be read, say so and ask for the text.',
        'When a student shares course material (slides, an assignment spec, a paper): read the actual file, base your answer on what it',
        'contains, and never guess at a file you have not read.',
        '',
    ]
    return '\n'.join(out)


def main(argv):
    if len(argv) != 3:
        sys.stderr.write('usage: make_course_reference.py PAGES_DIR OUT_FILE\n')
        return 2
    pages, out_file = Path(argv[1]), Path(argv[2])
    try:
        weeks = json.loads((pages / 'weeks.json').read_text(encoding='utf-8'))
        homework = json.loads((pages / 'homework.json').read_text(encoding='utf-8'))
        syllabus = json.loads((pages / 'syllabus.json').read_text(encoding='utf-8'))
    except (OSError, ValueError) as err:
        sys.stderr.write('cannot read the published pages in %s: %s\n' % (pages, type(err).__name__))
        return 1
    text = build(weeks, homework, syllabus, datetime.now(timezone.utc))
    if len(text) < 500 or '| 1 |' not in text:
        sys.stderr.write('the published pages gave no weeks: not writing\n')
        return 1
    tmp = out_file.with_name(out_file.name + '.new')
    tmp.write_text(text, encoding='utf-8', newline='\n')
    tmp.replace(out_file)
    print('course reference: %d weeks, %d bytes' % (text.count('\n| ') - 1, len(text)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
