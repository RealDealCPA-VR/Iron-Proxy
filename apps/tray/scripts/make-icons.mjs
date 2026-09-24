// Draws the tray and app icons and writes them as PNGs, with no dependencies
// beyond node:zlib. The output is deterministic, so the committed files in
// assets/ can be checked against a fresh run (see test/icons.test.ts).
//
//   node scripts/make-icons.mjs            writes into assets/
//   node scripts/make-icons.mjs --out DIR  writes into DIR
//
// The mark is a bold serif "I" (an I-beam) on a rounded square:
// - trayTemplate*.png: monochrome, black with the "I" cut out. macOS treats a
//   "Template" image as a mask and tints it for light and dark menu bars.
// - tray*.png: the colored version for Windows and Linux trays.
// - icon-256.png / icon-512.png: the colored app icon.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outFlag = process.argv.indexOf('--out');
const outDir = outFlag > 0 ? resolve(process.argv[outFlag + 1]) : join(root, 'assets');

/* ------------------------------------------------------------------ */
/* PNG encoding                                                        */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA8 pixels (straight alpha), row-major, to a PNG file. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Shapes, in unit coordinates (0..1 across the icon)                  */
/* ------------------------------------------------------------------ */

function inRoundedSquare(x, y, margin, radius) {
  const lo = margin;
  const hi = 1 - margin;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** A bold serif capital I: top bar, stem, bottom bar. */
function inGlyph(x, y) {
  const top = y >= 0.22 && y <= 0.35 && x >= 0.29 && x <= 0.71;
  const bottom = y >= 0.65 && y <= 0.78 && x >= 0.29 && x <= 0.71;
  const stem = y >= 0.22 && y <= 0.78 && x >= 0.405 && x <= 0.595;
  return top || bottom || stem;
}

const mix = (a, b, t) => a + (b - a) * t;

/** Monochrome mask: black square, transparent "I". */
function templatePaint(x, y) {
  if (!inRoundedSquare(x, y, 0.04, 0.2)) return [0, 0, 0, 0];
  if (inGlyph(x, y)) return [0, 0, 0, 0];
  return [0, 0, 0, 255];
}

/** Colored: slate-to-ink gradient, soft top highlight, near-white "I". */
function colorPaint(x, y) {
  if (!inRoundedSquare(x, y, 0.04, 0.2)) return [0, 0, 0, 0];
  if (inGlyph(x, y)) return [244, 246, 250, 255];
  const t = (y - 0.04) / 0.92;
  let r = mix(71, 17, t);
  let g = mix(85, 24, t);
  let b = mix(105, 39, t);
  if (y < 0.12) {
    const h = (0.12 - y) / 0.08;
    r = mix(r, 110, h * 0.35);
    g = mix(g, 126, h * 0.35);
    b = mix(b, 148, h * 0.35);
  }
  return [r, g, b, 255];
}

/** Rasterise with 4x4 supersampling, averaged in premultiplied space. */
function render(size, paint) {
  const ss = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [cr, cg, cb, ca] = paint(
            (px + (sx + 0.5) / ss) / size,
            (py + (sy + 0.5) / ss) / size,
          );
          const al = ca / 255;
          r += cr * al;
          g += cg * al;
          b += cb * al;
          a += al;
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      out[i + 3] = Math.round((a / n) * 255);
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
    }
  }
  return out;
}

const files = [
  ['trayTemplate.png', 16, templatePaint],
  ['trayTemplate@2x.png', 32, templatePaint],
  ['trayTemplate@4x.png', 64, templatePaint],
  ['tray.png', 16, colorPaint],
  ['tray@2x.png', 32, colorPaint],
  ['tray@4x.png', 64, colorPaint],
  ['icon-256.png', 256, colorPaint],
  ['icon-512.png', 512, colorPaint],
];

await mkdir(outDir, { recursive: true });
for (const [name, size, paint] of files) {
  await writeFile(join(outDir, name), encodePng(size, render(size, paint)));
}
console.log(`Wrote ${files.length} icons to ${outDir}`);
