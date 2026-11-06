#!/usr/bin/env node
// Draws the PNG icons of the page from the geometry of portal/web/mark.svg (a disc with a three-colour gradient and a soft highlight, a white
// four-pointed star and a small dot, in a 64 x 64 box), with node:zlib alone, the way dev_server.mjs draws its picture. Written to portal/web:
//
//   icon-192.png, icon-512.png   the mark as it is, on a transparent background (manifest "any"; the notification's icon)
//   icon-maskable-512.png        the mark on a full-bleed gradient square, its star inside the middle 40% radius that a launcher's mask keeps
//   apple-touch-icon.png         the same full-bleed square at 180 px: iOS rounds the corners itself and paints transparency black
//
//   node portal/qa/make_icons.mjs            (deterministic: the same files every time; run again after mark.svg changes)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);
const STOPS = [[0, [0x3b, 0x82, 0xf6]], [0.55, [0x7c, 0x5c, 0xf6]], [1, [0xec, 0x5b, 0xb4]]];

/** The gradient of mark.svg: from (8, 6) to (56, 60), the same for every point of the plane. */
function gradient(x, y) {
  const dx = 48;
  const dy = 54;
  const t = clamp01(((x - 8) * dx + (y - 6) * dy) / (dx * dx + dy * dy));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) return mix(STOPS[i - 1][1], STOPS[i][1], (t - STOPS[i - 1][0]) / (STOPS[i][0] - STOPS[i - 1][0]));
  }
  return STOPS[STOPS.length - 1][1];
}

// the star: M32 12 Q34 30 52 32 Q34 34 32 52 Q30 34 12 32 Q30 30 32 12 Z, as a polygon (each curve cut in 24 pieces)
const STAR = [];
for (const [p0, c, p1] of [
  [[32, 12], [34, 30], [52, 32]],
  [[52, 32], [34, 34], [32, 52]],
  [[32, 52], [30, 34], [12, 32]],
  [[12, 32], [30, 30], [32, 12]],
]) {
  for (let i = 0; i < 24; i++) {
    const t = i / 24;
    STAR.push([(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1]]);
  }
}

function inStar(x, y) {
  let inside = false;
  for (let i = 0, j = STAR.length - 1; i < STAR.length; j = i++) {
    const [xi, yi] = STAR[i];
    const [xj, yj] = STAR[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The colour and opacity of the mark at a point of its 64 x 64 box; `bleed`: the square is filled to its corners, not just the disc. */
function shade(x, y, bleed) {
  if (!bleed && Math.hypot(x - 32, y - 32) > 30) return null;
  let color = gradient(x, y);
  color = mix(color, [255, 255, 255], 0.55 * (1 - clamp01(Math.hypot(x - 22, y - 16) / 32)));
  if (inStar(x, y)) color = [255, 255, 255];
  else if (Math.hypot(x - 47, y - 17) <= 2.6) color = mix(color, [255, 255, 255], 0.9);
  return color;
}

function render(size, bleed) {
  const rgba = Buffer.alloc(size * size * 4);
  const N = 4;                                         // 4 x 4 samples for each pixel
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const color = shade(((px + (i + 0.5) / N) / size) * 64, ((py + (j + 0.5) / N) / size) * 64, bleed);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          covered++;
        }
      }
      const at = (py * size + px) * 4;
      if (covered) {
        rgba[at] = Math.round(r / covered);
        rgba[at + 1] = Math.round(g / covered);
        rgba[at + 2] = Math.round(b / covered);
      }
      rgba[at + 3] = Math.round((covered / (N * N)) * 255);
    }
  }
  return rgba;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);      // filter 0 (none) at the start of each row
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8;                                          // 8 bits per channel
  head[9] = 6;                                          // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, size, bleed] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true]]) {
  const file = path.join(out, name);
  fs.writeFileSync(file, png(size, render(size, bleed)));
  console.log(`${name}: ${size} x ${size}, ${fs.statSync(file).size} bytes`);
}
