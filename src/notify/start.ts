/**
 * Builds everything notifications need from the environment and hands the student page its few hooks (src/portal/start.ts calls this once):
 *
 *   routes        the preferences and push calls (src/portal/prefs-routes.ts), always: a time zone and a voice speed are worth keeping
 *                 whether or not anything is switched on
 *   features      `prefs: true`, `push: <on>`, `email: <on>` in GET api/me
 *   presence      what the page's poll reports (whether it is open and in front); when push or e-mail is on
 *   noteSubmit    wraps what the page does with a message of the student's: the clock of a reply starts when it is handed to TAi
 *
 * Push is on only when TAI_NOTIFY is on AND a VAPID key pair is usable AND there is a `sub` claim for it. E-mail is on only when TAI_NOTIFY_EMAIL is on
 * AND the SMTP settings are all there (host, from address, the login's password in `.env` when a user is set) AND the page has an https address to link
 * to AND the list of students can give an address. Anything missing is said once in the log and the page is told `false`, so it draws no switch that
 * cannot work. The notifier listens to the web channel through its own `onOutbound` (the one place every web message passes), so no line of the channel
 * itself changes.
 */
import path from 'node:path';

import type { PortalUser } from '../portal/auth.js';
import { PrefsStore } from '../portal/prefs.js';
import { prefsRoutes } from '../portal/prefs-routes.js';
import type { PortalRoute } from '../portal/server.js';
import { loadVoiceConfig } from '../voice/config.js';
import { notifyConfig } from './config.js';
import { EmailChannel } from './email-channel.js';
import { Notifier, type NotifyChannel, type NotifyLog, type OutboundLike } from './notifier.js';
import { Presence } from './presence.js';
import { PushChannel, type PushLike } from './push-channel.js';
import { SmtpMailer, type MailSender } from './smtp.js';
import { loadVapid } from './vapid.js';
import { PushSender } from './webpush.js';

export interface NotifyStartOptions {
  env: NodeJS.ProcessEnv;
  /** The web channel: its `onOutbound` and the id of this run (src/channels/web.ts). */
  web: { onOutbound(listener: (entry: OutboundLike) => void): () => void; bootId?: string };
  /** The store directory: preferences go to <storeDir>/portal/<folder>.prefs.json, next to the history. */
  storeDir: string;
  origin?: string;
  basePath?: string;
  log?: NotifyLog;
  /** The student's own sign-in address from the allowlist, by their folder: the only place an e-mail address comes from. Without it there is no e-mail. */
  recipientOf?: (folder: string) => string | undefined;
  /** Reads a secret of the orchestrator's `.env` (readEnvFile): the SMTP password. Not the process environment: it is never in it. */
  readSecret?: (key: string) => string | undefined;
  /** For tests and the dev server only: stand in for the connection to the push services and to the mail server. The page's own start never passes them. */
  sender?: PushLike;
  mailer?: MailSender;
  now?: () => number;
  /** How often held messages are looked at (ms). Default 30 s. */
  sweepEveryMs?: number;
}

export interface NotifyStart {
  routes: PortalRoute[];
  features: (user: PortalUser) => Record<string, unknown>;
  presence?: Presence;
  notifier?: Notifier;
  prefs: PrefsStore;
  pushOn: boolean;
  emailOn: boolean;
  /** Returns the result unchanged; a message that was accepted starts the clock of its reply. */
  noteSubmit<T extends { ok: boolean }>(jid: string, result: T): T;
  stop(): void;
}

const silent: NotifyLog = { debug: () => undefined, info: () => undefined, warn: () => undefined };

export function startNotify(opts: NotifyStartOptions): NotifyStart {
  const log = opts.log ?? silent;
  const config = notifyConfig(opts.env, { origin: opts.origin, basePath: opts.basePath });
  for (const warning of config.warnings) log.warn({}, `notify: ${warning}`);
  const prefs = new PrefsStore(path.join(opts.storeDir, 'portal'), opts.now);
  // what a call runs at until the student chooses: read the way src/voice reads its own settings (TAI_VOICE_SPEED), so the dialog shows what they get
  const voiceSpeed = loadVoiceConfig((key) => opts.env[key]).speed ?? 1;

  // push
  let vapid = config.on ? loadVapid(opts.env) : undefined;
  let publicKey = '';
  if (vapid && !vapid.vapid) log.warn({}, `notify: TAI_NOTIFY is on but push stays off: ${vapid.problem}`);
  else if (vapid?.vapid && !config.subject) {
    log.warn({}, 'notify: TAI_NOTIFY is on but push stays off: no TAI_PUSH_SUBJECT and no https TAI_PORTAL_ORIGIN to take the VAPID subject from');
    vapid = undefined;
  }
  const signer = vapid?.vapid;
  if (signer) publicKey = signer.publicKey;

  // e-mail
  let mailer: MailSender | undefined;
  const email = config.email;
  if (email.on) {
    const missing: string[] = [];
    if (!email.host) missing.push('TAI_SMTP_HOST');
    if (!email.from) missing.push('TAI_NOTIFY_FROM');
    if (!config.pageUrl) missing.push('an https TAI_PORTAL_ORIGIN (the link in the mail)');
    if (!opts.recipientOf) missing.push('the list of students');
    const password = email.user ? (opts.readSecret?.('SMTP_PASSWORD') ?? '') : '';
    if (email.user && !password) missing.push('SMTP_PASSWORD (tai_credentials.sh smtp)');
    if (missing.length) log.warn({}, `notify: TAI_NOTIFY_EMAIL is on but e-mail stays off: missing ${missing.join(', ')}`);
    else {
      mailer = opts.mailer ?? new SmtpMailer({ host: email.host as string, port: email.port, user: email.user, password: password || undefined, from: email.from as string }, { log, now: opts.now });
    }
  }

  const pushOn = !!signer;
  const emailOn = !!mailer;
  const presence = pushOn || emailOn ? new Presence({ now: opts.now }) : undefined;
  const channels: NotifyChannel[] = [];
  if (signer && presence) {
    const sender = opts.sender ?? new PushSender({ vapid: signer, subject: config.subject as string, now: opts.now });
    channels.push(new PushChannel({ sender, prefs, log, now: opts.now }));
  }
  if (mailer && presence) {
    channels.push(
      new EmailChannel({
        mailer,
        recipientOf: opts.recipientOf as (folder: string) => string | undefined,
        prefs,
        page: presence,
        pageUrl: config.pageUrl as string,
        rules: email.rules,
        defaultTz: config.rules.defaultTz,
        log,
        now: opts.now,
      }),
    );
  }

  let notifier: Notifier | undefined;
  let stopListening = () => undefined as void;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (presence && channels.length) {
    const live = new Notifier({ rules: config.rules, prefs, channels, page: presence, log, preview: config.preview, bootId: opts.web.bootId, now: opts.now });
    notifier = live;
    stopListening = opts.web.onOutbound((entry) => live.outbound(entry));
    timer = setInterval(() => live.sweep(), opts.sweepEveryMs ?? 30_000);
    timer.unref?.();
    if (pushOn) {
      log.info(
        { quiet: `${config.quiet.start}-${config.quiet.end}`, dailyMax: config.rules.dailyMax, replyAfterSeconds: config.rules.replyAfterMs / 1000, preview: config.preview, subject: config.subject },
        'notify: push is on',
      );
    }
    if (emailOn) log.info({ afterMinutes: email.rules.afterMs / 60_000, dailyMax: email.rules.dailyMax, port: email.port }, 'notify: e-mail is on');
  }

  return {
    routes: prefsRoutes({
      prefs,
      push: pushOn ? { publicKey } : null,
      limits: {
        quietStart: config.quiet.start,
        quietEnd: config.quiet.end,
        dailyMax: config.rules.dailyMax,
        ...(emailOn ? { emailAfterMinutes: email.rules.afterMs / 60_000, emailDailyMax: email.rules.dailyMax } : {}),
      },
      defaults: { voiceSpeed },
      emailAvailable: () => emailOn,
      now: opts.now,
      log,
    }),
    features: () => ({ prefs: true, push: pushOn, email: emailOn }),
    presence,
    notifier,
    prefs,
    pushOn,
    emailOn,
    noteSubmit: (jid, result) => {
      try {
        if (result.ok && notifier && jid.startsWith('web:')) notifier.studentMessage(jid.slice(4));
      } catch {
        /* a notification is never a reason for a message not to reach TAi */
      }
      return result;
    },
    stop: () => {
      stopListening();
      if (timer) clearInterval(timer);
    },
  };
}
