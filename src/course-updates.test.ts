import { describe, expect, it } from 'vitest';

import { alertLines, courseUpdates, pacificOf, tableRows } from './course-updates.js';

const table = (header: string[], rows: string[][]) =>
  rows.length === 0 ? '(none)' : ['| ' + header.join(' | ') + ' |', '|' + '---|'.repeat(header.length), ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join('\n');

/** A COURSE_STATUS.md as container/scripts/course_status.py writes it, with the sections the updates read. */
function page(o: { modules?: string[][]; announcements?: string[][]; files?: string[][]; assignments?: string[][]; alerts?: string[] } = {}): string {
  return (
    [
      '# Course Status',
      'Last synced: 2026-11-02 15:00 UTC',
      '',
      '## Course Structure (Modules)',
      table(['Module', 'Materials'], o.modules ?? []),
      '',
      '## Announcements (Recent)',
      table(['Date', 'Title', 'Summary'], o.announcements ?? []),
      '',
      '## Course Files (Recent)',
      table(['File', 'Type', 'Updated'], o.files ?? []),
      '',
      '## Assignments',
      table(['Name', 'Due', 'Points', 'State'], o.assignments ?? []),
      '',
      '## Alerts',
      ...(o.alerts?.length ? o.alerts.map((a) => '- ' + a) : ['(nothing new)']),
      '',
      '## Sync Errors',
      '(none)',
      '',
      '<!-- state: {"announcements":[],"files":[]} -->',
    ].join('\n') + '\n'
  );
}

const hw = (name: string, due: string, state = 'upcoming', points = '15.0') => [name, `2026-11-09 17:00 UTC (${due})`, points, state];

describe('reading the page', () => {
  it('reads a table without its header and separator, and a section that is "(none)" as no rows', () => {
    const text = page({ assignments: [hw('HW7', 'Mon Nov 9, 9:00 AM PST')] });
    expect(tableRows(text, 'Assignments')).toEqual([['HW7', '2026-11-09 17:00 UTC (Mon Nov 9, 9:00 AM PST)', '15.0', 'upcoming']]);
    expect(tableRows(text, 'Course Files')).toEqual([]);
    expect(tableRows(text, 'Nothing like this')).toEqual([]);
  });

  it('reads the alerts, and none from a page with nothing new', () => {
    expect(alertLines(page({ alerts: ['new announcement: Hello', 'due within 24 hours: HW7'] }))).toEqual(['new announcement: Hello', 'due within 24 hours: HW7']);
    expect(alertLines(page())).toEqual([]);
  });

  it('takes the Pacific time out of a date the page gives twice', () => {
    expect(pacificOf('2026-11-09 17:00 UTC (Mon Nov 9, 9:00 AM PST)')).toBe('Mon Nov 9, 9:00 AM PST');
    expect(pacificOf('2026-11-09 17:00 UTC')).toBe('2026-11-09 17:00 UTC');
    expect(pacificOf('-')).toBe('');
    expect(pacificOf(undefined)).toBe('');
  });
});

describe('courseUpdates', () => {
  it('has nothing to say about the first page there is: that is the baseline, not news', () => {
    expect(courseUpdates('', page({ assignments: [hw('HW7', 'Mon Nov 9, 9:00 AM PST')], alerts: ['new announcement: Hello'] }))).toEqual([]);
    expect(courseUpdates('not a page', page())).toEqual([]);
  });

  it('names a new announcement, with its date and what it says', () => {
    const current = page({
      announcements: [['2026-11-02 15:32 UTC (Mon Nov 2, 7:32 AM PST)', 'Projects and more Experiments!', 'Hi all! Lock in on your projects.']],
      alerts: ['new announcement: Projects and more Experiments!'],
    });
    expect(courseUpdates(page(), current)).toEqual([
      { title: 'New announcement', text: 'Projects and more Experiments!', detail: 'Mon Nov 2, 7:32 AM PST\n\nHi all! Lock in on your projects.' },
    ]);
  });

  it('names a new file, with its type and when it came', () => {
    const current = page({ files: [['day10-deploy.pdf', 'application/pdf', '2026-11-03 03:52 UTC (Mon Nov 2, 7:52 PM PST)']], alerts: ['new course file: day10-deploy.pdf'] });
    expect(courseUpdates(page(), current)).toEqual([{ title: 'New file', text: 'day10-deploy.pdf', detail: 'application/pdf · Mon Nov 2, 7:52 PM PST' }]);
  });

  it('does not take the script\'s first sync for news, and an alert that is not a post or a file for one', () => {
    expect(courseUpdates(page(), page({ alerts: ['first sync: nothing to compare with yet', 'new announcement: Hello'] }))).toEqual([]);
    expect(courseUpdates(page(), page({ alerts: ['due within 24 hours: HW7'] }))).toEqual([]);
  });

  it('names a new assignment with its due time and points, and keeps quiet about a table that was empty before (Canvas could not be read)', () => {
    const before = page({ assignments: [hw('HW6', 'Mon Nov 2, 9:00 AM PST', 'past')] });
    const after = page({ assignments: [hw('HW6', 'Mon Nov 2, 9:00 AM PST', 'past'), hw('HW7: Cost savings', 'Mon Nov 9, 9:00 AM PST')] });
    expect(courseUpdates(before, after)).toEqual([{ title: 'New assignment', text: 'HW7: Cost savings · due Mon Nov 9, 9:00 AM PST', detail: 'Worth 15.0 points.' }]);
    expect(courseUpdates(page(), after)).toEqual([]);
  });

  it('says a due date moved, with the old one', () => {
    const before = page({ assignments: [hw('HW7', 'Mon Nov 9, 9:00 AM PST')] });
    const after = page({ assignments: [hw('HW7', 'Wed Nov 11, 9:00 AM PST')] });
    expect(courseUpdates(before, after)).toEqual([{ title: 'Due date moved', text: 'HW7 · now due Wed Nov 11, 9:00 AM PST', detail: 'It was due Mon Nov 9, 9:00 AM PST.' }]);
  });

  it('says an assignment is due soon once: when it comes within 24 hours, not at every sync after', () => {
    const upcoming = page({ assignments: [hw('HW7', 'Mon Nov 9, 9:00 AM PST', 'upcoming')] });
    const soon = page({ assignments: [hw('HW7', 'Mon Nov 9, 9:00 AM PST', 'due within 24h')] });
    const updates = courseUpdates(upcoming, soon);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ title: 'Due soon', text: 'HW7 · due Mon Nov 9, 9:00 AM PST' });
    expect(courseUpdates(soon, soon)).toEqual([]);
  });

  it('names a new module with its materials, and a new thing in an old one', () => {
    const before = page({ modules: [['Week 9', 'Day 9 slides; Day 9 video']] });
    const after = page({ modules: [['Week 9', 'Day 9 slides; Day 9 video; Day 9 quiz'], ['Week 10', 'Day 10 slides; Lab 10']] });
    expect(courseUpdates(before, after)).toEqual([
      { title: 'New module', text: 'Week 10', detail: 'Day 10 slides\nLab 10' },
      { title: 'New in a module', text: 'Week 9: Day 9 quiz' },
    ]);
  });

  it('does not take what a cell the script cut short hides or shifts for something new', () => {
    const before = page({ modules: [['Week 1', 'a; b; c ...']] });
    const after = page({ modules: [['Week 1', 'a; b; d ...']] });
    expect(courseUpdates(before, after)).toEqual([]);
  });

  it('puts a flood of one kind in one line: more than four new files is a Canvas that came back, not four hundred announcements', () => {
    const names = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'f.pdf'];
    const current = page({ files: names.map((n) => [n, 'application/pdf', '2026-11-03 03:52 UTC (Mon Nov 2, 7:52 PM PST)']), alerts: names.map((n) => `new course file: ${n}`) });
    const updates = courseUpdates(page(), current);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ title: 'New files', text: '6 new files in the course' });
    expect(updates[0].detail).toContain('a.pdf\nb.pdf');
  });

  it('is quiet when nothing changed', () => {
    const same = page({ assignments: [hw('HW7', 'Mon Nov 9, 9:00 AM PST')], modules: [['Week 9', 'Day 9 slides']] });
    expect(courseUpdates(same, same)).toEqual([]);
  });
});
