/**
 * What changed in the course between two COURSE_STATUS.md files, as the student's activity list says it: a new announcement, a new file, a new
 * assignment, a deadline that moved or came within 24 hours, a new module or something new in one. The file is built from Canvas every few
 * hours by container/scripts/course_status.py (no model, nothing about one student), so what it shows is the same for the whole class and so
 * is every update here. Pure functions over two texts; src/index.ts puts the result in the students' histories.
 *
 * Announcements and files come from the file's own "Alerts" section (the script compares Canvas ids, which the tables do not carry: a file that
 * was updated and climbed back into the table of the twenty newest is not a new file). Assignments and modules are compared by their tables.
 */

export interface CourseUpdate {
  /** "New announcement", "Due soon", "New file" ... */
  title: string;
  /** One line naming it. */
  text: string;
  detail?: string;
}

/** More than this many of one kind in one sync is a Canvas that could not be read last time, or a term's worth of material put up at once: one line, not a flood. */
const MAX_PER_KIND = 4;

function lines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/** The rows of the table under a "## heading" (the heading starts with `heading`), without the header row and the separator; [] when there is none. */
export function tableRows(text: string, heading: string): string[][] {
  const all = lines(text);
  const start = all.findIndex((l) => l.startsWith(`## ${heading}`));
  if (start === -1) return [];
  const rows: string[][] = [];
  let header = true;
  for (const line of all.slice(start + 1)) {
    if (line.startsWith('## ') || line.startsWith('<!--')) break;
    if (!line.startsWith('| ')) continue;
    if (/^\|[-| ]+\|$/.test(line)) continue;
    if (header) {
      header = false;
      continue;
    }
    rows.push(line.replace(/^\| /, '').replace(/ \|$/, '').split(' | '));
  }
  return rows;
}

/** The lines of the "## Alerts" section: "new announcement: ...", "new course file: ...", "due within 24 hours: ...". */
export function alertLines(text: string): string[] {
  const all = lines(text);
  const start = all.findIndex((l) => l.startsWith('## Alerts'));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of all.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) out.push(line.slice(2).trim());
  }
  return out;
}

/** "2026-11-09 17:00 UTC (Mon Nov 9, 9:00 AM PST)" is "Mon Nov 9, 9:00 AM PST": the course keeps Pacific time. '' for no date. */
export function pacificOf(cell: string | undefined): string {
  const value = (cell ?? '').trim();
  if (!value || value === '-') return '';
  const inner = /\(([^)]+)\)\s*$/.exec(value);
  return inner ? inner[1] : value;
}

const isBaseline = (text: string): boolean => !text.trim().startsWith('# Course Status');

/** Many of one kind become one line saying how many, with the first few named in the detail. */
function capped(kind: string, plural: string, items: CourseUpdate[]): CourseUpdate[] {
  if (items.length <= MAX_PER_KIND) return items;
  return [
    {
      title: kind,
      text: `${items.length} ${plural} in the course`,
      detail: items
        .slice(0, 10)
        .map((i) => i.text)
        .join('\n'),
    },
  ];
}

/** A table row as a map from its first cell (the name) to its cells. */
function byName(rows: string[][]): Map<string, string[]> {
  return new Map(rows.filter((r) => r[0]).map((r) => [r[0], r]));
}

/**
 * The updates between two files. Nothing for the first file there is (`previous` empty or not a Course Status page): that is the
 * baseline, not news, and a student who has just arrived is not told the whole term.
 */
export function courseUpdates(previous: string, current: string): CourseUpdate[] {
  if (isBaseline(previous) || isBaseline(current)) return [];
  const alerts = alertLines(current);
  const firstSync = alerts.some((a) => a.startsWith('first sync'));
  const out: CourseUpdate[] = [];

  // announcements and files, by the script's own alerts (it compares ids)
  const announcements: CourseUpdate[] = [];
  const files: CourseUpdate[] = [];
  if (!firstSync) {
    const announcementRows = tableRows(current, 'Announcements');
    const fileRows = tableRows(current, 'Course Files');
    for (const alert of alerts) {
      const post = /^new announcement: (.+)$/.exec(alert);
      if (post) {
        const row = announcementRows.find((r) => r[1] === post[1]);
        announcements.push({ title: 'New announcement', text: post[1], ...(row ? { detail: [pacificOf(row[0]), row[2]].filter(Boolean).join('\n\n') } : {}) });
        continue;
      }
      const file = /^new course file: (.+)$/.exec(alert);
      if (file) {
        const row = fileRows.find((r) => r[0] === file[1]);
        files.push({ title: 'New file', text: file[1], ...(row ? { detail: [row[1], pacificOf(row[2])].filter((c) => c && c !== '-').join(' · ') } : {}) });
      }
    }
  }
  out.push(...capped('New announcements', 'new announcements', announcements), ...capped('New files', 'new files', files));

  // assignments, by name: a new one, a due date that moved, one that has come within 24 hours since the last sync
  const before = byName(tableRows(previous, 'Assignments'));
  const assignments: CourseUpdate[] = [];
  const moved: CourseUpdate[] = [];
  const soon: CourseUpdate[] = [];
  for (const [name, row] of byName(tableRows(current, 'Assignments'))) {
    const due = pacificOf(row[1]);
    const was = before.get(name);
    if (!was) {
      if (before.size === 0) continue;                       // a table that was empty (Canvas could not be read): not news
      const points = row[2] && row[2] !== '-' ? `Worth ${row[2]} points.` : '';
      assignments.push({ title: 'New assignment', text: due ? `${name} · due ${due}` : name, ...(points ? { detail: points } : {}) });
      continue;
    }
    const wasDue = pacificOf(was[1]);
    if (due && wasDue && due !== wasDue) {
      moved.push({ title: 'Due date moved', text: `${name} · now due ${due}`, detail: `It was due ${wasDue}.` });
    } else if (row[3] === 'due within 24h' && was[3] !== 'due within 24h') {
      soon.push({ title: 'Due soon', text: `${name} · due ${due}`, detail: 'Due within 24 hours. This is for the whole class: if you have already turned it in, you are done.' });
    }
  }
  out.push(...capped('New assignments', 'new assignments', assignments), ...capped('Due dates moved', 'due dates moved', moved), ...soon.slice(0, MAX_PER_KIND));

  // modules, by name: a new one, or something new in one (only when both lists were whole: a cell the script cut short ends in " ...")
  const modulesBefore = byName(tableRows(previous, 'Course Structure'));
  const modules: CourseUpdate[] = [];
  const items: CourseUpdate[] = [];
  for (const [name, row] of byName(tableRows(current, 'Course Structure'))) {
    const was = modulesBefore.get(name);
    const materials = (row[1] ?? '').split('; ').filter((m) => m && m !== '-');
    if (!was) {
      if (modulesBefore.size === 0) continue;
      modules.push({ title: 'New module', text: name, ...(materials.length ? { detail: materials.join('\n') } : {}) });
      continue;
    }
    if ((row[1] ?? '').endsWith(' ...') || (was[1] ?? '').endsWith(' ...')) continue;
    const had = new Set((was[1] ?? '').split('; '));
    for (const item of materials) if (!had.has(item)) items.push({ title: 'New in a module', text: `${name}: ${item}` });
  }
  out.push(...capped('New modules', 'new modules', modules), ...capped('New in modules', 'new things in modules', items));
  return out;
}
