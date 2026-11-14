/**
 * A few lines of ustar writer plus gzip, for the sandbox's own checks (the smoke's hostile archives, the script tests): no dependency, and it can make what a careful tool would
 * refuse to (a member named `../x`, an absolute path, a link that points out). Nothing in the host reads an archive: this only writes them.
 */
import { gzipSync } from 'node:zlib';

export interface TarEntry {
  name: string;
  /** `file` (default), `dir`, `symlink`, `hardlink` or `fifo`. */
  type?: 'file' | 'dir' | 'symlink' | 'hardlink' | 'fifo';
  data?: Buffer | string;
  /** For links: where they point. */
  linkname?: string;
  mode?: number;
  /** The size the header SAYS (a bomb says more than it holds); defaults to the data's length. */
  declaredSize?: number;
}

const TYPEFLAG: Record<NonNullable<TarEntry['type']>, string> = { file: '0', dir: '5', symlink: '2', hardlink: '1', fifo: '6' };

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(e: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(512);
  const put = (text: string, at: number, max: number) => block.write(text.slice(0, max), at, 'utf8');
  // names longer than 100 bytes use the prefix field (155) when there is a slash to split at
  let name = e.name;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 100);
    if (cut > 0) {
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
  }
  put(name, 0, 100);
  put(octal(e.mode ?? (e.type === 'dir' ? 0o755 : 0o644), 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(1_700_000_000, 12), 136, 12);
  put('        ', 148, 8); // the checksum counts these as spaces
  put(TYPEFLAG[e.type ?? 'file'], 156, 1);
  put(e.linkname ?? '', 157, 100);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

/** The archive's bytes (not compressed). */
export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = e.type === undefined || e.type === 'file' ? (typeof e.data === 'string' ? Buffer.from(e.data) : (e.data ?? Buffer.alloc(0))) : Buffer.alloc(0);
    parts.push(header(e, e.declaredSize ?? data.length));
    if (data.length > 0) {
      parts.push(data);
      parts.push(Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A gzip-compressed tar archive, as GitHub's and a student's `tar czf` make them. */
export const tarGz = (entries: TarEntry[]): Buffer => gzipSync(tar(entries), { level: 6 });
