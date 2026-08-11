import { createServiceClient, removeMedia } from "@wa/shared";
import type { Env } from "./env.js";
import { ping, report } from "./monitor.js";

/**
 * A cron gets the same 10ms CPU as a request and **does not retry on failure**, so a
 * nightly job can fail silently for weeks. Everything here is I/O, and every job pings
 * the dead-man's-switch so a silent failure becomes an email.
 */

/** The DO holds the last 200 ids; this table only covers DOs the runtime evicted. */
const DEDUPE_RETENTION_DAYS = 30;

/** One inbound message is roughly one webhook plus four delivery receipts. */
const REQUESTS_PER_MESSAGE = 5;

/** free-tier.md: requests > 70k/day → Workers Paid. */
const DAILY_REQUEST_BUDGET = 70_000;

/**
 * free-tier.md: DB > 400MB → Supabase Pro. Rows, not bytes: PostgREST cannot report
 * table size, and the real figure needs the Supabase management API and a PAT we do
 * not hold. A message row is on the order of a kilobyte, so this is a rough proxy.
 */
const ROW_BUDGET = 400_000;

/** safety.md: delete message content within 24h of a flag; hard-delete rows at 12 months. */
const SCRUB_AFTER_HOURS = 24;
const RETENTION_MONTHS = 12;

/**
 * Attachments go long before the text does. Storage is 1GB for every client at once,
 * where the 500MB database is ~5 years of messages — so media is the budget that
 * actually runs out, and it is the one thing an owner rarely needs a year later.
 */
const MEDIA_RETENTION_DAYS = 30;

/**
 * free-tier.md: 1GB Storage. 800MB leaves room for a month of intake to land before
 * the next retention pass, so this fires with time to act rather than at the wall.
 */
export const STORAGE_ALARM_BYTES = 800 * 1024 * 1024;

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const job = JOBS[controller.cron];
  if (!job) {
    ctx.waitUntil(report(env, new Error(`no handler for cron "${controller.cron}"`), { job: "?" }));
    return;
  }

  ctx.waitUntil(run(env, job.slug, job.run));
}

async function run(env: Env, slug: string, work: (env: Env) => Promise<void>): Promise<void> {
  try {
    await work(env);
    await ping(env, slug, "success");
  } catch (error) {
    // Ping the failure rather than waiting for healthchecks.io to notice a missing
    // one: there is no retry, so the sooner this is a human's problem the better.
    await report(env, error, { job: slug });
    await ping(env, slug, "fail");
  }
}

/**
 * Counts what we are close to running out of and fails the heartbeat when a free-tier
 * upgrade trigger fires, so the alarm channel is the one we already have.
 *
 * Not covered: Supabase egress, the limit that actually kills every client at once. It
 * is only available from the management API. Watch it in the dashboard until then.
 */
async function usageCheck(env: Env): Promise<void> {
  const sb = createServiceClient(env);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // head: true returns the count in a header and no rows, which keeps a daily job off
  // the egress budget it exists to protect.
  const daily = await sb
    .from("messages")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since);
  if (daily.error) throw new Error(`daily message count failed: ${daily.error.message}`);

  const total = await sb.from("messages").select("id", { count: "exact", head: true });
  if (total.error) throw new Error(`total message count failed: ${total.error.message}`);

  // Metadata only, so the job that guards egress does not spend it.
  const stored = await sb.rpc("media_bytes");
  if (stored.error) throw new Error(`media bytes lookup failed: ${stored.error.message}`);

  const requests = (daily.count ?? 0) * REQUESTS_PER_MESSAGE;
  const rows = total.count ?? 0;
  const bytes = Number(stored.data ?? 0);

  const breaches: string[] = [];
  if (requests > DAILY_REQUEST_BUDGET) breaches.push(`~${requests} requests/day`);
  if (rows > ROW_BUDGET) breaches.push(`${rows} message rows`);
  if (bytes > STORAGE_ALARM_BYTES) {
    breaches.push(`${Math.round(bytes / (1024 * 1024))}MB of 1GB media storage`);
  }

  if (breaches.length > 0) {
    throw new Error(`free-tier upgrade trigger: ${breaches.join(", ")}`);
  }
}

/**
 * Cross-org by nature: this table has no conversation and no owner to scope to, and
 * sweeping it per org would cost one round trip per client.
 */
async function sweepDedupe(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - DEDUPE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await createServiceClient(env)
    .from("inbound_dedupe")
    .delete()
    .lt("seen_at", cutoff);
  if (error) throw new Error(`inbound_dedupe sweep failed: ${error.message}`);
}

/**
 * safety.md: a flagged conversation has ALL its message content scrubbed within 24h —
 * "delete the payload, keep the proof." The safety_flags row, wa_message_ids and
 * timestamps survive; body and media keys go. Conversation-scoped, not flagged-turn
 * scoped: a minor's PII can sit in any message, not just the flagged one.
 *
 * Cross-org by nature, like sweepDedupe: the flagged set comes from safety_flags,
 * which has no owner to scope to. Idempotent — the or(...) guard skips rows that are
 * already scrubbed or never had content, and an empty flagged set skips the update.
 */
async function scrubFlaggedContent(env: Env): Promise<void> {
  const sb = createServiceClient(env);
  const cutoff = new Date(Date.now() - SCRUB_AFTER_HOURS * 60 * 60 * 1000).toISOString();

  const flagged = await sb.from("safety_flags").select("conversation_id").lt("detected_at", cutoff);
  if (flagged.error) throw new Error(`flagged conversation lookup failed: ${flagged.error.message}`);

  const ids = flagged.data.map((row) => row.conversation_id);
  if (ids.length === 0) return;

  // Objects go before the rows that name them. The other order loses the paths on a
  // failure and leaves customer media stored with nothing left pointing at it —
  // undeletable in practice, and exactly what retention exists to prevent.
  const keys = await sb
    .from("messages")
    .select("media_key")
    .in("conversation_id", ids)
    .not("media_key", "is", null);
  if (keys.error) throw new Error(`flagged media lookup failed: ${keys.error.message}`);
  await removeMedia(env, keys.data.map((row) => row.media_key as string));

  const { error } = await sb
    .from("messages")
    .update({ body: null, media_key: null })
    .in("conversation_id", ids)
    .or("body.not.is.null,media_key.not.is.null");
  if (error) throw new Error(`flagged content scrub failed: ${error.message}`);
}

type Sb = ReturnType<typeof createServiceClient>;

interface Override {
  id: string;
  retention_months: number | null;
  media_retention_days: number | null;
}

/**
 * The clients who asked for something other than the platform default
 * (admin-panel.md §3). Normally none, and while it is none both sweeps below stay
 * exactly the single cross-org statement they have always been.
 */
async function retentionOverrides(sb: Sb): Promise<Override[]> {
  const { data, error } = await sb
    .from("organizations")
    .select("id,retention_months,media_retention_days")
    .or("retention_months.not.is.null,media_retention_days.not.is.null");
  if (error) throw new Error(`retention override lookup failed: ${error.message}`);
  return (data ?? []) as Override[];
}

/**
 * Either one overriding client, or everyone except the overriding clients. Never both:
 * the default pass excludes them and each override pass is one org.
 */
type Scope = { orgId: string; exclude?: never } | { exclude: string[]; orgId?: never };

/**
 * Narrows a query to that scope.
 *
 * `T` is deliberately unconstrained and the body casts. PostgREST's builder types are
 * generated per column set and per chained filter, and constraining a generic to them
 * makes the type checker recurse past its own depth limit (TS2589) — a compiler limit,
 * not a design signal.
 */
interface Narrowable {
  eq(column: string, value: string): unknown;
  not(column: string, operator: string, value: string): unknown;
}

function scoped<T>(query: T, scope: Scope): T {
  const q = query as Narrowable;
  if (scope.orgId) return q.eq("org_id", scope.orgId) as T;
  // PostgREST's `in` wants `(a,b,c)`.
  if (scope.exclude && scope.exclude.length > 0) {
    return q.not("org_id", "in", `(${scope.exclude.join(",")})`) as T;
  }
  return query;
}

function monthsAgo(months: number): string {
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff.toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * safety.md retention: auto-delete at 12 months. Full row delete — the scrub already
 * dropped flagged content, and safety_flags/audit_log outlive messages on their own
 * clocks. Cross-org like sweepDedupe: one DELETE beats one round trip per client.
 *
 * A client with its own `retention_months` is cut out of that DELETE and swept on its
 * own clock instead. One extra round trip per overriding client is the right price for
 * a control nobody else has to pay for.
 */
async function deleteExpired(env: Env): Promise<void> {
  const sb = createServiceClient(env);
  const overrides = (await retentionOverrides(sb)).filter((o) => o.retention_months !== null);

  await purge(env, sb, monthsAgo(RETENTION_MONTHS), { exclude: overrides.map((o) => o.id) });
  for (const org of overrides) {
    await purge(env, sb, monthsAgo(org.retention_months as number), { orgId: org.id });
  }
}

async function purge(env: Env, sb: Sb, cutoff: string, scope: Scope): Promise<void> {
  // Objects first, then the rows — same reason as the scrub above.
  const keys = await scoped(
    sb.from("messages").select("media_key").lt("created_at", cutoff).not("media_key", "is", null),
    scope,
  );
  if (keys.error) throw new Error(`expired media lookup failed: ${keys.error.message}`);
  await removeMedia(env, keys.data.map((row) => row.media_key as string));

  const { error } = await scoped(
    sb.from("messages").delete().lt("created_at", cutoff),
    scope,
  );
  if (error) throw new Error(`retention delete failed: ${error.message}`);
}

/**
 * Drops attachments at 30 days while their text stays the full 12 months. The message,
 * its timestamps and its caption survive — only the bytes go, because the bytes are the
 * only part that competes for a 1GB bucket shared by every client.
 *
 * Cross-org like the sweeps above, idempotent (the not-null guard skips rows whose
 * media has already gone), and per-client only for clients who overrode the default.
 */
async function scrubExpiredMedia(env: Env): Promise<void> {
  const sb = createServiceClient(env);
  const overrides = (await retentionOverrides(sb)).filter((o) => o.media_retention_days !== null);

  await dropMedia(env, sb, daysAgo(MEDIA_RETENTION_DAYS), { exclude: overrides.map((o) => o.id) });
  for (const org of overrides) {
    await dropMedia(env, sb, daysAgo(org.media_retention_days as number), { orgId: org.id });
  }
}

async function dropMedia(env: Env, sb: Sb, cutoff: string, scope: Scope): Promise<void> {
  const keys = await scoped(
    sb.from("messages").select("media_key").lt("created_at", cutoff).not("media_key", "is", null),
    scope,
  );
  if (keys.error) throw new Error(`expired media lookup failed: ${keys.error.message}`);
  if (keys.data.length === 0) return;

  // Objects first, then the rows — same reason as the scrub above.
  await removeMedia(env, keys.data.map((row) => row.media_key as string));

  const { error } = await scoped(
    sb
      .from("messages")
      .update({ media_key: null })
      .lt("created_at", cutoff)
      .not("media_key", "is", null),
    scope,
  );
  if (error) throw new Error(`media retention update failed: ${error.message}`);
}

async function retentionDelete(env: Env): Promise<void> {
  await scrubFlaggedContent(env);
  await scrubExpiredMedia(env);
  await deleteExpired(env);
}

/** Keyed by the exact expression in wrangler.jsonc. UTC; IST is +5:30. */
const JOBS: Record<string, { slug: string; run: (env: Env) => Promise<void> }> = {
  "0 20 * * *": { slug: "usage-check", run: usageCheck },
  "0 21 * * *": { slug: "retention-delete", run: retentionDelete },
  "0 22 * * 7": { slug: "dedupe-sweep", run: sweepDedupe },
};
