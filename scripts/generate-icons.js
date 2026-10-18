/**
 * Draws the app icons procedurally and writes them as PNGs.
 * No image library: pixels are rasterised by hand and deflated with node:zlib.
 *
 * Usage: node scripts/generate-icons.js
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(OUT, { recursive: true });

const INK = [11, 15, 14];
const LIME = [215, 255, 62];
const MINT = [122, 240, 190];

/* ------------------------------------------------------------ rasteriser -- */

function render(size, opts) {
  const {
    padding = 0,
    radiusF = 0.23,   // corner radius, as a fraction of size
    ringRF = 0.62,    // clock ring radius, as a fraction of the usable radius
    ringWidthF = 0.055,
    handMinF = 0.052,
    handHourF = 0.044,
    dotRF = 0.1,
  } = opts;
  const px = new Uint8ClampedArray(size * size * 4);
  const c = size / 2;
  const r = c - padding;

  const set = (x, y, [red, green, blue], alpha = 1) => {
    if (alpha <= 0) return;
    const i = (y * size + x) * 4;
    const a = Math.min(1, alpha);
    px[i] = px[i] * (1 - a) + red * a;
    px[i + 1] = px[i + 1] * (1 - a) + green * a;
    px[i + 2] = px[i + 2] * (1 - a) + blue * a;
    px[i + 3] = Math.max(px[i + 3], a * 255);
  };

  // Rounded-square backdrop with a lime -> mint diagonal gradient.
  const radius = size * radiusF;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = roundedRectDistance(x + 0.5, y + 0.5, padding, size - padding, radius);
      const alpha = clamp(0.5 - d, 0, 1);
      if (alpha <= 0) continue;
      const t = (x / size) * 0.45 + (y / size) * 0.55;
      set(x, y, mix(LIME, MINT, t), alpha);
    }
  }

  // Clock face: a thick ink ring.
  const ringOuter = r * ringRF;
  const ringWidth = size * ringWidthF;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.abs(Math.hypot(x + 0.5 - c, y + 0.5 - c) - ringOuter);
      set(x, y, INK, clamp(ringWidth / 2 - d + 0.5, 0, 1));
    }
  }

  // Hands at roughly 10:10 — the universal "this is a clock" pose.
  thickLine(set, c, c, c - ringOuter * 0.44, c - ringOuter * 0.30, size * handMinF, INK);
  thickLine(set, c, c, c + ringOuter * 0.40, c - ringOuter * 0.46, size * handHourF, INK);

  // Alert dot, top-right of the face.
  const dotX = c + ringOuter * 0.78;
  const dotY = c - ringOuter * 0.78;
  const dotR = size * dotRF;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - dotX, y + 0.5 - dotY);
      set(x, y, INK, clamp(dotR - d + 0.5, 0, 1));
      set(x, y, LIME, clamp(dotR * 0.5 - d + 0.5, 0, 1));
    }
  }

  return px;
}

function thickLine(set, x0, y0, x1, y1, width, color) {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = segmentDistance(x + 0.5, y + 0.5, x0, y0, x1, y1);
      set(x, y, color, clamp(width / 2 - d + 0.5, 0, 1));
    }
  }
}

function segmentDistance(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - x0) * dx + (py - y0) * dy) / len2, 0, 1);
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** Signed distance to a rounded rectangle, positive outside. */
function roundedRectDistance(px, py, min, max, radius) {
  const cx = (min + max) / 2;
  const cy = cx;
  const half = (max - min) / 2 - radius;
  const dx = Math.max(Math.abs(px - cx) - half, 0);
  const dy = Math.max(Math.abs(py - cy) - half, 0);
  return Math.hypot(dx, dy) - radius;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * clamp(t, 0, 1));

/* ------------------------------------------------------------ png writer -- */

function png(size, pixels) {
  // Each scanline is prefixed with filter byte 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ----------------------------------------------------------------- build -- */

// At 16-32px the normal stroke weights disappear, so favicons get a bolder
// cut of the same mark: thicker ring and hands, tighter corners.
const BOLD = {
  radiusF: 0.18,
  ringRF: 0.66,
  ringWidthF: 0.08,
  handMinF: 0.08,
  handHourF: 0.07,
  dotRF: 0.15,
};

const targets = [
  // Maskable icons get cropped to a circle by Android, so they bleed to the edge.
  { file: "icon-192.png", size: 192, padding: 0 },
  { file: "icon-512.png", size: 512, padding: 0 },
  { file: "icon-maskable-512.png", size: 512, padding: 0 },
  { file: "apple-touch-icon.png", size: 180, padding: 0 },
  // The badge is a monochrome silhouette in Android's status bar.
  { file: "badge-96.png", size: 96, padding: 10 },
  { file: "favicon-32.png", size: 32, ...BOLD },
  { file: "favicon-16.png", size: 16, ...BOLD },
];

for (const { file, size, ...opts } of targets) {
  writeFileSync(join(OUT, file), png(size, render(size, opts)));
  console.log(`  wrote icons/${file}  (${size}x${size})`);
}

// /favicon.ico so the browser's automatic request doesn't 404. An .ico is just
// a small directory in front of the image payloads, and PNG payloads are legal
// entries, so the two PNGs above go in verbatim.
const icoSizes = [16, 32];
const images = icoSizes.map((size) => png(size, render(size, BOLD)));

let offset = 6 + 16 * images.length;
const dir = [Buffer.from([0, 0, 1, 0, images.length, 0])];

images.forEach((data, i) => {
  const entry = Buffer.alloc(16);
  entry[0] = icoSizes[i] === 256 ? 0 : icoSizes[i]; // width
  entry[1] = icoSizes[i] === 256 ? 0 : icoSizes[i]; // height
  entry.writeUInt16LE(1, 4);  // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32BE(0, 8);
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += data.length;
  dir.push(entry);
});

const ICO_PATH = join(OUT, "..", "favicon.ico");
writeFileSync(ICO_PATH, Buffer.concat([...dir, ...images]));
console.log(`  wrote favicon.ico   (${icoSizes.join(" + ")})`);
