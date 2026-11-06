// The pure parts of the teaching view (team-data.js): what a cell says, how rows are ordered and filtered, the words of a reason, the CSV of the
// heat map and what a spreadsheet must not be allowed to take for a formula; and that team.html names only files the server serves. (The page
// itself is DOM: it is looked at in the dev server, portal/qa/dev_server.mjs.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CSV_HEADER,
  FORBIDDEN_WORDS,
  agoText,
  cellInfo,
  csvField,
  csvName,
  csvRow,
  dayText,
  describeCell,
  heatmapCsv,
  hoursText,
  levelOf,
  matches,
  minutesText,
  orderStudents,
  percent,
  questionRows,
  reasonText,
  sortRows,
  viewForStatus,
} from './team-data.js';

const BANDS = { solid: 0.7, gettingThere: 0.4 };

describe('where a confidence stands', () => {
  it('is solid from 0.7, getting there from 0.4, just started above 0, and not started at 0, by the bands the server sent', () => {
    expect(levelOf(1, BANDS)).toBe('solid');
    expect(levelOf(0.7, BANDS)).toBe('solid');
    expect(levelOf(0.699, BANDS)).toBe('getting');
    expect(levelOf(0.4, BANDS)).toBe('getting');
    expect(levelOf(0.399, BANDS)).toBe('started');
    expect(levelOf(0.01, BANDS)).toBe('started');
    expect(levelOf(0, BANDS)).toBe('none');
    expect(levelOf(-1, BANDS)).toBe('none');
    expect(levelOf(NaN, BANDS)).toBe('none');
    expect(levelOf(0.5, { solid: 0.9, gettingThere: 0.6 })).toBe('started');          // not numbers of this file's own
  });
});

describe('a cell of the heat map', () => {
  it('is the confidence, the stability, the scopes, the last evidence and whether it is a verbal gap; nothing is no cell', () => {
    expect(cellInfo([0.8, 0.5, ['theoretical', 'implementation'], '2026-11-01', 1])).toEqual({ confidence: 0.8, stability: 0.5, scope: ['theoretical', 'implementation'], last: '2026-11-01', gap: true });
    expect(cellInfo([0.2, 0.1, [], '', 0])).toEqual({ confidence: 0.2, stability: 0.1, scope: [], last: '', gap: false });
    expect(cellInfo(null)).toBeNull();
    expect(cellInfo(undefined)).toBeNull();
    expect(cellInfo('x')).toBeNull();
    expect(cellInfo([])).toEqual({ confidence: 0, stability: 0, scope: [], last: '', gap: false });
  });

  it('says what it holds in words, with the level as a word and the verbal gap said', () => {
    expect(describeCell('Carol', 'Raft', [0.8, 0.5, ['theoretical', 'implementation'], '2026-11-01', 1], BANDS)).toBe(
      'Carol, Raft: solid (confidence 0.80, stability 0.50); shown in theoretical and implementation; has not explained it out loud (mock interview risk); last evidence 2026-11-01.',
    );
    expect(describeCell('Bob', 'Paxos', [0.4, 0.1, [], '', 0], BANDS)).toBe('Bob, Paxos: getting there (confidence 0.40, stability 0.10); no context recorded; no date.');
    expect(describeCell('Dave', 'Raft', null, BANDS)).toBe('Dave, Raft: no evidence yet.');
  });
});

describe('filtering and ordering', () => {
  it('matches when every word of the query is in the text, in any order and whatever the case; an empty query matches all', () => {
    expect(matches('Raft (leader election, log replication)', 'raft election')).toBe(true);
    expect(matches('Raft (leader election, log replication)', 'ELECTION  raft')).toBe(true);
    expect(matches('Raft (leader election, log replication)', 'raft paxos')).toBe(false);
    expect(matches('anything', '')).toBe(true);
    expect(matches('anything', '   ')).toBe(true);
    expect(matches(undefined, 'x')).toBe(false);
    expect(matches(undefined, '')).toBe(true);
  });

  it('sorts a copy, by numbers or by words, keeps equal rows in the order they came, and puts what is missing last whichever way', () => {
    const rows = [{ n: 'c', v: 2 }, { n: 'a', v: null }, { n: 'b', v: 1 }, { n: 'd', v: 2 }, { n: 'e', v: undefined }];
    const asc = sortRows(rows, (r) => r.v, 'asc');
    expect(asc.map((r) => r.n)).toEqual(['b', 'c', 'd', 'a', 'e']);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.n)).toEqual(['c', 'd', 'b', 'a', 'e']);
    expect(rows.map((r) => r.n)).toEqual(['c', 'a', 'b', 'd', 'e']);                         // the original is as it was
    expect(sortRows(rows, (r) => r.n, 'asc').map((r) => r.n)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(sortRows(['b', 'B', 'a'], (s) => s, 'asc')).toEqual(['a', 'b', 'B']);
  });

  it('orders the students\' columns: as sent, weakest mean first (none last), or never wrote and then the longest quiet', () => {
    const students = [
      { name: 'Ann', mean: 0.8, quietDays: 1 },
      { name: 'Ben', mean: null, quietDays: 30 },
      { name: 'Cy', mean: 0.2, quietDays: null },
      { name: 'Di', mean: 0.5, quietDays: 9 },
    ];
    expect(orderStudents(students, 'name')).toEqual([0, 1, 2, 3]);
    expect(orderStudents(students, 'weakest')).toEqual([2, 3, 0, 1]);
    expect(orderStudents(students, 'quiet')).toEqual([2, 1, 3, 0]);
    expect(orderStudents([], 'weakest')).toEqual([]);
  });
});

describe('the words of the page', () => {
  it('says why a student needs attention, in each of the four ways', () => {
    expect(reasonText({ kind: 'quiet', days: null })).toBe('has not written to TAi yet');
    expect(reasonText({ kind: 'quiet', days: 1 })).toBe('has not written or called for 1 day');
    expect(reasonText({ kind: 'quiet', days: 12 })).toBe('has not written or called for 12 days');
    expect(reasonText({ kind: 'deadline', assignment: '901', hours: 20 })).toBe('Canvas assignment 901 is due in about 20 hours and nothing is turned in (the last patrol before it)');
    expect(reasonText({ kind: 'overdue', assignment: '902', hours: 30 })).toBe('Canvas assignment 902 was due about 30 hours ago and nothing is turned in');
    expect(reasonText({ kind: 'misconception', concepts: ['Raft'] })).toBe('1 confirmed misconception not remediated: Raft');
    expect(reasonText({ kind: 'misconception', concepts: ['Raft', 'Paxos'] })).toBe('2 confirmed misconceptions not remediated: Raft; Paxos');
    expect(reasonText({ kind: 'something-new' })).toBe('');
  });

  it('counts hours up to a day and a half and days after that', () => {
    expect(hoursText(1)).toBe('1 hour');
    expect(hoursText(35)).toBe('35 hours');
    expect(hoursText(36)).toBe('2 days');
    expect(hoursText(72)).toBe('3 days');
  });

  it('says how long ago, a day by the reader\'s calendar, minutes and percent', () => {
    expect(agoText(0)).toBe('today');
    expect(agoText(1)).toBe('yesterday');
    expect(agoText(5)).toBe('5 days ago');
    expect(agoText(null)).toBe('never');
    // days are counted by the calendar from the server's day, so no time zone of the machine this runs on can move them
    expect(dayText('2026-11-04', '2026-11-04')).toBe('today');
    expect(dayText('2026-11-03', '2026-11-04')).toBe('yesterday');
    expect(dayText('2026-10-30', '2026-11-04')).toBe('Oct 30');
    expect(dayText('2026-11-05', '2026-11-04')).toBe('Nov 5');                            // a day ahead is a date, not "today"
    expect(dayText('2025-01-02', '2026-11-04')).toBe('Jan 2, 2025');
    expect(dayText('2026-12-31', '2027-01-01')).toBe('yesterday');                       // over the new year
    expect(dayText('2026-10-30')).toBe('Oct 30');                                        // no day to count from
    expect(dayText('', '2026-11-04')).toBe('');
    expect(dayText(undefined, '2026-11-04')).toBe('');
    expect(dayText('sometime', '2026-11-04')).toBe('sometime');
    expect(minutesText(0)).toBe('–');
    expect(minutesText(12)).toBe('12');
    expect(minutesText(12.5)).toBe('12.5');
    expect(percent(2, 4)).toBe(50);
    expect(percent(1, 3)).toBe(33);
    expect(percent(0, 0)).toBeNull();
  });

  it('draws the answer of the server, goes to the sign-in, says the page is not for the account, or says it did not work', () => {
    expect(viewForStatus(200)).toBe('ok');
    expect(viewForStatus(401)).toBe('signin');
    expect(viewForStatus(403)).toBe('forbidden');
    for (const status of [0, 400, 404, 429, 500, 502]) expect(viewForStatus(status)).toBe('error');
    expect(FORBIDDEN_WORDS).toBe('This page is for the teaching team');
  });
});

describe('the quick checks', () => {
  const rows = [
    { question: 'Which of these is true of a Raft term?', answers: 4, graded: 4, right: 2, percentRight: 50 },
    { question: 'What does a goroutine leak look like?', answers: 1, graded: 1, right: 0, percentRight: 0 },
    { question: 'Which keys move?', answers: 2, graded: 2, right: 2, percentRight: 100 },
    { question: 'And this one?', answers: 3, graded: 0, right: 0, percentRight: null },
  ];

  it('are the questions with enough answers, matching what is typed, most answered or hardest first', () => {
    expect(questionRows(rows).map((q) => q.answers)).toEqual([4, 3, 2, 1]);
    expect(questionRows(rows, { min: 2 }).map((q) => q.answers)).toEqual([4, 3, 2]);
    expect(questionRows(rows, { key: 'right', dir: 'asc' }).map((q) => q.percentRight)).toEqual([0, 50, 100, null]);
    expect(questionRows(rows, { key: 'right', dir: 'desc' }).map((q) => q.percentRight)).toEqual([100, 50, 0, null]);
    expect(questionRows(rows, { query: 'RAFT' }).map((q) => q.answers)).toEqual([4]);
    expect(questionRows(rows, { key: 'question', dir: 'asc' })[0].question).toBe('And this one?');
    expect(questionRows([], { min: 5 })).toEqual([]);
  });
});

describe('the CSV of the heat map', () => {
  it('puts a quote mark in front of a text that a spreadsheet would run as a formula: = + - @, a tab, a carriage return', () => {
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('-2')).toBe("'-2");
    expect(csvField('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvField('\tcmd')).toBe("'\tcmd");
    expect(csvField('=HYPERLINK("http://example.com","x")')).toBe('"\'=HYPERLINK(""http://example.com"",""x"")"');
    expect(csvField('=a,b')).toBe('"\'=a,b"');                                           // the guard and the quoting together
    expect(csvField('\rx')).toBe('"\'\rx"');
    expect(csvField('a=b')).toBe('a=b');                                                // only a first character is a formula
    expect(csvField('- ')).toBe("'- ");
  });

  it('quotes what has a comma, a quote or a line break, doubles a quote inside, and writes numbers as they are', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a, b')).toBe('"a, b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField(0.85)).toBe('0.85');
    expect(csvField(0)).toBe('0');
    expect(csvField(NaN)).toBe('');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvRow(['a', 1, 'b,c', null])).toBe('a,1,"b,c",');
  });

  const overview = {
    bands: BANDS,
    students: [{ name: 'Ada Lovelace' }, { name: '=cmd|\' /C calc\'!A0' }, { name: 'Cy "Cy" Young' }],
    concepts: [
      { name: 'Raft (leader election, log replication)', group: 'Week 11: Consensus & Replication (HW10)', cells: [[0.8, 0.5, ['theoretical', 'implementation'], '2026-11-01', 1], null, [0.2, 0.1, ['verbal'], '', 0]] },
      { name: '@concept', group: '', cells: [null, [0.75, 0.6, [], '2026-10-30', 0], null] },
      { name: 'Nobody has this', group: '', cells: [null, null, null] },
    ],
  };

  it('is one row for each student and concept with evidence, under a header, with CRLF line ends and nothing a formula', () => {
    const csv = heatmapCsv(overview);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(CSV_HEADER.join(','));
    expect(lines.pop()).toBe('');                                                        // ends with a line break
    expect(lines).toHaveLength(1 + 3);
    expect(lines[1]).toBe('Ada Lovelace,"Raft (leader election, log replication)",Week 11: Consensus & Replication (HW10),0.8,0.5,solid,theoretical; implementation,2026-11-01,yes');
    expect(lines[2]).toBe('"Cy ""Cy"" Young","Raft (leader election, log replication)",Week 11: Consensus & Replication (HW10),0.2,0.1,just started,verbal,,no');
    expect(lines[3]).toBe("'=cmd|' /C calc'!A0,'@concept,,0.75,0.6,solid,,2026-10-30,no");
    for (const line of lines.slice(1)) expect(/^[=+\-@]/.test(line)).toBe(false);          // no row begins as a formula
    expect(csv).not.toContain('Nobody has this');
  });

  it('is only the rows it is given (the page hands it the concepts the filter leaves), and a header alone for an empty class', () => {
    expect(heatmapCsv(overview, [overview.concepts[1]]).split('\r\n')).toHaveLength(3);
    expect(heatmapCsv({ bands: BANDS, students: [], concepts: [] })).toBe(`${CSV_HEADER.join(',')}\r\n`);
  });

  it('names its file for the day', () => {
    expect(csvName(new Date('2026-11-04T20:00:00Z'))).toBe('tai-competency-2026-11-04.csv');
  });
});

// ---------------------------------------------------------------- what the page names

describe('team.html', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (...parts) => fs.readFileSync(path.join(here, ...parts), 'utf-8');
  const start = read('..', '..', 'src', 'portal', 'start.ts');
  const list = /export const PAGE_FILES = \[([^\]]*)\]/.exec(start);
  const served = list ? [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const html = read('team.html');

  it('names only files the server serves, and the modules its script imports are served too', () => {
    const wanted = new Set([...html.matchAll(/(?:src|href)="([A-Za-z0-9_.-]+\.(?:js|css|svg))"/g)].map((m) => m[1]));
    const queue = [...wanted].filter((name) => name.endsWith('.js'));
    for (let file = queue.shift(); file; file = queue.shift()) {
      for (const m of read(file).matchAll(/from\s+'\.\/([A-Za-z0-9_.-]+\.js)'/g)) {
        if (!wanted.has(m[1])) {
          wanted.add(m[1]);
          queue.push(m[1]);
        }
      }
    }
    expect([...wanted].sort()).toEqual(expect.arrayContaining(['style.css', 'team.css', 'team.js', 'team-data.js']));
    expect([...wanted].filter((name) => !served.includes(name))).toEqual([]);
    expect(served).toContain('team.html');
    for (const name of ['team.html', 'team.js', 'team-data.js', 'team.css']) expect(fs.existsSync(path.join(here, name)), name).toBe(true);
  });

  it('uses only addresses relative to itself (the page lives under a base path the server does not rewrite in this file), and no inline script', () => {
    for (const m of html.matchAll(/(?:src|href|action)="([^"]*)"/g)) {
      const url = m[1];
      if (url.startsWith('#')) continue;
      expect(url, url).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:|\/)/i);
    }
    expect(html).not.toMatch(/<base\b/i);
    expect(html).not.toContain('__BASE__');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);                          // every script has a src: the policy allows no inline script
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);                                         // no inline handler
    expect(html).toMatch(/<meta name="viewport"/);
    expect(html).toMatch(/<html lang="en"/);
  });

  it('is drawn without innerHTML: nothing a student, a model or the server wrote becomes markup', () => {
    for (const file of ['team.js', 'team-data.js']) {
      expect(read(file), file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    }
  });
});
