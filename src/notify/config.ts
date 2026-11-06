/**
 * The settings of notifications, read from the orchestrator's environment (docs/SETTINGS.md and docs/NOTIFICATIONS.md list them with what they do).
 * Nonsense falls back to the default and says so in `warnings`; nothing here throws.
 *
 *   TAI_NOTIFY                       1: web push may be sent (needs a VAPID key). Default: off.
 *   TAI_VAPID_KEY_FILE, VAPID_*      the key pair (vapid.ts)
 *   TAI_PUSH_SUBJECT                 the VAPID `sub` claim (an https URL or mailto:), which Google's and Mozilla's push services see.
 *                                    Default: the page's own https address, not anyone's e-mail address.
 *   TAI_PUSH_PREVIEW                 1: the first ~80 characters of a message in the notification. Default: off (a lock screen shows it).
 *   TAI_PUSH_DAILY_MAX               pushes of TAi's own messages per student per local day. Default 3; 0: none.
 *   TAI_PUSH_QUIET_START, _END       quiet hours for TAi's own messages, "22:00" and "08:00" (equal: none), in the student's time zone
 *   TAI_PUSH_REPLY_AFTER_SECONDS     a reply is pushed only if the student waited this long. Default 20.
 *   TAI_PUSH_DEFAULT_TZ              the zone of a student who has not told us theirs. Default America/Los_Angeles (the course's "Pacific").
 *
 *   TAI_NOTIFY_EMAIL                 1: e-mail to a student who turned it on (needs the SMTP settings). Default: off.
 *   TAI_SMTP_HOST, TAI_SMTP_PORT     the mail server; 465 is TLS from the first byte, any other port (default 587) must offer STARTTLS
 *   TAI_SMTP_USER, TAI_NOTIFY_FROM   the login (none: no login) and the address mail is sent from. The password is SMTP_PASSWORD in `.env`.
 *   TAI_EMAIL_DAILY_MAX              e-mails per student per local day. Default 1; 0: none.
 *   TAI_EMAIL_AFTER_MINUTES          a message nobody has looked at this long is written about. Default 60.
 */
import { validTimeZone } from '../portal/prefs.js';
import { DEFAULT_EMAIL_RULES, DEFAULT_RULES, type EmailRules, type Rules } from './core.js';
import { validAddress } from './smtp.js';

export interface EmailConfig {
  /** TAI_NOTIFY_EMAIL=1. Whether e-mail really is on also needs everything below (and the password): src/notify/start.ts says what is missing. */
  on: boolean;
  host?: string;
  port: number;
  user?: string;
  from?: string;
  rules: EmailRules;
}

export interface NotifyConfig {
  on: boolean;
  preview: boolean;
  /** The `sub` claim; undefined when there is no usable one (push stays off). */
  subject?: string;
  rules: Rules;
  /** The quiet hours as the page shows them. */
  quiet: { start: string; end: string };
  /** Where the page is, for the link in an e-mail (https origin and base path, ending in a slash); undefined without an https origin. */
  pageUrl?: string;
  email: EmailConfig;
  warnings: string[];
}

const truthy = (value: string | undefined): boolean => ['1', 'true', 'on', 'yes'].includes((value ?? '').trim().toLowerCase());

/** "22:00", "8:30", "8": minutes after midnight, or null. */
export function parseClock(value: string | undefined): number | null {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec((value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

export const clockText = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function whole(value: string | undefined, fallback: number, min: number, max: number, name: string, warnings: string[]): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  warnings.push(`${name}=${JSON.stringify(value.slice(0, 20))} is not a whole number from ${min} to ${max}: ${fallback} is used`);
  return fallback;
}

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const LOGIN = /^[\x21-\x7e]{1,200}$/;

function emailConfig(env: NodeJS.ProcessEnv, warnings: string[]): EmailConfig {
  const host = (env.TAI_SMTP_HOST ?? '').trim();
  const port = (env.TAI_SMTP_PORT ?? '').trim();
  const user = (env.TAI_SMTP_USER ?? '').trim();
  const from = (env.TAI_NOTIFY_FROM ?? '').trim();
  let portNumber = 587;
  let portOk = true;
  if (port) {
    const n = Number(port);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) portNumber = n;
    else {
      portOk = false;
      warnings.push('TAI_SMTP_PORT is not a port number (465 for TLS, 587 for STARTTLS): e-mail stays off');
    }
  }
  const hostOk = !host || HOST.test(host);
  if (!hostOk) warnings.push('TAI_SMTP_HOST is not a host name: e-mail stays off');
  const userOk = !user || LOGIN.test(user);
  if (!userOk) warnings.push('TAI_SMTP_USER is not a login name: e-mail stays off');
  const fromOk = !from || validAddress(from);
  if (!fromOk) warnings.push('TAI_NOTIFY_FROM is not a plain e-mail address: e-mail stays off');
  return {
    on: truthy(env.TAI_NOTIFY_EMAIL),
    host: host && hostOk && portOk ? host : undefined,
    port: portNumber,
    user: user && userOk ? user : undefined,
    from: from && fromOk ? from : undefined,
    rules: {
      ...DEFAULT_EMAIL_RULES,
      dailyMax: whole(env.TAI_EMAIL_DAILY_MAX, DEFAULT_EMAIL_RULES.dailyMax, 0, 10, 'TAI_EMAIL_DAILY_MAX', warnings),
      afterMs: whole(env.TAI_EMAIL_AFTER_MINUTES, DEFAULT_EMAIL_RULES.afterMs / 60_000, 1, 1440, 'TAI_EMAIL_AFTER_MINUTES', warnings) * 60_000,
    },
  };
}

export function notifyConfig(env: NodeJS.ProcessEnv, page: { origin?: string; basePath?: string } = {}): NotifyConfig {
  const warnings: string[] = [];
  const on = truthy(env.TAI_NOTIFY);

  let subject: string | undefined;
  let pageUrl: string | undefined;
  const given = (env.TAI_PUSH_SUBJECT ?? '').trim();
  if (given) {
    if (/^(https:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/.test(given)) subject = given;
    else warnings.push('TAI_PUSH_SUBJECT must be an https URL or a mailto: address: the page\'s own address is used');
  }
  if (page.origin && /^https:\/\//.test(page.origin)) {
    const base = (page.basePath ?? '/').replace(/\/+$/, '');
    const root = page.origin.replace(/\/+$/, '') + (base && base !== '/' ? base : '');
    if (!subject) subject = root;
    pageUrl = `${root}/`;
  }

  const start = parseClock(env.TAI_PUSH_QUIET_START);
  const end = parseClock(env.TAI_PUSH_QUIET_END);
  if (env.TAI_PUSH_QUIET_START && start === null) warnings.push('TAI_PUSH_QUIET_START is not a time such as 22:00: 22:00 is used');
  if (env.TAI_PUSH_QUIET_END && end === null) warnings.push('TAI_PUSH_QUIET_END is not a time such as 08:00: 08:00 is used');

  let defaultTz = DEFAULT_RULES.defaultTz;
  if (env.TAI_PUSH_DEFAULT_TZ) {
    const zone = validTimeZone(env.TAI_PUSH_DEFAULT_TZ.trim());
    if (zone) defaultTz = zone;
    else warnings.push(`TAI_PUSH_DEFAULT_TZ is not a time zone: ${defaultTz} is used`);
  }

  const rules: Rules = {
    ...DEFAULT_RULES,
    quietStart: start ?? DEFAULT_RULES.quietStart,
    quietEnd: end ?? DEFAULT_RULES.quietEnd,
    dailyMax: whole(env.TAI_PUSH_DAILY_MAX, DEFAULT_RULES.dailyMax, 0, 100, 'TAI_PUSH_DAILY_MAX', warnings),
    replyAfterMs: whole(env.TAI_PUSH_REPLY_AFTER_SECONDS, DEFAULT_RULES.replyAfterMs / 1000, 0, 3600, 'TAI_PUSH_REPLY_AFTER_SECONDS', warnings) * 1000,
    defaultTz,
  };
  return { on, preview: truthy(env.TAI_PUSH_PREVIEW), subject, rules, quiet: { start: clockText(rules.quietStart), end: clockText(rules.quietEnd) }, pageUrl, email: emailConfig(env, warnings), warnings };
}
