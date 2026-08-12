// Install icons, drawn here rather than added as binaries nobody can diff. Two PNGs, no
// dependency and no image library: a solid tile with an F, encoded by hand.
//
// The glyph sits inside the middle 60% so the same file can serve `purpose: "any
// maskable"` — Android crops a maskable icon to whatever shape the launcher uses, and
// anything in the outer 20% is not guaranteed to survive.
//
// This is a placeholder for the branding step. Re-run after replacing BG or GLYPH:
//   pnpm tsx scripts/make-icons.ts
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BG = [0x1c, 0x1c, 0x1c];
const GLYPH = [0xff, 0xff, 0xff];

// prettier-ignore
const F = [
  "11111",
  "10000",
  "10000",
  "11110",
  "10000",
  "10000",
  "10000",
];

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(name, 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function png(size: number): Uint8Array {
  // One filter byte per row, then RGBA. Filter 0 (none) throughout: these are two flat
  // colours, so a predictor would buy nothing over deflate.
  const stride = 1 + size * 4;
  const raw = new Uint8Array(stride * size);

  const cell = Math.floor((size * 0.6) / F.length);
  const glyphW = cell * F[0]!.length;
  const glyphH = cell * F.length;
  const originX = Math.floor((size - glyphW) / 2);
  const originY = Math.floor((size - glyphH) / 2);

  for (let y = 0; y < size; y++) {
    const row = y * stride + 1;
    const gy = Math.floor((y - originY) / cell);
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x - originX) / cell);
      const inGlyph =
        gy >= 0 && gy < F.length && gx >= 0 && gx < F[0]!.length && F[gy]![gx] === "1";
      const [r, g, b] = inGlyph ? GLYPH : BG;
      const at = row + x * 4;
      raw[at] = r!;
      raw[at + 1] = g!;
      raw[at + 2] = b!;
      raw[at + 3] = 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  const head = new DataView(ihdr.buffer);
  head.setUint32(0, size);
  head.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ];

  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    file.set(part, at);
    at += part.length;
  }
  return file;
}

const dir = fileURLToPath(new URL("../dashboard/public/", import.meta.url));
for (const size of [192, 512]) {
  const path = `${dir}icon-${size}.png`;
  writeFileSync(path, png(size));
  console.log(`wrote ${path}`);
}
