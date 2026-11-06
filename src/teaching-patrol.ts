/**
 * Teaching Patrol — Phase 1D
 * Auto-seeds a daily teaching patrol cron task for each student group.
 * The patrol reads COMPETENCY.md and decides whether proactive intervention is needed.
 */
import { CronExpressionParser } from 'cron-parser';

import { MAIN_GROUP_FOLDER, TIMEZONE } from './config.js';
import { createTask, getAllTasks, updateTask } from './db.js';
import { logger } from './logger.js';
import { isSystemTaskOfKind } from './task-origin.js';
import { RegisteredGroup } from './types.js';

export const PATROL_TAG = '[TEACHING_PATROL]';

/**
 * A scheduled task that is a student's teaching patrol (the scheduler asks src/patrol-gate.ts before it starts a model for one): one the host seeded, by its stored
 * origin and its `patrol-` id. Never by PATROL_TAG, which is only the head of the prompt: a student's agent can schedule a task whose prompt carries it.
 */
export function isPatrolTask(task: { id: string; origin?: string | null }): boolean {
  return isSystemTaskOfKind(task, 'teaching patrol');
}

const PATROL_PROMPT = `${PATROL_TAG}
You are running your daily Teaching Patrol. This is a proactive check — no student messaged you.

Instructions:
1. Read COMPETENCY.md for this student.
2. Read /workspace/global/COURSE_STATUS.md: the whole class's assignments, deadlines, announcements and files, as of the last sync. It says nothing about any one student. For THIS student's own standing call canvas_query with action "week_status" and no params: it is always about this student (the account linked to this chat, whoever you name), and gives the week's assignments with their due times and whether each is submitted, on time or graded. The actions that list the class ("submissions", "grades", "users") are for the admin chat only and are refused here: do not try them. For their GitHub activity call github_query with action "activity" and no params: it is always their own linked account, and a GitHub name written in COMPETENCY.md is not used.
3. Check the current date, and work out the course week from the modules and deadlines in COURSE_STATUS.md (do not assume a start date).
4. Evaluate each intervention trigger below. For EACH trigger, decide "intervene" or "no action" and log your reasoning.

Intervention triggers:
- 5+ days inactive + homework deadline approaching (due Monday 9am) → reach out with specific value, not nagging
- Low confidence (<0.4) on this week's topic + mock interview coming → offer targeted practice
- High confidence (>0.7) but low stability (<0.3) + 14+ days since last_evidence → spaced review needed
- Confirmed misconception not yet remediated → send targeted correction
- High confidence + scope missing "verbal" + mock interview within 2 days → offer verbal practice
- Prerequisite gap: student working on topic X but prerequisite Y confidence < 0.4 → address prerequisite first
- Canvas: assignment due within 24h + student has not submitted (check with canvas_query "week_status") → proactive nudge
- Canvas: assignment past due + no submission → gentle check-in (not nagging)
- GitHub: no commits in 5+ days + assignment active → ask if they need help getting started

5. If ALL triggers evaluate to "no action needed":
   - Update the Proactive Intervention Log in COMPETENCY.md with your decision and reasoning.
   - DO NOT send any message. Do not send a message explaining why you're not sending a message. Just update COMPETENCY.md and stop.
   - Never leak internal reasoning to the student. Your patrol analysis is private.

6. If you decide to intervene (at least one trigger fires):
   - Use send_message to reach out to the student
   - Keep it warm and specific — reference what they were working on
   - Offer concrete value (practice question, concept check, resource)
   - ONE message only, ONE question only
   - Update the Proactive Intervention Log in COMPETENCY.md

CRITICAL: The student must NEVER see your patrol reasoning. No messages like "No action needed", "I checked and everything looks fine", "Just doing my daily check-in", etc. If there's nothing to act on, the student should not know a patrol ran at all.

Remember: 90% of patrols should result in "no action needed". Your value is in judgment, not volume.`;

/**
 * Check if a teaching patrol task already exists for a group folder: one the host seeded (isPatrolTask), so that a student's task that merely carries the patrol's
 * marker does not keep the real one from being seeded.
 */
export function hasPatrolTask(groupFolder: string): boolean {
  const tasks = getAllTasks();
  return tasks.some((t) => t.group_folder === groupFolder && isPatrolTask(t) && t.status === 'active');
}

/**
 * Puts the current prompt into the host's own patrol rows of a group whose stored prompt is another. The prompt lives in the row and the scheduler runs the row, so a
 * patrol that was seeded before a fix would go on running the old text for ever: this one used to tell the patrol to call canvas_query "submissions", which lists the
 * whole class. Called at every start by the seed. Returns how many rows it changed.
 */
export function refreshPatrolPrompts(groupFolder: string): number {
  let changed = 0;
  for (const t of getAllTasks()) {
    if (t.group_folder !== groupFolder || !isPatrolTask(t) || t.prompt === PATROL_PROMPT) continue;
    updateTask(t.id, { prompt: PATROL_PROMPT });
    changed++;
    logger.info({ taskId: t.id, group: groupFolder }, 'Teaching patrol prompt brought up to date');
  }
  return changed;
}

/**
 * Seed teaching patrol tasks for all registered student groups.
 * Skips groups that already have an active patrol task (their stored prompt is brought up to date instead).
 * Skips the main (admin) group, and the smoke tests' chats (`smoke-*`): a patrol
 * run every weekday for each of them would only spend the model.
 */
export function seedTeachingPatrol(
  registeredGroups: Record<string, RegisteredGroup>,
): void {
  let seeded = 0;

  for (const [jid, group] of Object.entries(registeredGroups)) {
    // Skip admin group and smoke chats
    if (group.folder === MAIN_GROUP_FOLDER || group.folder.startsWith('smoke-')) continue;

    // A patrol that already exists keeps what it was seeded with unless it is told otherwise
    refreshPatrolPrompts(group.folder);

    // Skip if patrol already exists
    if (hasPatrolTask(group.folder)) continue;

    // Compute next run: weekdays 9am local time
    const cron = '0 9 * * 1-5';
    let nextRun: string;
    try {
      const interval = CronExpressionParser.parse(cron, { tz: TIMEZONE });
      const next = interval.next();
      nextRun = next.toISOString()!;
    } catch {
      logger.warn(
        { group: group.name },
        'Failed to parse patrol cron, skipping',
      );
      continue;
    }

    const taskId = `patrol-${group.folder}-${Date.now()}`;
    createTask({
      id: taskId,
      group_folder: group.folder,
      chat_jid: jid,
      prompt: PATROL_PROMPT,
      schedule_type: 'cron',
      schedule_value: cron,
      context_mode: 'group',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
      origin: 'system',                       // the host made this one: its container's tool limits are lifted (src/task-origin.ts)
    });

    seeded++;
    logger.info(
      { taskId, group: group.name, nextRun },
      'Teaching patrol task seeded',
    );
  }

  if (seeded > 0) {
    logger.info({ count: seeded }, 'Teaching patrol tasks seeded for student groups');
  }
}
