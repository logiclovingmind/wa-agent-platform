// Install icons, generated from `logo.svg` so there is one source of the mark and the
// PNGs are never edited by hand.
//
// It builds a wrapper SVG — brand tile, logo nested at 60% — and lets macOS render it
// through `qlmanage`, which is the only rasteriser on this machine. That makes this a
// local tool, not a build step: the PNGs are committed, and CI never runs it.
//
//   pnpm tsx scripts/make-icons.ts
//
// The mark sits inside the middle 60% so one file can serve `purpose: "any maskable"`.
// Android crops a maskable icon to the launcher's shape and nothing in the outer 20% is
// guaranteed to survive.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TILE = "#1c1c1c";
const MARK = "#ffffff";

const root = fileURLToPath(new URL("../", import.meta.url));
const logo = readFileSync(join(root, "logo.svg"), "utf8");

const viewBox = /viewBox="([^"]+)"/.exec(logo)?.[1];
const body = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(logo)?.[1];
if (!viewBox || !body) throw new Error("logo.svg is not the shape this script expects");

const work = mkdtempSync(join(tmpdir(), "icons-"));

for (const size of [192, 512]) {
  const inset = Math.round(size * 0.2);
  const inner = size - inset * 2;
  const source = join(work, `icon-${size}.svg`);

  writeFileSync(
    source,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${TILE}"/>
  <svg x="${inset}" y="${inset}" width="${inner}" height="${inner}" viewBox="${viewBox}" fill="${MARK}" color="${MARK}">${body.replace(/currentColor/g, MARK)}</svg>
</svg>`,
  );

  execFileSync("qlmanage", ["-t", "-s", String(size), "-o", work, source], { stdio: "ignore" });
  const out = join(root, "dashboard/public", `icon-${size}.png`);
  renameSync(`${source}.png`, out);
  console.log(`wrote ${out}`);
}
