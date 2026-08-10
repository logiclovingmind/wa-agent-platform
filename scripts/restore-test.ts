// Proves a dump is a backup. An untested dump is a folder of files.
//
//   pnpm db:restore-test path/to/wa-agent-....dump
//
// Restores into a throwaway database in the local PG17 cluster — never into wa_agent —
// then checks the tables and rows actually arrived.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const PG_BIN = process.env.PG_BIN ?? "/usr/local/opt/postgresql@17/bin";
const PORT = process.env.PGPORT ?? "54322";
const SCRATCH = "wa_agent_restore_test";
const CONN = ["-U", "postgres", "-h", "127.0.0.1", "-p", PORT];

/** Every table the platform cannot be rebuilt without. */
const REQUIRED = [
  "organizations",
  "wa_accounts",
  "conversations",
  "messages",
  "inbound_dedupe",
  "kb_documents",
  "safety_flags",
];

const dump = process.argv[2];
if (!dump || !existsSync(dump)) {
  console.error("usage: restore-test.ts <dump-file>");
  process.exit(1);
}

function pg(cmd: string, args: string[], opts: { quiet?: boolean } = {}) {
  return spawnSync(join(PG_BIN, cmd), args, {
    stdio: opts.quiet ? "pipe" : "inherit",
    env: { ...process.env, PGPORT: PORT, LC_ALL: "en_US.UTF-8" },
  });
}

function query(sql: string): string {
  const res = pg("psql", [...CONN, "-d", SCRATCH, "-tAc", sql], { quiet: true });
  if (res.status !== 0) {
    console.error(res.stderr?.toString());
    process.exit(1);
  }
  return res.stdout.toString().trim();
}

if (pg("pg_ctl", ["-D", join(process.cwd(), ".pgdata"), "status"], { quiet: true }).status !== 0) {
  console.error("local cluster is not running — pnpm db:up first");
  process.exit(1);
}

console.log(`recreating ${SCRATCH}`);
pg("dropdb", [...CONN, "--if-exists", SCRATCH], { quiet: true });
if (pg("createdb", [...CONN, SCRATCH]).status !== 0) process.exit(1);

// The dump is public-schema only, so auth.users, auth.uid() and the Supabase roles the
// FKs and RLS policies point at have to exist before pg_restore runs.
console.log("applying the Supabase shim");
const shim = pg("psql", [
  ...CONN, "-d", SCRATCH, "-v", "ON_ERROR_STOP=1", "-q",
  "-f", join(process.cwd(), "db", "init-local.sql"),
]);
if (shim.status !== 0) process.exit(1);

console.log(`restoring ${resolve(dump)}`);
// Not --exit-on-error: a Supabase dump reaches for objects a bare cluster does not
// have, and those errors are noise. The checks below are what decides pass or fail.
pg("pg_restore", [...CONN, "-d", SCRATCH, "--no-owner", "--no-privileges", dump]);

const missing = REQUIRED.filter(
  (t) => query(`select to_regclass('public.${t}') is not null`) !== "t",
);
if (missing.length > 0) {
  console.error(`\nFAIL — tables missing after restore: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("\ntable                 rows");
for (const table of REQUIRED) {
  console.log(`${table.padEnd(20)} ${query(`select count(*) from ${table}`).padStart(6)}`);
}

// Invariant 1 is only worth anything if it survives a restore.
const POLICIED = ["organizations", "conversations", "messages", "safety_flags", "kb_documents"];

const unscoped = query(`
  select count(*) from information_schema.tables t
  where t.table_schema = 'public'
    and t.table_name = any(array['conversations','messages','safety_flags','kb_documents'])
    and not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'org_id'
    )`);
const norls = query(`
  select count(*) from pg_class
  where relnamespace = 'public'::regnamespace and relkind = 'r'
    and relname = any(array['conversations','messages','safety_flags','kb_documents'])
    and not relrowsecurity`);

// The failure this exists to catch: a dump that omits the `app` schema restores every
// table and then loses every policy that calls app.is_member(). RLS stays *enabled*,
// so the tables look locked down while the dashboard is quietly broken for everyone.
const helpers = query(`
  select count(*) from pg_proc
  where pronamespace = to_regnamespace('app')
    and proname = any(array['is_member','is_owner','is_platform_admin'])`);
const unpolicied = POLICIED.filter(
  (t) => query(`select count(*) from pg_policies where schemaname='public' and tablename='${t}'`) === "0",
);

console.log(`\norg_id missing on: ${unscoped} table(s)`);
console.log(`RLS off on:        ${norls} table(s)`);
console.log(`app.is_* helpers:  ${helpers}/3`);
console.log(`no RLS policy on:  ${unpolicied.length} table(s)`);

const orgs = Number(query("select count(*) from organizations"));
const messages = Number(query("select count(*) from messages"));

if (unscoped !== "0" || norls !== "0") {
  console.error("\nFAIL — the restored schema does not carry org_id + RLS");
  process.exit(1);
}
if (helpers !== "3") {
  console.error("\nFAIL — the app schema did not restore. Dump needs --schema=app.");
  process.exit(1);
}
if (unpolicied.length > 0) {
  console.error(`\nFAIL — RLS enabled but no policy on: ${unpolicied.join(", ")}`);
  process.exit(1);
}
if (orgs === 0) {
  console.error("\nFAIL — restored zero organizations. That is not a usable backup.");
  process.exit(1);
}

console.log(`\nPASS — ${orgs} org(s), ${messages} message(s) restored into ${SCRATCH}.`);
console.log(`Inspect: psql -h 127.0.0.1 -p ${PORT} -U postgres -d ${SCRATCH}`);
console.log("Then record the date in docs/backups.md.");
