import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../src/do/conversation.js";
import { stubSupabase, type RestCall } from "./fake-supabase.js";

// Test 1, DO layer. The Postgres half lives in tests/db/dedupe.test.ts.

const ORG = "11111111-1111-1111-1111-111111111111";
const CONVERSATION = "33333333-3333-3333-3333-333333333333";

const msg: InboundMessage = {
  orgId: ORG,
  waAccountId: "22222222-2222-2222-2222-222222222222",
  customerWaId: "919876543210",
  waMessageId: "wamid.DUPLICATE",
  type: "text",
  body: "hi",
  sentAt: Date.UTC(2026, 2, 1, 4, 20),
};

function ok(call: RestCall): unknown {
  return call.table === "conversations" ? [{ id: CONVERSATION }] : [];
}

afterEach(() => vi.unstubAllGlobals());

describe("inbound dedupe", () => {
  it("accepts once and drops the repeat without touching Postgres", async () => {
    const calls = stubSupabase(ok);
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName("dupe"));

    expect(await stub.onInbound(msg)).toBe("accepted");
    expect(calls.map((c) => `${c.method} ${c.table}`)).toEqual([
      "POST conversations",
      "POST messages",
      "POST inbound_dedupe",
    ]);

    calls.length = 0;
    expect(await stub.onInbound(msg)).toBe("duplicate");
    expect(calls).toEqual([]);
  });

  it("keeps a different message id flowing", async () => {
    const calls = stubSupabase(ok);
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName("dupe-2"));

    expect(await stub.onInbound(msg)).toBe("accepted");
    expect(await stub.onInbound({ ...msg, waMessageId: "wamid.SECOND" })).toBe("accepted");

    const inserted = calls
      .filter((c) => c.table === "messages")
      .flatMap((c) => c.body as Array<{ wa_message_id: string }>)
      .map((row) => row.wa_message_id);
    expect(inserted).toEqual(["wamid.DUPLICATE", "wamid.SECOND"]);
  });

  it("stamps org_id on every write and never sends a bare insert", async () => {
    const calls = stubSupabase(ok);
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName("dupe-3"));
    await stub.onInbound(msg);

    for (const call of calls) {
      const rows = call.body as Array<Record<string, unknown>>;
      expect(rows.every((row) => row["org_id"] === ORG)).toBe(true);
    }
  });
});
