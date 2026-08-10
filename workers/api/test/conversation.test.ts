import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS, type InboundMessage } from "../src/do/conversation.js";
import { stubSupabase } from "./fake-supabase.js";

// Not broad coverage: the two things here that cost real money are a second reply to
// the same customer and the bot talking over a human.

const ORG = "11111111-1111-1111-1111-111111111111";

function inbound(waMessageId: string): InboundMessage {
  return {
    orgId: ORG,
    waAccountId: "22222222-2222-2222-2222-222222222222",
    customerWaId: "919876543210",
    waMessageId,
    type: "text",
    body: "hi",
    sentAt: Date.now(),
  };
}

function stub(name: string) {
  stubSupabase((call) =>
    call.table === "conversations" ? [{ id: "33333333-3333-3333-3333-333333333333" }] : [],
  );
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(name));
}

/**
 * `runDurableObjectAlarm` fires the alarm immediately, which is *before* the deadline
 * it was set for. The handler checks each deadline against the clock — it has to, with
 * two deadlines sharing one alarm slot — so the clock is what has to move.
 * Only `Date` is faked; faking timers would deadlock the RPC promises.
 */
async function fireAlarmAt(offsetMs: number, run: () => Promise<boolean>): Promise<boolean> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + offsetMs);
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("debounce", () => {
  it("collects a burst into one batch", async () => {
    const conv = stub("debounce-burst");
    await conv.onInbound(inbound("wamid.b1"));
    await conv.onInbound(inbound("wamid.b2"));
    await conv.onInbound(inbound("wamid.b3"));
    expect((await conv.getState()).pending).toBe(3);

    expect(await fireAlarmAt(DEBOUNCE_MS, () => runDurableObjectAlarm(conv))).toBe(true);
    const state = await conv.getState();
    expect(state.lastBatchSize).toBe(3);
    expect(state.pending).toBe(0);
  });

  it("does not fire twice for one batch", async () => {
    const conv = stub("debounce-once");
    await conv.onInbound(inbound("wamid.o1"));
    expect(await fireAlarmAt(DEBOUNCE_MS, () => runDurableObjectAlarm(conv))).toBe(true);
    expect(await runDurableObjectAlarm(conv)).toBe(false);
  });
});

describe("handoff", () => {
  it("locks the bot out while a human holds the conversation", async () => {
    const conv = stub("handoff-lock");
    await conv.takeOver();
    expect((await conv.getState()).canBotReply).toBe(false);

    await conv.onInbound(inbound("wamid.h1"));
    await fireAlarmAt(DEBOUNCE_MS, () => runDurableObjectAlarm(conv));
    // The batch is still drained — the customer's message is persisted, the bot just
    // does not answer it.
    expect((await conv.getState()).pending).toBe(0);
    expect((await conv.getState()).canBotReply).toBe(false);
  });

  it("returns to the bot on the next customer message after release", async () => {
    const conv = stub("handoff-return");
    await conv.takeOver();
    await conv.release();
    expect((await conv.getState()).handoff).toBe("returned");

    await conv.onInbound(inbound("wamid.h2"));
    expect((await conv.getState()).handoff).toBe("bot");
  });

  it("keeps the human's alarm from being eaten by the debounce alarm", async () => {
    const conv = stub("handoff-alarm");
    await conv.takeOver();
    await conv.onInbound(inbound("wamid.h3"));

    // The debounce deadline is sooner, so it fires first — and the handoff timer must
    // survive it. One alarm slot, two deadlines.
    expect(await fireAlarmAt(DEBOUNCE_MS, () => runDurableObjectAlarm(conv))).toBe(true);
    expect((await conv.getState()).handoff).toBe("human");
  });
});

describe("outbound idempotency", () => {
  it("claims a reply exactly once", async () => {
    const conv = stub("claim");
    expect(await conv.claimReply("wamid.c1")).toBe(true);
    expect(await conv.claimReply("wamid.c1")).toBe(false);
    expect(await conv.claimReply("wamid.c2")).toBe(true);
  });
});

describe("erase", () => {
  const CONV = "33333333-3333-3333-3333-333333333333";
  const ACC = "22222222-2222-2222-2222-222222222222";
  const CUST = "919876543210";

  async function erased(name: string) {
    const conv = env.CONVERSATION.get(env.CONVERSATION.idFromName(name));
    await conv.attach({ orgId: ORG, waAccountId: ACC, customerWaId: CUST, conversationId: CONV });
    return conv;
  }

  it("erases an unflagged conversation completely", async () => {
    const calls = stubSupabase((call) =>
      call.table === "conversations" ? [{ id: CONV }] : [],
    );
    const conv = await erased("erase-unflagged");
    await conv.erase();

    const delTables = calls.filter((c) => c.method === "DELETE").map((c) => c.table);
    expect(delTables).toEqual(expect.arrayContaining(["usage_events", "messages", "conversations"]));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("keeps the safety proof when erasing a flagged conversation", async () => {
    const calls = stubSupabase((call) => {
      if (call.table === "conversations") return [{ id: CONV }];
      if (call.table === "safety_flags") return [{ id: "sf-1" }];
      if (call.table === "messages" && call.method === "GET") return [{ wa_message_id: "wamid.f1" }];
      return [];
    });
    const conv = await erased("erase-flagged");
    await conv.erase();

    // Content is scrubbed, not deleted.
    const scrub = calls.find((c) => c.method === "PATCH");
    expect(scrub?.table).toBe("messages");
    expect(scrub?.body).toEqual({ body: null, media_r2_key: null });
    expect(calls.some((c) => c.method === "DELETE" && c.table === "conversations")).toBe(false);
    // The customer's dedupe identifiers still go.
    const dedupe = calls.find((c) => c.method === "DELETE" && c.table === "inbound_dedupe");
    expect(dedupe?.url.searchParams.get("wa_message_id")).toContain("wamid.f1");
  });
});
