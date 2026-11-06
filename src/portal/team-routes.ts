/**
 * The teaching-team view's two calls, for the owner only (src/portal/server.ts checks that before the handler runs: 401 signed out, 403 for
 * anyone who is not the owner), and the one function that src/portal/start.ts needs to put the whole of it on the page's server.
 *
 *   GET api/team/overview[?staff=1]   the class: heat map, misconceptions, patrol, quick checks, who needs attention, voice (src/portal/team.ts)
 *   GET api/team/student?folder=      one student's detail (404 when the folder is not on the allowlist)
 *
 * Both are read-only and `no-store` (the server's `json` says so); the aggregate is cached for a minute inside the view. `staff=1` counts the
 * teaching-team accounts (role owner) in the class too; by default they are left out, so a TA testing the page does not move the numbers.
 */
import path from 'path';

import { STORE_DIR } from '../config.js';
import { readStudentSnapshot } from '../student-course.js';
import { loadVoiceConfig } from '../voice/config.js';
import type { PortalUser } from './auth.js';
import { STUDENT_FOLDER } from './history.js';
import type { PortalRoute } from './server.js';
import { TeamView, sqliteTeamDb } from './team.js';
import type { TeamDb, TeamDeps, TeamSqlite } from './team.js';

/** The view's database questions on the orchestrator's database: `teamDbOf(() => getDb(), ASSISTANT_NAME)` (src/db.ts is not imported here, so that this module loads without better-sqlite3). */
export function teamDbOf(getDb: () => unknown, assistantName: string): TeamDb {
  return sqliteTeamDb(getDb as () => TeamSqlite, assistantName);
}

/** The two routes, answered from `view`. */
export function teamRoutes(view: TeamView): PortalRoute[] {
  return [
    {
      path: '/api/team/overview',
      method: 'GET',
      access: 'owner',
      handler: async ({ url, json }) => {
        json(200, await view.overview(url.searchParams.get('staff') === '1'));
      },
    },
    {
      path: '/api/team/student',
      method: 'GET',
      access: 'owner',
      handler: async ({ url, json }) => {
        const folder = url.searchParams.get('folder') || '';
        if (!STUDENT_FOLDER.test(folder)) return json(400, { error: 'bad-request' });
        const detail = await view.student(folder);
        if (!detail) return json(404, { error: 'not-found' });
        json(200, detail);
      },
    },
  ];
}

export interface TeamModuleOptions {
  env: NodeJS.ProcessEnv;
  groupsDir: string;
  /** The allowlist (src/portal/auth.ts UserDirectory): who is in the class, by name, folder and role. */
  users: { list(): PortalUser[] };
  /** The orchestrator's registered chats, for when each student's was registered (a student who has never written counts from there). */
  registeredGroups?: () => Record<string, { added_at?: string }>;
  /** The database (`teamDbOf(() => getDb(), ASSISTANT_NAME)`): without it the page has no patrol panel and does not know when anyone last wrote. */
  db?: TeamDb | null;
}

/** What start.ts adds to the page's server: the routes, and `features.team` (true for the owner, who is the only one who may call them). */
export function teamModule(opts: TeamModuleOptions): { view: TeamView; routes: PortalRoute[]; features: (user: PortalUser) => Record<string, unknown> } {
  const deps: TeamDeps = {
    groupsDir: opts.groupsDir,
    historyDir: opts.env.TAI_PORTAL_HISTORY_DIR || path.join(STORE_DIR, 'portal'),
    voiceUsageFile: path.join(STORE_DIR, 'voice-usage.json'),
    roster: () => {
      const registered = opts.registeredGroups?.() ?? {};
      return opts.users.list().map((user) => ({
        folder: user.folder,
        jid: user.jid,
        name: user.name,
        staff: user.role === 'owner',
        canvasUserId: user.canvasUserId,
        addedAt: registered[user.jid]?.added_at,
      }));
    },
    db: opts.db ?? null,
    canvas: () => readStudentSnapshot(),
    env: opts.env,
    voiceCapMinutes: loadVoiceConfig((key) => opts.env[key]).dailyMin,
  };
  const view = new TeamView(deps);
  return { view, routes: teamRoutes(view), features: (user) => ({ team: user.role === 'owner' }) };
}
