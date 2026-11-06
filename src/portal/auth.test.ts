import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthError, GoogleVerifier, NonceStore, RateLimiter, SessionCodec, UserDirectory, b64url, loadSecret, parseUsers, studentFolder } from './auth.js';

const CLIENT = '1234567890-abcdef.apps.googleusercontent.com';
const NOW = 1_800_000_000_000;

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (key: crypto.KeyObject, kid: string) => ({ ...(key.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' });

interface TokenOptions {
  kid?: string;
  alg?: string;
  key?: crypto.KeyObject;
  claims?: Record<string, unknown>;
}

function token(options: TokenOptions = {}): string {
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT,
    sub: '1042',
    email: 'Ada@Example.com',
    email_verified: true,
    nonce: 'nonce-1',
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 3000,
    ...(options.claims || {}),
  };
  const head = b64url(JSON.stringify({ alg: options.alg ?? 'RS256', kid: options.kid ?? 'k1', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), options.key ?? pair.privateKey);
  return `${head}.${body}.${b64url(signature)}`;
}

function verifier(fetches: { count: number }, keys = [jwk(pair.publicKey, 'k1')], clock = { now: NOW }) {
  return new GoogleVerifier({
    clientId: CLIENT,
    now: () => clock.now,
    fetchJwks: async () => {
      fetches.count++;
      return { jwks: { keys }, maxAgeSeconds: 3600 };
    },
  });
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AuthError) return err.reason;
    throw err;
  }
  return 'accepted';
}

describe('GoogleVerifier', () => {
  it('accepts a token Google signed for this page and returns the e-mail in lower case', async () => {
    const v = verifier({ count: 0 });
    expect(await v.verify(token(), 'nonce-1')).toEqual({ email: 'ada@example.com', subject: '1042' });
  });

  it('accepts the issuer written without the scheme', async () => {
    expect(await verifier({ count: 0 }).verify(token({ claims: { iss: 'accounts.google.com' } }), 'nonce-1')).toMatchObject({ email: 'ada@example.com' });
  });

  it('refuses every way a token can be wrong', async () => {
    const v = verifier({ count: 0 });
    const cases: Array<[string, string, string]> = [
      ['another client', token({ claims: { aud: 'someone-else.apps.googleusercontent.com' } }), 'audience'],
      ['another issuer', token({ claims: { iss: 'https://evil.example' } }), 'issuer'],
      ['expired', token({ claims: { exp: NOW / 1000 - 120 } }), 'expired'],
      ['issued in the future', token({ claims: { iat: NOW / 1000 + 600 } }), 'issued-in-the-future'],
      ['no nonce', token({ claims: { nonce: undefined } }), 'nonce'],
      ['another nonce', token({ claims: { nonce: 'nonce-2' } }), 'nonce'],
      ['e-mail not verified', token({ claims: { email_verified: false } }), 'email-not-verified'],
      ['e-mail verified as a string', token({ claims: { email_verified: 'true' } }), 'email-not-verified'],
      ['no e-mail', token({ claims: { email: undefined } }), 'email-not-verified'],
      ['signed by another key', token({ key: other.privateKey }), 'signature'],
      ['unknown key id', token({ kid: 'nope' }), 'unknown-key'],
      ['alg none', token({ alg: 'none' }), 'algorithm'],
      ['alg HS256', token({ alg: 'HS256' }), 'algorithm'],
      ['not a JWT', 'abc.def', 'malformed'],
      ['junk characters', 'a b.c.d', 'malformed'],
      ['far too long', 'a'.repeat(9000), 'malformed'],
    ];
    for (const [name, value, expected] of cases) expect(await reason(v.verify(value, 'nonce-1')), name).toBe(expected);
  });

  it('refuses a token whose payload was changed after it was signed', async () => {
    const [head, , signature] = token().split('.');
    const forged = b64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '1', email: 'root@example.com', email_verified: true, nonce: 'nonce-1', exp: NOW / 1000 + 3000 }));
    expect(await reason(verifier({ count: 0 }).verify(`${head}.${forged}.${signature}`, 'nonce-1'))).toBe('signature');
  });

  it('refuses a token signed with the public key used as an HMAC secret (algorithm confusion)', async () => {
    const head = b64url(JSON.stringify({ alg: 'HS256', kid: 'k1' }));
    const body = b64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '1', email: 'ada@example.com', email_verified: true, nonce: 'nonce-1', exp: NOW / 1000 + 3000 }));
    const mac = crypto.createHmac('sha256', pair.publicKey.export({ type: 'spki', format: 'pem' })).update(`${head}.${body}`).digest();
    expect(await reason(verifier({ count: 0 }).verify(`${head}.${body}.${b64url(mac)}`, 'nonce-1'))).toBe('algorithm');
  });

  it('refuses without an expected nonce, whatever the token carries', async () => {
    expect(await reason(verifier({ count: 0 }).verify(token({ claims: { nonce: '' } }), ''))).toBe('nonce');
  });

  it('fetches Google\'s keys once and keeps them until they expire', async () => {
    const fetches = { count: 0 };
    const clock = { now: NOW };
    const v = verifier(fetches, [jwk(pair.publicKey, 'k1')], clock);
    await v.verify(token(), 'nonce-1');
    await v.verify(token(), 'nonce-1');
    expect(fetches.count).toBe(1);
    clock.now += 3601 * 1000;
    await v.verify(token({ claims: { exp: clock.now / 1000 + 3000, iat: clock.now / 1000 - 5 } }), 'nonce-1');
    expect(fetches.count).toBe(2);
  });

  it('looks once for a key it has not seen, then not again for a minute', async () => {
    const fetches = { count: 0 };
    const clock = { now: NOW };
    const v = verifier(fetches, [jwk(pair.publicKey, 'k1')], clock);
    await v.verify(token(), 'nonce-1');
    expect(fetches.count).toBe(1);
    expect(await reason(v.verify(token({ kid: 'rotated' }), 'nonce-1'))).toBe('unknown-key');
    expect(fetches.count).toBe(2);
    for (let i = 0; i < 5; i++) await reason(v.verify(token({ kid: `junk-${i}` }), 'nonce-1'));
    expect(fetches.count).toBe(2);
    clock.now += 61_000;
    await reason(v.verify(token({ kid: 'rotated' }), 'nonce-1'));
    expect(fetches.count).toBe(3);
  });

  it('answers "unknown key" rather than failing when Google cannot be reached', async () => {
    const v = new GoogleVerifier({ clientId: CLIENT, now: () => NOW, fetchJwks: async () => { throw new Error('offline'); } });
    expect(await reason(v.verify(token(), 'nonce-1'))).toBe('unknown-key');
  });
});

describe('NonceStore', () => {
  it('hands out a nonce once and takes it back once', () => {
    const store = new NonceStore();
    const nonce = store.issue();
    expect(nonce.length).toBeGreaterThanOrEqual(24);
    expect(store.consume(nonce)).toBe(true);
    expect(store.consume(nonce)).toBe(false);
    expect(store.consume('never-issued')).toBe(false);
  });

  it('forgets a nonce after its time and never holds more than its limit', () => {
    const clock = { now: 1000 };
    const store = new NonceStore(1000, 3, () => clock.now);
    const first = store.issue();
    clock.now += 1001;
    expect(store.consume(first)).toBe(false);
    const issued = [store.issue(), store.issue(), store.issue(), store.issue()];
    expect(store.consume(issued[0])).toBe(false);                 // pushed out by the fourth
    expect(store.consume(issued[3])).toBe(true);
  });
});

describe('SessionCodec', () => {
  const secret = crypto.randomBytes(32);
  const clock = { now: NOW };
  const codec = new SessionCodec(secret, 3600, () => clock.now);

  it('gives back the e-mail it signed, until the session ends', () => {
    const { value, maxAgeSeconds } = codec.issue('ada@example.com');
    expect(maxAgeSeconds).toBe(3600);
    expect(codec.verify(value)).toEqual({ email: 'ada@example.com' });
    clock.now += 3599_000;
    expect(codec.verify(value)).toEqual({ email: 'ada@example.com' });
    clock.now += 2_000;
    expect(codec.verify(value)).toBeNull();
    clock.now = NOW;
  });

  it('refuses a cookie that was changed, forged with another secret, or is not one', () => {
    const { value } = codec.issue('ada@example.com');
    const [payload, signature] = value.split('.');
    const forgedPayload = b64url(JSON.stringify({ v: 1, e: 'root@example.com', x: NOW / 1000 + 99999 }));
    expect(codec.verify(`${forgedPayload}.${signature}`)).toBeNull();
    expect(codec.verify(`${payload}.${signature.slice(0, -2)}AA`)).toBeNull();
    expect(new SessionCodec(crypto.randomBytes(32), 3600, () => clock.now).verify(value)).toBeNull();
    for (const junk of [undefined, '', 'abc', 'a.b.c', '.', `${payload}.`, 'x'.repeat(2000)]) expect(codec.verify(junk as string)).toBeNull();
  });

  it('will not run with a short secret', () => {
    expect(() => new SessionCodec(Buffer.alloc(16), 60)).toThrow(/32 bytes/);
  });
});

describe('loadSecret', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const file = (text: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-secret-'));
    dirs.push(dir);
    const f = path.join(dir, 'secret');
    fs.writeFileSync(f, text);
    return f;
  };

  it('reads a hex secret as bytes and refuses one that is too short', () => {
    expect(loadSecret(file(crypto.randomBytes(32).toString('hex') + '\n'))).toHaveLength(32);
    expect(() => loadSecret(file('abcd'))).toThrow(/fewer than 32/);
  });
});

describe('the allowlist', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-users-'));
    dirs.push(dir);
    return dir;
  };

  it('derives a stable folder and chat from the e-mail and nothing else', () => {
    expect(studentFolder('Ada@Example.com')).toBe(studentFolder(' ada@example.com '));
    expect(studentFolder('ada@example.com')).toMatch(/^s_[0-9a-f]{20}$/);
    expect(studentFolder('ada@example.com')).not.toBe(studentFolder('bob@example.com'));
    const [ada] = parseUsers('{"users":[{"email":"Ada@Example.com"}]}');
    expect(ada.jid).toBe(`web:${ada.folder}`);
  });

  it('reads the entries it can use and says why it skipped the others', () => {
    const warnings: string[] = [];
    const users = parseUsers(
      JSON.stringify({
        users: [
          { email: 'ada@example.com', name: ' Ada ', canvasUserId: 1001, githubUsername: 'ada-eval', role: 'owner' },
          { email: 'ADA@example.com', name: 'a duplicate: the last one wins' },
          { email: 'not-an-email' },
          { email: 'bob@example.com', canvasUserId: '12abc' },
          { email: 'cy@example.com', githubUsername: 'bad name!' },
          { email: 'dee@example.com' },
          null,
        ],
      }),
      (m) => warnings.push(m),
    );
    expect(users.map((u) => u.email).sort()).toEqual(['ada@example.com', 'dee@example.com']);
    const ada = users.find((u) => u.email === 'ada@example.com')!;
    expect(ada).toMatchObject({ name: 'a duplicate: the last one wins', role: 'student', canvasUserId: undefined });
    const dee = users.find((u) => u.email === 'dee@example.com')!;
    expect(dee).toMatchObject({ name: 'dee', role: 'student' });
    expect(warnings.length).toBe(4);
    expect(parseUsers('{"users":[{"email":"a@b.co","canvasUserId":1001,"githubUsername":"ada-eval","role":"owner"}]}')[0]).toMatchObject({ canvasUserId: '1001', githubUsername: 'ada-eval', role: 'owner' });
  });

  it('refuses a file that is not a list of users', () => {
    expect(() => parseUsers('{"people":[]}')).toThrow(/users/);
    expect(() => parseUsers('not json')).toThrow();
  });

  it('follows the file when it changes and keeps the last good list when it breaks', () => {
    const file = path.join(tmp(), 'users.json');
    const warnings: string[] = [];
    const directory = new UserDirectory(file, (m) => warnings.push(m));
    expect(directory.find('ada@example.com')).toBeUndefined();            // no file: nobody
    fs.writeFileSync(file, '{"users":[{"email":"ada@example.com"}]}');
    expect(directory.find('ADA@example.com')?.email).toBe('ada@example.com');
    expect(directory.count()).toBe(1);

    fs.writeFileSync(file, '{ broken');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(directory.find('ada@example.com')).toBeDefined();               // still the list from before
    expect(warnings.some((w) => w.includes('keeping the list from before'))).toBe(true);

    fs.writeFileSync(file, '{"users":[{"email":"bob@example.com"}]}');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    expect(directory.find('ada@example.com')).toBeUndefined();             // removed from the file: gone at once
    expect(directory.find('bob@example.com')).toBeDefined();
  });
});

describe('RateLimiter', () => {
  it('lets a key hit up to its limit in a window, and a hit over the limit does not count', () => {
    const clock = { now: 0 };
    const limiter = new RateLimiter(3, 1000, () => clock.now);
    expect([1, 2, 3, 4].map(() => limiter.allow('a'))).toEqual([true, true, true, false]);
    expect(limiter.allow('b')).toBe(true);
    clock.now = 1001;
    expect(limiter.allow('a')).toBe(true);
  });
});
