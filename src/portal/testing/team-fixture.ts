/**
 * A synthetic class as REAL FILES, for the teaching-team view's tests and for the dev server (portal/qa/dev_server.mjs): twelve students and one
 * teaching-team account under a temporary directory, written with the orchestrator's own writers (History.append for the chats and the quick
 * checks, VoiceUsage for store/voice-usage.json, appendVoiceSession for the calls) and from the real groups/global/COMPETENCY_TEMPLATE.md, so
 * that the view reads what it reads in production and nothing else. Nothing here is a real person: Ada, Bob and the rest are `@example.com`.
 *
 *   bob     strong across weeks 1 to 4 (labelled spelling), wrote today, two calls
 *   carol   strong in theory on Raft, Paxos, CAP and hashing and has never said any of it out loud: the verbal gap
 *   dave    weak: a few concepts, all just started; the patrol's log in the scheduler's own format (a skip, two runs, a failure)
 *   erin    quiet for 12 days, and a CONFIRMED misconception on concurrency that nobody has remediated
 *   frank   the same mix-up, a candidate (one sighting); answers quick checks
 *   gina    the same mix-up, confirmed; an `identifying` line that is not a misconception; a deadline that is the last chance
 *   hana    a remediated misconception; the older two-line spelling of the mastery lines
 *   ivan    on the list and has never opened the page: no files at all
 *   june    the voice user: four calls this week, one day at the daily cap
 *   kai     the quick-check user: nine answers, right, wrong and ungraded
 *   lena    a COMPETENCY.md the view cannot read, and a history with a broken line in it
 *   mike    solid but going stale (confidence high, stability low, no evidence for a month); an overdue deadline; the patrol's log
 *   ada     a teaching-team account: left out of the class unless asked for
 *
 * Every file the view must NOT read out holds a CANARY- string (a chat message, a call's transcript and summary, the belief of a misconception,
 * the learning-style line, a saved note, an upload, the summaries and logs of the agent, the text a model answered in a patrol run, an error):
 * `fixture.canaries` lists them, and a test asserts that none is in any answer.
 */
import fs from 'fs';
import path from 'path';

import { interventionLine } from '../../intervention-log.js';
import type { PatrolRecord } from '../../intervention-log.js';
import type { Snapshot } from '../../student-course.js';
import { VoiceUsage } from '../../voice/usage.js';
import { appendVoiceSession, findConcept, parseMastery, renderMastery } from '../../voice/competency.js';
import type { MasteryEntry, MasteryFormat } from '../../voice/competency.js';
import { History } from '../history.js';
import type { PatrolRow, RosterEntry, TeamDb, TeamDeps } from '../team.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const FIXTURE_PEOPLE: Array<{ key: string; name: string; canvasUserId: string; staff?: boolean }> = [
  { key: 'ada', name: 'Ada Lovelace', canvasUserId: '1001', staff: true },
  { key: 'bob', name: 'Bob Barker', canvasUserId: '1002' },
  { key: 'carol', name: 'Carol Shaw', canvasUserId: '1003' },
  { key: 'dave', name: 'Dave Cutler', canvasUserId: '1004' },
  { key: 'erin', name: 'Erin Brockovich', canvasUserId: '1005' },
  { key: 'frank', name: 'Frank Lloyd', canvasUserId: '1006' },
  { key: 'gina', name: 'Gina Torres', canvasUserId: '1007' },
  { key: 'hana', name: 'Hana Kimura', canvasUserId: '1008' },
  { key: 'ivan', name: 'Ivan Petrov', canvasUserId: '1009' },
  { key: 'june', name: 'June Park', canvasUserId: '1010' },
  { key: 'kai', name: 'Kai Tanaka', canvasUserId: '1011' },
  { key: 'lena', name: 'Lena Fischer', canvasUserId: '1012' },
  { key: 'mike', name: 'Mike Okafor', canvasUserId: '1013' },
];

export const CANARIES = {
  chat: 'CANARY-CHAT-my-code-deadlocks-and-i-do-not-know-why',
  voice: 'CANARY-VOICE-so-i-think-raft-is-basically-paxos',
  summary: 'CANARY-SUMMARY-student-struggled-with-terms',
  belief: 'CANARY-BELIEF-concurrency-and-parallelism-are-the-same',
  style: 'CANARY-STYLE-learns-best-with-football-analogies',
  note: 'CANARY-NOTE-has-a-job-interview-on-friday',
  upload: 'CANARY-UPLOAD-func main() { secret homework }',
  agent: 'CANARY-AGENT-interaction-summary-of-a-private-chat',
  model: 'CANARY-MODEL-the-patrol-decided-to-message-bob',
  error: 'CANARY-ERROR-stack-trace-with-a-path-in-it',
  why: 'CANARY-WHY-the-host-keeps-this-note-on-the-answer',
} as const;

const QUESTIONS = {
  raft: 'Which of these is true of a Raft term?',
  leak: 'What does a goroutine leak look like in a service?',
  hash: 'When a node joins a consistent-hashing ring, which keys move?',
  amdahl: "Amdahl's law says the speed-up of a program is limited by what?",
};

interface Edit {
  concept: string;
  confidence: number;
  stability?: number;
  scope?: string[];
  via?: string[];
  /** Days ago the evidence is from; absent: today's. */
  ago?: number;
}

const day = (now: number, ago: number): string => new Date(now - ago * DAY).toISOString().slice(0, 10);

/** The template with some concepts moved (found by name, rewritten in the spelling asked for) and some Active Misconceptions lines put in. */
function competencyText(template: string, now: number, edits: Edit[], more: { format?: MasteryFormat; misconceptions?: string[]; style?: string } = {}): string {
  const lines = template.split('\n');
  const entries = parseMastery(template);
  const changed: MasteryEntry[] = [];
  for (const edit of edits) {
    const e = findConcept(entries, edit.concept);
    if (!e) throw new Error(`the template has no concept like "${edit.concept}"`);
    e.confidence = edit.confidence;
    e.stability = edit.stability ?? 0.2;
    e.scope = edit.scope ?? ['theoretical'];
    e.via = edit.via ?? ['socratic_dialogue'];
    e.last = day(now, edit.ago ?? 0);
    if (more.format) e.format = more.format;
    changed.push(e);
  }
  for (const e of [...new Set(changed)].sort((a, b) => b.line - a.line)) lines.splice(e.line, e.span, ...renderMastery(e));
  let text = lines.join('\n');
  if (more.style) text = text.replace(/^- Learning style:.*$/m, `- Learning style: ${more.style}`);
  if (more.misconceptions?.length) text = text.replace(/^## Active Misconceptions[ \t]*$/m, (heading) => `${heading}\n\n${more.misconceptions!.join('\n')}`);
  return text;
}

const misconception = (belief: string, concept: string, fields: string): string =>
  `- "${belief}" | contradicts: ${concept} | ${fields}`;

export interface TeamFixture {
  deps: TeamDeps;
  roster: RosterEntry[];
  now: number;
  dir: string;
  folderOf: (key: string) => string;
  /** Strings that sit in files the view must not read out: none may be in any answer. */
  canaries: string[];
  /** What the fake database answers, for a test to change. */
  db: { patrol: PatrolRow[]; cron: string | null; messages: Map<string, string> };
  snapshot: { at: string; snapshot: Snapshot };
}

export interface TeamFixtureOptions {
  /** The moment "now" is: the dates of everything are relative to it. */
  now: number;
  /** groups/global/COMPETENCY_TEMPLATE.md. */
  template: string;
  /** The folder of a student (`s_` and 20 hex digits): from the allowlist in the dev server, from studentFolder() in a test. */
  folderOf: (key: string) => string;
}

export function writeTeamFixture(dir: string, opts: TeamFixtureOptions): TeamFixture {
  const { now, template, folderOf } = opts;
  const groupsDir = path.join(dir, 'groups');
  const historyDir = path.join(dir, 'history');
  const voiceUsageFile = path.join(dir, 'voice-usage.json');
  fs.mkdirSync(groupsDir, { recursive: true });
  fs.mkdirSync(historyDir, { recursive: true });

  const at = (ago: number, extra = 0): Date => new Date(now - ago * DAY - extra);
  const write = (key: string, relative: string, text: string): void => {
    const file = path.join(groupsDir, folderOf(key), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf-8');
  };
  const text = (key: string, edits: Edit[], more?: Parameters<typeof competencyText>[3]): void => write(key, 'COMPETENCY.md', competencyText(template, now, edits, more));
  const solid = (concept: string, ago: number, scope = ['theoretical', 'implementation', 'verbal'], via = ['socratic_dialogue', 'mock_interview']): Edit => ({
    concept,
    confidence: 0.85,
    stability: 0.7,
    scope,
    via,
    ago,
  });

  // ---- the competency files
  text(
    'bob',
    [
      solid('Go programming basics', 9),
      solid('RESTful API design (Go/Gin)', 8),
      solid('Docker concepts (images, containers, Dockerfile)', 4),
      solid('Concurrency vs parallelism distinction', 3),
      solid('ACID properties', 6),
      { concept: 'Raft (leader election, log replication)', confidence: 0.75, stability: 0.5, scope: ['theoretical', 'verbal'], via: ['mock_interview'], ago: 2 },
      { concept: 'Paxos', confidence: 0.6, stability: 0.4, scope: ['theoretical', 'verbal'], via: ['mock_interview'], ago: 2 },
    ],
    { format: 'labelled' },
  );
  text('carol', [
    { concept: 'Raft (leader election, log replication)', confidence: 0.8, stability: 0.5, scope: ['theoretical', 'implementation'], ago: 3 },
    { concept: 'Paxos', confidence: 0.75, stability: 0.5, scope: ['theoretical', 'implementation'], ago: 3 },
    { concept: 'CAP theorem (CP vs AP tradeoffs)', confidence: 0.8, stability: 0.4, scope: ['theoretical'], ago: 5 },
    { concept: 'Consistent hashing and partitioning strategies', confidence: 0.7, stability: 0.4, scope: ['theoretical', 'implementation'], ago: 5 },
    { concept: 'Go programming basics', confidence: 0.9, stability: 0.8, scope: ['theoretical', 'implementation', 'verbal'], ago: 12 },
    { concept: 'Two-phase commit (2PC)', confidence: 0.5, stability: 0.3, scope: ['theoretical'], ago: 6 },
  ]);
  text('dave', [
    { concept: 'Go programming basics', confidence: 0.35, stability: 0.1, ago: 6 },
    { concept: 'Docker concepts (images, containers, Dockerfile)', confidence: 0.2, stability: 0.1, ago: 4 },
    { concept: 'Concurrency vs parallelism distinction', confidence: 0.15, stability: 0.1, ago: 2 },
    { concept: 'Load balancers', confidence: 0.1, stability: 0.1, ago: 2 },
  ]);
  text(
    'erin',
    [
      { concept: 'Go programming basics', confidence: 0.55, stability: 0.3, scope: ['theoretical', 'implementation'], ago: 20 },
      { concept: 'Concurrency vs parallelism distinction', confidence: 0.3, stability: 0.1, ago: 20 },
      { concept: 'Docker concepts (images, containers, Dockerfile)', confidence: 0.5, stability: 0.2, ago: 21 },
    ],
    { misconceptions: [misconception(CANARIES.belief, 'Concurrency vs parallelism distinction', `status: confirmed | freq: 3 | first: ${day(now, 30)} | last: ${day(now, 20)} | holding | remediation: none yet | effective: unknown`)] },
  );
  text(
    'frank',
    [
      { concept: 'Concurrency vs parallelism distinction', confidence: 0.4, stability: 0.2, ago: 3 },
      { concept: 'Go programming basics', confidence: 0.6, stability: 0.4, scope: ['theoretical', 'implementation'], ago: 7 },
      { concept: "Amdahl's Law and parallelism limits", confidence: 0.35, stability: 0.1, ago: 3 },
    ],
    { misconceptions: [misconception(CANARIES.belief, 'Concurrency vs parallelism distinction', `status: candidate | freq: 1 | first: ${day(now, 3)} | last: ${day(now, 3)} | holding | remediation: none yet | effective: unknown`)] },
  );
  text(
    'gina',
    [
      { concept: 'Concurrency vs parallelism distinction', confidence: 0.3, stability: 0.1, ago: 4 },
      { concept: 'ACID properties', confidence: 0.65, stability: 0.4, scope: ['theoretical', 'verbal'], ago: 5 },
      { concept: 'Terraform / Infrastructure as Code', confidence: 0.45, stability: 0.2, scope: ['implementation'], via: ['homework'], ago: 9 },
    ],
    {
      misconceptions: [
        misconception(CANARIES.belief, 'Concurrency vs parallelism distinction', `status: confirmed | freq: 4 | first: ${day(now, 14)} | last: ${day(now, 4)} | holding | remediation: Socratic once | effective: false`),
        misconception('a student explaining why X is wrong', 'ACID properties', `status: candidate | freq: 1 | first: ${day(now, 5)} | last: ${day(now, 5)} | identifying | remediation: none | effective: unknown`),
      ],
    },
  );
  text(
    'hana',
    [
      { concept: "Little's Law and queue theory", confidence: 0.7, stability: 0.5, scope: ['theoretical', 'implementation'], ago: 3 },
      { concept: 'Load balancers', confidence: 0.75, stability: 0.5, scope: ['theoretical', 'verbal'], ago: 4 },
      { concept: 'Stateless vs stateful services', confidence: 0.55, stability: 0.3, ago: 6 },
    ],
    {
      format: 'labelled2',
      misconceptions: [misconception(CANARIES.belief, "Little's Law and queue theory", `status: remediated | freq: 2 | first: ${day(now, 20)} | last: ${day(now, 8)} | holding | remediation: worked example | effective: true`)],
    },
  );
  text(
    'june',
    [
      { concept: 'Raft (leader election, log replication)', confidence: 0.6, stability: 0.3, scope: ['theoretical', 'verbal'], via: ['socratic_dialogue', 'mock_interview'], ago: 1 },
      { concept: 'Consistent hashing and partitioning strategies', confidence: 0.5, stability: 0.3, scope: ['theoretical', 'verbal'], ago: 2 },
      { concept: 'CAP theorem (CP vs AP tradeoffs)', confidence: 0.55, stability: 0.3, scope: ['theoretical', 'verbal'], ago: 2 },
    ],
    { style: CANARIES.style },
  );
  text('kai', [
    { concept: 'Raft (leader election, log replication)', confidence: 0.5, stability: 0.2, ago: 1 },
    { concept: "Amdahl's Law and parallelism limits", confidence: 0.45, stability: 0.2, ago: 1 },
    { concept: 'Consistent hashing and partitioning strategies', confidence: 0.4, stability: 0.2, ago: 2 },
    { concept: 'Concurrency and threads (goroutines, atomic, mutex, RWMutex, sync.Map)', confidence: 0.35, stability: 0.1, ago: 1 },
  ]);
  write('lena', 'COMPETENCY.md', `# Student Competency Model\n\n${'the agent wrote this file in a shape nobody has seen; '.repeat(12)}\n`);
  text('mike', [
    { concept: 'Docker concepts (images, containers, Dockerfile)', confidence: 0.85, stability: 0.2, scope: ['theoretical', 'implementation'], ago: 30 },
    { concept: 'MapReduce paper concepts', confidence: 0.8, stability: 0.2, scope: ['theoretical', 'implementation', 'verbal'], via: ['mock_interview'], ago: 28 },
    { concept: 'Terraform / Infrastructure as Code', confidence: 0.6, stability: 0.4, scope: ['implementation'], via: ['homework'], ago: 30 },
  ]);
  text('ada', [
    { concept: 'Raft (leader election, log replication)', confidence: 0.9, stability: 0.8, scope: ['theoretical', 'implementation', 'verbal'], ago: 1 },
    { concept: 'Go programming basics', confidence: 0.9, stability: 0.8, scope: ['theoretical', 'implementation', 'verbal'], ago: 1 },
  ]);

  // ---- what the agent keeps beside it (the view must never read these out)
  for (const key of ['bob', 'carol', 'june', 'kai', 'mike']) {
    write(key, 'competency/interaction-summary.md', `# Interaction Summary\n\n- ${CANARIES.agent}\n`);
    write(key, 'competency/strategy-log.md', `# Teaching Strategy Log\n\n- ${CANARIES.agent}\n`);
    write(key, 'memory_store.json', JSON.stringify({ memories: [{ text: CANARIES.note }] }));
    write(key, 'uploads/hw3.go', `package main\n// ${CANARIES.upload}\n`);
  }

  // ---- the patrol's log, written by the agent (a1's host-written file may look different: the view reads a line that begins with a date)
  write('mike', 'competency/intervention-log.md', [
    '# Intervention Log',
    '',
    `- ${day(now, 1)}: intervene — Docker confidence 0.85 but stability 0.2 and no evidence for 30 days; sent a quick check.`,
    `- ${day(now, 3)}: no-action — mock interview is a week away, nothing new.`,
    `${day(now, 9)}: no-action — deadline far off.`,
    `- ${day(now, 20)}: intervene — older than the week.`,
    '',
  ].join('\n'));
  // the scheduler's own lines (src/intervention-log.ts), with the dates of this fixture
  const patrolLine = (ago: number, record: PatrolRecord): string => interventionLine(day(now, ago), record);
  write('dave', 'competency/intervention-log.md', [
    '# Intervention Log',
    '',
    patrolLine(1, { kind: 'skipped', keys: ['inactive'], weekly: false }),
    patrolLine(2, { kind: 'ran', sent: false, keys: ['spaced:ab12cd34'], weekly: true, seconds: 31, gate: 'on', shadowSkip: false }),
    patrolLine(3, { kind: 'ran', sent: true, keys: ['due-last:901'], weekly: false, seconds: 44, gate: 'on', shadowSkip: false }),
    patrolLine(5, { kind: 'failed', why: 'model', apiFailure: 'other', sent: false, keys: ['inactive'], weekly: false, seconds: 12, gate: 'on' }),
    '',
  ].join('\n'));
  write('carol', 'competency/intervention-log.md', `# Intervention Log\n\n- ${day(now, 2)}: no-action — Raft is solid in theory; verbal practice is for the mock interview.\n`);
  write('bob', 'competency/intervention-log.md', '# Intervention Log\n\n');                    // the seeded file with nothing in it

  // ---- the chats: quick checks and the taps on them (History.append is the writer the page's server uses), and what students wrote
  const ask = (key: string, ago: number, question: string, options: string[], keyIndex: number | null, tap: number | null, opts2: { quiz?: boolean } = {}): void => {
    const history = new History(path.join(historyDir, `${folderOf(key)}.jsonl`));
    const when = at(ago);
    const choices = options.map((text, i) => ({ label: 'ABCDEF'[i], text }));
    const line = history.append('assistant', question, when, {
      choices,
      ...(opts2.quiz === false ? {} : { quiz: true }),
      ...(keyIndex !== null ? { secret: { key: keyIndex, why: CANARIES.why } } : { secret: { doubt: true, why: CANARIES.why } }),
    });
    if (tap !== null) {
      const correct = keyIndex !== null ? tap === keyIndex : undefined;
      history.append('user', `${choices[tap].label}. ${choices[tap].text}`, new Date(when.getTime() + 20_000), { id: `tap-${key}-${line.n}`, choice: { to: line.n, index: tap, ...(correct !== undefined ? { correct } : {}) } });
    }
  };
  const raft = ['Every heartbeat starts a new term', 'A term has at most one leader', 'The term number can go down after a failure'];
  ask('kai', 5, QUESTIONS.raft, raft, 1, 1);                       // right
  ask('kai', 4, QUESTIONS.leak, ['Memory that never levels off', 'A CPU at 100% with nothing queued', 'Fewer goroutines after each request'], 0, 2);    // wrong
  ask('kai', 3, QUESTIONS.hash, ['Every key', 'Only the keys the new node now owns', 'None, until a rebalance'], 1, 1);                          // right
  ask('kai', 2, QUESTIONS.amdahl, ['The serial part of the program', 'The clock speed', 'The number of threads'], 0, 0);                          // right
  ask('kai', 1, 'Which part of Raft is confusing?', ['Elections', 'Log replication', 'Both'], null, 1, { quiz: false });                          // quick replies: not a quick check
  ask('kai', 0, 'And this one, which the host doubted?', ['One', 'Two'], null, 0);                                                              // a quick check whose key was dropped: ungraded
  ask('kai', 0, QUESTIONS.raft, raft, 1, 0);                      // the same question again, wrong (a second time for the same student)
  ask('frank', 4, QUESTIONS.raft, raft, 1, 0);                    // wrong
  ask('june', 2, QUESTIONS.raft, raft, 1, 1);                     // right
  ask('june', 1, QUESTIONS.hash, ['Every key', 'Only the keys the new node now owns', 'None, until a rebalance'], 1, null);                       // asked, not answered
  for (const key of ['bob', 'carol', 'dave', 'frank', 'june', 'kai']) {
    const history = new History(path.join(historyDir, `${folderOf(key)}.jsonl`));
    history.append('user', `${CANARIES.chat} (${key})`, at(0, 2 * HOUR));
    history.append('assistant', 'What have you tried so far?', at(0, 2 * HOUR - 5000));
    history.append('user', `${CANARIES.voice}`, at(0, HOUR), { kind: 'speech', call: 'c1' });
  }
  // a history with a line that is not JSON in it (a crash left half of one): skipped, not a failed page
  fs.appendFileSync(path.join(historyDir, `${folderOf('lena')}.jsonl`), '{"n":1,"role":"assistant","quiz":tr\nnot json at all\n');

  // ---- the voice: calls (the real writer), and the minutes per day
  const call = (key: string, ago: number, minutes: number, mode = 'conversational'): void =>
    appendVoiceSession(path.join(groupsDir, folderOf(key)), {
      startedAt: `${day(now, ago)} 14:05`,
      minutes,
      modes: mode,
      summary: CANARIES.summary,
      competency: [],
      transcript: [{ role: 'student', text: CANARIES.voice, mode: mode === 'interviewer' ? 'interviewer' : 'conversational' }],
    });
  call('bob', 1, 12);
  call('bob', 0, 9, 'interviewer');
  for (const [ago, minutes] of [[6, 10], [4, 22], [2, 31], [0, 14]] as const) call('june', ago, minutes);
  const clock = { at: now };
  const usage = new VoiceUsage(voiceUsageFile, { now: () => clock.at, timeZone: 'UTC', flushDelayMs: 0 });
  for (const [key, ago, minutes] of [['bob', 1, 12], ['bob', 0, 9], ['june', 6, 10], ['june', 4, 22], ['june', 2, 45], ['june', 0, 14], ['carol', 3, 5]] as const) {
    clock.at = now - ago * DAY;
    usage.add(folderOf(key), minutes * 60);
  }
  usage.flush();

  // ---- the database (what task_run_logs and messages hold) and the Canvas snapshot
  const roster: RosterEntry[] = FIXTURE_PEOPLE.map((p) => ({
    folder: folderOf(p.key),
    jid: `web:${folderOf(p.key)}`,
    name: p.name,
    staff: p.staff === true,
    canvasUserId: p.canvasUserId,
    addedAt: new Date(now - 40 * DAY).toISOString(),
  }));
  const messages = new Map<string, string>();
  for (const [key, ago, extra] of [['bob', 0, 2 * HOUR], ['carol', 1, 0], ['dave', 1, 3 * HOUR], ['erin', 12, 0], ['frank', 0, 5 * HOUR], ['gina', 4, 0], ['hana', 2, 0], ['june', 0, 90 * 60_000], ['kai', 0, 20 * 60_000], ['lena', 3, 0], ['mike', 8, 0], ['ada', 0, 5 * 60_000]] as const) {
    messages.set(`web:${folderOf(key)}`, at(ago, extra).toISOString());
  }
  const patrol: PatrolRow[] = [];
  // the patrol runs at 9:00 Pacific, which is 16:00-17:00 UTC: the day it is booked on is the same whatever hour the fixture is made at
  const runOn = (ago: number, extra = 0): string => new Date(Date.parse(`${day(now, ago)}T16:00:00Z`) + extra).toISOString();
  const skipText = (ago: number): string => `skipped by the gate: nothing new since the model last looked (${day(now, ago + 2)}); still open: inactive; the weekly full check is due ${day(now, ago - 5)}`;
  for (const key of ['bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hana', 'june', 'kai', 'mike']) {
    for (const ago of [1, 2, 3]) patrol.push({ folder: folderOf(key), runAt: runOn(ago), status: 'success', result: skipText(ago) });
  }
  patrol.push({ folder: folderOf('mike'), runAt: runOn(1, 1000), status: 'success', result: CANARIES.model });
  patrol.push({ folder: folderOf('erin'), runAt: runOn(2, 1000), status: 'error', result: CANARIES.error });
  patrol.push({ folder: folderOf('gina'), runAt: runOn(3, 1000), status: 'success', result: `[the gate would have skipped this run: nothing new since the model last looked (${day(now, 5)})] ${CANARIES.model}` });
  patrol.push({ folder: folderOf('bob'), runAt: runOn(12), status: 'success', result: skipText(12) });          // older than the week
  patrol.push({ folder: 'main', runAt: runOn(1), status: 'success', result: skipText(1) });                    // not a student on the list
  const db = { patrol, cron: null as string | null, messages };
  const open = (ago: number, due: number): Snapshot[string] => ({ [`${900 + ago}`]: { state: 'unsubmitted', missing: false, dueAt: new Date(now + due).toISOString(), submittable: true } });
  const snapshot = {
    at: new Date(now - 3 * HOUR).toISOString(),
    snapshot: {
      '1007': open(1, 20 * HOUR),                                    // gina: due in 20 hours, nothing turned in
      '1013': open(2, -30 * HOUR),                                   // mike: due 30 hours ago, nothing turned in
      '1002': { '905': { state: 'submitted', missing: false, dueAt: new Date(now + 10 * HOUR).toISOString(), submittable: true } },
    } as Snapshot,
  };
  const teamDb: TeamDb = {
    patrolRuns: (sinceIso) => db.patrol.filter((r) => r.runAt >= sinceIso),
    patrolCron: () => db.cron,
    lastStudentMessages: () => db.messages,
  };
  return {
    deps: {
      groupsDir,
      historyDir,
      voiceUsageFile,
      roster: () => roster,
      db: teamDb,
      canvas: () => snapshot,
      now: () => now,
      env: {},
      voiceCapMinutes: 45,
      gateStateFile: path.join(dir, 'no-gate-state.json'),
      timeZone: 'UTC',
    },
    roster,
    now,
    dir,
    folderOf,
    canaries: Object.values(CANARIES),
    db,
    snapshot,
  };
}
