---
paths:
  - "workers/api/**/*.ts"
---

# Message flow — normative, do not reorder

## Inbound webhook (`POST /webhook/:slug`)

```
1. Look up wa_account by slug. Unknown slug → 404, no body read.
2. Read raw body as text (needed for HMAC).
3. HMAC-SHA256 verify against that client's app_secret. Fail → 401, stop.
4. Cheap substring test on raw text for "statuses".
     → status webhook: 200 immediately, waitUntil(persist status).
5. JSON.parse. Extract wa_message_id.
6. Return 200. Everything below runs in waitUntil / the DO.
```

A substring test is not a parse. HMAC comes first because an unverified body is
untrusted input.

## Dedupe (inbound)

The DO is the source of truth: it keeps the last ~200 `wa_message_id`s in SQLite
storage. Already seen → drop silently, no Postgres write.

Second line: `inbound_dedupe (wa_message_id text primary key, org_id uuid not null,
seen_at timestamptz)`, swept weekly. Separate from `messages` on purpose — see
`data-model.md`.

## Idempotency (outbound)

Before calling Meta, the DO writes `reply_sent_for: <inbound_wa_message_id>` to its
own storage. A retry sees the flag and does not send again.

**A successful Meta call with no Postgres row is recoverable. A second Meta call is
not.**

## Debounce

DO sets an alarm **4 seconds** after the first inbound message and collects anything
arriving before it fires. DO alarms retry with backoff — cron does not — which is why
debounce lives here.

## 24-hour window

`window_expires_at` decides free-form vs template sending, computed from the
customer's last inbound message. **Treat the window as closed at 23h50m, not 24h00m.**
Clock skew, debounce, and LLM latency otherwise produce failed sends at the boundary.

This is the #1 cause of "why didn't the bot reply?".

## LLM failure

Timeout **12 seconds**. One retry, then give up. On give-up: send the hardcoded
fallback ("Sorry — I'm having trouble right now. Someone from the team will get back
to you shortly."), set handoff to `requested`, notify the owner. The fallback is a
constant, not model output. Never leave the customer with silence.

## CPU budget (10ms)

Waiting on the LLM is I/O and costs nothing. What burns CPU: `JSON.parse` on long
histories, prompt assembly, parsing model output, HMAC, heavy dependencies.

So: cap history at ~10 recent messages plus a rolling summary.

**`ctx.waitUntil()` does not give more CPU.** It keeps the invocation alive after the
response is sent, on the *same* 10ms meter. Work inside `waitUntil` that is *waiting*
(Meta send, Supabase write) is free; work that is *computing* is not. Use it for
"reply first, log usage after" — not to move slow prompt assembly off the hot path.

We prefer `waitUntil` over Queues to save **Queue operations** (10k/day, our tightest
limit), not to save CPU.

Failure mode is nasty: it breaks only the longest conversations, and silently.

⚠️ DO CPU limits are not the same as the Worker's 10ms. Verify current DO free-tier
numbers before moving prompt assembly into the DO. Until verified, budget as 10ms.
