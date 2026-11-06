import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CompetencyGuard,
  appendVoiceSession,
  competencyForTopic,
  findConcept,
  interviewProfile,
  parseMastery,
  renderMastery,
  summarizeCompetency,
  writeInterviewResults,
} from './competency.js';

const TEMPLATE_STYLE = `# Student Competency Model

Last updated: 2026-10-01

## Student Profile

- Name: Ana Lopez
- Learning style: analogies
- Current week: 9

## Mastery Scores

Format: concept: confidence | stability | scope | via | last_evidence

### Week 3: Concurrency (HW3)
Concurrency vs parallelism distinction: 0.6 | 0.3 | [theoretical] | [socratic_dialogue] | 2026-09-20
Lamport clocks and event ordering: 0.2 | 0.1 | [] | [] | 2026-09-21

### Week 11: Consensus & Replication (HW10)
Raft (leader election, log replication): 0.4 | 0.2 | [theoretical] | [homework] | 2026-10-01
Paxos: 0.0 | 0.0 | [] | [] | never
CAP theorem (CP vs AP tradeoffs): 0.75 | 0.6 | [theoretical, implementation] | [homework] | 2026-09-30
Docker concepts (images, containers, Dockerfile): 0.7 | 0.5 | [implementation] | [homework] | 2026-09-10

## Active Misconceptions

None yet. (Discovered organically from interactions — never pre-loaded.)

## Mock Interview Summary

- Most recent interview: [date, assignment, scores]
- → Full history + upcoming focus: \`competency/interviews.md\`

## Detail Files

| File | Read When |
`;

const PROTOCOL_STYLE = `## Mastery Scores
- Docker concepts: confidence: 0.3 | stability: 0.1 | scope: [theoretical] | via: [socratic_dialogue] | last: 2026-02-21
Go programming basics: confidence: 0.5 | stability: 0.2 | scope: [] | via: [] | last: never
Raft consensus:
  confidence: 0.4 | stability: 0.3 | scope: [theoretical] | via: [homework] | last: 2026-03-01
`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-comp-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (text: string) => fs.writeFileSync(path.join(dir, 'COMPETENCY.md'), text);
const read = () => fs.readFileSync(path.join(dir, 'COMPETENCY.md'), 'utf-8');
const today = '2026-11-01';

describe('reading mastery lines', () => {
  it('reads the template spelling, the protocol spelling and the older two-line one, and writes each back as it was', () => {
    const t = parseMastery(TEMPLATE_STYLE);
    expect(t.map((e) => e.name)).toEqual([
      'Concurrency vs parallelism distinction',
      'Lamport clocks and event ordering',
      'Raft (leader election, log replication)',
      'Paxos',
      'CAP theorem (CP vs AP tradeoffs)',
      'Docker concepts (images, containers, Dockerfile)',
    ]);
    expect(t[2]).toMatchObject({ confidence: 0.4, stability: 0.2, scope: ['theoretical'], via: ['homework'], last: '2026-10-01', format: 'compact' });
    const p = parseMastery(PROTOCOL_STYLE);
    expect(p.map((e) => [e.name, e.format, e.confidence])).toEqual([
      ['Docker concepts', 'labelled', 0.3],
      ['Go programming basics', 'labelled', 0.5],
      ['Raft consensus', 'labelled2', 0.4],
    ]);
    const lines = PROTOCOL_STYLE.split('\n');
    for (const e of p) expect(renderMastery(e)).toEqual(lines.slice(e.line, e.line + e.span));
    for (const e of t) expect(renderMastery(e)[0]).toBe(TEMPLATE_STYLE.split('\n')[e.line].replace('0.75', '0.75'));
  });

  it('finds a concept by what the model calls it, and nothing for a vague name', () => {
    const entries = parseMastery(TEMPLATE_STYLE);
    expect(findConcept(entries, 'Raft leader election')?.name).toBe('Raft (leader election, log replication)');
    expect(findConcept(entries, 'paxos')?.name).toBe('Paxos');
    expect(findConcept(entries, 'Docker containers')?.name).toBe('Docker concepts (images, containers, Dockerfile)');
    expect(findConcept(entries, 'leader')).toBeUndefined();
    expect(findConcept(entries, 'Kubernetes pods')).toBeUndefined();
  });

  it('summarizes the state and answers for a topic', () => {
    const s = summarizeCompetency(TEMPLATE_STYLE);
    expect(s).toContain('Student: Ana Lopez | current week: 9 | learning style: analogies');
    expect(s).toContain('Strong: CAP theorem (CP vs AP tradeoffs): confidence 0.75');
    expect(s).toContain('Weak: Lamport clocks and event ordering: confidence 0.2');
    expect(s).toMatch(/Verbal gaps .*Concurrency vs parallelism distinction/);
    expect(s).toContain('1 course concepts not discussed yet');
    expect(summarizeCompetency(null)).toMatch(/No competency record yet/);
    expect(competencyForTopic(TEMPLATE_STYLE, 'raft')).toContain('Raft (leader election, log replication): confidence 0.4');
    expect(competencyForTopic(TEMPLATE_STYLE, 'kubernetes')).toMatch(/^Nothing recorded about "kubernetes"/);
    expect(interviewProfile(TEMPLATE_STYLE)).toMatchObject({
      name: 'Ana Lopez',
      weakConcepts: ['Lamport clocks and event ordering (0.2)', 'Raft (leader election, log replication) (0.4)'],
    });
  });
});

describe('update_competency and its guard', () => {
  it('changes one concept in its own spelling, adds the verbal scope, logs the strategy', () => {
    write(TEMPLATE_STYLE);
    const guard = new CompetencyGuard();
    const r = guard.apply(dir, { concept: 'Raft leader election', confidence_delta: 0.15, notes: 'explained timeouts' }, { today });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('0.4 -> 0.55');
    const text = read();
    expect(text).toContain('Raft (leader election, log replication): 0.55 | 0.3 | [theoretical, verbal] | [homework, socratic_dialogue] | 2026-11-01');
    expect(text).toContain('Last updated: 2026-11-01');
    expect(text).toContain('## Detail Files');
    const log = fs.readFileSync(path.join(dir, 'competency', 'strategy-log.md'), 'utf-8');
    expect(log).toContain('- 2026-11-01: VOICE on Raft (leader election, log replication) | 0.4→0.55 (+0.15) | voice call | effective | explained timeouts');
    expect(guard.changes).toEqual([{ concept: 'Raft (leader election, log replication)', before: 0.4, after: 0.55, scope: ['theoretical', 'verbal'] }]);
  });

  it('keeps the protocol spelling of a line it changes', () => {
    write(PROTOCOL_STYLE);
    new CompetencyGuard().apply(dir, { concept: 'Docker concepts', confidence_delta: -0.1 }, { today });
    expect(read()).toContain('- Docker concepts: confidence: 0.2 | stability: 0.0 | scope: [theoretical] | via: [socratic_dialogue] | last: 2026-11-01');
    new CompetencyGuard().apply(dir, { concept: 'Raft consensus', confidence_delta: 0.1 }, { today });
    expect(read()).toContain('Raft consensus:\n  confidence: 0.5 | stability: 0.4 | scope: [theoretical, verbal] | via: [homework, socratic_dialogue] | last: 2026-11-01');
  });

  it('clamps a delta to 0.3, refuses the sixth increase, and holds a third concept below 0.8', () => {
    write(TEMPLATE_STYLE);
    const guard = new CompetencyGuard();
    expect(guard.apply(dir, { concept: 'Paxos', confidence_delta: 0.9 }, { today }).message).toContain('0.0 -> 0.3');
    expect(guard.apply(dir, { concept: 'CAP theorem', confidence_delta: 0.1 }, { today }).message).toContain('0.75 -> 0.85');
    expect(guard.apply(dir, { concept: 'Docker concepts', confidence_delta: 0.2 }, { today }).message).toContain('0.7 -> 0.9');
    const held = guard.apply(dir, { concept: 'Concurrency vs parallelism distinction', confidence_delta: 0.3 }, { today });
    expect(held.message).toContain('0.6 -> 0.79');
    expect(held.message).toContain('held below 0.8');
    expect(guard.apply(dir, { concept: 'Lamport clocks', confidence_delta: 0.1 }, { today }).ok).toBe(true);
    const sixth = guard.apply(dir, { concept: 'Raft', confidence_delta: 0.1 }, { today });
    expect(sixth.ok).toBe(false);
    expect(sixth.message).toMatch(/at most 5 confidence increases/);
    // a decrease is still fine
    expect(guard.apply(dir, { concept: 'Raft', confidence_delta: -0.1 }, { today }).ok).toBe(true);
  });

  it('records a misconception, counts it, confirms it at three, and adds an unknown concept under its own heading', () => {
    write(TEMPLATE_STYLE);
    const guard = new CompetencyGuard();
    guard.apply(dir, { concept: 'Raft', misconception: 'a leader can commit without a majority' }, { today });
    expect(read()).toContain('- "a leader can commit without a majority" | contradicts: Raft (leader election, log replication) | status: candidate | freq: 1');
    expect(read()).not.toContain('None yet. (Discovered');
    guard.apply(dir, { concept: 'Raft', misconception: 'A leader can commit without a majority' }, { today });
    guard.apply(dir, { concept: 'Raft', misconception: 'a leader can commit without a majority' }, { today });
    expect(read()).toMatch(/status: confirmed \| freq: 3/);
    guard.apply(dir, { concept: 'Gossip protocols', confidence_delta: 0.1, new_scope: 'theoretical' }, { today });
    const text = read();
    expect(text).toMatch(/### Voice sessions \(concepts first met in a voice call\)\nGossip protocols: 0\.1 \| 0\.1 \| \[theoretical, verbal\] \| \[socratic_dialogue\] \| 2026-11-01/);
    expect(text.indexOf('Gossip protocols')).toBeLessThan(text.indexOf('## Active Misconceptions'));
  });

  it('refuses nonsense and creates the file from the template when there is none', () => {
    const guard = new CompetencyGuard();
    expect(guard.apply(dir, { concept: '' }, { today }).ok).toBe(false);
    expect(guard.apply(dir, { concept: 'Raft' }, { today }).ok).toBe(false);
    const template = path.join(dir, 'TEMPLATE.md');
    fs.writeFileSync(template, TEMPLATE_STYLE.replace('Last updated: 2026-10-01', 'Last updated: [auto]'));
    const sub = path.join(dir, 's_new');
    expect(guard.apply(sub, { concept: 'Paxos', confidence_delta: 0.1 }, { today, templateFile: template }).ok).toBe(true);
    const created = fs.readFileSync(path.join(sub, 'COMPETENCY.md'), 'utf-8');
    expect(created).toContain('Paxos: 0.1 | 0.1 | [verbal] | [socratic_dialogue] | 2026-11-01');
    expect(created).toContain('Last updated: 2026-11-01');
    // a concept name cannot break the line format
    guard.apply(sub, { concept: 'evil: 1.0 | 1.0 | [x]\nnext', confidence_delta: 0.1 }, { today, templateFile: template });
    expect(parseMastery(fs.readFileSync(path.join(sub, 'COMPETENCY.md'), 'utf-8')).find((e) => e.name.startsWith('evil'))?.confidence).toBe(0.1);
  });
});

describe('after a mock interview', () => {
  it('writes scope, the interview summary, the history and the strategy log', () => {
    write(TEMPLATE_STYLE);
    writeInterviewResults(dir, {
      assignmentName: 'HW3 Concurrency',
      date: today,
      durationMinutes: 12,
      rubric: { verbal_clarity: 4, technical_accuracy: 3.5, depth_of_reasoning: 3, problem_solving_process: 4 },
      strengths: ['clear verbal explanations'],
      weaknesses: ['going deeper in explanations'],
      topicsCovered: ['Concurrency vs parallelism', 'Lamport clocks'],
      overallImpression: 'solid, needs depth',
      questions: 6,
    });
    const text = read();
    expect(text).toContain('Concurrency vs parallelism distinction: 0.6 | 0.3 | [theoretical, verbal] | [socratic_dialogue, mock_interview] | 2026-11-01');
    expect(text).toContain('Lamport clocks and event ordering: 0.2 | 0.1 | [verbal] | [mock_interview] | 2026-11-01');
    expect(text).toContain('- Most recent interview: 2026-11-01, HW3 Concurrency, 12 min (voice) — adequate: clarity 4/5, accuracy 3.5/5, depth 3/5, process 4/5');
    expect(text).not.toContain('[date, assignment, scores]');
    expect(text).toContain('## Detail Files');
    const interviews = fs.readFileSync(path.join(dir, 'competency', 'interviews.md'), 'utf-8');
    expect(interviews).toMatch(/## Interview History \(most recent first\)\n\n- 2026-11-01: HW3 Concurrency \(voice mock interview, 12 min, 6 answers scored\)/);
    expect(interviews).toContain("Interviewer's impression: solid, needs depth");
    writeInterviewResults(dir, { assignmentName: 'HW4', date: '2026-11-02', durationMinutes: 1, rubric: null, strengths: [], weaknesses: [], topicsCovered: [], questions: 0 });
    const again = fs.readFileSync(path.join(dir, 'competency', 'interviews.md'), 'utf-8');
    expect(again.indexOf('HW4')).toBeLessThan(again.indexOf('HW3 Concurrency'));
    const log = fs.readFileSync(path.join(dir, 'competency', 'strategy-log.md'), 'utf-8');
    expect(log).toContain('VOICE_INTERVIEW on HW3 Concurrency — 12 min, 2 topics covered');
    expect(log).not.toContain('HW4'); // under three minutes and nothing scored: a test, not a strategy
  });

  it('keeps the newest voice sessions first and only thirty of them, and every call whole in an archive of its own', () => {
    for (let i = 1; i <= 32; i++) {
      appendVoiceSession(dir, {
        startedAt: `2026-11-01 10:${String(i).padStart(2, '0')}`,
        minutes: i,
        modes: 'conversation',
        summary: `call ${i}`,
        competency: [],
        transcript: [
          { role: 'student', text: `question ${i}`, mode: 'conversational' },
          { role: 'tai', text: `answer ${i}`, mode: 'interviewer' },
        ],
      });
    }
    const text = fs.readFileSync(path.join(dir, 'competency', 'voice-sessions.md'), 'utf-8');
    expect(text.startsWith('# Voice Sessions')).toBe(true);
    expect(text.match(/^## /gm)).toHaveLength(30);
    expect(text.indexOf('call 32')).toBeLessThan(text.indexOf('call 31'));
    expect(text).not.toContain('Summary: call 2\n');
    expect(text).toContain('- TAi (interview): answer 32');
    // the first call is no longer in the file the text agent reads, and is still whole in the archive
    const archive = fs.readdirSync(path.join(dir, 'competency', 'voice-transcripts'));
    expect(archive).toHaveLength(32);
    const first = fs.readFileSync(path.join(dir, 'competency', 'voice-transcripts', archive.sort()[0]), 'utf-8');
    expect(first).toContain('Summary: call 1\n');
    expect(first).toContain('- Student: question 1');
  });
});
