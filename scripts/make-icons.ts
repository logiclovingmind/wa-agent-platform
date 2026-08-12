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
import { copyFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

// Rasterised once, at the largest size, and scaled down from there. Asking qlmanage for a
// 192px thumbnail of a 192px SVG returns a 192px canvas with the drawing at about 120px
// in the top-left corner and the rest transparent — which is what shipped, and what an
// installed icon on a home screen made of. It only fills the canvas when the requested
// size is the larger number, so the small one is a resize rather than a second render.
const BASE = 512;
const inset = Math.round(BASE * 0.2);
const inner = BASE - inset * 2;
const source = join(work, "icon.svg");

writeFileSync(
  source,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${BASE}" height="${BASE}" viewBox="0 0 ${BASE} ${BASE}">
  <rect width="${BASE}" height="${BASE}" fill="${TILE}"/>
  <svg x="${inset}" y="${inset}" width="${inner}" height="${inner}" viewBox="${viewBox}" fill="${MARK}" color="${MARK}">${body.replace(/currentColor/g, MARK)}</svg>
</svg>`,
);

execFileSync("qlmanage", ["-t", "-s", String(BASE), "-o", work, source], { stdio: "ignore" });

const out512 = join(root, "dashboard/public", "icon-512.png");
renameSync(`${source}.png`, out512);
console.log(`wrote ${out512}`);

for (const size of [192]) {
  const out = join(root, "dashboard/public", `icon-${size}.png`);
  copyFileSync(out512, out);
  execFileSync("sips", ["-z", String(size), String(size), out], { stdio: "ignore" });
  console.log(`wrote ${out}`);
}

// Both files must come out square and full-bleed. The failure this guards against is
// silent: a wrong icon looks fine in the repo and only shows itself once someone has
// installed it, at which point iOS caches it and a redeploy does not replace it.
for (const [size, file] of [
  [512, out512],
  [192, join(root, "dashboard/public", "icon-192.png")],
] as const) {
  const probe = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], {
    encoding: "utf8",
  });
  const [w, h] = [...probe.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1]));
  if (w !== size || h !== size) throw new Error(`${file} is ${w}x${h}, expected ${size}`);
}
