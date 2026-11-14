import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { darkPixels, decodePng } from './png-decode.js';
import { bombPdf, loopPdf, numberedPdf, photoRgb, tinyPdf, truncated } from './tiny-pdf.js';

// The helpers the smoke is made of are tested here, so that a failure of the smoke is a failure of the renderer and not of the tools that make its files and read its pictures.

/** A PNG of the pixels given, every scanline filtered with the filter chosen for it (the encoder is the inverse of the reader's unfiltering). */
function encode(width: number, height: number, colorType: 0 | 2 | 4 | 6, pixels: number[], filters: number[]): Buffer {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const stride = width * channels;
  const lines: Buffer[] = [];
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length];
    const line = Buffer.alloc(stride + 1);
    line[0] = filter;
    for (let i = 0; i < stride; i++) {
      const v = pixels[y * stride + i];
      const left = i >= channels ? pixels[y * stride + i - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      line[i + 1] = (v - (filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, upLeft) : 0)) & 0xff;
    }
    lines.push(line);
  }
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    return out; // (the checksum is not checked by the reader)
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, colorType, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(lines))), chunk('IEND', Buffer.alloc(0))]);
}

describe('the PNG reader of the smoke', () => {
  const rgb = Array.from({ length: 5 * 4 * 3 }, (_, i) => (i * 37 + 11) % 256);

  it('reads back what was written with every filter, for gray, gray and alpha, RGB and RGBA', () => {
    for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4]]) {
      for (const colorType of [0, 2, 4, 6] as const) {
        const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
        const pixels = Array.from({ length: 5 * 4 * channels }, (_, i) => (i * 53 + 7) % 256);
        const png = decodePng(encode(5, 4, colorType, pixels, filters));
        expect(png, `${colorType} ${filters}`).not.toBeNull();
        expect([png!.width, png!.height]).toEqual([5, 4]);
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 5; x++) {
            const o = (y * 5 + x) * channels;
            const [r, g, b, a] = colorType === 0 ? [pixels[o], pixels[o], pixels[o], 255] : colorType === 4 ? [pixels[o], pixels[o], pixels[o], pixels[o + 1]] : colorType === 2 ? [pixels[o], pixels[o + 1], pixels[o + 2], 255] : [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]];
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            expect(png!.luma(x, y)).toBeCloseTo((luma * a + 255 * (255 - a)) / 255, 6);
          }
        }
      }
    }
  });

  it('counts the dark pixels of a rectangle given as fractions of the page', () => {
    const width = 10;
    const height = 10;
    const pixels = Array.from({ length: width * height * 3 }, () => 255);
    for (let y = 2; y < 4; y++) for (let x = 1; x < 4; x++) pixels.splice((y * width + x) * 3, 3, 0, 0, 0); // a black 3 x 2 block at x 1..3, y 2..3
    const png = decodePng(encode(width, height, 2, pixels, [4]))!;
    expect(darkPixels(png, [0.1, 0.2, 0.4, 0.4])).toBe(6);
    expect(darkPixels(png, [0, 0, 1, 1])).toBe(6);
    expect(darkPixels(png, [0.1, 0.6, 0.4, 0.8])).toBe(0); // the same block mirrored top to bottom: nothing there
    expect(darkPixels(png, [0.5, 0.5, 2, 2])).toBe(0); // a rectangle past the edge is cut
  });

  it('is nothing for what is not a plain PNG: a JPEG, a cut file, an image with another depth or interlaced', () => {
    expect(decodePng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(1)]))).toBeNull();
    expect(decodePng(encode(5, 4, 2, rgb, [0]).subarray(0, 60))).toBeNull();
    const sixteen = encode(5, 4, 2, rgb, [0]);
    sixteen[24] = 16;
    expect(decodePng(sixteen)).toBeNull();
    const interlaced = encode(5, 4, 2, rgb, [0]);
    interlaced[28] = 1;
    expect(decodePng(interlaced)).toBeNull();
    expect(decodePng(encode(5, 4, 2, rgb, [7]))).toBeNull(); // a filter the format does not have
  });
});

describe('the PDF writer of the smoke', () => {
  /** The objects of a PDF as the cross-reference table says where they are: each must be an `n 0 obj` where it is said to be. */
  function checkStructure(pdf: Buffer): { objects: number; trailer: string } {
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 5)).toBe('xref\n');
    const m = /xref\n0 (\d+)\n0000000000 65535 f \n((?:\d{10} 00000 n \n)+)trailer\n(.*)\nstartxref/s.exec(text.slice(startxref))!;
    const offsets = m[2].trim().split('\n').map((l) => Number(l.slice(0, 10)));
    expect(offsets).toHaveLength(Number(m[1]) - 1);
    offsets.forEach((offset, i) => expect(text.slice(offset, offset + `${i + 1} 0 obj\n`.length)).toBe(`${i + 1} 0 obj\n`));
    return { objects: offsets.length, trailer: m[3] };
  }

  it('makes a PDF whose cross-reference table points at its objects, with the page tree, the text where it was put and the boxes it was given', () => {
    const pdf = tinyPdf([{ texts: [{ x: 72, y: 700, size: 24, text: 'Alpha (1) \\ end' }] }, { rotate: 90, cropbox: [100, 400, 500, 700] }, { mediabox: [0, 0, 960, 540] }]);
    const { trailer } = checkStructure(pdf);
    expect(trailer).toMatch(/\/Root 1 0 R/);
    const text = pdf.toString('latin1');
    expect(text).toContain('/Count 3');
    expect(text).toContain('BT /F1 24 Tf 72 700 Td (Alpha \\(1\\) \\\\ end) Tj ET');
    expect(text).toContain('/Rotate 90 /CropBox [100 400 500 700]');
    expect(text).toContain('/MediaBox [0 0 960 540]');
  });

  it('makes a numbered document of any length, a page with a picture, and the hostile files', async () => {
    const ten = numberedPdf(10);
    checkStructure(ten);
    expect(ten.toString('latin1')).toContain('Page number 10');
    expect(ten.toString('latin1')).toContain('/Count 10');
    const photo = tinyPdf([{ image: { width: 40, height: 30, rgb: photoRgb(40, 30) } }]);
    checkStructure(photo);
    expect(photo.toString('latin1')).toContain('/Width 40 /Height 30 /ColorSpace /DeviceRGB');
    expect(photoRgb(40, 30)).toHaveLength(40 * 30 * 3);
    expect(photoRgb(40, 30).equals(photoRgb(40, 30))).toBe(true);
    expect(photoRgb(40, 30, 8).equals(photoRgb(40, 30))).toBe(false);
    checkStructure(loopPdf());
    expect(truncated(ten, 100)).toHaveLength(100);
    expect(truncated(ten, 1e9)).toHaveLength(ten.length);
    // the bomb: a few KB of file that says it is a hundred megabytes of spaces
    const bomb = await bombPdf(0.1);
    expect(bomb.length).toBeLessThan(2_000_000);
    checkStructure(bomb);
  });
});
