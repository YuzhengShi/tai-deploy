#!/usr/bin/env python3
"""course_status.py: the class-wide COURSE_STATUS.md, built from Canvas by plain code (no model).

Run by the orchestrator in a throwaway container (src/course-status.ts), never by an agent. One JSON line on stdin:
  {"env": {"CANVAS_API_TOKEN": ..., "CANVAS_BASE_URL": ..., "CANVAS_COURSE_ID": ...}, "previous": "<the file as it was>", "now": "<ISO time>"}
The Markdown goes to stdout; when Canvas cannot be read at all a one-line reason goes to stderr and the exit status is 1.

What is in the file is what every student may see: the syllabus, the structure of the course, announcements, discussion topics, files,
assignments and deadlines. Nothing about one student (no submission status, grades or GitHub activity): the file is read by every
student's agent, so a line about one student would reach all of them. A student's own status is asked of the identity-bound canvas_query.
Text that came from Canvas is flattened to one line and stripped of the characters that could turn a line into a table row or markup.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pacific_time import pacific  # the course keeps Pacific time: a date in the file carries it next to the UTC one

CANVAS_API = os.environ.get('CANVAS_API_SCRIPT', '/opt/scripts/canvas_api.py')
PYTHON = os.environ.get('CANVAS_API_PYTHON', sys.executable)
STATE = re.compile(r'<!-- state: (\{.*?\}) -->')


def flat(text, limit):
    """One line, no control characters, nothing that is markup or a table cell edge, cut at a word."""
    text = re.sub(r'[\x00-\x1f\x7f]+', ' ', str(text or ''))
    text = re.sub(r'[|<>`]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(' ', 1)[0] or text[:limit]
    return cut + ' ...'


def when(iso):
    parsed = parse_time(iso)
    if not parsed:
        return '-'
    local = pacific(parsed.strftime('%Y-%m-%dT%H:%M:%S'))
    return parsed.strftime('%Y-%m-%d %H:%M UTC') + (' (%s)' % local if local else '')


def parse_time(iso):
    if not iso:
        return None
    try:
        return datetime.fromisoformat(str(iso).replace('Z', '+00:00')).astimezone(timezone.utc)
    except ValueError:
        return None


def canvas(action, params=None):
    """One canvas_api.py call (the script the agents' canvas_query runs): the answer, or raises RuntimeError with a short reason."""
    done = subprocess.run([PYTHON, CANVAS_API], input=json.dumps({'action': action, 'params': params or {}}), capture_output=True, text=True, timeout=90, env=os.environ)
    try:
        data = json.loads(done.stdout)
    except ValueError:
        raise RuntimeError('%s: no usable answer' % action)
    if isinstance(data, dict) and data.get('error'):
        raise RuntimeError('%s: %s' % (action, flat(data['error'], 120)))
    return data


def fetch_all():
    """Every section's data; a section that cannot be read is left out and named in the errors."""
    data, errors = {}, []
    for name, action in (('syllabus', 'syllabus'), ('modules', 'modules'), ('announcements', 'announcements'), ('discussions', 'discussions'),
                         ('files', 'files'), ('assignments', 'assignments')):
        try:
            data[name] = canvas(action)
        except Exception as err:      # one section failing must not cost the others
            errors.append(str(err))
    return data, errors


def table(header, rows):
    if not rows:
        return ['(none)']
    return ['| ' + ' | '.join(header) + ' |', '|' + '---|' * len(header)] + ['| ' + ' | '.join(row) + ' |' for row in rows]


def build(data, errors, previous, now):
    """The Markdown file. `data` as fetch_all gives it, `previous` the file as it was (for the alerts), `now` a timezone-aware datetime."""
    seen = {}
    match = STATE.search(previous or '')
    if match:
        try:
            seen = json.loads(match.group(1))
        except ValueError:
            seen = {}
    out = ['# Course Status', 'Last synced: %s' % now.strftime('%Y-%m-%d %H:%M UTC'),
           'Built from Canvas by a script, for every student: nothing here is about one student (ask canvas_query for a student\'s own status).', '']

    syllabus = data.get('syllabus') or {}
    out += ['## Syllabus Summary', flat(syllabus.get('syllabus'), 1500) or '(not published)', '']

    modules = data.get('modules') or []
    rows = []
    for module in sorted(modules, key=lambda m: m.get('position') or 0):
        items = [flat(i.get('title'), 60) for i in (module.get('items') or []) if i.get('title')]
        rows.append([flat(module.get('name'), 50), flat('; '.join(items[:12]), 400) or '-'])
    out += ['## Course Structure (Modules)'] + table(['Module', 'Materials'], rows) + ['']

    announcements = sorted(data.get('announcements') or [], key=lambda a: a.get('posted_at') or '', reverse=True)[:10]
    rows = [[when(a.get('posted_at')), flat(a.get('title'), 80), flat(a.get('message'), 400 if i < 3 else 160)] for i, a in enumerate(announcements)]
    out += ['## Announcements (Recent)'] + table(['Date', 'Title', 'Summary'], rows) + ['']

    discussions = sorted(data.get('discussions') or [], key=lambda d: d.get('posted_at') or '', reverse=True)[:10]
    rows = [[flat(d.get('title'), 80), when(d.get('posted_at'))] for d in discussions]
    out += ['## Discussion Topics'] + table(['Topic', 'Posted'], rows) + ['']

    files = sorted(data.get('files') or [], key=lambda f: f.get('updated_at') or '', reverse=True)[:20]
    rows = [[flat(f.get('display_name') or f.get('filename'), 70), flat(f.get('content_type'), 30) or '-', when(f.get('updated_at'))] for f in files]
    out += ['## Course Files (Recent)'] + table(['File', 'Type', 'Updated'], rows) + ['']

    assignments = [a for a in (data.get('assignments') or []) if a.get('published') is not False]
    dated = sorted(assignments, key=lambda a: (parse_time(a.get('due_at')) is None, parse_time(a.get('due_at')) or now))
    rows = []
    for a in dated:
        due = parse_time(a.get('due_at'))
        state = 'no due date' if due is None else 'past' if due < now else 'due within 24h' if due - now <= timedelta(hours=24) else 'upcoming'
        rows.append([flat(a.get('name'), 70), when(a.get('due_at')), flat(a.get('points_possible'), 8) or '-', state])
    out += ['## Assignments'] + table(['Name', 'Due', 'Points', 'State'], rows) + ['']

    soon = [a for a in dated if parse_time(a.get('due_at')) and now <= parse_time(a.get('due_at')) <= now + timedelta(days=7)]
    out += ['## Upcoming Deadlines (next 7 days)']
    out += ['- %s: %s%s' % (when(a.get('due_at')), flat(a.get('name'), 70), ' (within 24 hours)' if parse_time(a.get('due_at')) - now <= timedelta(hours=24) else '') for a in soon] or ['(none)']
    out += ['']

    state = {'announcements': sorted(str(a.get('id')) for a in (data.get('announcements') or []) if a.get('id') is not None),
             'files': sorted(str(f.get('id')) for f in (data.get('files') or []) if f.get('id') is not None)}
    out += ['## Alerts']
    alerts = []
    if not seen:
        alerts.append('first sync: nothing to compare with yet')
    else:
        for a in announcements:
            if str(a.get('id')) not in seen.get('announcements', []):
                alerts.append('new announcement: %s' % flat(a.get('title'), 80))
        for f in files:
            if str(f.get('id')) not in seen.get('files', []):
                alerts.append('new course file: %s' % flat(f.get('display_name') or f.get('filename'), 70))
    alerts += ['due within 24 hours: %s' % flat(a.get('name'), 70) for a in soon if parse_time(a.get('due_at')) - now <= timedelta(hours=24)]
    out += ['- ' + line for line in alerts] or ['(nothing new)']
    out += ['', '## Sync Errors'] + (['- ' + flat(e, 160) for e in errors] or ['(none)'])
    out += ['', '<!-- state: %s -->' % json.dumps(state, separators=(',', ':'))]
    return '\n'.join(out) + '\n'


def main():
    try:
        config = json.loads(sys.stdin.readline() or '{}')
    except ValueError:
        sys.stderr.write('stdin is not one JSON line\n')
        return 1
    for key, value in (config.get('env') or {}).items():
        if re.fullmatch(r'CANVAS_[A-Z_]+', key) and isinstance(value, str):
            os.environ[key] = value
    now = parse_time(config.get('now')) or datetime.now(timezone.utc)
    data, errors = fetch_all()
    if not data.get('assignments') and not data.get('modules'):
        sys.stderr.write('Canvas could not be read: %s\n' % '; '.join(flat(e, 100) for e in errors[:3]))
        return 1
    sys.stdout.write(build(data, errors, config.get('previous') or '', now))
    return 0


if __name__ == '__main__':
    sys.exit(main())
