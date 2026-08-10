# Backups — read before writing anything

⚠️ **A Cloudflare Worker cannot run `pg_dump`.** A Worker is a JavaScript sandbox with
no OS, no filesystem, and no ability to execute compiled binaries. `pg_dump` is a
compiled binary. The planning document says to do this via a Cloudflare cron; that
instruction is wrong and must not be implemented. (Independently confirmed by the 10ms
cron CPU limit — even if it could, 10ms would not serialise a database.)

**Correct approach:** a GitHub Actions scheduled workflow. Free Ubuntu runner,
`pg_dump` available, R2 speaks S3 so upload is one `aws s3 cp`.

Three things break it on the first run:

1. ⚠️ **Use the Supabase Session pooler connection string, not the direct
   `db.<ref>.supabase.co` host.** The direct host resolves to IPv6 only and
   GitHub-hosted runners have no outbound IPv6 — it fails with "network is
   unreachable". The session pooler is IPv4 and supports the prepared statements
   `pg_dump` needs. (The *transaction* pooler does not — use session.)
2. **Pin the client version.** `pg_dump` aborts on server-version mismatch. Install the
   client matching your Supabase Postgres major version explicitly.
3. **Avoid special characters in the DB password**, or URL-encode it. An `@` silently
   breaks the connection URI.

4. ⚠️ **Dump `--schema=public --schema=app`, not `public` alone.** Every RLS policy
   calls `app.is_member()` / `app.is_owner()`. A public-only dump restores all the
   tables and then silently drops **14 of 15 policies** — `pg_restore` reports
   "schema app does not exist", exits 0, and leaves RLS *enabled* with nothing behind
   it. The database looks locked down and the dashboard is broken for every user.
   Found by actually running the restore, which is the entire point of running it.

Also:

- ⚠️ **GitHub disables scheduled workflows after ~60 days of repo inactivity**, and
  scheduled runs are best-effort under load. Add `workflow_dispatch` and actually press
  it if the repo goes quiet.
- Check the R2 upload lands. Recent AWS CLI v2 versions changed default checksum
  behaviour in ways that break S3-compatible endpoints; pin the CLI version if uploads
  start failing with checksum errors.

## Not in the backup

`auth.users` is excluded, because Supabase owns that schema and a new project recreates
it. Dashboard logins therefore do **not** survive a restore — owners and staff have to
be re-invited. Messages and KB, which cannot be recreated, do survive. If that trade
stops being acceptable, add a second `--data-only --table=auth.users` dump.

## Testing the restore

```bash
pnpm db:up
pnpm db:restore-test path/to/wa-agent-….dump
```

Restores into a throwaway `wa_agent_restore_test` database in the local PG17 cluster —
never into `wa_agent` — applies `db/init-local.sql` for the `auth` shim the FKs need,
then fails loudly if the `app` helpers, the RLS policies, `org_id`, or the rows are
missing. `pg_restore` on its own exits 0 with 18 errors, so its exit code proves
nothing.

Free Supabase has **no backups at all.** This job is the only thing between us and
total data loss. Build it before client 1 and **test a restore** — an untested dump is
a folder of files, not a backup.

Restore last verified: **2026-08-10**, against a local PG17 dump — round trip green,
15/15 policies restored. ⚠️ Still to do against a **real Supabase dump** once the
project exists: that is what exercises the session-pooler, client-version and R2 legs
above, none of which a local dump touches.
