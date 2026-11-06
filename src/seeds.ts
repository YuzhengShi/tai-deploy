/**
 * Which of the orchestrator's background jobs run. They spawn containers (or call Canvas) on their own, and without a switch every
 * evaluation run and every new deployment had them all, so each has one:
 *
 *   TAI_NO_SEEDS=1            all off (what an evaluation run sets, and what the live service had until the competency files had a way to exist)
 *   TAI_SEED_BOOTSTRAP        (default on)   one run per new student: scores from their Canvas grades into COMPETENCY.md
 *   TAI_SEED_PATROL           (default on)   each weekday morning one run per student that may send them a message
 *   TAI_COURSE_STATUS_HOURS   (default 6)    the class-wide COURSE_STATUS.md, rebuilt by a script (src/course-status.ts); 0 = off
 *   TAI_STUDENT_COURSE_HOURS  (default 6)    one look at Canvas for every student's own standing (a grade posted, an assignment marked missing,
 *                                            one due soon and not turned in) for their activity list (src/student-course.ts); 0 = off
 *   TAI_SEED_COURSE_SYNC=1    (default OFF)  the original's course sync: a model in the instructor's admin group; see course-status.ts for why not
 *   TAI_SEED_LEANRAG_SYNC=1   (default OFF)  the original's knowledge-graph rebuild (needs Cohere and DeepSeek): the live deployment refreshes its
 *                                            corpus with a timer instead (tai_live.sh timers)
 */
export interface SeedSwitches {
  bootstrap: boolean;
  patrol: boolean;
  courseStatus: boolean;
  studentCourse: boolean;
  courseSyncAgent: boolean;
  leanragSync: boolean;
}

export function seedSwitches(env: NodeJS.ProcessEnv): SeedSwitches {
  if (env.TAI_NO_SEEDS === '1') return { bootstrap: false, patrol: false, courseStatus: false, studentCourse: false, courseSyncAgent: false, leanragSync: false };
  return {
    bootstrap: env.TAI_SEED_BOOTSTRAP !== '0',
    patrol: env.TAI_SEED_PATROL !== '0',
    courseStatus: Number.parseFloat(env.TAI_COURSE_STATUS_HOURS ?? '6') !== 0,
    studentCourse: Number.parseFloat(env.TAI_STUDENT_COURSE_HOURS ?? '6') !== 0,
    courseSyncAgent: env.TAI_SEED_COURSE_SYNC === '1',
    leanragSync: env.TAI_SEED_LEANRAG_SYNC === '1',
  };
}

export function anySeed(switches: SeedSwitches): boolean {
  return Object.values(switches).some(Boolean);
}
