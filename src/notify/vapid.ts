/**
 * VAPID (RFC 8292): the server's own key pair, which a push service uses to know that a message comes from the site that the subscription was made
 * for. The private key signs a short-lived ES256 token for each push (`Authorization: vapid t=<token>, k=<public key>`); the public key is what
 * the page hands to `pushManager.subscribe` as its application server key, so a subscription only ever accepts messages from this key.
 *
 * The private key is never logged, never in a URL, never in a response. It comes from the environment (VAPID_PRIVATE_KEY) or from a file
 * the environment names (TAI_VAPID_KEY_FILE, mode 600, what `tai_live.sh notify vapid` writes). Either holds the key the way the web-push
 * libraries do: the 32-byte private scalar as unpadded base64url. A PEM (PKCS#8 or SEC1) is accepted too. The public key is worked out from
 * it; a VAPID_PUBLIC_KEY that disagrees means the keys were mixed up, and push stays off rather than send what no browser would accept.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { b64url, decodeB64url } from './webpush.js';

/** What a token is good for (RFC 8292 allows up to 24 hours; a push is sent within seconds). */
const TOKEN_SECONDS = 12 * 60 * 60;

export class Vapid {
  /** The 65-byte uncompressed public key, unpadded base64url: the `k=` of the header and the page's application server key. */
  readonly publicKey: string;

  constructor(private readonly privateKey: crypto.KeyObject, publicPoint: Buffer) {
    this.publicKey = b64url(publicPoint);
  }

  /** The ES256 token (a JWT): `aud` is the push service's origin, `sub` how to reach the operator (an https URL or mailto:), `exp` within 24 hours. */
  token(audience: string, subject: string, nowMs: number): string {
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64url(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + TOKEN_SECONDS, sub: subject }));
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: this.privateKey, dsaEncoding: 'ieee-p1363' });
    return `${header}.${claims}.${b64url(signature)}`;
  }

  /** The value of the Authorization header (RFC 8292, section 3). */
  authorization(audience: string, subject: string, nowMs: number): string {
    return `vapid t=${this.token(audience, subject, nowMs)}, k=${this.publicKey}`;
  }
}

/** A key pair in the form the files and the environment hold it: the private scalar and the public point, each unpadded base64url. */
export function generateVapidKeys(): { privateKey: string; publicKey: string } {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  // getPrivateKey() drops leading zero bytes (one key in 256 begins with one), and a scalar of 31 bytes is not what loadVapid reads: padded to 32
  const scalar = ecdh.getPrivateKey();
  return { privateKey: b64url(Buffer.concat([Buffer.alloc(32 - scalar.length), scalar])), publicKey: b64url(ecdh.getPublicKey()) };
}

/** The signer for a private key written as base64url (32 bytes) or as a PEM. Throws when it is neither. */
export function vapidFromPrivate(raw: string): Vapid {
  const text = raw.trim();
  if (text.startsWith('-----BEGIN')) {
    const privateKey = crypto.createPrivateKey(text);
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('the VAPID key must be an EC key on P-256');
    const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
    const x = Buffer.from(String(jwk.x), 'base64url');
    const y = Buffer.from(String(jwk.y), 'base64url');
    return new Vapid(privateKey, Buffer.concat([Buffer.from([4]), x, y]));
  }
  const scalar = decodeB64url(text, 32);
  if (!scalar) throw new Error('the VAPID private key must be 32 bytes as unpadded base64url (or a PEM)');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(scalar);
  const point = ecdh.getPublicKey();
  const privateKey = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(scalar), x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) },
    format: 'jwk',
  });
  return new Vapid(privateKey, point);
}

export type VapidLoad = { vapid: Vapid; problem?: undefined } | { vapid?: undefined; problem: string };

/**
 * The key pair the environment gives, or why there is none. The private key is the environment's VAPID_PRIVATE_KEY, else the file named by
 * TAI_VAPID_KEY_FILE. Nothing about the key itself appears in `problem`.
 */
export function loadVapid(env: NodeJS.ProcessEnv, readFile: (path: string) => string = (path) => fs.readFileSync(path, 'utf-8')): VapidLoad {
  let raw = (env.VAPID_PRIVATE_KEY || '').trim();
  const file = (env.TAI_VAPID_KEY_FILE || '').trim();
  if (!raw && file) {
    try {
      raw = readFile(file).trim();
    } catch {
      return { problem: `TAI_VAPID_KEY_FILE names a file that cannot be read (${file})` };
    }
  }
  if (!raw) return { problem: 'no VAPID private key (VAPID_PRIVATE_KEY, or a file named by TAI_VAPID_KEY_FILE)' };
  let vapid: Vapid;
  try {
    vapid = vapidFromPrivate(raw);
  } catch (err) {
    return { problem: `the VAPID private key cannot be used (${(err as Error).message.slice(0, 100)})` };
  }
  const declared = (env.VAPID_PUBLIC_KEY || '').trim();
  if (declared && declared !== vapid.publicKey) return { problem: 'VAPID_PUBLIC_KEY is not the public half of the private key: push is off until they agree' };
  return { vapid };
}
