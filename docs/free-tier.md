# Free-tier discipline

| Resource | Limit | How it breaks |
|---|---|---|
| Worker requests | 100k/day | Status webhooks are 4–5× per message |
| Worker CPU | 10ms/invocation | Silent, partial, hits longest conversations |
| Durable Objects | own request/duration/storage limits | **Verify current numbers before relying on them.** DO requests are additional to Worker requests |
| Queues | 10k ops/day | ⚠️ Free-tier retention is **24h**, not 14 days |
| Supabase DB | 500MB | ~5 years at expected volume |
| **Supabase egress** | **5GB/mo** | **402 on everything — all clients dead at once** |
| Supabase Realtime | concurrent connections + monthly messages | One leaked subscription per open tab burns this |
| Supabase project | pauses after ~7 days inactivity | Bites in the pre-client gap, not production |
| **Supabase Storage** | **1GB, and reads come out of the same 5GB egress** | Media shares the budget the dashboard is already spending. R2 is the right home and is not usable — enabling it needs a payment method this account does not have |

**Media retention is 30 days, not the 12 months text gets.** 1GB is shared by every
client at once, and one 16MB video costs as much of it as a hundred photos — so video
is rejected at the webhook and never fetched, and attachments are dropped at 30 days
while their captions and timestamps stay the full 12 months. The daily usage cron
alarms at 800MB via the `media_bytes()` function, since nothing else we hold reports
bucket size.
| Cloudflare Pages | build minutes | Only matters if CI rebuilds on every push |
| GitHub Actions | free minutes on private repos | The backup job is small but not free forever |
| Subrequests | 50/request | Each `fetch` counts; a fan-out loop hits this fast |
| Worker size | 3MB gzipped | Another reason for no heavy dependencies |

Queues only for embeddings and follow-ups. The main reply path uses `ctx.waitUntil()`.
The 24h Queue retention matters: a consumer that breaks Friday night loses its backlog
before Monday.

## Cron triggers — verified 10 Aug 2026

| | Free | Paid |
|---|---|---|
| Triggers **per account** | 5 | 250 |
| **CPU per trigger** | **10 ms** | 30s (<1h interval), 15min (≥1h) |
| Minimum interval | 1 minute | 1 minute |
| Retry on failure | **none** | none |

- The 5 is **per account**, not per Worker. It covers everything we ever run.
- A scheduled Worker gets the **same 10ms CPU** as an HTTP request. Cron is not a place
  to do slow work.
- **A failed cron does not retry.** Nothing happens until the next fire — a nightly job
  can fail silently for weeks.
- ⚠️ **Cloudflare's day-of-week is 1-7, not 0-6.** `0` is rejected at deploy time with
  "invalid cron string", so Sunday is `7`. healthchecks.io uses the ordinary `0`, so the
  same weekly job is `0 22 * * 7` in `wrangler.jsonc` and `0 22 * * 0` on the monitor.
  They look inconsistent and are not.

Budget (3 used, 2 spare):

```
1. daily usage check + heartbeat ping        0 20 * * *   (01:30 IST)
2. retention auto-delete, batched            0 21 * * *   (02:30 IST)
3. weekly inbound_dedupe sweep               0 22 * * 0   (03:30 IST Mon)
```

Handoff auto-return is a DO alarm, not a cron. The backup runs on GitHub Actions and
consumes no trigger.

## Graceful degradation

If Supabase returns 402 or errors, **do not drop inbound messages.** Buffer writes into
the DO and keep accepting. Degraded beats dead across 15 clients.

## Monitoring

- Cloudflare Workers observability: on from day one.
- Sentry free tier (5k errors/month): before client 1.
- ⚠️ **External dead-man's-switch.** "No success ping = alarm" cannot be implemented by
  another cron on the same account — if the account has a problem both die quietly. Use
  healthchecks.io or cronitor (free): every cron and the backup job pings a URL on
  success, and *they* email us when a ping doesn't arrive. Five minutes of setup; the
  only external observer we have.
- **Per-client rate limiting** in the DO, so one client's runaway integration can't burn
  the shared quota and take down the other fourteen.

## Upgrade triggers — signals, not dates

```
egress > 3GB by day 20 of the month  → Supabase Pro
egress > 4GB/mo                      → Supabase Pro
DB > 400MB                           → Supabase Pro
requests > 70k/day                   → Workers Paid
client #12 signed                    → both, pre-emptively
first 402 or CPU error               → too late; post-mortem, not a trigger
```
