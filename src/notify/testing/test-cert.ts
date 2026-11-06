/**
 * A self-signed X.509 certificate made with node:crypto alone (there is no API for one, so the DER is written out here), for the tests of the SMTP
 * client: a server on a loopback port needs a certificate for 127.0.0.1 and localhost that the client can be told to trust. ECDSA P-256 with
 * SHA-256, valid from yesterday for a year, with the name in subjectAltName (a client checks that, not the common name). Test use only: the key is
 * thrown away with the process.
 */
import crypto from 'node:crypto';

const length = (n: number): Buffer => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const oid = (...bytes: number[]) => tlv(0x06, Buffer.from(bytes));
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text));
const utcTime = (date: Date) => tlv(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

const ECDSA_WITH_SHA256 = oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);       // 1.2.840.10045.4.3.2

export interface TestCertificate {
  /** PEM of the certificate: what a client is told to trust (`ca`) and what the server presents. */
  cert: string;
  /** PEM (PKCS#8) of its private key, for the server. */
  key: string;
}

export function makeTestCertificate(options: { commonName?: string; dns?: string[]; ips?: string[] } = {}): TestCertificate {
  const commonName = options.commonName ?? 'localhost';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = seq(set(seq(oid(0x55, 0x04, 0x03), utf8(commonName))));
  const names = [...(options.dns ?? ['localhost']).map((dns) => tlv(0x82, Buffer.from(dns))), ...(options.ips ?? ['127.0.0.1']).map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number))))];
  const extensions = tlv(
    0xa3,
    seq(
      seq(oid(0x55, 0x1d, 0x11), tlv(0x04, seq(...names))),                                           // subjectAltName
      seq(oid(0x55, 0x1d, 0x13), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))),    // basicConstraints, critical, CA: true (it is its own anchor)
    ),
  );
  const serial = crypto.randomBytes(8);
  serial[0] = (serial[0] & 0x7f) | 0x01;                                                              // positive, and no leading zero byte
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),                                                           // version 3
    tlv(0x02, serial),
    seq(ECDSA_WITH_SHA256),
    name,
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 365 * 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, seq(ECDSA_WITH_SHA256), tlv(0x03, Buffer.from([0]), signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
}
