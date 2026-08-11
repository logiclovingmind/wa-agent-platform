# Credential rotation

Everything here is a live-production procedure. Read the whole section before typing
any of it — several of these commands are irreversible and two of them take the
platform down if run in the wrong order.

Rotate all three **before client 1 signs**. Until then the blast radius is a sandbox
number and demo rows; afterwards it is a customer's WhatsApp.

## What exists, and where

| Credential | Lives in | Rotating it breaks |
|---|---|---|
| `MASTER_KEY_V*` | Wrangler secret | Reading any client's Meta token — i.e. all replies |
| Database password | GitHub secret `SUPABASE_DB_URL` | Backups and the migrate workflow |
| service_role key | Wrangler secret `SUPABASE_SERVICE_ROLE_KEY` | The Worker entirely — **and the anon key with it** |

The anon key is not on that list on purpose: it is public by design and appears in the
dashboard bundle. It still changes when the service_role key is rolled, because both
are signed by the same project JWT secret. That is the trap in §3.

---

## 1. Master key — safe, do this first

Additive: V2 is set alongside V1, rows move to V2, then V1 goes away. There is no
window in which a stored credential cannot be read, which is why this one can be done
on a weekday afternoon.

The plaintext is the input, because a Wrangler secret is write-only — nothing, not even
the account owner, can read the current V1 back out to re-encrypt with it. Get the
token and app secret from the Meta app dashboard.

```bash
read -rs META_TOKEN;      export META_TOKEN
read -rs META_APP_SECRET; export META_APP_SECRET
pnpm tsx scripts/rotate-key.ts --version 2 --phone-number-id <phone_number_id>
unset META_TOKEN META_APP_SECRET
```

`read -rs` and not `META_TOKEN=… pnpm tsx …`: the second puts a live Meta token in
`~/.zsh_history`.

The script prints the new key, the `wrangler secret put` line and one `UPDATE`. Follow
its three steps in order and **save the key to a password manager before closing the
terminal** — it is not recoverable, and losing it means re-onboarding every client from
the Meta dashboard.

Do not delete `MASTER_KEY_V1` until a real WhatsApp message has produced a real reply.

---

## 2. Database password — brief outage, no code change

Only the nightly backup and the migrate workflow use it. Neither is on the request
path, so the "outage" is a failed cron at worst.

1. Supabase dashboard → Settings → Database → Reset database password. Copy it.
2. Rebuild the **session pooler** URI — port 6543, not 5432. `docs/backups.md` explains
   why the direct connection is unusable from a GitHub runner (IPv6-only).

   ```
   postgresql://postgres.<project-ref>:<new-password>@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```

3. Replace the secret and prove it before the next nightly run:

   ```bash
   gh secret set SUPABASE_DB_URL          # paste the URI, then Ctrl-D
   gh workflow run backup.yml
   gh run watch
   ```

If anything on this machine has the old URI in a shell variable or a scratch file, it
is now a dead credential in plaintext — delete it rather than leaving it lying around.

---

## 3. service_role key — **platform-wide outage, plan it**

⚠️ Rotating the legacy service_role key on Supabase rolls the project's **JWT secret**.
That invalidates the `anon` key at the same instant. So this is not one credential
changing, it is three things that must land together:

- the Worker's `SUPABASE_SERVICE_ROLE_KEY` secret,
- the Worker's `SUPABASE_ANON_KEY` secret,
- the dashboard bundle, which has the old anon key **compiled into it** and needs a
  rebuild and redeploy, not a config change.

Between the roll and the last of those, every client is down: the Worker cannot read
Postgres, so inbound messages get no reply, and every signed-in dashboard session is
rejected. Do it in a quiet hour and have the new keys copied out *before* starting.

```bash
# Supabase dashboard → Settings → API → rotate the service_role key.
# Copy BOTH the new service_role key and the new anon key off that page first.

cd workers/api
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler deploy

cd ../..
# The anon key is baked in at build time, so this is a rebuild, not a redeploy.
# dashboard/.env — set VITE_SUPABASE_ANON_KEY to the new value first.
pnpm deploy:dashboard
```

Then, in this order, because each one exercises a different half:

1. Send a WhatsApp message to the sandbox number — proves the service_role key.
2. Sign in to the dashboard — proves the anon key and the rebuild.

Anyone still holding a dashboard tab open gets signed out. That is expected; their
session token was signed by the old JWT secret.

---

## After any rotation

Old keys do not expire on their own — they stop working only because the thing that
issued them was replaced. So the last step is always the same: delete the superseded
value from wherever it was stored. A rotated credential still sitting in a password
manager entry marked "current" is the problem the rotation was supposed to solve.
