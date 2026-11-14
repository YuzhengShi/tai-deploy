/**
 * Enough of a PNG reader for the smoke to look at the page images the renderer made (is there dark ink where the box of a word says the word is?): 8 bit gray, gray with alpha, RGB, RGBA and palette
 * images, not interlaced, every filter. Not used by the service: the host never decodes an image (it reads the header, src/docs/readback.ts, and the browser decodes the rest).
 */
import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** The brightness of a pixel, 0 (black) to 255 (white); transparent pixels are taken over white. */
  luma(x: number, y: number): number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Buffer): DecodedPng | null {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) return null;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Buffer | null = null;
  const data: Buffer[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (!channels || depth !== 8 || interlace !== 0 || width < 1 || height < 1 || width * height > 64_000_000) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixels[y * stride + i - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, upLeft);
      else if (filter !== 0) return null;
      pixels[y * stride + i] = v & 0xff;
    }
  }
  return {
    width,
    height,
    luma(x, y) {
      const o = y * stride + x * channels;
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (colorType === 0 || colorType === 4) {
        r = g = b = pixels[o];
        if (colorType === 4) a = pixels[o + 1];
      } else if (colorType === 3) {
        const index = pixels[o] * 3;
        r = palette?.[index] ?? 0;
        g = palette?.[index + 1] ?? 0;
        b = palette?.[index + 2] ?? 0;
      } else {
        r = pixels[o];
        g = pixels[o + 1];
        b = pixels[o + 2];
        if (colorType === 6) a = pixels[o + 3];
      }
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      return (luma * a + 255 * (255 - a)) / 255;
    },
  };
}

/** How many pixels in the rectangle (fractions of the page, x to the right and y downwards) are darker than `threshold`. */
export function darkPixels(png: DecodedPng, box: [number, number, number, number], threshold = 128): number {
  const x0 = Math.max(0, Math.floor(box[0] * png.width));
  const x1 = Math.min(png.width, Math.ceil(box[2] * png.width));
  const y0 = Math.max(0, Math.floor(box[1] * png.height));
  const y1 = Math.min(png.height, Math.ceil(box[3] * png.height));
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (png.luma(x, y) < threshold) n++;
  return n;
}
