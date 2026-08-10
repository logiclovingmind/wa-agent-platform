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

    expect(calls).toHaveLength(2);
    // head requests: the count comes back in a header, so a daily job costs no egress.
    expect(calls.every((c) => c.method === "HEAD" && c.table === "messages")).toBe(true);
    expect(calls.some((c) => c.url.searchParams.get("created_at")?.startsWith("gte."))).toBe(true);
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

  it("does nothing for a cron with no handler", async () => {
    const calls = stub();
    await fire("0 5 * * *");
    expect(calls).toEqual([]);
  });
});
