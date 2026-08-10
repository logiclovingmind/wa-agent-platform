// Project-local Postgres cluster. No Docker, no global brew service — the data
// directory lives in .pgdata/ so db:reset can delete it without touching any other
// Postgres on this machine.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const PG_BIN = process.env.PG_BIN ?? "/usr/local/opt/postgresql@17/bin";
const PORT = process.env.PGPORT ?? "54322";
const ROOT = process.cwd();
const DATA = join(ROOT, ".pgdata");
const LOG = join(ROOT, ".pgdata", "server.log");
const DB = "wa_agent";

function run(cmd: string, args: string[], opts: { quiet?: boolean } = {}) {
  const res = spawnSync(join(PG_BIN, cmd), args, {
    stdio: opts.quiet ? "pipe" : "inherit",
    env: { ...process.env, PGPORT: PORT, LC_ALL: "en_US.UTF-8" },
  });
  return res;
}

function isRunning() {
  return run("pg_ctl", ["-D", DATA, "status"], { quiet: true }).status === 0;
}

function up() {
  if (!existsSync(join(PG_BIN, "initdb"))) {
    console.error(`No Postgres at ${PG_BIN}. Set PG_BIN, or: brew install postgresql@17`);
    process.exit(1);
  }

  if (!existsSync(DATA)) {
    console.log("initdb .pgdata");
    const res = run("initdb", ["-D", DATA, "-U", "postgres", "--auth=trust", "--encoding=UTF8"]);
    if (res.status !== 0) process.exit(res.status ?? 1);
  }

  if (isRunning()) {
    console.log(`already running on :${PORT}`);
  } else {
    // pg_ctl hands -o to a shell unquoted, so nothing here may contain a space.
    // That rules out -k <datadir>; the default socket dir is fine since we use TCP.
    const res = run("pg_ctl", ["-D", DATA, "-l", LOG, "-o", `-p ${PORT}`, "-w", "start"]);
    if (res.status !== 0) {
      console.error(`failed to start; see ${LOG}`);
      process.exit(res.status ?? 1);
    }
  }

  const exists = run("psql", [
    "-U", "postgres", "-h", "127.0.0.1", "-p", PORT, "-d", "postgres",
    "-tAc", `select 1 from pg_database where datname = '${DB}'`,
  ], { quiet: true });

  if (exists.stdout?.toString().trim() !== "1") {
    console.log(`createdb ${DB}`);
    run("createdb", ["-U", "postgres", "-h", "127.0.0.1", "-p", PORT, DB]);
  }

  // Idempotent: safe to re-run on every db:up.
  const shim = run("psql", [
    "-U", "postgres", "-h", "127.0.0.1", "-p", PORT, "-d", DB,
    "-v", "ON_ERROR_STOP=1", "-q", "-f", join(ROOT, "db", "init-local.sql"),
  ]);
  if (shim.status !== 0) process.exit(shim.status ?? 1);

  console.log(`postgres ready on 127.0.0.1:${PORT}/${DB}`);
}

function down() {
  if (!existsSync(DATA) || !isRunning()) {
    console.log("not running");
    return;
  }
  run("pg_ctl", ["-D", DATA, "-m", "fast", "-w", "stop"]);
}

const cmd = process.argv[2];
if (cmd === "up") {
  up();
} else if (cmd === "down") {
  down();
} else if (cmd === "nuke") {
  down();
  rmSync(DATA, { recursive: true, force: true });
  console.log("removed .pgdata");
} else {
  console.error("usage: db.ts up|down|nuke");
  process.exit(1);
}
