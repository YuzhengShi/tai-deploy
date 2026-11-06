/**
 * Web Push: the RFC 8291 example reproduced bit for bit, the endpoint rule (the SSRF door), and the sender against a stand-in push service on
 * a loopback port (what it sends, that it follows no redirect, that it stops waiting). The VAPID token is in vapid.test.ts.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { generateVapidKeys, vapidFromPrivate } from './vapid.js';
import {
  MAX_PAYLOAD_BYTES,
  PAD_TO_BYTES,
  PUSH_SERVICE_HOSTS,
  PushSender,
  b64url,
  checkSubscription,
  classify,
  decodeB64url,
  deriveKeys,
  encryptPayload,
  endpointHash,
  guardedLookup,
  isForbiddenAddress,
  validateEndpoint,
} from './webpush.js';

const b64 = (s: string) => Buffer.from(s, 'base64url');

// RFC 8291, section 5 ("Push Message Encryption Example") and Appendix A: every value is the RFC's.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  record: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** The other end of the RFC, written separately from the code under test (node's HKDF instead of two HMACs): what a browser does with a push. */
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const record = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  let end = record.length;
  while (end > 0 && record[end - 1] === 0) end--;
  if (record[end - 1] !== 2) throw new Error('no last-record delimiter');
  return record.subarray(0, end - 1);
}

/** A browser's side of a subscription: its key pair and secret, and the JSON the page posts. */
function browser(endpoint = 'https://fcm.googleapis.com/fcm/send/abc:123') {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    private: ecdh.getPrivateKey(),
    public: ecdh.getPublicKey(),
    auth,
    sub: { endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) } },
  };
}

describe('RFC 8291: the encrypted payload', () => {
  it('derives every intermediate value of the RFC\'s example', () => {
    const asKey = crypto.createECDH('prime256v1');
    asKey.setPrivateKey(b64(RFC.asPrivate));
    expect(b64url(asKey.getPublicKey())).toBe(RFC.asPublic);
    const secret = asKey.computeSecret(b64(RFC.uaPublic));
    expect(b64url(secret)).toBe(RFC.ecdhSecret);
    const keys = deriveKeys(secret, b64(RFC.authSecret), b64(RFC.uaPublic), b64(RFC.asPublic), b64(RFC.salt));
    expect(b64url(keys.prkKey)).toBe(RFC.prkKey);
    expect(b64url(keys.ikm)).toBe(RFC.ikm);
    expect(b64url(keys.prk)).toBe(RFC.prk);
    expect(b64url(keys.cek)).toBe(RFC.cek);
    expect(b64url(keys.nonce)).toBe(RFC.nonce);
  });

  it('produces the RFC\'s encrypted message from the RFC\'s keys, salt and plaintext', () => {
    const body = encryptPayload(Buffer.from(RFC.plaintext), { uaPublic: b64(RFC.uaPublic), authSecret: b64(RFC.authSecret), salt: b64(RFC.salt), senderPrivate: b64(RFC.asPrivate) });
    expect(b64url(body)).toBe(RFC.message);
    expect(b64url(body.subarray(body.length - 58))).toBe(RFC.record);           // 41 bytes of text, the delimiter, the 16-byte tag
  });

  it('is read back by a separate implementation of the receiving side, with and without padding', () => {
    const ua = browser();
    for (const padTo of [0, 40, PAD_TO_BYTES]) {
      const body = encryptPayload(Buffer.from('{"t":"TAi"}'), { uaPublic: ua.public, authSecret: ua.auth, padTo });
      expect(decrypt(body, ua.private, ua.public, ua.auth).toString()).toBe('{"t":"TAi"}');
    }
    const rfc = decrypt(Buffer.from(RFC.message, 'base64url'), b64(RFC.uaPrivate), b64(RFC.uaPublic), b64(RFC.authSecret));
    expect(rfc.toString()).toBe(RFC.plaintext);
  });

  it('uses a new salt and a new sender key for every message', () => {
    const ua = browser();
    const a = encryptPayload(Buffer.from('x'), { uaPublic: ua.public, authSecret: ua.auth });
    const b = encryptPayload(Buffer.from('x'), { uaPublic: ua.public, authSecret: ua.auth });
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it('makes every padded message the same size, whatever it says, and refuses one over the limit', () => {
    const ua = browser();
    const short = encryptPayload(Buffer.from('a'), { uaPublic: ua.public, authSecret: ua.auth, padTo: PAD_TO_BYTES });
    const long = encryptPayload(Buffer.from('b'.repeat(200)), { uaPublic: ua.public, authSecret: ua.auth, padTo: PAD_TO_BYTES });
    expect(short.length).toBe(long.length);
    expect(short.length).toBe(86 + PAD_TO_BYTES + 16);
    expect(() => encryptPayload(Buffer.alloc(MAX_PAYLOAD_BYTES + 1), { uaPublic: ua.public, authSecret: ua.auth })).toThrow(/at most/);
    expect(encryptPayload(Buffer.alloc(MAX_PAYLOAD_BYTES), { uaPublic: ua.public, authSecret: ua.auth }).length).toBeLessThan(4096);
  });

  it('does not decrypt with the wrong secret (the tag is checked)', () => {
    const ua = browser();
    const body = encryptPayload(Buffer.from('secret words'), { uaPublic: ua.public, authSecret: ua.auth });
    expect(() => decrypt(body, ua.private, ua.public, crypto.randomBytes(16))).toThrow();
    body[body.length - 1] ^= 1;
    expect(() => decrypt(body, ua.private, ua.public, ua.auth)).toThrow();
  });
});

describe('the push services an endpoint may name', () => {
  it('are these four rules and no others (Apple: web.push.apple.com, the one host its web push documentation names)', () => {
    expect(PUSH_SERVICE_HOSTS).toEqual(['fcm.googleapis.com', '.push.services.mozilla.com', '.notify.windows.com', 'web.push.apple.com']);
  });

  it('accepts what the browsers\' own push services give out', () => {
    for (const good of [
      'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHun4MxP5egoKMwt2KZFBaFUH',
      'https://fcm.googleapis.com/wp/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2f',
      'https://web.push.apple.com/QAAAAAAAAAAAAAAA',
      'https://fcm.googleapis.com:443/fcm/send/x',
      'HTTPS://FCM.GoogleAPIs.COM/fcm/send/x',
    ]) {
      expect(validateEndpoint(good), good).not.toBeNull();
    }
  });

  it('refuses everything else: other schemes, ports and hosts, IP literals, internal names, look-alikes and userinfo tricks', () => {
    const bad: unknown[] = [
      // not https, or not a URL
      'http://fcm.googleapis.com/fcm/send/x', 'ftp://fcm.googleapis.com/x', 'wss://fcm.googleapis.com/x', 'javascript:alert(1)', 'data:text/plain,hello', 'file:///etc/passwd',
      '//fcm.googleapis.com/x', 'fcm.googleapis.com/fcm/send/x', '', 'not a url', 'https://',
      // IP literals, in every spelling a URL parser knows
      'https://127.0.0.1/x', 'https://127.0.0.1:443/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://0177.0.0.1/x',
      'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5/x', 'https://192.168.1.1/x', 'https://8.8.8.8/x', 'https://[2607:f8b0::1]/x',
      // names with no dot, and internal ones
      'https://localhost/x', 'https://localhost:443/x', 'https://intranet/x', 'https://tai-live-litellm/x', 'https://metadata.google.internal/x', 'https://host.docker.internal/x',
      'https://foo.localhost/x', 'https://router.lan/x',
      // look-alikes of the allowed hosts
      'https://fcm.googleapis.com.evil.example/x', 'https://evilfcm.googleapis.com/x', 'https://xfcm.googleapis.com/x', 'https://fcm-googleapis.com/x', 'https://googleapis.com/x',
      'https://storage.googleapis.com/x', 'https://evil.example/fcm.googleapis.com', 'https://evil-push.services.mozilla.com/x', 'https://push.services.mozilla.com/x',
      'https://updates.push.services.mozilla.com.evil.example/x', 'https://notify.windows.com/x', 'https://x.notify.windows.com.evil.example/x', 'https://windows.com/x',
      'https://web.push.apple.com.evil.example/x', 'https://apple.com/x', 'https://evilweb.push.apple.com.example/x', 'https://a_b.push.apple.com/x',
      // the rest of Apple's push.apple.com is not web push: api.push.apple.com is the gateway of native apps (APNs)
      'https://api.push.apple.com/3/device/abc', 'https://api.sandbox.push.apple.com/3/device/abc', 'https://gateway.push.apple.com/x', 'https://push.apple.com/x', 'https://x.web.push.apple.com/x',
      // a trailing dot, a port, userinfo, an encoded dot, a backslash
      'https://fcm.googleapis.com./fcm/send/x', 'https://updates.push.services.mozilla.com./x', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com:444/x',
      'https://fcm.googleapis.com:80/x', 'https://fcm.googleapis.com@evil.example/x', 'https://user:pass@fcm.googleapis.com/x', 'https://user@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:443@evil.example/x', 'https://fcm.googleapis.com%2eevil.example/x', 'https://evil.example\\@fcm.googleapis.com/x', 'https://evil.example#@fcm.googleapis.com/x',
      'https://fcm.googleapis.com\u0000.evil.example/x', 'https://xn--fcm-googleapis-abc.example/x',
      // not strings, or too long
      null, undefined, 42, {}, [], { endpoint: 'https://fcm.googleapis.com/x' }, `https://fcm.googleapis.com/${'a'.repeat(2100)}`,
    ];
    for (const endpoint of bad) expect(validateEndpoint(endpoint), JSON.stringify(endpoint)).toBeNull();
  });

  it('judges the host that was parsed, which is the one connected to', () => {
    // a spelling the parser folds into the allowed host is that host: the connection goes to url.hostname, so it is no way round the rule
    const url = validateEndpoint('https://fcm.googleapis.com\\.evil.example/x');
    expect(url?.hostname).toBe('fcm.googleapis.com');
    expect(url?.pathname).toBe('/.evil.example/x');
    expect(validateEndpoint('https://FCM.googleapis.com/a?b=1#frag')?.href).toBe('https://fcm.googleapis.com/a?b=1#frag');
    // extra slashes and a tab are folded away by the parser; what is left is the real host, and the sender connects to exactly that
    expect(validateEndpoint('https:///fcm.googleapis.com/x')?.hostname).toBe('fcm.googleapis.com');
    expect(validateEndpoint('https://fcm.googleapis.com\t/x')?.hostname).toBe('fcm.googleapis.com');
  });

  it('names an endpoint by a hash that the endpoint cannot be read back from', () => {
    const id = endpointHash('https://fcm.googleapis.com/fcm/send/abc');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain('abc');
    expect(endpointHash('https://fcm.googleapis.com/fcm/send/abd')).not.toBe(id);
  });
});

describe('a subscription as the browser posts it', () => {
  it('is accepted with its real keys', () => {
    const ua = browser();
    const checked = checkSubscription(ua.sub);
    expect(checked.ok).toBe(true);
  });

  it('is refused for a bad endpoint, and for keys of the wrong size, the wrong alphabet or off the curve', () => {
    const ua = browser();
    expect(checkSubscription({ ...ua.sub, endpoint: 'https://127.0.0.1/x' })).toEqual({ ok: false, error: 'bad-endpoint' });
    expect(checkSubscription({ keys: ua.sub.keys })).toEqual({ ok: false, error: 'bad-endpoint' });
    expect(checkSubscription(null)).toEqual({ ok: false, error: 'bad-endpoint' });
    const withKeys = (keys: unknown) => checkSubscription({ endpoint: ua.sub.endpoint, keys });
    expect(withKeys(undefined)).toEqual({ ok: false, error: 'bad-keys' });
    expect(withKeys({ p256dh: ua.sub.keys.p256dh })).toEqual({ ok: false, error: 'bad-keys' });
    expect(withKeys({ auth: ua.sub.keys.auth })).toEqual({ ok: false, error: 'bad-keys' });
    expect(withKeys({ p256dh: b64url(ua.public.subarray(0, 64)), auth: ua.sub.keys.auth })).toEqual({ ok: false, error: 'bad-keys' });      // 64 bytes
    expect(withKeys({ p256dh: ua.sub.keys.p256dh, auth: b64url(ua.auth.subarray(0, 15)) })).toEqual({ ok: false, error: 'bad-keys' });       // 15 bytes
    expect(withKeys({ p256dh: ua.sub.keys.p256dh, auth: ua.sub.keys.auth + '=' })).toEqual({ ok: false, error: 'bad-keys' });                 // padded
    expect(withKeys({ p256dh: ua.sub.keys.p256dh.replace(/.$/, '+'), auth: ua.sub.keys.auth })).toEqual({ ok: false, error: 'bad-keys' });   // not base64url
    expect(withKeys({ p256dh: b64url(Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)])), auth: ua.sub.keys.auth })).toEqual({ ok: false, error: 'bad-keys' });   // 65 bytes, not a point
    expect(withKeys({ p256dh: b64url(Buffer.concat([Buffer.from([2]), ua.public.subarray(1)])), auth: ua.sub.keys.auth })).toEqual({ ok: false, error: 'bad-keys' }); // not uncompressed
    expect(withKeys({ p256dh: 12, auth: ['x'] })).toEqual({ ok: false, error: 'bad-keys' });
  });

  it('decodes only canonical unpadded base64url of the exact length', () => {
    expect(decodeB64url('AAAAAAAAAAAAAAAAAAAAAA', 16)?.length).toBe(16);
    expect(decodeB64url('AAAAAAAAAAAAAAAAAAAAAA==', 16)).toBeNull();
    expect(decodeB64url('AAAAAAAAAAAAAAAAAAAAAB', 16)).toBeNull();           // stray low bits
    expect(decodeB64url('AAAAAAAAAAAAAAAAAAAAAA', 15)).toBeNull();
    expect(decodeB64url('', 0)).toBeNull();
    expect(decodeB64url(null, 16)).toBeNull();
  });
});

describe('where the sender will not connect, whatever the name resolves to', () => {
  it('knows the forbidden addresses', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', 'not an address']) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '142.250.80.42', '172.32.0.1', '2607:f8b0:4005:80a::200e', '::ffff:8.8.8.8']) expect(isForbiddenAddress(address), address).toBe(false);
  });

  it('knows the IPv6 forms that carry an IPv4 address through a gateway: NAT64 (64:ff9b::/96), 6to4 (2002::/16) and the IPv4-compatible range (::/96)', () => {
    for (const address of [
      '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::a00:1', '64:ff9b::808:808', '64:ff9b::', '64:ff9b::ffff:ffff',                       // 127.0.0.1, 169.254.169.254, 10.0.0.1, 8.8.8.8 (all of it)
      '2002:7f00:1::', '2002:a9fe:a9fe::1', '2002:a00:1::1', '2002:808:808::1', '2002::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      '::2', '::7f00:1', '::a00:1', '::808:808', '::ffff:0', '::ffff:ffff',                                                                      // ::127.0.0.1, ::10.0.0.1, ::8.8.8.8 (the last of the range)
    ]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
    // one step outside each range: not these rules' business (the v4-mapped form stays judged as the v4 address it carries)
    for (const address of ['64:ff9c::1', '64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff', '64:ff9b:1::1', '2003::1', '2001:ffff::1', '::1:0:0', '::1:0:0:0', '0:0:1::', '::ffff:8.8.8.8', '::ffff:0808:0808']) {
      expect(isForbiddenAddress(address), address).toBe(false);
    }
    expect(isForbiddenAddress('::ffff:7f00:1')).toBe(true);
  });

  it('fails a lookup of a name that resolves to this machine', async () => {
    const outcome = await new Promise<{ code?: string }>((resolve) => {
      (guardedLookup as unknown as (host: string, options: object, cb: (err: (Error & { code?: string }) | null) => void) => void)('localhost', {}, (err) => resolve({ code: err?.code }));
    });
    expect(outcome.code).toBe('EFORBIDDEN');
    const all = await new Promise<{ code?: string }>((resolve) => {
      (guardedLookup as unknown as (host: string, options: object, cb: (err: (Error & { code?: string }) | null) => void) => void)('localhost', { all: true }, (err) => resolve({ code: err?.code }));
    });
    expect(all.code).toBe('EFORBIDDEN');
  });
});

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

describe('the sender, against a stand-in push service', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function pushService(respond: (seen: Seen, res: http.ServerResponse) => void): Promise<{ seen: Seen[]; origin: string }> {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const one = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
        seen.push(one);
        respond(one, res);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { seen, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  /** A sender whose transport is plain http to the stand-in (the only way a test reaches loopback: production goes through https.request and validateEndpoint). */
  function senderFor(origin: string, extra: { timeoutMs?: number } = {}) {
    const keys = generateVapidKeys();
    const vapid = vapidFromPrivate(keys.privateKey);
    return {
      vapid,
      sender: new PushSender({
        vapid,
        subject: 'https://tai.example/tai',
        now: () => Date.parse('2026-11-05T12:00:00Z'),
        request: http.request as never,
        policy: (endpoint) => (typeof endpoint === 'string' && endpoint.startsWith(origin) ? new URL(endpoint) : null),
        ...extra,
      }),
    };
  }

  it('POSTs the encrypted payload with the headers RFC 8030, 8188 and 8292 ask for', async () => {
    const service = await pushService((_seen, res) => res.writeHead(201, { location: '/message/1' }).end());
    const ua = browser(`${service.origin}/push/abc`);
    const { sender, vapid } = senderFor(service.origin);
    const payload = Buffer.from(JSON.stringify({ t: 'TAi', b: 'TAi has a new message' }));
    const result = await sender.send(ua.sub, payload, { ttl: 1800, urgency: 'high' });
    expect(result).toEqual({ outcome: 'sent', status: 201 });
    expect(service.seen).toHaveLength(1);
    const [seen] = service.seen;
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/push/abc');
    expect(seen.headers['content-encoding']).toBe('aes128gcm');
    expect(seen.headers['content-type']).toBe('application/octet-stream');
    expect(seen.headers.ttl).toBe('1800');
    expect(seen.headers.urgency).toBe('high');
    expect(seen.headers['content-length']).toBe(String(seen.body.length));
    expect(seen.body.length).toBe(86 + PAD_TO_BYTES + 16);
    expect(seen.body.length).toBeLessThan(4096);
    const auth = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]{87})$/.exec(String(seen.headers.authorization));
    expect(auth).not.toBeNull();
    expect(auth![2]).toBe(vapid.publicKey);
    // the token is for the service's origin, not the sender's (the claim a push service checks)
    const claims = JSON.parse(Buffer.from(auth![1].split('.')[1], 'base64url').toString());
    expect(claims).toEqual({ aud: service.origin, exp: Math.floor(Date.parse('2026-11-05T12:00:00Z') / 1000) + 12 * 3600, sub: 'https://tai.example/tai' });
    // and the browser can read what was sent
    expect(decrypt(seen.body, ua.private, ua.public, ua.auth).toString()).toBe(payload.toString());
    // nothing that identifies the student or the message is in the request but the encrypted body
    expect(JSON.stringify(seen.headers)).not.toContain('new message');
  });

  it('tells a gone subscription (404, 410) from a refusal, a throttle and a failure', async () => {
    const status = { code: 201 };
    const service = await pushService((_seen, res) => res.writeHead(status.code, status.code === 429 ? { 'retry-after': '30' } : {}).end(status.code === 403 ? 'VapidPkHashMismatch' : ''));
    const ua = browser(`${service.origin}/push/abc`);
    const { sender } = senderFor(service.origin);
    const send = async (code: number) => {
      status.code = code;
      return sender.send(ua.sub, Buffer.from('{}'), { ttl: 60, urgency: 'normal' });
    };
    expect(await send(200)).toEqual({ outcome: 'sent', status: 200 });
    expect(await send(202)).toEqual({ outcome: 'sent', status: 202 });
    expect((await send(404)).outcome).toBe('gone');
    expect((await send(410)).outcome).toBe('gone');
    expect(await send(403)).toEqual({ outcome: 'rejected', status: 403, detail: 'VapidPkHashMismatch' });
    expect((await send(401)).outcome).toBe('rejected');
    expect((await send(400)).outcome).toBe('rejected');
    expect((await send(413)).outcome).toBe('rejected');
    expect(await send(429)).toEqual({ outcome: 'failed', status: 429, detail: 'rate limited', retryAfterSec: 30 });
    expect((await send(500)).outcome).toBe('failed');
    expect((await send(503)).outcome).toBe('failed');
  });

  it('follows no redirect', async () => {
    const elsewhere = await pushService((_seen, res) => res.writeHead(201).end());
    const service = await pushService((_seen, res) => res.writeHead(307, { location: `${elsewhere.origin}/stolen` }).end());
    const ua = browser(`${service.origin}/push/abc`);
    const { sender } = senderFor(service.origin);
    const result = await sender.send(ua.sub, Buffer.from('{}'), { ttl: 60, urgency: 'normal' });
    expect(result).toMatchObject({ outcome: 'failed', status: 307 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(elsewhere.seen).toHaveLength(0);
    expect(service.seen).toHaveLength(1);
    for (const code of [301, 302, 303, 308]) expect(classify(code, undefined).outcome).toBe('failed');
  });

  it('stops waiting for a service that does not answer, and reads no more than a few kilobytes of an answer', async () => {
    const silent = await pushService(() => undefined);
    const ua = browser(`${silent.origin}/push/abc`);
    const started = Date.now();
    const timedOut = await senderFor(silent.origin, { timeoutMs: 150 }).sender.send(ua.sub, Buffer.from('{}'), { ttl: 60, urgency: 'normal' });
    expect(timedOut).toEqual({ outcome: 'failed', detail: 'timeout' });
    expect(Date.now() - started).toBeLessThan(3000);

    const big = await pushService((_seen, res) => {
      res.writeHead(201);
      res.write(Buffer.alloc(300_000, 65));
      res.end();
    });
    const result = await senderFor(big.origin).sender.send(browser(`${big.origin}/push/abc`).sub, Buffer.from('{}'), { ttl: 60, urgency: 'normal' });
    expect(result.outcome).toBe('sent');
  });

  it('reports a service that is not there, without throwing', async () => {
    const service = await pushService((_seen, res) => res.writeHead(201).end());
    const { sender } = senderFor(service.origin);
    const dead = `http://127.0.0.1:1`;
    const unreachable = new PushSender({ vapid: vapidFromPrivate(generateVapidKeys().privateKey), subject: 'https://tai.example', request: http.request as never, policy: () => new URL(`${dead}/x`), timeoutMs: 2000 });
    const result = await unreachable.send(browser(`${service.origin}/p`).sub, Buffer.from('{}'), { ttl: 60, urgency: 'normal' });
    expect(result.outcome).toBe('failed');
    expect(result.detail).toBeTruthy();
    expect(sender).toBeDefined();
  });

  it('refuses at send time an endpoint that was stored before the rule, keys that are not keys and a payload that is too big, without connecting', async () => {
    const service = await pushService((_seen, res) => res.writeHead(201).end());
    const { sender } = senderFor(service.origin);
    const ua = browser(`${service.origin}/push/abc`);
    expect(await sender.send({ ...ua.sub, endpoint: 'https://127.0.0.1/x' }, Buffer.from('{}'), { ttl: 60, urgency: 'normal' })).toEqual({ outcome: 'refused', detail: 'endpoint not allowed' });
    expect(await sender.send({ ...ua.sub, keys: { p256dh: 'AAAA', auth: ua.sub.keys.auth } }, Buffer.from('{}'), { ttl: 60, urgency: 'normal' })).toEqual({ outcome: 'refused', detail: 'bad keys' });
    expect((await sender.send(ua.sub, Buffer.alloc(MAX_PAYLOAD_BYTES + 1), { ttl: 60, urgency: 'normal' })).outcome).toBe('refused');
    expect(service.seen).toHaveLength(0);
  });

  it('with the real rule and the real transport, never opens a connection to a loopback address or an internal name', async () => {
    const service = await pushService((_seen, res) => res.writeHead(201).end());
    const port = new URL(service.origin).port;
    const sender = new PushSender({ vapid: vapidFromPrivate(generateVapidKeys().privateKey), subject: 'https://tai.example/tai' });
    for (const endpoint of [`https://127.0.0.1:${port}/x`, `https://localhost:${port}/x`, `http://127.0.0.1:${port}/x`, 'https://fcm.googleapis.com.evil.example/x', 'https://169.254.169.254/x']) {
      const result = await sender.send({ endpoint, keys: browser().sub.keys }, Buffer.from('{}'), { ttl: 60, urgency: 'normal' });
      expect(result, endpoint).toEqual({ outcome: 'refused', detail: 'endpoint not allowed' });
    }
    expect(service.seen).toHaveLength(0);
  });
});
