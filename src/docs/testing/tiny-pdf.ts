/**
 * A tiny PDF writer for the smoke (src/docs/smoke.ts) and its tests: pages of text in a standard font at places the caller chooses (so that the boxes of the words the renderer finds can be checked against where
 * the text was put), a page that is turned a quarter, a crop box, a page with a picture and no text (a scan), and the hostile shapes: a stream that expands to a gigabyte, a page tree that contains itself.
 * The files are real PDFs of the simplest kind (uncompressed objects, a cross-reference table, the standard Helvetica that is not embedded); poppler reads them as it reads any other.
 * Not used by the service: it exists to make files to try the service on.
 */
import { createDeflate } from 'node:zlib';

export interface TinyText {
  /** From the left edge of the page, in points. */
  x: number;
  /** From the BOTTOM edge of the page, in points (PDF's own axis: the page's top is its height). */
  y: number;
  size: number;
  text: string;
}

export interface TinyImage {
  width: number;
  height: number;
  /** 8 bit RGB, `width * height * 3` bytes. Drawn over the whole page. */
  rgb: Buffer;
}

export interface TinyPage {
  texts?: TinyText[];
  /** [x0, y0, x1, y1] in points; default US letter. */
  mediabox?: [number, number, number, number];
  cropbox?: [number, number, number, number];
  rotate?: 0 | 90 | 180 | 270;
  image?: TinyImage;
  /** Extra content stream text appended as it is (the hostile cases). */
  rawContent?: string;
}

const esc = (text: string): string => text.replace(/[\\()]/g, (c) => `\\${c}`);

/** A PDF with these pages. */
export function tinyPdf(pages: TinyPage[]): Buffer {
  const objs: Buffer[] = [];
  const add = (body: Buffer | string): number => {
    objs.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    return objs.length;
  };
  const catalog = add('');
  const tree = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const p of pages) {
    let xobject = '';
    let content = (p.texts ?? []).map((t) => `BT /F1 ${t.size} Tf ${t.x} ${t.y} Td (${esc(t.text)}) Tj ET`).join('\n');
    const mediabox = p.mediabox ?? [0, 0, 612, 792];
    if (p.image) {
      const header = Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${p.image.width} /Height ${p.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${p.image.rgb.length} >>\nstream\n`, 'latin1');
      const image = add(Buffer.concat([header, p.image.rgb, Buffer.from('\nendstream', 'latin1')]));
      xobject = ` /XObject << /Im1 ${image} 0 R >>`;
      content = `q ${mediabox[2] - mediabox[0]} 0 0 ${mediabox[3] - mediabox[1]} ${mediabox[0]} ${mediabox[1]} cm /Im1 Do Q\n${content}`;
    }
    if (p.rawContent) content += `\n${p.rawContent}`;
    const stream = Buffer.from(content, 'latin1');
    const contents = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]));
    const extra = `${p.rotate ? ` /Rotate ${p.rotate}` : ''}${p.cropbox ? ` /CropBox [${p.cropbox.join(' ')}]` : ''}`;
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [${mediabox.join(' ')}]${extra} /Contents ${contents} 0 R /Resources << /Font << /F1 ${font} 0 R >>${xobject} >> >>`));
  }
  objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${tree} 0 R >>`, 'latin1');
  objs[tree - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1');
  return assemble(objs, catalog);
}

function assemble(objs: Buffer[], root: number): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0].length;
  objs.forEach((body, i) => {
    offsets.push(length);
    const piece = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(piece);
    length += piece.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${root} 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** `n` pages, each with its own number as text near the top left and a second line low on the page. */
export function numberedPdf(n: number): Buffer {
  return tinyPdf(Array.from({ length: n }, (_, i) => ({ texts: [{ x: 72, y: 700, size: 24, text: `Page number ${i + 1}` }, { x: 72, y: 100, size: 12, text: `footer of page ${i + 1}` }] })));
}

/** A picture that is smooth with a little noise, so that it is a few MB as a PNG and a few hundred KB as a JPEG (the way a photograph is). */
export function photoRgb(width: number, height: number, seed = 7): Buffer {
  const out = Buffer.alloc(width * height * 3);
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const noise = Math.round((rand() - 0.5) * 80);
      out[i++] = Math.max(0, Math.min(255, Math.round((x / width) * 255) + noise));
      out[i++] = Math.max(0, Math.min(255, Math.round((y / height) * 255) + noise));
      out[i++] = Math.max(0, Math.min(255, 128 + noise));
    }
  }
  return out;
}

/**
 * A page with a content stream of Flate data that expands to `gigabytes` GB of spaces (a few MB in the file): a decompression bomb for whatever reads the page. Made through zlib's streaming
 * interface, so that the data is never held whole.
 */
export async function bombPdf(gigabytes: number): Promise<Buffer> {
  const deflate = createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on('end', () => resolve());
    deflate.on('error', reject);
  });
  const block = Buffer.alloc(8 * 1024 * 1024, 0x20);
  const blocks = Math.ceil((gigabytes * 1024) / 8);
  for (let i = 0; i < blocks; i++) {
    if (!deflate.write(block)) await new Promise<void>((resolve) => deflate.once('drain', () => resolve()));
  }
  deflate.end();
  await done;
  const data = Buffer.concat(chunks);
  const objs: Buffer[] = [Buffer.alloc(0), Buffer.alloc(0), Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'latin1')];
  objs[3] = Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
  objs[4] = Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>', 'latin1');
  objs[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1');
  objs[1] = Buffer.from('<< /Type /Pages /Kids [5 0 R] /Count 1 >>', 'latin1');
  return assemble(objs, 1);
}

/** A page tree whose one kid is the tree itself (and a page that is its own parent): for a reader that walks it without a guard. */
export function loopPdf(): Buffer {
  const objs: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 5 /Parent 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] >>', 'latin1'),
  ];
  return assemble(objs, 1);
}

/** What a PDF is when it is cut short: the first `bytes` bytes. */
export const truncated = (pdf: Buffer, bytes: number): Buffer => pdf.subarray(0, Math.min(bytes, pdf.length));
