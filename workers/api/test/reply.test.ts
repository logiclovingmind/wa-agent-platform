import { env, runDurableObjectAlarm } from "cloudflare:test";
import {
  BLOCKED_REPLY,
  FALLBACK_REPLY,
  MEDIA_REPLY,
  SAFE_REPLY,
  VIDEO_REPLY,
  type ModelFlags,
  type Sector,
} from "@wa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEBOUNCE_MS, type InboundMessage } from "../src/do/conversation.js";
import { stubSupabase, type RestCall } from "./fake-supabase.js";
import { encryptUnderMasterKey } from "./fixtures.js";

const ORG = "11111111-1111-1111-1111-111111111111";
const ACCOUNT = "22222222-2222-2222-2222-222222222222";
const CONVERSATION = "33333333-3333-3333-3333-333333333333";
const CUSTOMER = "919876543210";

interface Scenario {
  sector?: Sector;
  reply?: string;
  flags?: Partial<ModelFlags>;
  /** Every attempt fails, so the caller falls back. */
  llmDown?: boolean;
  /** An approved re-engagement template on the wa_account, or none configured. */
  template?: { name: string; lang: string };
}

interface Harness {
  rest: RestCall[];
  llm: Array<{ system: string; turns: Array<{ role: string; content: string }> }>;
  sent: string[];
  templates: Array<{ name: string; language: string }>;
}

async function harness(name: string, scenario: Scenario = {}) {
  const token = await encryptUnderMasterKey("meta-token");
  const out: Harness = { rest: [], llm: [], sent: [], templates: [] };

  out.rest = stubSupabase(
    (call) => {
      switch (call.table.split("?")[0]) {
        case "conversations":
          return [{ id: CONVERSATION }];
        case "organizations":
          return [{ name: "Acme Salon", sector: scenario.sector ?? "general" }];
        case "kb_documents":
          return [{ raw: "Haircut is Rs 400. Open 9am to 8pm." }];
        case "wa_accounts":
          return [
            {
              phone_number_id: "1555",
              token_ciphertext: token.ciphertext,
              token_iv: token.iv,
              token_key_version: 1,
              reengagement_template_name: scenario.template?.name ?? null,
              reengagement_template_lang: scenario.template?.lang ?? null,
            },
          ];
        case "messages":
          return call.method === "GET" ? [{ direction: "inbound", body: "hi" }] : [];
        default:
          return [];
      }
    },
    async (req, url) => {
      if (url.hostname === "llm.test") {
        if (scenario.llmDown) return new Response("upstream", { status: 502 });
        const body = (await req.json()) as {
          messages: Array<{ role: string; content: string }>;
        };
        out.llm.push({ system: body.messages[0]!.content, turns: body.messages });
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  reply: scenario.reply ?? "Sure, 6pm works. See you then.",
                  flags: { minor: false, distress: false, out_of_scope: false, ...scenario.flags },
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        });
      }

      if (url.hostname === "graph.test") {
        const body = (await req.json()) as {
          type: string;
          text?: { body: string };
          template?: { name: string; language: { code: string } };
        };
        if (body.type === "template") {
          out.templates.push({
            name: body.template!.name,
            language: body.template!.language.code,
          });
        } else {
          out.sent.push(body.text!.body);
        }
        return Response.json({ messages: [{ id: `wamid.OUT.${out.sent.length}` }] });
      }

      throw new Error(`unexpected outbound fetch: ${req.method} ${req.url}`);
    },
  );

  return { ...out, conv: env.CONVERSATION.get(env.CONVERSATION.idFromName(name)) };
}

function inbound(waMessageId: string, body: string): InboundMessage {
  return {
    orgId: ORG,
    waAccountId: ACCOUNT,
    customerWaId: CUSTOMER,
    waMessageId,
    type: "text",
    body,
    sentAt: Date.now(),
  };
}

async function flush(conv: { getState: () => Promise<unknown> }): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + DEBOUNCE_MS);
  try {
    await runDurableObjectAlarm(conv as never);
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("reply path", () => {
  it("answers a normal burst with exactly one message", async () => {
    const h = await harness("reply-ok");
    await h.conv.onInbound(inbound("wamid.r1", "do you have a slot"));
    await h.conv.onInbound(inbound("wamid.r2", "at 6pm?"));
    await flush(h.conv);

    expect(h.sent).toEqual(["Sure, 6pm works. See you then."]);

    // The burst is one user turn, and it is a user turn — not part of the system prompt.
    const call = h.llm[0]!;
    expect(call.turns.at(-1)).toEqual({ role: "user", content: "do you have a slot\nat 6pm?" });
    expect(call.system).not.toContain("do you have a slot");
    expect(call.system).toContain("<<<REFERENCE");

    const outbound = h.rest
      .filter((c) => c.table.startsWith("messages") && c.method === "POST")
      .flatMap((c) => c.body as Array<Record<string, unknown>>)
      .filter((row) => row["direction"] === "outbound");
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({
      org_id: ORG,
      direction: "outbound",
      wa_message_id: "wamid.OUT.1",
    });
  });

  it("records one usage_events row per LLM reply, at the billed cost", async () => {
    const h = await harness("reply-usage");
    await h.conv.onInbound(inbound("wamid.u1", "do you have a slot"));
    await flush(h.conv);

    const usage = h.rest
      .filter((c) => c.table.startsWith("usage_events"))
      .flatMap((c) => c.body as Array<Record<string, unknown>>);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      org_id: ORG,
      pricing_category: "reply",
      // The stub returns 100 prompt + 20 completion tokens:
      // 100 * 14 + 20 * 57 = 2540 micro-INR, i.e. ₹0.00254.
      cost_micros: 2540,
    });
  });

  it("never calls the model on a prefiltered turn", async () => {
    const h = await harness("reply-distress");
    await h.conv.onInbound(inbound("wamid.d1", "I want to die, nothing helps"));
    await flush(h.conv);

    expect(h.llm).toEqual([]);
    expect(h.sent).toEqual([SAFE_REPLY.self_harm]);

    const flags = h.rest
      .filter((c) => c.table.startsWith("safety_flags"))
      .flatMap((c) => c.body as Array<Record<string, unknown>>);
    expect(flags[0]).toMatchObject({ org_id: ORG, kind: "self_harm" });
    expect((await h.conv.getState()).canBotReply).toBe(false);
  });

  it("discards the model's text when the model flags a minor", async () => {
    const h = await harness("reply-minor", {
      reply: "Sure! I can book you in for the colour package.",
      flags: { minor: true },
    });
    await h.conv.onInbound(inbound("wamid.m1", "my dad will pay when he comes"));
    await flush(h.conv);

    expect(h.sent).toEqual([SAFE_REPLY.minor]);
    expect(h.sent[0]).not.toContain("colour package");
    // Invariant 11: no auto-resume. The handoff lock is what stops it.
    expect((await h.conv.getState()).handoff).toBe("requested");
  });

  it("sends the constant fallback when the model is down, never silence", async () => {
    const h = await harness("reply-down", { llmDown: true });
    await h.conv.onInbound(inbound("wamid.f1", "are you open sunday"));
    await flush(h.conv);

    expect(h.sent).toEqual([FALLBACK_REPLY]);
    expect((await h.conv.getState()).handoff).toBe("requested");
    // The fallback is a constant, not model output — there is nothing to bill.
    expect(h.rest.some((c) => c.table.startsWith("usage_events"))).toBe(false);
  });

  it("blocks a reply the sector rules forbid, and hands off instead of retrying", async () => {
    const h = await harness("reply-blocked", {
      sector: "healthcare",
      reply: "It sounds like you have a sinus infection. Take 500mg twice a day.",
    });
    await h.conv.onInbound(inbound("wamid.b1", "my nose is blocked"));
    await flush(h.conv);

    expect(h.sent).toEqual([BLOCKED_REPLY]);
    expect(h.llm).toHaveLength(1);
    expect((await h.conv.getState()).handoff).toBe("requested");
  });

  it("does not send twice for the same burst", async () => {
    const h = await harness("reply-idempotent");
    await h.conv.onInbound(inbound("wamid.i1", "hello"));
    await flush(h.conv);
    expect(h.sent).toHaveLength(1);

    // A replayed claim is the guard: the same anchor can never buy a second send.
    expect(await h.conv.claimReply("wamid.i1")).toBe(false);
  });

  it("does not send or bill when the 24h window is closed, and hands off", async () => {
    const h = await harness("reply-stale");
    const stale = inbound("wamid.s1", "hello");
    stale.sentAt = Date.now() - 25 * 60 * 60 * 1000;
    await h.conv.onInbound(stale);
    await flush(h.conv);

    expect(h.llm).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.templates).toEqual([]);
    expect(h.rest.some((c) => c.table.startsWith("usage_events"))).toBe(false);
    expect((await h.conv.getState()).handoff).toBe("requested");
  });

  it("sends the re-engagement template when the window is closed", async () => {
    const h = await harness("reply-template", { template: { name: "reengage", lang: "en" } });
    const stale = inbound("wamid.t1", "hello");
    stale.sentAt = Date.now() - 25 * 60 * 60 * 1000;
    await h.conv.onInbound(stale);
    await flush(h.conv);

    expect(h.templates).toEqual([{ name: "reengage", language: "en" }]);
    // The template cannot carry the answer, so a human still owes this customer one.
    expect((await h.conv.getState()).handoff).toBe("requested");
    // No model call and no free-form send: both are illegal outside the window.
    expect(h.llm).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.rest.some((c) => c.table.startsWith("usage_events"))).toBe(false);
  });

  it("never templates a flagged conversation, even with one configured", async () => {
    const h = await harness("reply-template-flagged", {
      template: { name: "reengage", lang: "en" },
    });
    // safety.md: engagement content toward a flagged customer is exactly what must
    // never happen, and outside the window the prefilter is the only detector there is.
    const stale = inbound("wamid.t2", "i am in 10th standard");
    stale.sentAt = Date.now() - 25 * 60 * 60 * 1000;
    await h.conv.onInbound(stale);
    await flush(h.conv);

    expect(h.templates).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.rest.some((c) => c.table.startsWith("safety_flags"))).toBe(true);
    expect((await h.conv.getState()).handoff).toBe("requested");
  });

  it("templates at most once for a replayed stale burst", async () => {
    const h = await harness("reply-template-replay", {
      template: { name: "reengage", lang: "en" },
    });
    const stale = inbound("wamid.t3", "hello");
    stale.sentAt = Date.now() - 25 * 60 * 60 * 1000;
    await h.conv.onInbound(stale);
    await flush(h.conv);

    expect(h.templates).toHaveLength(1);
    // Same claim that guards a normal reply: templates cost money per send.
    expect(await h.conv.claimReply("wamid.t3")).toBe(false);
  });

  it("hands an attachment to a person rather than guessing from its caption", async () => {
    const h = await harness("reply-media");
    await h.conv.onInbound({ ...inbound("wamid.p1", "is this the right one?"), type: "image" });
    await flush(h.conv);

    expect(h.sent).toEqual([MEDIA_REPLY]);
    // The model never sees the bytes, so calling it at all would be paying to guess.
    expect(h.llm).toEqual([]);
    expect((await h.conv.getState()).handoff).toBe("requested");
  });

  it("asks for a photo instead of a video", async () => {
    const h = await harness("reply-video");
    await h.conv.onInbound({ ...inbound("wamid.v1", "see the leak"), type: "video" });
    await flush(h.conv);

    expect(h.sent).toEqual([VIDEO_REPLY]);
    expect(h.llm).toEqual([]);
  });

  it("lets the prefilter outrank the attachment handoff", async () => {
    const h = await harness("reply-media-flagged");
    // A caption is still customer text. If media short-circuited first, a flagged turn
    // would get the ordinary handoff line and no safety_flags row.
    await h.conv.onInbound({
      ...inbound("wamid.p2", "i am in 10th standard, is this ok"),
      type: "image",
    });
    await flush(h.conv);

    expect(h.sent).toEqual([SAFE_REPLY.minor]);
    expect(h.rest.some((c) => c.table.startsWith("safety_flags"))).toBe(true);
  });
});
