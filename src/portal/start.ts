/**
 * Starts the student page inside the orchestrator when it is configured (TAI_PORTAL_SOCKET or TAI_PORTAL_PORT), wiring it to the
 * web channel and to the registry of chats. Without those settings nothing listens and nothing here runs. With them, the pieces that
 * make it safe are required, not optional: an allowlist file and a session secret file. Google's client id is the one thing that may
 * be missing: the page then runs closed (nobody can sign in) and says so.
 *
 *   TAI_PORTAL_SOCKET        unix socket to listen on (the live deployment: a proxy container on the same host connects to it)
 *   TAI_PORTAL_PORT/HOST     or a loopback port (HOST defaults to 127.0.0.1; anything wider is refused)
 *   TAI_PORTAL_USERS_FILE    the allowlist: {"users":[{"email","name","canvasUserId","githubUsername","role"}]}
 *   TAI_PORTAL_SECRET_FILE   a file with the cookie-signing secret (64 hex digits), mode 600
 *   TAI_GOOGLE_CLIENT_ID     the OAuth web client id of the "Sign in with Google" button (public)
 *   TAI_PORTAL_ORIGIN        https://the.host the browsers see: POSTs must come from it; the cookie is Secure under https
 *   TAI_PORTAL_BASE_PATH     where the page lives behind the proxy (/tai): the session cookie is limited to it
 *   TAI_PORTAL_TRUST_PROXY   1 when a proxy sets X-Forwarded-For (its last entry is the client)
 *   TAI_PORTAL_SESSION_HOURS (default 12)
 *   TAI_PORTAL_HISTORY_DIR   (default store/portal) one JSON-lines file per student
 *   TAI_PORTAL_STATIC_DIR    (default portal/web) the page's files
 *   TAI_PORTAL_JWKS_URL      where Google's keys are (tests)
 */
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR, STORE_DIR } from '../config.js';
import { getDb } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { buildMemoryExport } from '../memory.js';
import { writeFileAtomicSafe } from '../safe-fs.js';
import { sourceHosts } from '../sources.js';
import { RegisteredGroup } from '../types.js';
import { WebChannel } from '../channels/web.js';
import { startNotify } from '../notify/start.js';
import { GoogleVerifier, NonceStore, PortalUser, SessionCodec, UserDirectory, loadSecret } from './auth.js';
import { ADMIN_FOLDER, HistoryStore } from './history.js';
import { MediaStore } from './media.js';
import { MemoryDb, StudentMemory, sqliteMemoryStore } from './memory-view.js';
import { Portal, PortalCore, PortalRoute, PortalVoice, loadStaticFiles, reactReplyDelay } from './server.js';
import { teamDbOf, teamModule } from './team-routes.js';
import { deepgramTranscriber } from './transcribe.js';
import { UploadStore } from './uploads.js';
import { voiceRoutes } from './voice-routes.js';

/** The pictures of the page, one place for the web channel (which stores what TAi sends) and the page (which serves it). */
export const mediaStore = new MediaStore(process.env.TAI_PORTAL_MEDIA_DIR || path.join(STORE_DIR, 'portal-media'));

/**
 * Every file the page serves by name: the voice client and its worklet are part of it. One name to a line, so that a feature that adds a file
 * never touches another's line (portal/web/pagefiles.test.js reads this list: keep the closing bracket the first one after PAGE_FILES).
 */
export const PAGE_FILES = [
  'index.html',
  'app.js',
  'markdown.js',
  'highlight.js',
  'notes.js',
  'activity.js',
  'choices.js',
  'speech.js',
  'voice.js',
  'voice-worklet.js',
  'review.js',
  'review.css',
  'team.html',
  'team.js',
  'team-data.js',
  'team.css',
  'style.css',
  'highlight.css',
  'settings.js',
  'settings.css',
  'status.js',
  'sources.js',
  'status.css',
  'sw.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'mark.svg',
];

/** What the voice side is given when the page starts: the pieces of the page it shares. */
export interface VoiceContext {
  history: HistoryStore;
  /** https origin + base path, as browsers see the page (the address Deepgram calls back on). */
  publicBase: string;
  publicOrigin: string;
  secretFile: string;
  wakeStudent: (folder: string) => void;
}

export interface PortalDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  /** Builds the voice hub (src/voice) from what the page shares with it; null or absent: no voice calls. */
  createVoice?: (ctx: VoiceContext) => PortalVoice | null;
}

/** The chat of a signed-in student: registered with the Canvas user and GitHub account the allowlist gives, and kept in step with it. */
export function ensureStudentGroup(deps: PortalDeps, user: PortalUser): string {
  const existing = deps.registeredGroups()[user.jid];
  if (
    !existing ||
    existing.name !== user.name ||
    existing.canvasUserId !== user.canvasUserId ||
    existing.githubUsername !== user.githubUsername
  ) {
    deps.registerGroup(user.jid, {
      ...existing,
      name: user.name,
      folder: user.folder,
      trigger: existing?.trigger ?? `@${ASSISTANT_NAME}`,
      added_at: existing?.added_at ?? new Date().toISOString(),
      requiresTrigger: false,
      canvasUserId: user.canvasUserId,
      githubUsername: user.githubUsername,
    });
  }
  return user.jid;
}

/**
 * A note of TAi's about a student was taken back: the copy of their notes that memory_query and a running call's tool host read
 * (groups/<folder>/memory_store.json) is rebuilt, as src/ipc.ts does after a note is saved. The next text run and the next call rebuild it anyway.
 */
export function refreshMemoryExport(deps: PortalDeps, groupsDir: string, folder: string): void {
  try {
    const jid = Object.entries(deps.registeredGroups()).find(([, group]) => group.folder === folder)?.[0];
    if (jid) writeFileAtomicSafe(path.join(groupsDir, folder, 'memory_store.json'), JSON.stringify(buildMemoryExport(folder, jid)), path.join(groupsDir, folder));   // (never through a link the container planted)
  } catch (err) {
    logger.warn({ err, folder }, 'Student page: could not rebuild memory_store.json after a note was taken back');
  }
}

/** The admin group (folder `main`, the one chat that is the orchestrator's isMain): registered once, here, when the owner first opens it. */
export function ensureAdminGroup(deps: PortalDeps): string {
  const jid = `web:${ADMIN_FOLDER}`;
  if (!deps.registeredGroups()[jid]) {
    deps.registerGroup(jid, {
      name: 'Admin',
      folder: ADMIN_FOLDER,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });
  }
  return jid;
}

export async function startPortal(web: WebChannel, deps: PortalDeps, env: NodeJS.ProcessEnv = process.env): Promise<Portal | null> {
  const socket = env.TAI_PORTAL_SOCKET;
  const port = env.TAI_PORTAL_PORT;
  if (!socket && !port) return null;

  const usersFile = env.TAI_PORTAL_USERS_FILE;
  const secretFile = env.TAI_PORTAL_SECRET_FILE;
  if (!usersFile || !secretFile) {
    throw new Error('the student page needs TAI_PORTAL_USERS_FILE (who may sign in) and TAI_PORTAL_SECRET_FILE (the cookie secret): it will not start without them');
  }
  const clientId = (env.TAI_GOOGLE_CLIENT_ID || '').trim();
  const users = new UserDirectory(usersFile, (message) => logger.warn(message));
  const core: PortalCore = {
    ensureStudent: (user) => ensureStudentGroup(deps, user),
    submit: (jid, text, name, id) => notify.noteSubmit(jid, web.submit(jid, text, { name, id })),       // a message handed to TAi starts the clock of its reply (notify, below)
    onOutbound: (listener) => web.onOutbound(listener),
    isTyping: (jid) => web.isTyping(jid),
    status: (jid) => web.getStatus(jid),
    // the owner's second chat, with the instructor's admin group: only when the deployment asks for it (TAI_ADMIN_CHAT=1)
    ...(env.TAI_ADMIN_CHAT === '1' ? { ensureAdmin: () => ensureAdminGroup(deps) } : {}),
  };
  const history = new HistoryStore(env.TAI_PORTAL_HISTORY_DIR || path.join(STORE_DIR, 'portal'));
  const basePath = env.TAI_PORTAL_BASE_PATH || '/';
  const origin = env.TAI_PORTAL_ORIGIN || undefined;
  const groupsDir = env.TAI_PORTAL_GROUPS_DIR || GROUPS_DIR;
  const portalRef: { current: Portal | null } = { current: null };
  // What feature modules add to the page's server: their routes (src/portal/server.ts, PortalRoute) and the entries they put in /api/me's `features`.
  // One line to a module, so that adding one never touches another's: `...prefsRoutes(...)` for a module that has several routes.
  const routes: PortalRoute[] = [];
  const featureFlags: Array<(user: PortalUser) => Record<string, unknown>> = [];
  const voice = origin
    ? deps.createVoice?.({
        history,
        publicOrigin: origin,
        publicBase: origin.replace(/\/+$/, '') + (basePath === '/' ? '' : basePath.replace(/\/+$/, '')),
        secretFile,
        wakeStudent: (folder) => portalRef.current?.wakeStudent(folder),
      }) ?? null
    : null;
  routes.push(...voiceRoutes({ voice }));       // POST /api/voice/warm: the call's tool host starts while the microphone's prompt is on screen
  const team = teamModule({ env, groupsDir, users, registeredGroups: deps.registeredGroups, db: teamDbOf(() => getDb(), ASSISTANT_NAME) });
  routes.push(...team.routes);                  // GET /api/team/overview and /api/team/student: the teaching view, for the owner only (docs/TEAM_VIEW.md)
  featureFlags.push(team.features);             // features.team: true for the owner, whose account menu then offers the page
  const notify = startNotify({
    env,
    web,
    storeDir: STORE_DIR,
    origin,
    basePath,
    log: logger,
    // e-mail goes to the address a student signed in with, from the allowlist and nowhere else; its password is SMTP_PASSWORD in `.env` (tai_credentials.sh smtp)
    recipientOf: (folder) => users.list().find((u) => u.folder === folder)?.email,
    readSecret: (key) => readEnvFile([key])[key],
  });      // preferences, and web push when TAI_NOTIFY=1, e-mail when TAI_NOTIFY_EMAIL=1 (docs/NOTIFICATIONS.md)
  routes.push(...notify.routes);                // GET/POST api/prefs, GET api/push/key, POST api/push/subscribe and api/push/unsubscribe
  featureFlags.push(notify.features);           // features.prefs, features.push (key and TAI_NOTIFY), features.email (false until the mail channel exists)
  const portal = new Portal({
    core,
    users,
    verifier: clientId ? new GoogleVerifier({ clientId, jwksUrl: env.TAI_PORTAL_JWKS_URL }) : null,
    googleClientId: clientId,
    sessions: new SessionCodec(loadSecret(secretFile),Math.round(parseFloat(env.TAI_PORTAL_SESSION_HOURS || '12') * 3600)),
    nonces: new NonceStore(),
    history,
    media: mediaStore,
    uploads: new UploadStore(groupsDir),
    transcribe: deepgramTranscriber(env),
    voice,
    memory: new StudentMemory(sqliteMemoryStore(() => getDb() as unknown as MemoryDb), groupsDir, Date.now, (folder) => refreshMemoryExport(deps, groupsDir, folder)),
    staticFiles: loadStaticFiles(env.TAI_PORTAL_STATIC_DIR || path.join(process.cwd(), 'portal', 'web'), PAGE_FILES, basePath),
    basePath,
    origin,
    trustProxy: env.TAI_PORTAL_TRUST_PROXY === '1',
    reactReplyDelayMs: reactReplyDelay(env),
    choices: env.TAI_CHOICES !== '0',
    routes,
    presence: notify.presence,                  // each poll says whether the page is open and in front: no push to a page that is looking at the message
    features: (user) => Object.assign({}, ...featureFlags.map((flags) => flags(user))),
    sourceHosts: sourceHosts(readEnvFile, env),           // the hosts a "looked at" chip may link to (src/sources.ts)
  });
  portalRef.current = portal;
  await portal.listen(socket ? { socket } : { host: env.TAI_PORTAL_HOST || '127.0.0.1', port: parseInt(port as string, 10) });
  logger.info(
    { listening: socket || `${env.TAI_PORTAL_HOST || '127.0.0.1'}:${port}`, signIn: clientId ? 'google' : 'closed (no TAI_GOOGLE_CLIENT_ID)', users: users.count() },
    'Student page listening',
  );
  return portal;
}
