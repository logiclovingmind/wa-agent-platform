/**
 * Puts the bytes behind the attachment rows in `scripts/demo-seed.sql`.
 *
 * The seed can create rows but not objects, so on its own the photo and voice-note
 * demos render as "no longer stored" — indistinguishable from a feature that does not
 * work. This uploads the fixtures to the exact paths those rows already point at.
 *
 * Run after the seed, once per install. The seed pins those conversations to fixed ids
 * precisely so re-running it does not strand what this uploaded.
 *
 *   pnpm tsx scripts/demo-media.ts            # upload
 *   pnpm tsx scripts/demo-media.ts --remove   # delete, for the final cleanup
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FIXTURES = join(process.cwd(), "scripts", "fixtures");
const BUCKET = "media";

/** Keyed by the wa_message_id the seed writes, so a renamed row fails loudly here. */
const FIXTURE: Record<string, { file: string; contentType: string }> = {
  "demo-919990010005-1": { file: "demo-photo.jpg", contentType: "image/jpeg" },
  "demo-919990010007-1": { file: "demo-voice.m4a", contentType: "audio/mp4" },
};

const remove = process.argv.includes("--remove");
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };

// The path is whatever the seed computed, not something rebuilt here: two copies of
// mediaPath() that drift would upload to a path nothing points at. Read over PostgREST
// rather than a direct connection, so this needs the same one credential as the upload
// below — and so it can never read paths out of a different database than it writes to.
const ids = Object.keys(FIXTURE)
  .map((id) => `"${id}"`)
  .join(",");
const lookup = await fetch(
  `${supabaseUrl}/rest/v1/messages?select=wa_message_id,media_key&media_key=not.is.null&wa_message_id=in.(${ids})`,
  { headers },
);
if (!lookup.ok) {
  console.error(`lookup failed (${lookup.status}): ${await lookup.text()}`);
  process.exit(1);
}
const rows = (await lookup.json()) as Array<{ wa_message_id: string; media_key: string }>;

if (rows.length === 0) {
  console.error("no demo attachment rows found — run scripts/demo-seed.sql first");
  process.exit(1);
}

for (const { wa_message_id, media_key } of rows) {
  const url = `${supabaseUrl}/storage/v1/object/${BUCKET}/${media_key}`;

  if (remove) {
    const res = await fetch(url, { method: "DELETE", headers });
    console.log(`${res.ok ? "removed" : `FAILED (${res.status})`} ${media_key}`);
    continue;
  }

  const { file, contentType } = FIXTURE[wa_message_id]!;
  const body = await readFile(join(FIXTURES, file));

  // upsert, so re-running after a re-seed replaces rather than 409s.
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": contentType, "x-upsert": "true" },
    body,
  });
  console.log(
    res.ok
      ? `uploaded ${file} (${body.byteLength} bytes) -> ${media_key}`
      : `FAILED (${res.status}) ${media_key}: ${await res.text()}`,
  );
}
