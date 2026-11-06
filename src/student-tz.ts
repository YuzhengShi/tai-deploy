/**
 * The student's own time zone, for the containers that answer them (docs/COURSE_TIME.md).
 *
 * The page sends the zone the student's browser reports once they sign in, and `src/portal/prefs.ts` keeps it (validated, canonical) in
 * `store/portal/<folder>.prefs.json`. This module hands it to the container as `TAI_STUDENT_TZ`; there, `container/scripts/canvas_api.py` puts
 * the student's own clock next to the Pacific one of every deadline when the two read differently (`due_local`).
 *
 * The prefs store is the one that reads and validates: this is no second parser. Anything that is not a zone it knows (no file, a damaged
 * file, a name that is no zone, a folder name that could be a path) is `undefined`, and then no variable is set at all.
 */
import path from 'node:path';

import { PrefsStore } from './portal/prefs.js';

/**
 * The zone of the chat folder `folder`, or undefined. `storeDir` is the orchestrator's store directory: the preferences are in
 * `<storeDir>/portal`, where `src/notify/start.ts` reads them too. Read at every container start, so a change a student made a minute ago
 * is in their next container (one that is already running keeps what it started with).
 */
export function studentTimeZone(folder: string, storeDir: string): string | undefined {
  try {
    return new PrefsStore(path.join(storeDir, 'portal')).read(folder).tz;
  } catch {
    return undefined; // a folder name that is not a chat folder (PrefsStore refuses it), or a store that cannot be read: no zone
  }
}
