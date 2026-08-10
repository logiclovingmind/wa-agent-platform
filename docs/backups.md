# Backups — read before writing anything

⚠️ **A Cloudflare Worker cannot run `pg_dump`.** A Worker is a JavaScript sandbox with
no OS, no filesystem, and no ability to execute compiled binaries. `pg_dump` is a
compiled binary. The planning document says to do this via a Cloudflare cron; that
instruction is wrong and must not be implemented. (Independently confirmed by the 10ms
cron CPU limit — even if it could, 10ms would not serialise a database.)

**Correct approach:** a GitHub Actions scheduled workflow. Free Ubuntu runner,
`pg_dump` available, and the dump is kept as a **workflow artifact**.

⚠️ **Artifacts are a compromise, not the right answer.** Object storage is, but R2 and
S3 both require a payment method on file and this account has none. What that costs us:

- **Retention is capped at 90 days** on the free plan. Anything older is gone. R2 would
  have kept dumps indefinitely for well under the free tier.
- **Free-plan artifact storage is small and shared** with everything else the repo
  stores. As the client's data grows this will start evicting or failing.
- Artifacts are downloaded through the GitHub UI or `gh run download`, not `aws s3 cp`,
  so restoring is a manual step rather than a scripted pull.

Treat this as the thing to replace first once a payment method exists. Until then it is
still a real backup, which is the part that matters.

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
- `if-no-files-found: error` on the upload step. An empty artifact is indistinguishable
  from a healthy backup in the run list, which is the worst possible failure mode here.

## Not in the backup

`auth.users` is excluded, because Supabase owns that schema and a new project recreates
it. Dashboard logins therefore do **not** survive a restore — owners and staff have to
be re-invited. Messages and KB, which cannot be recreated, do survive. If that trade
stops being acceptable, add a second `--data-only --table=auth.users` dump.

## Testing the restore

```bash
gh run download --name wa-agent-<timestamp>.dump   # pull the artifact first
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

Restore last verified: **2026-08-11**, against a **real Supabase dump** pulled from the
GitHub artifact of a `workflow_dispatch` run — round trip green, 15/15 policies and
3/3 `app` helpers restored, seeded org/account/conversation/message all survived. The
session-pooler and client-version legs above are therefore exercised, not assumed.

`pg_restore` reports one ignored error on every run — `schema "public" already exists`.
That one is expected and harmless; the local shim creates `public` first. It is also
why the exit code proves nothing and `db:restore-test` counts rows instead.
