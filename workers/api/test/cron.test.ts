import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { stubSupabase, type RestCall } from "./fake-supabase.js";

/**
 * The failure mode this guards against: a cron expression in wrangler.jsonc with no
 * matching key in cron.ts fires forever and does nothing, and a cron does not retry,
 * so nothing ever surfaces it.
 */
async function fire(cron: string): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(
    { cron, scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

function stub(): RestCall[] {
  return stubSupabase(() => []);
}

afterEach(() => vi.unstubAllGlobals());

describe("scheduled", () => {
  it("sweeps inbound_dedupe on the weekly trigger", async () => {
    const calls = stub();
    await fire("0 22 * * 7");

    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.table).toBe("inbound_dedupe");
    expect(del?.url.searchParams.get("seen_at")).toMatch(/^lt\.\d{4}-/);
  });

  it("counts without pulling rows on the daily trigger", async () => {
    const calls = stub();
    await fire("0 20 * * *");

    // head requests: the count comes back in a header, so a daily job costs no egress.
    const counts = calls.filter((c) => c.method === "HEAD");
    expect(counts).toHaveLength(2);
    expect(counts.every((c) => c.table === "messages")).toBe(true);
    expect(counts.some((c) => c.url.searchParams.get("created_at")?.startsWith("gte."))).toBe(true);

    // Storage has no count to HEAD, so the 1GB check is an rpc that sums metadata.
    expect(calls.filter((c) => c.table === "rpc/media_bytes")).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("scrubs flagged content and deletes expired rows on the retention trigger", async () => {
    const flaggedId = "11111111-1111-1111-1111-111111111111";
    const calls = stubSupabase((call) =>
      call.method === "GET" && call.table === "safety_flags"
        ? [{ conversation_id: flaggedId }]
        : [],
    );
    await fire("0 21 * * *");

    const scrub = calls.find((c) => c.method === "PATCH");
    expect(scrub?.table).toBe("messages");
    expect(scrub?.body).toEqual({ body: null, media_key: null });
    expect(scrub?.url.searchParams.get("conversation_id")).toContain(flaggedId);

    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.table).toBe("messages");
    expect(del?.url.searchParams.get("created_at")).toMatch(/^lt\.\d{4}-/);
  });

  it("skips the scrub when nothing is flagged on the retention trigger", async () => {
    const calls = stub();
    await fire("0 21 * * *");

    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(calls.some((c) => c.method === "DELETE" && c.table === "messages")).toBe(true);
  });

  // The columns from migration 0015 are worse than useless if the sweep ignores them:
  // the panel would promise a client 24 months and the cron would still delete at 12.
  it("sweeps an overriding client on its own clock", async () => {
    const slow = "22222222-2222-2222-2222-222222222222";
    const calls = stubSupabase((call) =>
      call.method === "GET" && call.table.startsWith("organizations")
        ? [{ id: slow, retention_months: 24, media_retention_days: null }]
        : [],
    );
    await fire("0 21 * * *");

    const deletes = calls.filter((c) => c.method === "DELETE" && c.table === "messages");
    expect(deletes).toHaveLength(2);

    // The default pass must leave the overriding client alone, or the override is a lie.
    const [dflt, own] = deletes;
    expect(dflt?.url.searchParams.get("org_id")).toBe(`not.in.(${slow})`);
    expect(own?.url.searchParams.get("org_id")).toBe(`eq.${slow}`);

    // 24 months, not 12: the two cutoffs must differ or the override changed nothing.
    expect(own?.url.searchParams.get("created_at")).not.toBe(
      dflt?.url.searchParams.get("created_at"),
    );
  });

  it("stays one cross-org statement when nobody has an override", async () => {
    const calls = stub();
    await fire("0 21 * * *");

    const deletes = calls.filter((c) => c.method === "DELETE" && c.table === "messages");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url.searchParams.get("org_id")).toBe(null);
  });

  it("does nothing for a cron with no handler", async () => {
    const calls = stub();
    await fire("0 5 * * *");
    expect(calls).toEqual([]);
  });
});
