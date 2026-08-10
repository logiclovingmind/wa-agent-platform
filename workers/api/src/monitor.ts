import type { Env } from "./env.js";

/**
 * Sentry over plain fetch. The SDK is a dependency and per-invocation init CPU on a
 * 10ms budget and a 3MB bundle; this is one POST that only happens when something has
 * already gone wrong. No breadcrumbs, no tracing, no source maps — a stack string and
 * tags, which is what a 5k-errors/month free tier is for.
 *
 * Both functions swallow their own failures on purpose: monitoring must never be the
 * thing that takes the reply path down.
 */
export async function report(
  env: Env,
  error: unknown,
  tags: Record<string, string>,
): Promise<void> {
  if (!env.SENTRY_DSN) return;

  try {
    const dsn = new URL(env.SENTRY_DSN);
    const projectId = dsn.pathname.slice(1);
    const endpoint = `${dsn.protocol}//${dsn.host}/api/${projectId}/envelope/?sentry_key=${dsn.username}&sentry_version=7`;

    const err = error instanceof Error ? error : new Error(String(error));
    const eventId = crypto.randomUUID().replaceAll("-", "");
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "javascript",
      level: "error",
      server_name: "wa-agent-api",
      tags,
      exception: { values: [{ type: err.name, value: err.message }] },
      extra: { stack: err.stack ?? null },
    };

    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: `${JSON.stringify({ event_id: eventId })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`,
    });
  } catch {
    // Nothing sensible to do. Losing the report beats failing the request.
  }
}

/**
 * The dead-man's-switch. Every scheduled job pings on success and healthchecks.io
 * emails us when a ping does not arrive — the alarm has to live outside this account,
 * because a cron watching another cron dies with it.
 *
 * One secret holding the ping key, slug per job, so a new job is a string and not
 * another `wrangler secret put`. Requires slug URLs enabled on the healthchecks.io
 * project.
 */
export async function ping(env: Env, slug: string, outcome: "success" | "fail"): Promise<void> {
  if (!env.HEALTHCHECK_BASE) return;
  const suffix = outcome === "fail" ? "/fail" : "";
  try {
    await fetch(`${env.HEALTHCHECK_BASE}/${slug}${suffix}?create=1`, { method: "POST" });
  } catch {
    // A missed ping is itself the alarm, so there is nothing to escalate to here.
  }
}

/**
 * Wraps background work handed to `waitUntil`. A throw in there is invisible: it never
 * reaches Hono's error handler because the response has already been sent.
 */
export async function guard(
  env: Env,
  tags: Record<string, string>,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    await report(env, error, tags);
  }
}
