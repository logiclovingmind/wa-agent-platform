# The admin panel — plan

Written 2026-08-11 (session 18) as a plan only. Nothing here is built yet except what
§0 lists as already shipped. Read this before starting admin-panel work; it carries the
decisions and the traps, not just a feature list.

The panel is **our internal management screen**, not a sales prop. It is reached by
`logiclovingmind@gmail.com`, which belongs to no org and therefore cannot read any
client's messages — see §5, that limit is deliberate and should survive every feature
below.

---

## 0. What exists today

- `Admin.tsx`, read-only: client table (spend this month, replies, conversations,
  waiting, open flags, last message), platform LLM wallet with runway, demo badge.
- `public.admin_orgs()` — security definer, guarded on `users.is_platform_admin`,
  aggregates in SQL to protect the 5GB egress budget.
- `GET /api/usage/balance` — Worker, platform-admin gated, proxies the aicredits wallet.
- Three separated logins (session 18). Admin has no `org_members` row.

**Session 19 built step 1 of §7 — read-only health.** Local only; not yet migrated or
deployed live.

- `public.admin_health()` (migration `0014`) — the "our own data" half of §2: last
  inbound / outbound / **rejected send**, open 24h windows, when the longest wait
  started, open flags by kind, media bytes per org.
- `GET /api/admin/health/:orgId` — the Meta half: `debug_token`, `subscribed_apps`,
  quality rating + messaging limit, re-engagement template status. One org per request,
  fetched only when a row is opened.
- `GET /api/admin/platform` — media bucket against the cron's own 800MB alarm.
- `dashboard/src/lib/health.ts` — the traffic light from §2, in one function.
- ⚠️ **`authenticate()` used to 401 the admin.** It resolved the org from `org_members`
  and gave up when there was none, which is the admin's defining property — so
  `/api/usage/balance` had been failing for the only account allowed to call it, silently,
  because the wallet card renders "unavailable" either way. `Caller` is now a union of
  `member` and `platform_admin`.

**Session 20 built step 2 of §7 — runtime controls.** Local only; not yet migrated or
deployed live.

- Migration `0015`: seven columns on `organizations` (`ai_paused`, `cap_micros`,
  `retention_months`, `media_retention_days`, `hours_open_ist`, `hours_close_ist`,
  `out_of_hours`), all added to `admin_health()`'s return type.
- `audit_log.org_id` is now nullable — the §1 correction below, closed in the same
  migration as the first admin write, because an org-less admin action must still be
  auditable.
- `public.org_month_spend(org_id)` — invoker, not definer, and read only when the org
  actually has a cap. Deliberately not a denormalized counter: a counter would be a
  second source of truth for a number `admin_orgs()` already computes live.
- The DO reads all seven off the org row `#promptContext()` already fetches, so pause
  and hours cost **zero** extra round trips, and it returns early on a hold so a paused
  client never pays for the KB and history reads.
- The retention sweep stays one cross-org statement when nobody overrides; overriding
  orgs get one extra pass each. Both shapes are tested.
- `PATCH /api/admin/orgs/:orgId/controls` and `PATCH /api/admin/wa-accounts/:id/template`
  — allowlisted keys, validated values, both audited.
- Every control **fails open**: a missing org row, a failed meter read, or a malformed
  time all fall through to today's behaviour. The controls must never be the reason a
  client goes silent.
- ⚠️ **The per-org webhook rate limit in §3 cannot be built.** Cloudflare's rate-limit
  binding is fixed in `wrangler.jsonc` at deploy time, so a per-client value would mean a
  deploy per client — the one thing CLAUDE.md forbids. The panel says so on screen rather
  than leaving a silent gap.

**Session 20 also built step 3 of §7 — flag queue, audit viewer, access management.**
Local only; not yet migrated or deployed live.

- Migration `0016`: `safety_flags.resolved_by` and `.resolution_note` — `resolved_at`
  alone records that somebody closed a distress flag without recording who or why, which
  is useless in the one situation these rows exist for.
- `public.admin_flags()` — definer, guarded, capped at 200. Six columns and the absence
  of a seventh is the point: kind, client, time, conversation id. No body, ever.
  ⚠️ Its guard has to say `users.id`, not `id`: the function returns a column called
  `id`, and a plpgsql `returns table` name shadows an unqualified column reference.
- No RPC for the audit viewer or the user lists. `audit_log`'s policy is
  `is_platform_admin()` and both `users` and `org_members` already carry
  `or app.is_platform_admin()` — the browser reads all three straight from PostgREST.
- Worker writes, all audited: resolve a flag (note required), add a login, change a role,
  remove a login, issue a reset link, grant/revoke platform admin by email.
- **No password is ever chosen, sent or stored.** There is no SMTP, so GoTrue's
  `generate_link` returns a one-time link, the panel shows it once, and the admin passes
  it on. The link never reaches `audit_log` — an audit row holding a working credential
  is a second copy of that credential with a longer retention.
- Two refusals worth keeping: an org cannot be left with no owner, and an admin cannot
  revoke their own flag (there would be nobody left to undo it).
- `dashboard/src/AdminGovernance.tsx` holds all of it, out of `Admin.tsx`, which is the
  all-clients table and nothing else.

**Session 20 also built step 4 of §7 — onboarding and offboarding.** Local only; not yet
migrated or deployed live.

- `encryptSecret()` and `currentKeyVersion()` in `workers/api/src/crypto.ts`. Until now
  the Worker could only ever *decrypt*, and a new client's token was sealed by hand with
  `scripts/rotate-key.ts`. New secrets go under the highest `MASTER_KEY_V*` that is set,
  so a client onboarded halfway through a rotation is not a row the rotation has already
  passed over.
- `POST /api/admin/orgs` — one request creates the org, the sealed `wa_accounts` row, a
  128-bit random `webhook_slug`, the owner's login and the audit row. The response
  carries the webhook URL to paste into Meta and the owner's one-time link, once.
- **Two failures, handled differently on purpose.** A failed `wa_accounts` insert rolls
  the organization back — a client that can receive nothing should not appear on the
  all-clients table. A failed Meta app subscription does *not* roll anything back: the
  org is real and correct, and §2's health screen already reports an unsubscribed WABA
  as a fault. Losing an encrypted token to a Meta outage is the worse trade.
- `POST .../test-message` sends Meta's `hello_world` template, not free text: a number
  that has never messaged the client has no open 24-hour window, so a free-form send
  would fail for a reason unrelated to the setup. Meta's refusal comes back verbatim at
  502, because that refusal *is* the diagnosis.
- **Export, then erase, then delete — enforced, not documented.** `DELETE /api/admin/orgs/:orgId`
  refuses with 409 until an `org_exported` audit row exists for that client, and refuses
  with 400 unless the client's name is typed exactly. A DPDP erasure that ran before the
  client had their data cannot be apologised away.
- Two things no cascade reaches, both done by hand in that route: Storage objects
  (`listMedia`/`removeMedia`) and the `auth.users` rows behind `public.users`, which
  would otherwise survive and still be able to sign in. The offboard audit row is written
  with `org_id: null` — written against the org, the cascade it records would delete it.
- `dashboard/src/AdminOnboard.tsx`. The token and app secret are `type="password"` with
  `autoComplete="new-password"`, and the form is cleared the moment the Worker has them.
  Nothing reads them back: `wa_accounts` denies select to every browser login.

**Session 20 also built step 5 of §7 — the `app.` / `admin.` split (§9).** The code half
only; the DNS and Pages halves are by hand and are listed below.

- `DASHBOARD_ORIGIN` is now comma-separated and `cors` takes the list. The pages.dev
  origin stays in it: it is what the deploy prints, and it still answers while DNS moves.
- ⚠️ **`allowMethods` was missing `PATCH` and `DELETE`** — a real bug, not a §9 cost.
  Steps 3 and 4 added routes on both, and every one of them would have failed at the
  preflight against the live origin while working perfectly in `wrangler dev`. Fixed, and
  a test now walks both hostnames against both methods.
- `shellFor(location.hostname)` in `App.tsx`. `admin.` renders the platform console,
  `app.` renders the client shell, anything else (localhost, pages.dev) keeps deciding by
  role. Signing in at the wrong one gives the other hostname as a link, not an empty
  screen.
- **Still to do by hand, in this order:** two CNAMEs on Hostinger (`app`, `admin` →
  `wa-agent-dashboard.pages.dev`, apex untouched), then both as custom domains on the
  existing Pages project — `wrangler` has no `pages domain` command, so that is the
  Cloudflare dashboard — then `pnpm deploy:api` to ship the widened origin list.

All five steps of §7 are built locally. Nothing is committed, migrated or deployed.

---

## 1. The one architectural constraint that shapes all of it

**The admin has no RLS path to client data.** Client tables are gated on
`app.is_member(org_id)` and the admin is a member of nothing. So an admin screen cannot
read or write client rows through PostgREST the way the inbox does. Two mechanisms are
available, and picking the wrong one is the main way this work goes bad:

| Need | Use | Why |
|---|---|---|
| Cross-org **reads**, aggregates, counts | `security definer` RPC with the `is_platform_admin` guard as the first statement | No Worker CPU, no egress — Postgres counts on Supabase's dime |
| Any **write**, anything touching a secret, anything calling Meta | Worker `/api/admin/*` with `service_role` | Secrets never reach the browser (invariant 6); writes get audited in one place |

Every new definer function repeats the guard. Every admin write appends to `audit_log`
with `actor_user_id`. No exceptions — an admin panel with unaudited writes is worse than
no admin panel, because it launders actions that later need explaining to a client.

Two corrections to the table above, found when the first of these was built:

- **`audit_log` is the exception.** Its policy is `app.is_platform_admin()`, not
  `app.is_member(org_id)` (`0001_init.sql:363`), so the admin reads it directly and the
  §5 viewer needs no definer RPC. The flip side is that a client's *owner* cannot read
  their own audit log — deliberate or not, it is what the policy says today.
- **`audit_log.org_id` is `not null` with an FK to `organizations`.** Any admin action
  that belongs to no org — granting `is_platform_admin` by email (§6), or anything that
  happens before the org row exists (§4 step 1) — **cannot be audited as written**. Make
  the column nullable in the same migration as the first admin write, or "no exceptions"
  above is already false.

**CPU budget still applies** (10ms). Health checks that call Meta are I/O and free; doing
21 clients in one request means 21 sequential fetches and a slow screen. Poll per-client
on demand, or write a `client_health` table from a cron. Cron budget: **5 triggers, 3
used, 2 left** — a health poll would spend one of them.

---

## 2. Client health

Per client, one row that answers "is this working, and if not, whose fault is it".

**From Meta (Worker, needs the org's decrypted token):**
- Token still valid + expiry (`debug_token`). A permanent token reads `expires_at: 0`.
- App subscribed to the WABA (`/{waba-id}/subscribed_apps`). An onboarding that never
  got subscribed looks exactly like a quiet client — this is the single most valuable
  check on the screen.
- Phone number **quality rating** and **messaging limit**. Meta throttles silently; the
  client experiences it as "the bot stopped replying to new people".
- Re-engagement template approval status per WABA.

**From our own data (definer RPC):**
- Last inbound, last outbound, last failed send.
- Conversations with an open 24h window; conversations waiting on a human, oldest first.
- Open safety flags by kind.
- Spend this month vs the org's cap (§3).
- Media bytes for the org.

**Platform-wide:**
- Wallet balance + runway (exists).
- Supabase egress against 5GB, media bucket against the 800MB alarm (`media_bytes()`).
- Backup: last successful run, last restore test.
- Healthchecks.io status for all four checks.
- Deployed Worker version, last migration applied.

Traffic-light per client, computed in one place, with the rule written down: red = not
replying (token dead, unsubscribed, wallet empty, cap hit); amber = degraded (quality
rating low, flags open, someone waiting > 30 min); green = otherwise.

---

## 3. Runtime controls per client

These need schema. Ask before adding columns (CLAUDE.md §7), expand-contract only.

- **Pause / resume the AI** — `organizations.ai_paused`. The DO must read it before
  calling the LLM and hand off instead. This is the kill switch for "the bot said
  something wrong, stop it now" and is the single most important control here.
- **Monthly spend cap** — `organizations.cap_micros`, plus an alert threshold. On exceed:
  hand off to a human rather than reply. Protects the shared wallet from one client
  (§8), and is the answer to per-client billing control.
- **Retention override** — currently 12 months text / 30 days media, platform-wide.
- **Business hours + out-of-hours behaviour** — reply, or hand off with a message.
- **System prompt and KB documents** — `kb_documents` exists; RAG retrieval is off by
  design (CLAUDE.md invariant 13), so this is prompt content, not a vector store.
- **Re-engagement template config** — columns exist on `wa_accounts` from migration 0005.
- **Per-org rate limit override** — the limiter is at the webhook, per org.

Every one of these is a row edit. None of them is a deploy. If a control here starts
needing a code change per client, the design is wrong.

---

## 4. Onboarding and lifecycle — the highest-risk part

Today onboarding is a manual encrypt plus an INSERT. To do it from the panel:

1. Create org (name, sector).
2. Create `wa_account`: phone_number_id, waba_id, display number, **webhook_slug
   generated randomly** — the slug *is* the per-client secret.
3. **Encrypt the Meta token and app secret.** This needs a new Worker endpoint, because
   `MASTER_KEY_V1` is a write-only wrangler secret and the browser cannot have it.
   `crypto.ts` currently only decrypts; `scripts/rotate-key.ts` is the only thing that
   can produce ciphertext and it runs offline.
   **This is the most dangerous new surface in the whole plan** — an admin-gated endpoint
   that turns plaintext secrets into stored ciphertext. Admin-gated, audited, no echo of
   the plaintext in any response or log.
4. Call Meta to subscribe the app to the WABA.
5. Create the client's owner login (GoTrue admin API from the Worker with `service_role`)
   and show the credentials once.
6. Show the webhook URL to paste into Meta, then a **"send a test message"** button that
   proves the whole path end to end before the client ever touches it.

Also: suspend (pause + keep data), and offboard (export, then erase, then delete —
audited, and in that order).

⚠️ Onboarding must stay "an INSERT, not a deploy". The panel is allowed to make the
INSERT convenient. It is not allowed to become a reason to touch the repo per client.

---

## 5. Safety, compliance, and the limit worth keeping

- Open safety-flag queue across every client, with resolve + note.
- Audit log viewer, filterable by org and actor.
- DPDP export / erase on a client's written request, audited.

**The admin sees flag counts and kinds, never message content.** That is why the admin
holds no membership. If a real incident needs the words, it goes through the client's own
owner account. Resist the "just let admin peek" feature — the moment it exists, the claim
"we cannot read your customers' conversations" stops being true, and that claim is worth
more than the convenience.

---

## 6. Access management

- Users per org: add staff, change role, remove, reset password.
- Grant / revoke `is_platform_admin` (by email, deliberately never seeded — see the note
  at the bottom of `scripts/demo-seed.sql`).

---

## 7. Suggested build order

1. **Read-only health + platform ops** (§2). Definer RPCs plus one Worker endpoint for
   the Meta calls. No new writes, no new secrets — lowest risk, highest daily value.
2. **Runtime controls** (§3), starting with `ai_paused` and the spend cap. Schema, DO
   read, admin writes, audit.
3. **Access management + audit viewer** (§5, §6).
4. **Onboarding wizard** (§4) last, because of the encrypt endpoint. Rehearse against
   local PG17 and a throwaway org before it touches live.
5. **Domain split** (§9) — independent of all of the above, can slot in anywhere.

---

## 8. Decision: one LLM key for all clients, or one per client

**Recommendation: keep the single platform wallet. Do not issue a key per client.**

The instinct is right — you want to know what each client costs and stop one that
overruns. But the API key is not the meter, and on this provider it probably cannot be:

- **`usage_events` already is the meter.** Every reply writes a row with `org_id`,
  token counts and `cost_micros` snapshotted at the aicredits INR rate at the time. That
  is per-client, per-day, per-conversation, and it is more precise than any provider
  dashboard. The demo already carries 1,955 rows and reports ₹6.84 all-time.
- **aicredits bills one wallet per account.** `/api/v1/credits` returns a single
  `credits_inr` for the account, so extra keys almost certainly draw on the same balance
  and would separate nothing. ⚠️ *Verify this before acting on it* — if they do support
  sub-accounts with independent balances, revisit.
- **A per-client key means the client opens an aicredits account** and gives us the key.
  That means asking a salon owner to sign up for an AI aggregator (with a payment
  method), and it makes us custodian of their credential — more encryption, more
  rotation, more liability, for something `usage_events` already answers.

What to build instead, which gives the control you actually want:
- **Per-org monthly cap + alert** (§3). This is the real protection: one client cannot
  drain the shared wallet, because it stops at its own ceiling and hands off to a human.
- **Per-client spend on the panel**, already there, billed from `usage_events`.
- Keep the **wallet + runway** card platform-only. One wallet funds everyone, so a client
  owner seeing it would be reading our books.

The genuine risk of one wallet: **at zero, every client stops replying at once.** That is
what the runway card and the balance alert are for, and it is an argument for keeping a
buffer, not for per-client keys.

Leave the door open: an `organizations.llm_key_ciphertext` column defaulting to the
platform key would let one large client bring their own billing relationship later. Not
worth building until a client asks.

---

## 9. Decision: `app.` for clients, `admin.` for us

**Yes, both are possible, and it is worth doing.**

- DNS: `logiclovingmind.com` is on **Hostinger** nameservers (`*.dns-parking.com`) with
  the apex A record on **Vercel** (`76.76.21.21`) — that is the company website. Two
  CNAMEs, `app` and `admin`, both pointing at `wa-agent-dashboard.pages.dev`, leave the
  apex completely untouched.
- Cloudflare: add both as custom domains on the existing Pages project. **`wrangler` has
  no `pages domain` command**, so this is the Cloudflare dashboard or the REST API.

**One Pages project, one bundle, two hostnames.** Not two projects: a second build
pipeline buys nothing, since both would ship the same anon key and the same RLS.

Make the hostname mean something rather than serving identical code at both:
- `admin.` renders the admin shell only. A client owner landing there is told to use
  `app.` rather than being shown an inbox.
- `app.` renders the client shell only. Clients never see an admin URL, and there is no
  admin tab to notice.

⚠️ **This is UX, not a security boundary.** The boundary is RLS and the missing
`org_members` row. Anyone can edit a hostname; nobody can edit their way past Postgres.
Do not let the two subdomains become an excuse to relax anything in §1 or §5.

Cost: `DASHBOARD_ORIGIN` allowed exactly one origin, so it has to accept both (Hono's
`cors` takes an array). Change it in the same deploy as the domains, or takeover, erase
and export start failing CORS while the inbox keeps loading — which reads as three broken
features rather than one wrong string. **Done in code (§0); the deploy is still pending.**
