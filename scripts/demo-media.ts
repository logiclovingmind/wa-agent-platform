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
import { Client } from "pg";

const LOCAL_URL = "postgresql://postgres@127.0.0.1:54322/wa_agent";
const FIXTURES = join(process.cwd(), "scripts", "fixtures");
const BUCKET = "media";

/** Keyed by the wa_message_id the seed writes, so a renamed row fails loudly here. */
const FIXTURE: Record<string, { file: string; contentType: string }> = {
  "demo-999005-1": { file: "demo-photo.jpg", contentType: "image/jpeg" },
  "demo-999007-1": { file: "demo-voice.m4a", contentType: "audio/mp4" },
};

const remove = process.argv.includes("--remove");
const dbUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? LOCAL_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const client = new Client({ connectionString: dbUrl });
await client.connect();

// The path is whatever the seed computed, not something rebuilt here: two copies of
// mediaPath() that drift would upload to a path nothing points at.
const { rows } = await client.query<{ wa_message_id: string; media_key: string }>(
  `select wa_message_id, media_key
     from messages
    where wa_message_id = any($1) and media_key is not null`,
  [Object.keys(FIXTURE)],
);
await client.end();

if (rows.length === 0) {
  console.error("no demo attachment rows found — run scripts/demo-seed.sql first");
  process.exit(1);
}

const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };

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
