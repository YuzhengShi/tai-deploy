/**
 * Competency Bootstrap — Initialize COMPETENCY.md from Canvas grades
 * Runs once per student group when registered. Queries Canvas for grades
 * and submission content, then initializes mastery scores instead of 0.0.
 */
import { createTask } from './db.js';
import { logger } from './logger.js';
import { isSystemTaskOfKind } from './task-origin.js';

const BOOTSTRAP_TAG = '[COMPETENCY_BOOTSTRAP]';

const BOOTSTRAP_PROMPT = `${BOOTSTRAP_TAG}
You are running a one-time COMPETENCY bootstrap for a new student. This is an automated background task — do NOT send any message to the student. Wrap ALL output in <internal> tags.

Your job: query Canvas for this student's grades and submission content, then initialize COMPETENCY.md with non-zero scores based on what they've already completed.

## Step 1: Identify the student

Read COMPETENCY.md: the student's name is in its Student Profile. Who the student is on Canvas is not for you to work out: the Canvas tools are bound to this student by the host, so my_grades and student_submission always use the account linked to this chat, whatever user_id you pass, and the actions that list the class ("users", "grades", "submissions") are for the admin chat only and are refused here. Do not try them, and do not bind or change an identity. If canvas_query says this student's Canvas account is not linked, there is nothing to bootstrap: stop, change nothing and say nothing.

## Step 2: Get all assignments and this student's grades

  canvas_query({ action: "assignments" })
  canvas_query({ action: "my_grades" })

## Step 3: Map assignments to competency concepts

Each homework covers the topics of its week. Use the assignment's name and description and the weekly topics in /workspace/global/COURSE_REFERENCE.md to decide which competency concepts it tests, and raise ONLY concepts that are already listed under Mastery Scores in COMPETENCY.md (never invent a concept name). The homework numbering and topics change from term to term: go by what the assignment says, not by a remembered list.

If the assignment name doesn't clearly say what it covers, read the assignment detail:
  canvas_query({ action: "assignment_detail", params: { assignment_id: "<id>" } })

## Step 4: Compute initial scores

For each assignment the student has submitted and been graded on:

Score-to-confidence mapping:
- 90-100% → confidence: 0.5, stability: 0.3, scope: [implementation], via: [homework]
- 80-89%  → confidence: 0.4, stability: 0.2, scope: [implementation], via: [homework]
- 70-79%  → confidence: 0.3, stability: 0.2, scope: [implementation], via: [homework]
- 60-69%  → confidence: 0.2, stability: 0.1, scope: [implementation], via: [homework]
- Below 60% → confidence: 0.1, stability: 0.1, scope: [], via: [homework]
- Not submitted → leave at 0.0 (default)

IMPORTANT: These are STARTING points, not final assessments. The agent will refine through interaction. Cap initial confidence at 0.5 — homework completion proves implementation ability but doesn't prove verbal/theoretical mastery.

Scope is [implementation] only — homework proves they built something, not that they can explain it. "verbal" and "theoretical" must be earned through conversation.

## Step 5: Fetch submission content for deeper signal (optional)

For the 3 most recent graded assignments, try to read the submission content:
  canvas_query({ action: "student_submission", params: { assignment_id: "<id>" } })

If the submission includes a text body or report URL, read it. Look for:
- Evidence of conceptual understanding (not just code) → add "theoretical" to scope
- Discussion of tradeoffs or design decisions → boost confidence +0.05
- Confusion or errors in the report → note as potential misconception candidates

Do NOT spend more than 3 tool calls on submission content. If submissions aren't accessible, skip this step.

## Step 6: Update COMPETENCY.md

Update the mastery score lines in COMPETENCY.md with the computed values. Also update:
- last_evidence: set to the submission date for each concept
- Student Profile: add any initial observations from submission content

Add a note at the top of the Teaching Strategy Log:
- [today's date]: BOOTSTRAP from Canvas grades — initialized scores from [N] graded assignments. Confidence capped at 0.5; verbal/theoretical scope NOT assumed from homework alone.

Do NOT:
- Send any message to the student
- Set confidence above 0.5 from grades alone
- Assume verbal or theoretical mastery from homework
- Add misconceptions (those must be discovered organically)`;

/**
 * Seed a one-time competency bootstrap task for a student group.
 */
export function seedCompetencyBootstrap(
  groupFolder: string,
  chatJid: string,
): void {
  const taskId = `bootstrap-${groupFolder}-${Date.now()}`;
  createTask({
    id: taskId,
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt: BOOTSTRAP_PROMPT,
    schedule_type: 'once',
    schedule_value: new Date(Date.now() + 5000).toISOString(), // Run in 5 seconds
    context_mode: 'group',
    next_run: new Date(Date.now() + 5000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    origin: 'system',                         // the host made this one: its container's tool limits are lifted (src/task-origin.ts)
  });

  logger.info(
    { taskId, groupFolder },
    'Competency bootstrap task seeded',
  );
}

/**
 * Check if a bootstrap task has already run for a group: one the host seeded (its stored origin and its `bootstrap-` id), never a task that merely carries the marker:
 * a student's agent can schedule a task that completes with BOOTSTRAP_TAG in its prompt, and the real bootstrap would then never run for that student.
 */
export function hasBootstrapRun(groupFolder: string, allTasks: Array<{ id: string; origin?: string | null; group_folder: string; status: string }>): boolean {
  return allTasks.some((t) => t.group_folder === groupFolder && isSystemTaskOfKind(t, 'grade bootstrap') && t.status === 'completed');
}
