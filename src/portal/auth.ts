/**
 * Who may use the student page, and how it knows. Three pieces, none of which talks to Canvas, GitHub or a model:
 *
 *  - GoogleVerifier: the "Sign in with Google" button hands the page an ID token; it is checked here against Google's published
 *    keys (signature, issuer, audience, expiry, verified e-mail, and the nonce this server issued for that page load).
 *  - SessionCodec: a verified e-mail is traded for a cookie this server signs itself (HMAC), so nothing is stored and a restart
 *    does not sign anyone out.
 *  - UserDirectory: the allowlist (a JSON file the operator edits). It decides WHICH chat, Canvas user and GitHub account a
 *    signed-in e-mail is bound to: that binding is never read from a request.
 */
import crypto from 'crypto';
import fs from 'fs';

export class AuthError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

export function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

// ---------------------------------------------------------------- Google ID tokens

export interface GoogleIdentity {
  email: string;
  subject: string;
}

export interface Jwks {
  keys: Array<Record<string, unknown>>;
}

export interface GoogleVerifierOptions {
  clientId: string;
  /** Where Google's public keys are; tests point it at their own. */
  jwksUrl?: string;
  /** How to get them (a test passes a stub). Returns the key set and how long it may be cached, in seconds. */
  fetchJwks?: () => Promise<{ jwks: Jwks; maxAgeSeconds: number }>;
  now?: () => number;
}

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const CLOCK_SKEW_SECONDS = 60;
const MIN_KEY_CACHE_SECONDS = 300;
const MAX_KEY_CACHE_SECONDS = 86_400;
const UNKNOWN_KEY_REFRESH_COOLDOWN_MS = 60_000;
const MAX_TOKEN_CHARS = 8192;

async function defaultFetchJwks(url: string): Promise<{ jwks: Jwks; maxAgeSeconds: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`keys answered HTTP ${res.status}`);
  const jwks = (await res.json()) as Jwks;
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  return { jwks, maxAgeSeconds: maxAge ? parseInt(maxAge[1], 10) : 3600 };
}

export class GoogleVerifier {
  private keys = new Map<string, crypto.KeyObject>();
  private expiresAt = 0;
  private lastUnknownRefresh = 0;
  private inFlight: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly fetchJwks: () => Promise<{ jwks: Jwks; maxAgeSeconds: number }>;

  constructor(private readonly opts: GoogleVerifierOptions) {
    this.now = opts.now ?? Date.now;
    this.fetchJwks = opts.fetchJwks ?? (() => defaultFetchJwks(opts.jwksUrl ?? GOOGLE_JWKS_URL));
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const { jwks, maxAgeSeconds } = await this.fetchJwks();
        const next = new Map<string, crypto.KeyObject>();
        for (const jwk of jwks.keys || []) {
          if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
          try {
            next.set(jwk.kid, crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' }));
          } catch {
            /* a key we cannot read is a key nobody can sign in with */
          }
        }
        if (next.size === 0) throw new Error('no usable keys');
        this.keys = next;
        const cache = Math.min(Math.max(maxAgeSeconds, MIN_KEY_CACHE_SECONDS), MAX_KEY_CACHE_SECONDS);
        this.expiresAt = this.now() + cache * 1000;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  private async keyFor(kid: string): Promise<crypto.KeyObject | undefined> {
    if (this.now() >= this.expiresAt) await this.refresh().catch(() => undefined);
    let key = this.keys.get(kid);
    if (!key && this.now() - this.lastUnknownRefresh > UNKNOWN_KEY_REFRESH_COOLDOWN_MS) {
      // Google rotates its keys: one look for a key we have not seen, then not again for a minute (a flood of bad tokens must not become a flood of fetches)
      this.lastUnknownRefresh = this.now();
      await this.refresh().catch(() => undefined);
      key = this.keys.get(kid);
    }
    return key;
  }

  /** The e-mail Google vouches for, or an AuthError saying why not. `expectedNonce` is the one this server issued to that page. */
  async verify(idToken: string, expectedNonce: string): Promise<GoogleIdentity> {
    if (typeof idToken !== 'string' || idToken.length > MAX_TOKEN_CHARS) throw new AuthError('malformed');
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new AuthError('malformed');
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    } catch {
      throw new AuthError('malformed');
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AuthError('algorithm');
    const key = await this.keyFor(header.kid);
    if (!key) throw new AuthError('unknown-key');
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!crypto.verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) throw new AuthError('signature');

    const nowSeconds = Math.floor(this.now() / 1000);
    if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) throw new AuthError('issuer');
    if (claims.aud !== this.opts.clientId) throw new AuthError('audience');
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) throw new AuthError('expired');
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) throw new AuthError('issued-in-the-future');
    if (typeof claims.nonce !== 'string' || !expectedNonce || claims.nonce !== expectedNonce) throw new AuthError('nonce');
    if (claims.email_verified !== true || typeof claims.email !== 'string' || typeof claims.sub !== 'string') throw new AuthError('email-not-verified');
    return { email: claims.email.trim().toLowerCase(), subject: claims.sub };
  }
}

/** Nonces handed to a page before it asks Google for a token: single use, short lived, bounded. */
export class NonceStore {
  private issued = new Map<string, number>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maxEntries = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(): string {
    this.sweep();
    while (this.issued.size >= this.maxEntries) this.issued.delete(this.issued.keys().next().value as string);
    const nonce = b64url(crypto.randomBytes(24));
    this.issued.set(nonce, this.now() + this.ttlMs);
    return nonce;
  }

  /** True once per issued nonce, and only before it expires. */
  consume(nonce: string): boolean {
    const expires = this.issued.get(nonce);
    this.issued.delete(nonce);
    return expires !== undefined && expires >= this.now();
  }

  private sweep(): void {
    const now = this.now();
    for (const [nonce, expires] of this.issued) if (expires < now) this.issued.delete(nonce);
  }
}

// ---------------------------------------------------------------- sessions

export class SessionCodec {
  constructor(
    private readonly secret: Buffer,
    private readonly ttlSeconds: number,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < 32) throw new Error('the session secret must be at least 32 bytes');
  }

  private sign(payload: string): string {
    return b64url(crypto.createHmac('sha256', this.secret).update(`tai-session.${payload}`).digest());
  }

  issue(email: string): { value: string; maxAgeSeconds: number } {
    const exp = Math.floor(this.now() / 1000) + this.ttlSeconds;
    const payload = b64url(JSON.stringify({ v: 1, e: email, x: exp }));
    return { value: `${payload}.${this.sign(payload)}`, maxAgeSeconds: this.ttlSeconds };
  }

  verify(cookie: string | undefined): { email: string } | null {
    if (!cookie || cookie.length > 1024) return null;
    const [payload, signature, extra] = cookie.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as { v?: number; e?: string; x?: number };
      if (claims.v !== 1 || typeof claims.e !== 'string' || typeof claims.x !== 'number') return null;
      if (claims.x < Math.floor(this.now() / 1000)) return null;
      return { email: claims.e };
    } catch {
      return null;
    }
  }
}

/** The cookie-signing secret lives in a file (mode 600), never in an environment variable. */
export function loadSecret(file: string): Buffer {
  const raw = fs.readFileSync(file, 'utf-8').trim();
  const secret = /^[0-9a-fA-F]{64,}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'utf-8');
  if (secret.length < 32) throw new Error(`${file} holds fewer than 32 bytes`);
  return secret;
}

// ---------------------------------------------------------------- the allowlist

export interface PortalUser {
  email: string;
  name: string;
  role: 'owner' | 'student';
  canvasUserId?: string;
  githubUsername?: string;
  /** The group folder and the chat of this student: derived from the e-mail, stable, not guessable from a name. */
  folder: string;
  jid: string;
}

/** s_ + 20 hex digits of the e-mail's hash: `[a-zA-Z0-9_-]`, so it is a valid group folder and a safe container name. */
export function studentFolder(email: string): string {
  return 's_' + crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 20);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function parseUsers(text: string, warn: (message: string) => void = () => undefined): PortalUser[] {
  const data = JSON.parse(text) as { users?: unknown };
  if (!data || !Array.isArray(data.users)) throw new Error('"users" must be a list');
  const out = new Map<string, PortalUser>();
  for (const raw of data.users as Array<Record<string, unknown>>) {
    const email = typeof raw?.email === 'string' ? raw.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) {
      warn('a user without a usable e-mail address was skipped');
      continue;
    }
    const canvas = raw.canvasUserId === undefined || raw.canvasUserId === null || raw.canvasUserId === '' ? undefined : String(raw.canvasUserId);
    if (canvas !== undefined && !/^\d{1,15}$/.test(canvas)) {
      warn(`${email}: canvasUserId must be digits: skipped`);
      continue;
    }
    const github = typeof raw.githubUsername === 'string' && raw.githubUsername ? raw.githubUsername : undefined;
    if (github !== undefined && !GITHUB_LOGIN.test(github)) {
      warn(`${email}: githubUsername is not a GitHub login: skipped`);
      continue;
    }
    const folder = studentFolder(email);
    out.set(email, {
      email,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : email.split('@')[0],
      role: raw.role === 'owner' ? 'owner' : 'student',
      canvasUserId: canvas,
      githubUsername: github,
      folder,
      jid: `web:${folder}`,
    });
  }
  return [...out.values()];
}

/** The allowlist file, re-read when it changes. A file that no longer parses keeps the last good list (and says so once). */
export class UserDirectory {
  private users = new Map<string, PortalUser>();
  private mtimeMs = -1;
  private broken = false;

  constructor(
    private readonly file: string,
    private readonly warn: (message: string) => void = () => undefined,
  ) {
    this.reload();
  }

  private reload(): void {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      if (this.mtimeMs !== -2) this.warn(`${this.file} does not exist: nobody can sign in`);
      this.mtimeMs = -2;
      this.users = new Map();
      return;
    }
    if (mtimeMs === this.mtimeMs) return;
    try {
      const list = parseUsers(fs.readFileSync(this.file, 'utf-8'), this.warn);
      this.users = new Map(list.map((u) => [u.email, u]));
      this.broken = false;
    } catch (err) {
      if (!this.broken) this.warn(`${this.file} cannot be read (${(err as Error).message}): keeping the list from before`);
      this.broken = true;
    }
    this.mtimeMs = mtimeMs;
  }

  find(email: string): PortalUser | undefined {
    this.reload();
    return this.users.get(email.trim().toLowerCase());
  }

  count(): number {
    this.reload();
    return this.users.size;
  }

  /** Everyone on the list (a change in the course goes to the ones who have a conversation here). */
  list(): PortalUser[] {
    this.reload();
    return [...this.users.values()];
  }
}

// ---------------------------------------------------------------- rate limits

/** At most `max` hits per key in any `windowMs`. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit; false when the key is over its limit (the hit then does not count). */
  allow(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) || []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(now);
    return true;
  }

  private sweep(now: number): void {
    for (const [key, times] of this.hits) if (times.every((t) => t <= now - this.windowMs)) this.hits.delete(key);
  }
}
