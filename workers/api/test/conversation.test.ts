import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS, type InboundMessage } from "../src/do/conversation.js";
import { stubSupabase, storedMedia } from "./fake-supabase.js";
import { encryptUnderMasterKey } from "./fixtures.js";

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

// Media is customer PII that outlives the row unless it is deleted deliberately, and
// Meta's URL is gone in ~5 minutes, so a failure here is unrecoverable rather than
// retryable. That is what makes these worth testing.
describe("inbound media", () => {
  const CONV = "33333333-3333-3333-3333-333333333333";

  async function account() {
    const token = await encryptUnderMasterKey("meta-token");
    return {
      id: "22222222-2222-2222-2222-222222222222",
      phone_number_id: "PN1",
      token_ciphertext: token.ciphertext,
      token_iv: token.iv,
      token_key_version: 1,
    };
  }

  function imageMessage(waMessageId: string): InboundMessage {
    return { ...inbound(waMessageId), type: "image", body: "look at this", mediaId: "MEDIA1" };
  }

  async function harness(outbound: (req: Request, url: URL) => Response) {
    const acc = await account();
    const calls = stubSupabase((call) => {
      if (call.table === "conversations") return [{ id: CONV }];
      if (call.table.startsWith("wa_accounts")) return [acc];
      return [];
    }, outbound);
    return calls;
  }

  it("copies media to Storage and stores the path on the message", async () => {
    const calls = await harness((req, url) => {
      // Hop 1: the id resolves to a short-lived CDN URL.
      if (url.pathname.endsWith("/MEDIA1")) {
        return Response.json({ url: "https://lookaside.test/blob", mime_type: "image/jpeg" });
      }
      // Hop 2: the bytes, still behind the bearer token.
      expect(req.headers.get("authorization")).toBe("Bearer meta-token");
      return new Response("JPEGBYTES");
    });

    const conv = env.CONVERSATION.get(env.CONVERSATION.idFromName("media-ok"));
    expect(await conv.onInbound(imageMessage("wamid.m1"))).toBe("accepted");

    const insert = calls.find((c) => c.table.startsWith("messages") && c.method === "POST");
    const path = `${ORG}/${CONV}/wamid.m1`;
    expect((insert?.body as Array<Record<string, unknown>>)[0]).toMatchObject({
      media_key: path,
    });

    expect(storedMedia.get(path)).toEqual({ body: "JPEGBYTES", contentType: "image/jpeg" });
  });

  it("still persists the message when the media fetch fails", async () => {
    const calls = await harness(() => new Response("gone", { status: 410 }));

    const conv = env.CONVERSATION.get(env.CONVERSATION.idFromName("media-fail"));
    // The turn survives: losing an attachment must not cost the customer's message,
    // and the id is already in `seen` so a retry would drop it entirely.
    expect(await conv.onInbound(imageMessage("wamid.m2"))).toBe("accepted");

    const insert = calls.find((c) => c.table.startsWith("messages") && c.method === "POST");
    expect((insert?.body as Array<Record<string, unknown>>)[0]).toMatchObject({
      media_key: null,
      body: "look at this",
    });
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
    expect(scrub?.body).toEqual({ body: null, media_key: null });
    expect(calls.some((c) => c.method === "DELETE" && c.table === "conversations")).toBe(false);
    // The customer's dedupe identifiers still go.
    const dedupe = calls.find((c) => c.method === "DELETE" && c.table === "inbound_dedupe");
    expect(dedupe?.url.searchParams.get("wa_message_id")).toContain("wamid.f1");
  });

  // An image is never part of the safety proof, so it dies even in the flagged branch.
  it("deletes the conversation's media from Storage, flagged or not", async () => {
    stubSupabase((call) => {
      if (call.table === "conversations") return [{ id: CONV }];
      if (call.table === "safety_flags") return [{ id: "sf-1" }];
      return [];
    });

    const path = `${ORG}/${CONV}/wamid.e1`;
    storedMedia.set(path, { body: "BYTES", contentType: "image/jpeg" });
    const conv = await erased("erase-media");
    await conv.erase();

    expect(storedMedia.has(path)).toBe(false);
  });
});
