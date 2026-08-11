# CLAUDE.md

Multi-tenant WhatsApp AI agent platform. One codebase, many clients. TypeScript
strict, pnpm. **Greenfield — no code exists yet.** Build in the order in §3.

Flow: Meta webhook → verify signature → identify client → debounce ~4s → build prompt
→ LLM → exactly one reply. Owner can take over from the dashboard.

Detail lives in `docs/` and `.claude/rules/` (§6). Open the relevant file before
writing code in that area. Several rules there exist because the obvious approach is
wrong.

---

## 1. Invariants

1. `org_id` on every table. RLS on every table.
2. The Worker uses `service_role` and bypasses RLS. Every Worker query filters by
   `org_id` in code. RLS is the second lock, never the only one.
3. Inbound dedupe on `wa_message_id` — DO first, unique index second.
4. Outbound idempotency: mark "reply sent" **before** calling Meta.
5. One reply = one message. In the prompt *and* asserted in code before send.
6. Secrets never reach the browser. Meta, LLM, and money go through the Worker.
7. Never `select *` on `messages`. Paginate at 20.
8. Realtime subscribes to the open conversation only. Unsubscribe on unmount and tab
   close.
9. Media to object storage by key, never into Postgres. Meta media URLs expire in
   ~5 min.
10. Distress/self-harm/abuse → one hardcoded acknowledgement, then instant human
    handoff. Never model text on a flagged turn, never silence.
11. Minor detected → stop the AI. Send once: *"I'll need to speak with a parent or
    guardian."* No interrogation, no age question, no auto-resume.
12. Store UTC, display IST. Cron expressions in UTC with IST in a comment.
13. `messages` is NOT partitioned and RAG retrieval is OFF. Both deliberate, both look
    like oversights. Read `.claude/rules/data-model.md` before changing either.

**Client #21 is an INSERT, not a deploy.** No per-client code, branches, deploys, or
secrets. A change that requires touching the repo to onboard a client is wrong.

---

## 2. Hard constraints

- **10ms CPU per invocation** (Workers and cron alike). I/O is free, computing is not.
  `ctx.waitUntil()` does not grant more CPU.
- **5GB/mo Supabase egress.** A 402 here kills every client at once.
- **5 cron triggers per account**, no retry on failure.

---

## 3. Build order

Grouped into sessions. Don't split the groups — each one is a single code path.

1. Schema + RLS. Gate: tests 3 and 4 green.
2. Webhook + Durable Object. Verify → dedupe → 200. DO handles debounce, dedupe,
   handoff lock, outbound idempotency. No LLM yet.
3. LLM call + safety enforcement in the same path. `llm.ts`, single-reply assert,
   flags, output check.
4. Dashboard. Inbox, Realtime, takeover.
5. Backups with a tested restore, monitoring, dead-man's-switch, rate limit. All
   before client 1.

Done when: a real phone gets one reply, the owner can take over mid-conversation, a
duplicate webhook changes nothing, a restore has been performed from a real dump, and
org A cannot see org B.

---

## 4. Commands

```bash
pnpm dev                 # wrangler dev on /workers/api
pnpm dev:dashboard
pnpm test                # vitest, @cloudflare/vitest-pool-workers
pnpm test:db             # tests needing real Postgres
pnpm typecheck
pnpm lint

pnpm db:up               # docker compose up local Postgres
pnpm db:migrate
pnpm db:reset
pnpm db:push             # remote — NEVER without running local first

pnpm deploy:api
pnpm deploy:dashboard
```

The workers pool provides no database. Tests 1, 3, 4 need `pnpm db:up`.

---

## 5. Layout

```
/workers/api        Hono Worker — webhooks, write API, cron handlers
/workers/api/do     Durable Objects (SQLite backend — required on free tier)
/dashboard          React + Vite + Tailwind + shadcn/ui
/dashboard/admin    All-clients view
/packages/shared    Types, Zod schemas, prompt builders, llm.ts
/supabase/migrations
/.github/workflows  Nightly pg_dump
```

Supabase Postgres + pgvector + Realtime + Auth. Supabase Storage for media, GitHub
Actions artifacts for backups — **no R2, no S3**: both need a payment method this
account does not have, and there is none coming. Cloudflare
Pages for the dashboard. LLM `gpt-4o-mini` — **base URL unknown, every call goes
through `packages/shared/llm.ts`.**

No moment.js, no lodash, no ORM. Every dependency is CPU and bundle budget.

---

## 6. Detail files

`.claude/rules/` load automatically when a matching file is opened. `docs/` are read
on demand by name.

| File | Read before |
|---|---|
| `.claude/rules/message-flow.md` | Webhook, DO, debounce, dedupe, 24h window, CPU budget |
| `.claude/rules/data-model.md` | Any migration, schema, token storage, handoff, roles |
| `.claude/rules/safety.md` | Any prompt, LLM call, or output check |
| `.claude/rules/testing.md` | Writing tests |
| `docs/meta-whatsapp.md` | Meta setup, webhook routing, media |
| `docs/free-tier.md` | Limits, cron budget, degradation, monitoring |
| `docs/backups.md` | The backup job — the original plan is impossible |
| `docs/rotation.md` | Rotating the master key, DB password or service_role key |

---

## 7. Working style

- Ask before adding a dependency or creating a table.
- Expand-contract migrations only: add column → backfill → switch reads → drop in a
  *later* deploy. No staging exists; run against local Postgres first.
- Prefer boring and readable. Solo project, one maintainer.
- If something here looks wrong, say so rather than working around it silently.
