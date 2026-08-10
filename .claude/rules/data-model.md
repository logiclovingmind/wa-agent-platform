---
paths:
  - "supabase/migrations/**"
  - "packages/shared/**/*.ts"
---

# Data model

```
organizations      one row per client, rag_enabled flag
users              dashboard logins, FK to organizations
org_members        user + org + role ('owner' | 'staff')
wa_accounts        phone_number_id, waba_id, webhook_slug,
                   token_ciphertext, token_iv, token_key_version,
                   app_secret_ciphertext, app_secret_iv, app_secret_key_version
conversations      org_id, customer wa_id, handoff_state, window_expires_at
messages           org_id, conversation_id, wa_message_id UNIQUE, direction, body,
                   media_r2_key, created_at
inbound_dedupe     wa_message_id PK, org_id, seen_at   -- swept weekly
kb_documents       org_id, raw text
kb_chunks          org_id, content, embedding vector(1536)   -- dormant
usage_events       org_id, pricing_category, cost snapshot at send time
audit_log          admin actions, retained ~1 year
safety_flags       org_id, conversation_id, kind, detected_at, resolved_at
```

## ⚠️ `messages` is NOT partitioned — deliberate

The original plan said partition by month. **That plan is wrong and must not be
implemented.** Postgres requires a unique index on a partitioned table to include
every partition key column, so `UNIQUE (wa_message_id)` on a table partitioned by
`created_at` is rejected outright.

The tempting fix — `UNIQUE (wa_message_id, created_at)` — compiles, passes a naive
test, and **does not dedupe**: Meta's retry carries a different receipt timestamp and
lands in a different row. Silent double-replies, silent double billing.

Second problem: partitions do not self-extend. On the 1st of a month with no partition
created, every INSERT fails for every client at midnight.

At 500MB we have ~5 years of headroom. Archival is a `DELETE` on an indexed
`created_at`, batched by cron. If partitioning ever is needed, the migration is
expand-contract and dedupe stays in `inbound_dedupe`, which is never partitioned.

## RAG is dormant — deliberate

`kb_chunks` with `vector(1536)` exists from day one because adding a vector column to
a live multi-tenant table later is painful. **Retrieval is switched off.**

A salon has ~30 facts, under 1,500 tokens — the whole KB goes in the system prompt.
That is cheaper *and* more accurate than top-3 retrieval at this size. Switch on
per-org via `organizations.rag_enabled` when a KB outgrows ~50 pages.

Do not "helpfully" wire up retrieval.

## Token storage

One master key as a Wrangler secret. Each client's Meta token **and app secret** are
encrypted with it via AES-GCM using WebCrypto. Store the IV alongside each ciphertext
plus a `key_version` integer so the master key can rotate without a schema change. A
database dump then leaks nothing, and adding a client stays an INSERT.

Do **not** use one Wrangler secret per client — that forces a redeploy per client.

## Handoff state machine

```
bot → requested → human → returned → bot
```

Auto-return to `bot` after ~30 minutes of human idleness. **This is a DO alarm, not a
cron:** per-conversation, retries on failure, costs no cron trigger and no cross-org
sweep. The DO also holds the lock so the bot and a human can never reply over each
other.

## Roles and RLS

| Role | Can |
|---|---|
| `owner` | Everything in their org: billing view, staff management, KB edits |
| `staff` | Read inbox, take handoff, reply, mark bookings. No KB edits, no billing |
| platform admin | Us. Separate app at `admin.` — all orgs. Every action to `audit_log` |

Platform admin is **not** a role in `org_members`. Keep it a separate flag so a bug in
role logic cannot promote a client.

`wa_accounts` is **never readable from the browser** — not by `owner`, not by `staff`.
RLS denies select outright. The dashboard gets the display phone number from a view
that excludes every ciphertext column.

## Time

`timestamptz` everywhere, no naive timestamps. Display `Asia/Kolkata`. Month
boundaries for usage are IST boundaries, computed by offsetting, not by storing local
time.
