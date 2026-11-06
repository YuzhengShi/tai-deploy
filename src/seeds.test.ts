import { describe, expect, it } from 'vitest';

import { anySeed, seedSwitches } from './seeds.js';

describe('which background jobs run', () => {
  it('runs none when told not to, whatever else is set', () => {
    const none = { bootstrap: false, patrol: false, courseStatus: false, studentCourse: false, courseSyncAgent: false, leanragSync: false };
    expect(seedSwitches({ TAI_NO_SEEDS: '1' })).toEqual(none);
    expect(seedSwitches({ TAI_NO_SEEDS: '1', TAI_SEED_COURSE_SYNC: '1', TAI_SEED_LEANRAG_SYNC: '1' })).toEqual(none);
    expect(anySeed(seedSwitches({ TAI_NO_SEEDS: '1' }))).toBe(false);
  });

  it('runs the cheap, safe ones by default and the original model-run sync and graph rebuild only when asked', () => {
    expect(seedSwitches({})).toEqual({ bootstrap: true, patrol: true, courseStatus: true, studentCourse: true, courseSyncAgent: false, leanragSync: false });
    expect(seedSwitches({ TAI_NO_SEEDS: '0' })).toEqual(seedSwitches({}));
    expect(seedSwitches({ TAI_SEED_COURSE_SYNC: '1', TAI_SEED_LEANRAG_SYNC: '1' })).toMatchObject({ courseSyncAgent: true, leanragSync: true });
  });

  it('lets each be turned off alone', () => {
    expect(seedSwitches({ TAI_SEED_PATROL: '0' })).toMatchObject({ patrol: false, bootstrap: true, courseStatus: true });
    expect(seedSwitches({ TAI_SEED_BOOTSTRAP: '0' })).toMatchObject({ bootstrap: false, patrol: true });
    expect(seedSwitches({ TAI_COURSE_STATUS_HOURS: '0' })).toMatchObject({ courseStatus: false, patrol: true });
    expect(seedSwitches({ TAI_COURSE_STATUS_HOURS: '12' }).courseStatus).toBe(true);
    expect(seedSwitches({ TAI_STUDENT_COURSE_HOURS: '0' })).toMatchObject({ studentCourse: false, courseStatus: true, patrol: true });
    expect(seedSwitches({ TAI_STUDENT_COURSE_HOURS: '3' }).studentCourse).toBe(true);
    expect(anySeed(seedSwitches({ TAI_SEED_PATROL: '0', TAI_SEED_BOOTSTRAP: '0', TAI_COURSE_STATUS_HOURS: '0', TAI_STUDENT_COURSE_HOURS: '0' }))).toBe(false);
  });
});
