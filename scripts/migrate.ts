import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";

const LOCAL_URL = "postgresql://postgres@127.0.0.1:54322/wa_agent";
const DIR = join(process.cwd(), "supabase", "migrations");

const remote = process.argv.includes("--remote");
const url = remote ? process.env.SUPABASE_DB_URL : (process.env.DATABASE_URL ?? LOCAL_URL);

if (remote && !url) {
  console.error("SUPABASE_DB_URL is required for --remote");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();

// Infra table, not a domain table, so it has no org_id. RLS with zero policies
// keeps it consistent with invariant 1's intent: nothing in public is readable
// from the browser by default.
await client.query(`
  create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )
`);
await client.query("alter table schema_migrations enable row level security");

const applied = new Set(
  (await client.query<{ version: string }>("select version from schema_migrations")).rows.map(
    (r) => r.version,
  ),
);

const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
let count = 0;

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = await readFile(join(DIR, file), "utf8");
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into schema_migrations (version) values ($1)", [file]);
    await client.query("commit");
    console.log(`applied ${file}`);
    count++;
  } catch (err) {
    await client.query("rollback");
    console.error(`failed ${file}`);
    throw err;
  }
}

console.log(count === 0 ? "up to date" : `${count} migration(s) applied`);
await client.end();
