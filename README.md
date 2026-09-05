# wa-agent-platform

A multi-tenant platform for running WhatsApp AI agents on behalf of many businesses from
a single deployment.

## The core constraint

Onboarding the twenty-first client is an `INSERT`, not a deploy.

Everything else follows from that. There is no per-client branch, no per-client
environment, and no per-client code path. A new business becomes a row in
`organizations`, a row in `wa_accounts`, and an encrypted credential blob. If adding a
client ever requires touching source, the design has failed.

## Architecture

**Edge compute.** Cloudflare Workers running Hono handle the Meta webhook. The 10ms
CPU budget per invocation is a hard constraint that shapes the request path — signature
verification and routing happen inline, anything slower is handed off.

**Per-conversation state lives in a Durable Object.** One `ConversationDO` per thread,
backed by SQLite, owns the problems that are genuinely stateful:

- debouncing bursts, so three messages typed in a row produce one considered reply
  rather than three overlapping ones
- duplicate suppression, because Meta retries deliveries and will resend the same
  `wa_message_id`
- the human-handoff lock, so the agent goes quiet the moment a person takes over
- WhatsApp's 24-hour reply window, and an alarm that returns the thread to the bot when
  a handoff goes stale

**Postgres on Supabase** holds durable data: 12 tables, row-level security enforced on
every one of them, 45 forward-only migrations under an expand-contract discipline so a
deploy never requires a destructive schema change.

**Credentials are encrypted at rest** with AES-GCM under a master key, versioned via
`key_version` so keys can rotate without downtime or a backfill.

## Safety

An agent that talks to the public will eventually receive a message it should not answer.
The platform detects distress and self-harm signals, and signals that the person on the
other end may be a minor, and escalates to a human instead of generating a reply.
Flagged content is scrubbed on a retention schedule.

## Operations

- Five cron triggers: usage accounting and heartbeat, retention deletion and flagged
  content scrub, and an inbound dedupe sweep
- Per-organisation rate limiting
- Nightly backups via GitHub Actions
- Vitest running against the real Workers runtime through
  `@cloudflare/vitest-pool-workers`, so tests exercise Durable Objects rather than mocks

## Stack

TypeScript (strict) · pnpm monorepo · Cloudflare Workers + Durable Objects · Hono ·
Supabase Postgres · React 18 + Vite + Tailwind + shadcn/ui · Vitest · GitHub Actions

## Layout

```
workers/      webhook handler, ConversationDO, crons, crypto, admin
dashboard/    React operator console
packages/     shared types and database client
supabase/     45 numbered migrations
docs/         message flow, data model, safety, backups, key rotation
```
