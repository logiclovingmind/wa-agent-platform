---
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
---

# Testing

Not broad coverage. Four tests, because these four cost real money or leak data.

1. **Duplicate `wa_message_id` is rejected** — at both layers: the DO drops it, and a
   direct insert into `messages` violates the unique index.
2. **`window_expires_at` computes correctly across the 24h boundary** — including the
   23h50m margin and a UTC/IST offset case.
3. **Org isolation, anon path** — a query authenticated as org A returns zero rows
   from org B.
4. **Org isolation, service path** — a Worker handler given org A's context cannot
   read or write org B's rows.

Test 4 is the one that matters most: test 3 passes even when the Worker is wide open,
because `service_role` bypasses RLS. Test 4 covers the code path every message goes
through.

Vitest with `@cloudflare/vitest-pool-workers`. Tests 1, 3 and 4 need local Postgres
(`pnpm db:up` / `pnpm test:db`) — the workers pool provides no database.
