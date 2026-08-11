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

## 3. service_role / anon keys — no outage, but no undo either

⚠️ **The legacy keys cannot be rotated.** Supabase removed that button. `anon` and
`service_role` are static JWTs signed by the project's legacy JWT secret, and the only
way to retire them is to move to the replacement keys and then disable the legacy pair
outright. Any older instruction to "rotate the service_role key" no longer matches the
product.

The replacements are on **Project Settings → API Keys**:

| Old | New | Goes in |
|---|---|---|
| `anon` | `sb_publishable_…` | `SUPABASE_ANON_KEY`, `VITE_SUPABASE_ANON_KEY` |
| `service_role` | `sb_secret_…` | `SUPABASE_SERVICE_ROLE_KEY` |

The env var names stay. They describe the privilege level, which has not changed, and
renaming them would touch `env.ts`, both wrangler secrets and the dashboard build for
no behavioural gain.

**No code change is needed.** `@supabase/supabase-js` ≥ 2.50 recognises a non-JWT key
and places it correctly, and the one hand-rolled caller — `packages/shared/src/storage.ts`
— sends the identical value in `authorization: Bearer` *and* `apikey`, which is the one
case the docs explicitly still allow. If that ever diverges, the Bearer header must be
dropped: a non-JWT there is forwarded to Postgres and rejected as a bad token.

Unlike the old roll, this is **not** a simultaneous outage. The legacy keys keep
working until you disable them, so cut over and verify first, disable second.

```bash
# 1. Supabase → Project Settings → API Keys → "Publishable and secret API keys".
#    Copy both. The secret key is shown once.

cd workers/api
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # sb_secret_…
npx wrangler secret put SUPABASE_ANON_KEY           # sb_publishable_…
npx wrangler deploy

cd ../..
# The anon key is baked in at build time, so this is a rebuild, not a redeploy.
# dashboard/.env — set VITE_SUPABASE_ANON_KEY to the new value first.
pnpm deploy:dashboard
```

Then, in this order, because each one exercises a different half:

1. Send a WhatsApp message to the sandbox number — proves the secret key, and a media
   message proves `storage.ts` in particular.
2. Sign in to the dashboard — proves the publishable key and the rebuild.

Only once both pass: **API Keys → Legacy anon, service_role API keys → Disable
JWT-based API keys.**

⚠️ **That button is not sufficient, and it reports success anyway.** It stops the API
gateway accepting the legacy keys, so Auth answers 401 and PostgREST answers
`Legacy API keys are disabled` — but **Storage keeps working**, because storage-api
validates the signature against the legacy JWT secret rather than consulting the key
list. Measured on 2026-08-12: with the pair "disabled", the legacy `service_role` key
still listed a client's media prefix out of the private bucket. Media is the one place
customer photos live, so this is the worst surface to leave open.

Killing it takes a second, separate step on **JWT Keys**:

1. **JWT Signing Keys → Create Standby Key** (asymmetric), if there isn't one.
2. **Rotate keys.** The legacy HS256 secret moves to *Previously used*. Nothing is
   revoked yet.
3. **Revoke** the legacy secret under *Previously used*. This is the step that
   invalidates every token it ever signed, `service_role` included, in Storage too.

Supabase advises waiting access-token-expiry + ~15 min before step 3 so live sessions
aren't cut off. With no clients on the platform the only session is ours, so revoke
immediately — a live leaked key outranks a re-login.

Safe for us because nothing here verifies a JWT locally: `workers/api/src/auth.ts`
hands the token to `/auth/v1/user`, and there are no Edge Functions. A project that
verified tokens itself with `jose`/`jsonwebtoken` would break at step 2.

**Verify, don't assume.** The check that caught this, re-run after revoking — it must
fail:

```bash
printf 'legacy service_role key: '; read -rs SR; echo
curl -s -X POST \
  "$SUPABASE_URL/storage/v1/object/list/media" \
  -H "apikey: $SR" -H "authorization: Bearer $SR" \
  -H "content-type: application/json" -d '{"prefix":"","limit":5}'
unset SR
```

A JSON array means the key is still live. Note that an unauthenticated request returns
`NoSuchBucket` while an authenticated-but-unauthorised one returns `NoSuchKey` — so on
single-object probes the error *shape*, not the status code, is what tells you whether
the key was accepted.

### Session signing keys are a different rotation

**JWT Keys → JWT Signing Keys** rotates the key that signs *user sessions*, not the API
keys above. Rotating there is safe and independent: we never verify a session token
locally — `workers/api/src/auth.ts` hands it to Supabase's `/auth/v1/user` — so nothing
in this repo caches a signing key. Signed-in tabs get signed out; that is the whole
blast radius.

---

## After any rotation

Old keys do not expire on their own — they stop working only because the thing that
issued them was replaced. So the last step is always the same: delete the superseded
value from wherever it was stored. A rotated credential still sitting in a password
manager entry marked "current" is the problem the rotation was supposed to solve.
