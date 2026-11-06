/** The VAPID key pair and its token (RFC 8292): decoded, verified with the public key, and what is done with keys that are wrong or missing. */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { Vapid, generateVapidKeys, loadVapid, vapidFromPrivate } from './vapid.js';
import { b64url } from './webpush.js';

/** The public key a push service holds, as a KeyObject, from the 65-byte point: what it verifies a token with. */
function publicKeyOf(point: string): crypto.KeyObject {
  const raw = Buffer.from(point, 'base64url');
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) }, format: 'jwk' });
}

function verify(token: string, point: string): boolean {
  const [header, claims, signature] = token.split('.');
  return crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKeyOf(point), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
}

const NOW = Date.parse('2026-11-05T12:00:00Z');

describe('a VAPID key pair', () => {
  it('is made as a 32-byte private scalar and a 65-byte public point, each as unpadded base64url, and the one gives the other', () => {
    const keys = generateVapidKeys();
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(Buffer.from(keys.publicKey, 'base64url')[0]).toBe(4);
    expect(vapidFromPrivate(keys.privateKey).publicKey).toBe(keys.publicKey);
    expect(generateVapidKeys().privateKey).not.toBe(keys.privateKey);
  });

  it('always has a 43-character private key, also when the scalar begins with a zero byte (one key in 256 does: node leaves that byte out of getPrivateKey)', () => {
    let zeroLeading = 0;
    for (let i = 0; i < 4000; i++) {
      const keys = generateVapidKeys();
      expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      if (Buffer.from(keys.privateKey, 'base64url')[0] === 0) zeroLeading++;
      if (i < 50) expect(vapidFromPrivate(keys.privateKey).publicKey).toBe(keys.publicKey);
    }
    expect(zeroLeading).toBeGreaterThan(0);                       // (the case was really met: about 15 of 4000)
    const forced = vapidFromPrivate(b64url(Buffer.concat([Buffer.alloc(1), Buffer.from('7'.repeat(31))])));
    expect(forced.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
  });

  it('can be read from a PKCS#8 or a SEC1 PEM too, and gives the same public key', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url'), Buffer.from(String(publicKey.export({ format: 'jwk' }).y), 'base64url')]);
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const sec1 = privateKey.export({ type: 'sec1', format: 'pem' }) as string;
    expect(vapidFromPrivate(pkcs8).publicKey).toBe(b64url(point));
    expect(vapidFromPrivate(sec1).publicKey).toBe(b64url(point));
  });

  it('is refused when it is not a P-256 key (another curve, the wrong size, text)', () => {
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => vapidFromPrivate(p384)).toThrow(/P-256/);
    expect(() => vapidFromPrivate(b64url(crypto.randomBytes(31)))).toThrow(/32 bytes/);
    expect(() => vapidFromPrivate('hello')).toThrow();
    expect(() => vapidFromPrivate('')).toThrow();
    expect(() => vapidFromPrivate(b64url(Buffer.alloc(32)))).toThrow();       // the zero scalar is no key
  });
});

describe('the token and the header', () => {
  const keys = generateVapidKeys();
  const vapid = vapidFromPrivate(keys.privateKey);
  const token = vapid.token('https://fcm.googleapis.com', 'https://tai.example/tai', NOW);

  it('is a JWT with the ES256 header and the three claims a push service reads', () => {
    const [header, claims] = token.split('.').slice(0, 2).map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()));
    expect(header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: Math.floor(NOW / 1000) + 12 * 3600, sub: 'https://tai.example/tai' });
    expect(claims.exp - NOW / 1000).toBeLessThanOrEqual(24 * 3600);            // RFC 8292: never more than a day ahead
    expect(claims.exp).toBeGreaterThan(NOW / 1000);
  });

  it('is signed with the private key: the public key verifies it, another does not, and a changed claim does not', () => {
    expect(token.split('.')).toHaveLength(3);
    expect(Buffer.from(token.split('.')[2], 'base64url')).toHaveLength(64);    // r and s, 32 bytes each (IEEE P1363), not DER
    expect(verify(token, keys.publicKey)).toBe(true);
    expect(verify(token, generateVapidKeys().publicKey)).toBe(false);
    const [header, , signature] = token.split('.');
    const forged = b64url(JSON.stringify({ aud: 'https://evil.example', exp: Math.floor(NOW / 1000) + 3600, sub: 'https://tai.example/tai' }));
    expect(verify(`${header}.${forged}.${signature}`, keys.publicKey)).toBe(false);
  });

  it('is in the Authorization header as `vapid t=<token>, k=<public key>`', () => {
    const header = vapid.authorization('https://updates.push.services.mozilla.com', 'mailto:ops@example.com', NOW);
    const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]{87})$/.exec(header);
    expect(match).not.toBeNull();
    expect(match![2]).toBe(keys.publicKey);
    expect(verify(match![1], keys.publicKey)).toBe(true);
    expect(JSON.parse(Buffer.from(match![1].split('.')[1], 'base64url').toString()).sub).toBe('mailto:ops@example.com');
  });

  it('never shows the private key when it is printed or serialised', () => {
    expect(JSON.stringify(vapid)).not.toContain(keys.privateKey);
    expect(String(vapid)).not.toContain(keys.privateKey);
    expect(JSON.stringify(vapid)).toContain(keys.publicKey);
  });
});

describe('the key pair the environment gives', () => {
  const keys = generateVapidKeys();
  const fileOf = (content: string) => (path: string) => {
    if (path !== '/run/vapid.key') throw new Error('ENOENT');
    return `${content}\n`;
  };

  it('is the one in VAPID_PRIVATE_KEY', () => {
    const loaded = loadVapid({ VAPID_PRIVATE_KEY: keys.privateKey });
    expect(loaded.vapid?.publicKey).toBe(keys.publicKey);
    expect(loaded.vapid).toBeInstanceOf(Vapid);
  });

  it('is the one in the file TAI_VAPID_KEY_FILE names, when the environment has none', () => {
    expect(loadVapid({ TAI_VAPID_KEY_FILE: '/run/vapid.key' }, fileOf(keys.privateKey)).vapid?.publicKey).toBe(keys.publicKey);
    const other = generateVapidKeys();
    expect(loadVapid({ VAPID_PRIVATE_KEY: other.privateKey, TAI_VAPID_KEY_FILE: '/run/vapid.key' }, fileOf(keys.privateKey)).vapid?.publicKey).toBe(other.publicKey);
  });

  it('is none, and says why, when there is no key, the file cannot be read or the key is no key', () => {
    expect(loadVapid({}).problem).toMatch(/no VAPID private key/);
    expect(loadVapid({ TAI_VAPID_KEY_FILE: '/nowhere/vapid.key' }, fileOf(keys.privateKey)).problem).toMatch(/cannot be read/);
    const bad = loadVapid({ VAPID_PRIVATE_KEY: 'definitely-not-a-key' });
    expect(bad.vapid).toBeUndefined();
    expect(bad.problem).toMatch(/cannot be used/);
  });

  it('is none when VAPID_PUBLIC_KEY is not the public half of the private key, and fine when it is', () => {
    const other = generateVapidKeys();
    expect(loadVapid({ VAPID_PRIVATE_KEY: keys.privateKey, VAPID_PUBLIC_KEY: other.publicKey }).problem).toMatch(/not the public half/);
    expect(loadVapid({ VAPID_PRIVATE_KEY: keys.privateKey, VAPID_PUBLIC_KEY: keys.publicKey }).vapid?.publicKey).toBe(keys.publicKey);
  });

  it('keeps the private key out of every message it gives', () => {
    const secret = keys.privateKey;
    const messages = [
      loadVapid({ VAPID_PRIVATE_KEY: `${secret}x` }).problem,
      loadVapid({ VAPID_PRIVATE_KEY: secret, VAPID_PUBLIC_KEY: generateVapidKeys().publicKey }).problem,
      loadVapid({ TAI_VAPID_KEY_FILE: '/run/vapid.key' }, () => {
        throw new Error(`could not read, the content was ${secret}`);
      }).problem,
    ];
    for (const message of messages) {
      expect(message).toBeTruthy();
      expect(message).not.toContain(secret);
    }
  });
});
