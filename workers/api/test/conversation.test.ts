import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MAX_MS, DEBOUNCE_MS, type InboundMessage } from "../src/do/conversation.js";
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

/**
 * Holds a fake clock across a whole test so the deadline arithmetic can be driven step
 * by step. `fireAlarmAt` above jumps once and restores, which cannot express "a message
 * arrived one second into the burst" — the inbound calls have to see the moved clock too.
 * Only `Date` is faked, for the same reason as above.
 */
async function onClock(run: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  const base = Date.now();
  let offset = 0;
  try {
    await run((ms) => {
      offset += ms;
      vi.setSystemTime(base + offset);
    });
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

  // The wait is short so a lone message is answered quickly, which only stays safe
  // because a second message restarts it. Without this the burst above would split into
  // two replies and break invariant 5.
  it("restarts the wait when another message arrives", async () => {
    const conv = stub("debounce-extend");
    await onClock(async (advance) => {
      await conv.onInbound(inbound("wamid.e1"));
      advance(1_000);
      await conv.onInbound(inbound("wamid.e2"));

      // Past the first message's deadline, short of the second's. The old flat deadline
      // would have flushed here and answered "wamid.e1" on its own.
      advance(600);
      await runDurableObjectAlarm(conv);
      expect((await conv.getState()).pending).toBe(2);

      advance(DEBOUNCE_MS);
      await runDurableObjectAlarm(conv);
      const state = await conv.getState();
      expect(state.pending).toBe(0);
      expect(state.lastBatchSize).toBe(2);
    });
  });

  // The reason the restart above needs a ceiling: someone typing steadily every second
  // would otherwise never be answered at all.
  it("stops extending at the ceiling", async () => {
    const conv = stub("debounce-ceiling");
    await onClock(async (advance) => {
      await conv.onInbound(inbound("wamid.c1"));
      for (const id of ["wamid.c2", "wamid.c3", "wamid.c4"]) {
        advance(1_000);
        await conv.onInbound(inbound(id));
      }

      // Four messages, one per second. The last one landed at 3s and would extend to
      // 4.5s on its own; the ceiling holds it at 4s from the first.
      advance(DEBOUNCE_MAX_MS - 3_000);
      await runDurableObjectAlarm(conv);
      const state = await conv.getState();
      expect(state.pending).toBe(0);
      expect(state.lastBatchSize).toBe(4);
    });
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

// The DO caches the conversation id in its own storage and Postgres has no way to tell
// it when the row goes away. `demo_reset()` deletes it after every walk-in demo, and a
// PATCH matching nothing is not an error — so the dead id survived, the message insert
// failed its foreign key, and the handset that ran the demo could never message again.
describe("a conversation deleted underneath the object", () => {
  it("re-creates it instead of inserting against the dead id", async () => {
    const OLD = "33333333-3333-3333-3333-333333333333";
    const NEW = "44444444-4444-4444-4444-444444444444";
    let reset = false;

    const calls = stubSupabase((call) => {
      if (call.table !== "conversations") return [];
      // PATCH is the cached-id path; POST is the upsert that has to take over from it.
      if (call.method === "PATCH") return reset ? [] : [{ id: OLD }];
      return [{ id: reset ? NEW : OLD }];
    });

    const conv = env.CONVERSATION.get(env.CONVERSATION.idFromName("conv-deleted"));
    await conv.onInbound(inbound("wamid.d1"));

    reset = true;
    await conv.onInbound(inbound("wamid.d2"));

    const inserted = calls
      .filter((c) => c.table === "messages" && c.method === "POST")
      .map((c) => (c.body as Array<{ conversation_id: string }>)[0]?.conversation_id);

    expect(inserted).toEqual([OLD, NEW]);
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
    expect((insert!.body as Array<Record<string, unknown>>)[0]).toMatchObject({
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
    expect((insert!.body as Array<Record<string, unknown>>)[0]).toMatchObject({
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

// The blue tick is a statement of fact and goes out on every turn. The typing bubble is
// a promise, and Meta asks that it only be shown when a reply is really coming — so it
// is the pairing of the two that is worth a test, not either one alone.
describe("read receipts", () => {
  const ACC = "22222222-2222-2222-2222-222222222222";

  type Conv = ReturnType<typeof env.CONVERSATION.get>;

  /**
   * Each case marks its own message id and counts only the receipts naming it. Both cases
   * used to mark "wamid.r1", so a request still in flight from the first landed in the
   * second one's array and the length assertion failed with two identical receipts — a
   * flake, and a confusing one, because the receipt it printed was the right receipt.
   * Filtering by id still catches the failure worth catching: one message marked twice.
   */
  async function receiptsFor(name: string, arrange?: (conv: Conv) => Promise<void>) {
    const token = await encryptUnderMasterKey("meta-token");
    const messageId = `wamid.${name}`;
    const receipts: Array<Record<string, unknown>> = [];

    stubSupabase(
      (call) => {
        if (call.table === "conversations") return [{ id: "33333333-3333-3333-3333-333333333333" }];
        if (call.table.startsWith("wa_accounts")) {
          return [{
            id: ACC,
            phone_number_id: "PN1",
            token_ciphertext: token.ciphertext,
            token_iv: token.iv,
            token_key_version: 1,
          }];
        }
        return [];
      },
      async (req, url) => {
        if (url.hostname === "llm.test") {
          return Response.json({
            choices: [{ message: { content: JSON.stringify({ reply: "hello", flags: {} }) } }],
          });
        }
        const body = (await req.clone().json()) as Record<string, unknown>;
        if (body["status"] === "read" && body["message_id"] === messageId) receipts.push(body);
        return Response.json({ messages: [{ id: "wamid.out1" }] });
      },
    );

    const conv = env.CONVERSATION.get(env.CONVERSATION.idFromName(name));
    await arrange?.(conv);
    await conv.onInbound(inbound(messageId));
    await fireAlarmAt(DEBOUNCE_MAX_MS, () => runDurableObjectAlarm(conv));
    return receipts;
  }

  it("shows the typing bubble when the bot is about to answer", async () => {
    const receipts = await receiptsFor("receipt-bot");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: "read",
      message_id: "wamid.receipt-bot",
      typing_indicator: { type: "text" },
    });
  });

  // A human holding the conversation is genuinely reading the inbox, so the tick is
  // still honest — but nothing is being typed, and the bubble would expire into silence.
  it("marks read without typing while a human holds the conversation", async () => {
    const receipts = await receiptsFor("receipt-human", (conv) => conv.takeOver());
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: "read", message_id: "wamid.receipt-human" });
    expect(receipts[0]).not.toHaveProperty("typing_indicator");
  });
});
