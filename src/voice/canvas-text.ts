/**
 * What a Canvas answer looks like to the voice model. The container's canvas_query returns Canvas's own objects (HTML descriptions, UTC
 * stamps, download URLs with tokens, a whole module tree), and the model, which reads them once and speaks, answered from the NAME of an
 * assignment instead ("a short online quiz that focuses on Raft": nothing in Canvas said so), took a file's id for a made-up one
 * ("files/xxxx/download") and found nothing when it looked for "the Raft slides" in 15 modules of 20 items cut off at 6000 characters.
 * These functions turn the answers into short plain text with the ids the next call needs, and look across files, modules and pages for
 * words ("find"). They are pure: the tool host's answers in, text out.
 */

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"', '&ndash;': '-', '&mdash;': '-' };

/** HTML as the words a person would read: no tags, the common entities decoded, white space collapsed. */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|rsquo|lsquo|ldquo|rdquo|ndash|mdash|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const asArray = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)) : [];
const text = (value: unknown, max = 200): string => (typeof value === 'string' ? value.trim().slice(0, max) : typeof value === 'number' ? String(value) : '');

const PACIFIC = { timeZone: 'America/Los_Angeles' } as const;

/**
 * The longest `due_local` read: "Fri Nov 6, 10:00 AM (America/Vancouver, UTC-7)" is 47 characters; with the longest zone name of tzdata
 * (America/Argentina/ComodRivadavia, 32 characters) and the widest clock and offset it is 65. It is the student's own clock, which canvas_api.py adds only when
 * it reads differently from Pacific (container/scripts/pacific_time.py, student_local): absent for most students, and then nothing below changes.
 */
const LOCAL_MAX = 80;
const localClock = (value: unknown): string => (typeof value === 'string' ? value.trim().slice(0, LOCAL_MAX) : '');

/** "Mon, Nov 2, 9:00 AM PST" for a Canvas UTC stamp. */
export function pacific(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { ...PACIFIC, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

/** "in 62 minutes", "in 3 days", "2 days ago" (a due date that has passed was due). */
export function distance(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return '';
  const abs = Math.abs(ms);
  const unit = abs < 3_600_000 ? [Math.max(1, Math.round(abs / 60_000)), 'minute'] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), 'hour'] : [Math.round(abs / 86_400_000), 'day'];
  const phrase = `${unit[0]} ${unit[1]}${unit[0] === 1 ? '' : 's'}`;
  return ms >= 0 ? `in ${phrase}` : `${phrase} ago`;
}

/** An assignment of Canvas (assignment_detail) as the facts a TA would tell: when, how many points, and what it asks, in words. */
export function compactAssignmentDetail(raw: string, now: number): string | null {
  const a = parseJson(raw);
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const o = a as Record<string, unknown>;
  const name = text(o.name);
  if (!name) return null;
  const due = text(o.due_at);
  const lines = [`Assignment ${text(o.id)}: ${name}`];
  lines.push(due ? `Due: ${pacific(due)} (${distance(due, now)}).` : 'Due: no due date in Canvas.');
  const local = due ? localClock(o.due_local) : '';
  if (local) lines.push(`On the student's own clock that is ${local}.`);
  const types = Array.isArray(o.submission_types) ? (o.submission_types as unknown[]).map((t) => text(t)).filter(Boolean) : [];
  lines.push(`Points: ${o.points_possible ?? 'none'}${types.length ? `. Submit as: ${types.join(', ')}` : ''}.`);
  const description = typeof o.description === 'string' ? plainText(o.description) : '';
  lines.push(description ? `What it says in Canvas: ${description.slice(0, 2500)}${description.length > 2500 ? ' [...]' : ''}` : 'What it says in Canvas: nothing (the assignment has no description): say that you do not know what it covers, never guess from its name.');
  const rubric = asArray(o.rubric_criteria)
    .map((c) => `${text(c.description, 80)} (${c.points ?? '?'} points)`)
    .filter((c) => c.length > 12)
    .slice(0, 8);
  if (rubric.length) lines.push(`Rubric: ${rubric.join('; ')}`);
  if (text(o.html_url)) lines.push(`Link: ${text(o.html_url, 300)}`);
  return lines.join('\n');
}

/** The assignment of a lookup that a name means, or the names to ask about. */
export function matchAssignment(name: string, listRaw: string): { id?: string; names: string[] } {
  const list = asArray(parseJson(listRaw)).filter((a) => text(a.name) && (typeof a.id === 'number' || typeof a.id === 'string'));
  const names = list.map((a) => text(a.name, 80));
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(name);
  if (!want) return { names };
  const exact = list.find((a) => norm(text(a.name)) === want);
  if (exact) return { id: String(exact.id), names };
  const words = want.split(' ').filter((w) => w.length > 0);
  let best: { id: string; score: number } | null = null;
  let ties = 0;
  for (const a of list) {
    const title = norm(text(a.name));
    const score = words.filter((w) => title.split(' ').includes(w)).length / Math.max(words.length, title.split(' ').length);
    const contained = title.includes(want) || want.includes(title) ? 1 : 0;
    const total = Math.max(score, contained * 0.9);
    if (!best || total > best.score) {
      best = { id: String(a.id), score: total };
      ties = 1;
    } else if (total === best.score) ties++;
  }
  return best && best.score >= 0.5 && ties === 1 ? { id: best.id, names } : { names };
}

const fileKb = (size: unknown): string => (typeof size === 'number' && size > 0 ? (size >= 1_048_576 ? `${(size / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`) : '');

/** A file's link in Canvas: the origin of the download address the API gave, and the file's id (the page logs the student in). */
function fileLink(f: Record<string, unknown>): string {
  try {
    return `${new URL(text(f.url, 600)).origin}/files/${text(f.id)}/download`;
  } catch {
    return '';
  }
}

/** The course's files (the files action) as one line each, without the tokens in their download addresses. */
export function compactFiles(raw: string, max = 40): string | null {
  const files = asArray(parseJson(raw));
  if (!files.length && !Array.isArray(parseJson(raw))) return null;
  if (!files.length) return 'The course has no files in Canvas.';
  const rows = files.slice(0, max).map((f) => {
    const link = fileLink(f);
    return `file_id=${text(f.id)} "${text(f.display_name || f.filename, 90)}" (${text(f.content_type, 40) || 'file'}${fileKb(f.size) ? `, ${fileKb(f.size)}` : ''})${link ? ` link=${link}` : ''}`;
  });
  return `Course files, newest first (read one with file_content and its file_id):\n${rows.join('\n')}${files.length > max ? `\n[${files.length - max} more: use find with words from the title]` : ''}`;
}

interface Hit {
  score: number;
  line: string;
}

/** A title that looks like lecture material: "Day1 lecture ONLINE 2026", "Week 7 slides", "Day3_More_Fundamentals", reading notes. */
const LECTURE_TITLE = /lecture|slides?\b|\bdeck\b|notes\b|reading|\bday ?\d|\bweek ?\d/i;

const STOP = new Set([
  'the', 'and', 'for', 'with', 'about', 'from', 'that', 'this', 'please', 'can', 'you', 'have', 'any', 'file', 'files', 'pdf', 'slides', 'slide', 'lecture', 'notes', 'course', 'material', 'materials', 'page', 'pages',
  // what a student says around it ("can you see the slides", "open the lecture pdf for me"): not words of a title
  'see', 'show', 'open', 'read', 'view', 'look', 'give', 'send', 'get', 'got', 'tell', 'are', 'there', 'some', 'all', 'my', 'me', 'your', 'do', 'does', 'of', 'to', 'in', 'on', 'is', 'it',
]);

/**
 * Words from the student's request looked for in the titles of the course's files, module items and pages. "pdf" and "slides" say what
 * kind of thing it is, not which, so they only count when nothing else is asked for.
 */
export function findInCourse(query: string, filesRaw: string, modulesRaw: string, pagesRaw: string, assignmentsRaw = ''): string {
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const all = norm(query).trim().split(' ').filter((w) => w.length >= 2);
  const key = all.filter((w) => !STOP.has(w));
  const words = key.length ? key : all;
  if (!words.length) return 'Nothing to look for: give words from the title.';
  // "slides", "the lecture pdf": what kind of thing, not which. The instructor's titles say "Day1 lecture ONLINE 2026.pdf" and never "slides", so a
  // request for nothing but the kind of thing matches the titles that look like lecture material, and any PDF (a student who is told there are no
  // slides in a course that has thirty decks does not believe the next thing TAi says)
  const kindOnly = key.length === 0;
  const need = kindOnly ? 1 : Math.max(1, Math.ceil(words.length / 2));
  const score = (title: string, contentType = ''): number => {
    if (kindOnly) return LECTURE_TITLE.test(title) || /pdf/i.test(contentType) ? 1 : 0;
    const t = norm(title);
    return words.filter((w) => t.includes(` ${w}`) || t.includes(w)).length;
  };
  const files: Hit[] = [];
  for (const f of asArray(parseJson(filesRaw))) {
    const name = text(f.display_name || f.filename, 120);
    const s = score(name, text(f.content_type, 60));
    const link = fileLink(f);
    if (s >= need) files.push({ score: s, line: `file_id=${text(f.id)} "${name}" (${text(f.content_type, 40) || 'file'}${fileKb(f.size) ? `, ${fileKb(f.size)}` : ''})${link ? ` link=${link}` : ''}` });
  }
  const items: Hit[] = [];
  const moduleNames: string[] = [];
  for (const m of asArray(parseJson(modulesRaw))) {
    const moduleName = text(m.name, 80);
    moduleNames.push(moduleName);
    const moduleScore = score(moduleName);
    for (const i of asArray(m.items)) {
      const title = text(i.title, 120);
      // (an item of a module whose name matches counts too, except when only the kind of thing is asked for: every item of "Week 7" is not "slides")
      const s = kindOnly ? score(title) : Math.max(score(title), moduleScore >= need ? 1 : 0);
      if (s < need) continue;
      const type = text(i.type, 20);
      const ref =
        type === 'File' ? `file_id=${text(i.content_id)}` : type === 'Page' ? `page_url=${text(i.page_url, 100)}` : type === 'Assignment' ? `assignment_id=${text(i.content_id)}` : text(i.external_url || i.html_url, 300) ? `link=${text(i.external_url || i.html_url, 300)}` : '';
      items.push({ score: s, line: `"${title}" [${type || 'item'}] ${ref} (in module "${moduleName}")`.replace(/\s+\(/, ' (') });
    }
  }
  const pages: Hit[] = [];
  for (const p of asArray(parseJson(pagesRaw))) {
    const title = text(p.title, 120);
    const s = score(title);
    if (s >= need) pages.push({ score: s, line: `page_url=${text(p.url, 100)} "${title}"` });
  }
  // an assignment is not a file, a module or a page: "midterm mastery" is not in their titles, and in the owner's call of 2026-11-02 22:47 TAi
  // said there was no such thing on Canvas of a course that has Midterm Mastery Part 1 and Part 2
  const assignments: Hit[] = [];
  for (const a of asArray(parseJson(assignmentsRaw))) {
    const name = text(a.name, 120);
    const s = name ? score(name) : 0;
    if (s >= need) {
      const due = text(a.due_pacific || '', 40);
      const local = due ? localClock(a.due_local) : '';
      assignments.push({ score: s, line: `assignment_id=${text(a.id)} "${name}"${due ? ` (due ${due}${local ? `; on the student's own clock ${local}` : ''})` : ''}` });
    }
  }
  const top = (hits: Hit[], n: number) => hits.sort((a, b) => b.score - a.score).slice(0, n).map((h) => `- ${h.line}`);
  const out: string[] = [];
  if (assignments.length) out.push('Assignments (what one asks: assignment_detail with its assignment_id):', ...top(assignments, 6));
  if (files.length) out.push('Files (read one with file_content):', ...top(files, 6));
  if (items.length) out.push('Module items (a File has a file_id: read it with file_content; a Page has a page_url: read it with page_detail; a link or a video you cannot open: say where it is):', ...top(items, 8));
  if (pages.length) out.push('Pages (read one with page_detail):', ...top(pages, 5));
  if (!out.length) {
    return (
      `Nothing in the course's files, modules, pages or assignments matches "${query}" (find looks at their titles: the instructor names things by day or week, ` +
      `like "Day1 lecture ONLINE 2026.pdf", so "slides" or a topic is rarely in a title). Do not tell the student there is nothing yet: find again with "lecture" or the ` +
      `day or week, or open a module (module_items) and look at what is in it. The modules are: ${moduleNames.filter(Boolean).slice(0, 14).join('; ') || 'none'}.`
    );
  }
  out.push('These are the titles that match. For another one, find again with words from its title, or open a module (module_items).');
  return out.join('\n');
}

/** The modules of the course, one line per module and the titles in it that name a file or a page, short enough to be read whole. */
export function compactModules(raw: string): string | null {
  const modules = asArray(parseJson(raw));
  if (!modules.length) return Array.isArray(parseJson(raw)) ? 'The course has no modules.' : null;
  const rows = modules.map((m) => {
    const items = asArray(m.items).filter((i) => text(i.title) && text(i.type) !== 'SubHeader');
    const shown = items.slice(0, 6).map((i) => `${text(i.title, 50)} [${text(i.type, 12)}]`);
    return `module_id=${text(m.id)} "${text(m.name, 70)}" (${items.length} items${shown.length ? `: ${shown.join('; ')}${items.length > shown.length ? '; ...' : ''}` : ''})`;
  });
  return `Modules (the items of one: module_items with its module_id; to look for something by name: find):\n${rows.join('\n')}`;
}

/** Links in a text, without the punctuation a sentence puts after them. */
export function urlsIn(value: string): string[] {
  const found = value.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  return found.map((u) => u.replace(/[)\].,;:!?]+$/, ''));
}

/** Is `url` one of the links seen (the same address, a fragment or a trailing slash aside)? */
export function seenUrl(seen: ReadonlySet<string>, url: string): boolean {
  const clean = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  const want = clean(url);
  for (const s of seen) {
    const have = clean(s);
    if (have === want || (want.length > 30 && have.startsWith(want)) || (have.length > 30 && want.startsWith(have))) return true;
  }
  return false;
}
