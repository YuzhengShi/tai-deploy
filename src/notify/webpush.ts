/**
 * Web Push written with node:crypto and node:https alone: RFC 8030 delivery (a POST to the subscription's endpoint with TTL and Urgency),
 * RFC 8291 `aes128gcm` payload encryption (checked against the RFC's own example in webpush.test.ts), RFC 8292 VAPID (vapid.ts signs).
 *
 * The one thing that needs care is the endpoint. It is a URL a signed-in student posted, and the server will connect to it: a classic
 * server-side request forgery. So (1) an endpoint is accepted only when it is https, on the default port, without credentials, and its host
 * is one of the push services the browser vendors run (PUSH_SERVICE_HOSTS); an IP literal, a name without a dot, a look-alike such as
 * `fcm.googleapis.com.evil.example` and a trailing-dot host all fail that test; (2) it is checked again at every send, from the stored
 * string, and the connection goes to the host the check parsed, never to a re-parsed string; (3) the name is resolved through a guard that
 * refuses private, loopback and link-local addresses, in case a name inside a vendor's domain ever pointed somewhere it should not;
 * (4) nothing is followed: a redirect is a failure, there is a timeout and the answer is read up to a few kilobytes and no further.
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

import type { Vapid } from './vapid.js';

/**
 * The push services a subscription may name. A rule that starts with a dot is any host below that name; one that does not is that host and
 * no other. `fcm.googleapis.com` is exact on purpose: other hosts of googleapis.com serve content that other people control.
 * Chrome, Edge, Opera, Brave and Samsung Internet use FCM; Firefox uses Mozilla's autopush; Edge on Windows may use WNS; Safari (macOS and the
 * home-screen web apps of iOS 16.4 and later) uses Apple's, at `web.push.apple.com` and nowhere else: `api.push.apple.com` is the gateway for native
 * apps (APNs), not a web push service, so the rest of `push.apple.com` is not let in.
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
  'web.push.apple.com',
];

/** The longest endpoint kept (real ones are 100 to 500 characters). */
const MAX_ENDPOINT_CHARS = 2048;
/** The plaintext of one push, at most. RFC 8291 allows 3,993 in a single 4,096-byte message; a notification needs a few hundred. */
export const MAX_PAYLOAD_BYTES = 3000;
/** Every payload is padded to this many bytes before it is encrypted, so the size of the message says nothing about the words in it. */
export const PAD_TO_BYTES = 256;
const RECORD_SIZE = 4096;
const RESPONSE_CAP_BYTES = 4096;
const HOST_LABELS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export const b64url = (data: Buffer | Uint8Array | string): string => Buffer.from(data as Buffer).toString('base64url');

/** `bytes` bytes out of canonical unpadded base64url, or null (wrong alphabet, wrong length, stray bits). */
export function decodeB64url(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64url');
  return buf.length === bytes && buf.toString('base64url') === value ? buf : null;
}

/** A short, stable name for an endpoint, for logs and for the page to tell its own subscription: the endpoint itself is never logged or listed. */
export function endpointHash(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
}

/**
 * The URL to connect to for an endpoint a student gave, or null when it may not be used. Everything about the host is judged on what
 * `new URL` parsed (it has already lower-cased, decoded and punycoded the name), and the caller connects to `url.hostname`.
 */
export function validateEndpoint(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ENDPOINT_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '' && url.port !== '443') return null;
  const host = url.hostname;
  // dotted labels of letters, digits and hyphens: no brackets (IPv6), no trailing dot, no empty label, no name without a dot ("localhost", "intranet")
  if (host.length > 253 || !HOST_LABELS.test(host)) return null;
  if (net.isIP(host) !== 0) return null;
  if (!PUSH_SERVICE_HOSTS.some((rule) => (rule.startsWith('.') ? host.endsWith(rule) : host === rule))) return null;
  return url;
}

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** A subscription as the browser's `toJSON()` gives it, checked: the endpoint by validateEndpoint, p256dh a point of P-256 (65 bytes), auth 16 bytes. */
export function checkSubscription(raw: unknown): { ok: true; sub: WebPushSubscription } | { ok: false; error: 'bad-endpoint' | 'bad-keys' } {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (!validateEndpoint(value.endpoint)) return { ok: false, error: 'bad-endpoint' };
  const keys = value.keys && typeof value.keys === 'object' ? (value.keys as Record<string, unknown>) : {};
  const point = decodeB64url(keys.p256dh, 65);
  const auth = decodeB64url(keys.auth, 16);
  if (!point || !auth || !isP256Point(point)) return { ok: false, error: 'bad-keys' };
  return { ok: true, sub: { endpoint: value.endpoint as string, keys: { p256dh: keys.p256dh as string, auth: keys.auth as string } } };
}

/** A public key that is really a point on the curve (a random 65 bytes starting with 4 is not): the ECDH of node:crypto refuses the others. */
function isP256Point(point: Buffer): boolean {
  if (point.length !== 65 || point[0] !== 4) return false;
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(point);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- RFC 8291: the payload

const hmac = (key: Buffer, data: Buffer): Buffer => crypto.createHmac('sha256', key).update(data).digest();

export interface DerivedKeys {
  ecdhSecret: Buffer;
  prkKey: Buffer;
  ikm: Buffer;
  prk: Buffer;
  cek: Buffer;
  nonce: Buffer;
}

/** RFC 8291 sections 3.3 and 3.4: from the shared secret and the two public keys, the content encryption key and the nonce of the (only) record. */
export function deriveKeys(ecdhSecret: Buffer, authSecret: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer): DerivedKeys {
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0', 'latin1'), Buffer.from([1])])).subarray(0, 12);
  return { ecdhSecret, prkKey, ikm, prk, cek, nonce };
}

export interface EncryptOptions {
  /** The user agent's public key (65 bytes) and authentication secret (16 bytes), from the subscription. */
  uaPublic: Buffer;
  authSecret: Buffer;
  /** Only the RFC's test vector sets these two: a random salt and a fresh key pair are what every real message uses. */
  salt?: Buffer;
  senderPrivate?: Buffer;
  /** Zero bytes after the record's delimiter bring the plaintext up to this length (RFC 8188 padding); 0: none. */
  padTo?: number;
}

/** The body of the push: the header (salt, record size, the sender's public key as key id) and one `aes128gcm` record. */
export function encryptPayload(plaintext: Buffer, options: EncryptOptions): Buffer {
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error(`a push payload is at most ${MAX_PAYLOAD_BYTES} bytes`);
  const sender = crypto.createECDH('prime256v1');
  if (options.senderPrivate) sender.setPrivateKey(options.senderPrivate);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const salt = options.salt ?? crypto.randomBytes(16);
  const keys = deriveKeys(sender.computeSecret(options.uaPublic), options.authSecret, options.uaPublic, asPublic, salt);
  const padding = Math.max(0, (options.padTo ?? 0) - plaintext.length - 1);
  const record = Buffer.concat([plaintext, Buffer.from([2]), Buffer.alloc(padding)]);       // 2 marks the last (here: the only) record
  const cipher = crypto.createCipheriv('aes-128-gcm', keys.cek, keys.nonce);
  const sealed = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

// ---------------------------------------------------------------- the connection

/**
 * Addresses a push service has no business at: this host's own, the private ranges, link-local (cloud metadata), multicast, documentation, and the IPv6
 * forms that carry an IPv4 address through a gateway (the IPv4-compatible `::/96`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`): `64:ff9b::7f00:1` or
 * `2002:a9fe:a9fe::` are loopback and cloud metadata for a host that has such a gateway. (On an IPv6-only host with DNS64 a push service without an IPv6
 * address of its own resolves into `64:ff9b::/96` and is refused here; whether the four services have one was not checked.)
 */
const FORBIDDEN = new net.BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) FORBIDDEN.addSubnet(address, bits, 'ipv4');
for (const [address, bits] of [['::', 96], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96], ['2002::', 16]] as const) FORBIDDEN.addSubnet(address, bits, 'ipv6');

/** Whether an address a name resolved to is one the sender must not connect to. (A v4-mapped v6 address is judged as the v4 address it carries.) */
export function isForbiddenAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  return FORBIDDEN.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** dns.lookup, except that a name that resolves to a forbidden address (any of them) is an error. Handles both callback shapes (`all: true` is what happy eyeballs asks for). */
export const guardedLookup = ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
  dns.lookup(hostname, options, (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
    if (list.length === 0 || list.some(isForbiddenAddress)) return callback(Object.assign(new Error('the push service name resolves to an address that is not allowed'), { code: 'EFORBIDDEN' }));
    callback(null, address, family);
  });
}) as net.LookupFunction;

export type PushOutcome = 'sent' | 'gone' | 'refused' | 'rejected' | 'failed';

export interface PushResult {
  outcome: PushOutcome;
  /** The HTTP status of the push service's answer, when there was one. */
  status?: number;
  retryAfterSec?: number;
  /** What went wrong, in a few safe words (never the endpoint, a key or the payload). */
  detail?: string;
}

export interface PushOptions {
  /** Seconds the push service keeps the message for a device that is off (RFC 8030 TTL). */
  ttl: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
}

export interface PushSenderOptions {
  vapid: Vapid;
  /** The page's own address (https), or a mailto: that the operator chose: the `sub` claim of the VAPID token, which the push service sees. */
  subject: string;
  timeoutMs?: number;
  now?: () => number;
  /**
   * For tests and the dev server only: a stand-in transport and endpoint rule. src/notify/start.ts never passes them, so the sender that runs
   * in production always goes through https.request and validateEndpoint.
   */
  request?: typeof https.request;
  policy?: (endpoint: unknown) => URL | null;
}

export class PushSender {
  private readonly now: () => number;
  private readonly request: typeof https.request;
  private readonly policy: (endpoint: unknown) => URL | null;
  private readonly timeoutMs: number;

  constructor(private readonly opts: PushSenderOptions) {
    this.now = opts.now ?? Date.now;
    this.request = opts.request ?? https.request;
    this.policy = opts.policy ?? validateEndpoint;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Sends one message to one subscription. Never throws: what happened is the result. */
  async send(sub: WebPushSubscription, payload: Buffer, options: PushOptions): Promise<PushResult> {
    const url = this.policy(sub.endpoint);
    if (!url) return { outcome: 'refused', detail: 'endpoint not allowed' };
    const point = decodeB64url(sub.keys?.p256dh, 65);
    const auth = decodeB64url(sub.keys?.auth, 16);
    if (!point || !auth) return { outcome: 'refused', detail: 'bad keys' };
    let body: Buffer;
    try {
      body = encryptPayload(payload, { uaPublic: point, authSecret: auth, padTo: PAD_TO_BYTES });
    } catch (err) {
      return { outcome: 'refused', detail: (err as Error).message.slice(0, 80) };
    }
    return this.post(url, body, options);
  }

  private post(url: URL, body: Buffer, options: PushOptions): Promise<PushResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: PushResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(result);
      };
      let req: ReturnType<typeof https.request>;
      const deadline = setTimeout(() => {
        finish({ outcome: 'failed', detail: 'timeout' });
        req?.destroy();
      }, this.timeoutMs);
      deadline.unref?.();
      try {
        req = this.request(
          {
            method: 'POST',
            hostname: url.hostname,
            port: url.port ? Number(url.port) : 443,
            path: url.pathname + url.search,
            agent: false,
            lookup: guardedLookup,
            headers: {
              authorization: this.opts.vapid.authorization(url.origin, this.opts.subject, this.now()),
              'content-encoding': 'aes128gcm',
              'content-type': 'application/octet-stream',
              'content-length': body.length,
              ttl: String(Math.max(0, Math.floor(options.ttl))),
              urgency: options.urgency,
              'user-agent': 'tai-push/1',
            },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            const chunks: Buffer[] = [];
            let size = 0;
            const done = () => {
              const text = Buffer.concat(chunks).toString('utf-8').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 80);
              finish(classify(status, res.headers['retry-after'], text));
            };
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > RESPONSE_CAP_BYTES) {
                res.destroy();                                  // an answer is a few words; more than this is not one
                return done();
              }
              chunks.push(chunk);
            });
            res.on('end', done);
            res.on('error', () => finish({ outcome: 'failed', status, detail: 'the answer was cut off' }));
            res.on('close', done);
          },
        );
      } catch (err) {
        return finish({ outcome: 'failed', detail: (err as Error).message.slice(0, 80) });
      }
      req.on('error', (err: NodeJS.ErrnoException) => finish({ outcome: 'failed', detail: String(err.code || err.message).slice(0, 80) }));
      req.end(body);
    });
  }
}

/** What an HTTP status means for the subscription (RFC 8030 section 8): 2xx took it, 404 and 410 say it is gone for good, the other 4xx are ours to stop on, the rest is worth another try later. */
export function classify(status: number, retryAfter: string | string[] | undefined, text = ''): PushResult {
  if (status >= 200 && status < 300) return { outcome: 'sent', status };
  if (status === 404 || status === 410) return { outcome: 'gone', status, detail: text };
  if (status === 429) {
    const seconds = parseInt(String(retryAfter ?? ''), 10);
    return { outcome: 'failed', status, detail: 'rate limited', ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSec: seconds } : {}) };
  }
  if (status === 400 || status === 401 || status === 403 || status === 413) return { outcome: 'rejected', status, detail: text };
  if (status >= 300 && status < 400) return { outcome: 'failed', status, detail: 'a redirect (not followed)' };
  return { outcome: 'failed', status, detail: text || undefined };
}
