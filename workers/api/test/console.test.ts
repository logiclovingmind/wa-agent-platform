import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { stubSupabase, type RestCall } from "./fake-supabase.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ADMIN = "55555555-5555-5555-5555-555555555555";

interface Scenario {
  admin?: boolean;
  paused?: boolean;
  capMicros?: number | null;
  monthSpend?: number;
  voice?: string | null;
  replyMaxWords?: number | null;
  languages?: string | null;
  kb?: string;
  reply?: string;
  /** What `free_slots` answers, as ISO instants. Absent means this client has no diary. */
  slots?: string[];
  /** The label the model picks, if any. */
  booking?: string;
}

/** What the model was actually shown, so a test can assert on the finished prompt. */
const sentPrompts: string[] = [];

function harness(scenario: Scenario = {}) {
  sentPrompts.length = 0;

  return stubSupabase(
    (call) => {
      switch (call.table.split("?")[0]) {
        case "org_members":
          // The platform admin is the account with no membership row at all.
          return scenario.admin === false ? [{ org_id: ORG_A, role: "owner" }] : [];
        case "users":
          return [{ id: ADMIN, email: "admin@x.test", is_platform_admin: scenario.admin !== false }];
        case "organizations":
          return [
            {
              id: ORG_A,
              name: "Acme Salon",
              sector: "general",
              ai_paused: scenario.paused ?? false,
              cap_micros: scenario.capMicros ?? null,
              hours_open_ist: null,
              hours_close_ist: null,
              out_of_hours: "reply",
              voice: scenario.voice ?? null,
              reply_max_words: scenario.replyMaxWords ?? null,
              languages: scenario.languages ?? null,
            },
          ];
        case "kb_documents":
          return [{ raw: scenario.kb ?? "Haircut ₹400. Open 9am to 8pm." }];
        case "rpc/org_month_spend":
          return scenario.monthSpend ?? 0;
        case "rpc/free_slots":
          return (scenario.slots ?? []).map((starts_at) => ({ starts_at }));
        default:
          return [];
      }
    },
    async (req, url) => {
      if (url.pathname === "/auth/v1/user") return Response.json({ id: ADMIN });
      if (url.hostname === "llm.test") {
        const body = (await req.json()) as { messages: Array<{ content: string }> };
        sentPrompts.push(body.messages[0]!.content);
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  reply: scenario.reply ?? "We're open 9am to 8pm — shall I book you in?",
                  flags: { minor: false, distress: false, out_of_scope: false },
                  ...(scenario.booking ? { booking: { slot: scenario.booking } } : {}),
                }),
              },
            },
          ],
          usage: { prompt_tokens: 400, completion_tokens: 20 },
        });
      }
      throw new Error(`unexpected outbound fetch: ${req.method} ${req.url}`);
    },
  );
}

async function run(body: unknown, orgId = ORG_A) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://api.test/api/admin/console/${orgId}`, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const writesTo = (rest: RestCall[], table: string) =>
  rest.filter((c) => c.method === "POST" && c.table.split("?")[0] === table);

afterEach(() => vi.unstubAllGlobals());

describe("training console", () => {
  it("is closed to a client owner", async () => {
    harness({ admin: false });
    const res = await run({ text: "are you open today?" });
    expect(res.status).toBe(403);
  });

  it("answers with the reply a real customer would have received", async () => {
    const rest = harness();
    const res = await run({ text: "are you open today?" });

    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out["action"]).toBe("send");
    expect(out["stage"]).toBe("sent");
    expect(out["text"]).toBe("We're open 9am to 8pm — shall I book you in?");
    // 400 prompt + 20 completion tokens at the aicredits INR rate.
    expect(out["costMicros"]).toBe(400 * 14 + 20 * 57);
    expect(out["systemPrompt"]).toContain("Haircut ₹400");

    // The point of the whole extraction: this runs the send path without sending.
    expect(writesTo(rest, "messages")).toHaveLength(0);
    expect(writesTo(rest, "conversations")).toHaveLength(0);
  });

  it("meters its own spend separately from the client's traffic", async () => {
    const rest = harness();
    await run({ text: "are you open today?" });

    const usage = writesTo(rest, "usage_events");
    expect(usage).toHaveLength(1);
    const row = (usage[0]!.body as Array<Record<string, unknown>>)[0]!;
    expect(row["pricing_category"]).toBe("console");
    // Folding it into `reply` would inflate the per-reply figure on the cost screen.
    expect(row["conversation_id"]).toBeNull();

    const audit = writesTo(rest, "audit_log");
    expect(audit).toHaveLength(1);
    const entry = (audit[0]!.body as Array<Record<string, unknown>>)[0]!;
    expect(entry["action"]).toBe("console_run");
    // Scratch input, not evidence: the typed message must not sit in audit_log for a year.
    expect(JSON.stringify(entry["detail"])).not.toContain("are you open today");
  });

  it("stops a flagged turn before the model and bills nothing", async () => {
    const rest = harness();
    const res = await run({ text: "I'm in 10th standard, can I join?" });

    const out = (await res.json()) as Record<string, unknown>;
    expect(out["action"]).toBe("safe");
    expect(out["stage"]).toBe("prefilter");
    expect(out["kind"]).toBe("minor");
    expect(out["costMicros"]).toBe(0);

    expect(sentPrompts).toHaveLength(0);
    expect(writesTo(rest, "usage_events")).toHaveLength(0);
  });

  it("reports a paused client rather than going dark, and can be stepped over", async () => {
    harness({ paused: true });
    const held = (await (await run({ text: "hi" })).json()) as Record<string, unknown>;
    expect(held["stage"]).toBe("hold");
    expect(held["hold"]).toBe("paused");
    expect(sentPrompts).toHaveLength(0);

    harness({ paused: true });
    const forced = (await (
      await run({ text: "hi", overrideHold: true })
    ).json()) as Record<string, unknown>;
    // The hold is still reported — the override tests the prompt underneath it, it does
    // not pretend the client is live.
    expect(forced["hold"]).toBe("paused");
    expect(forced["overrodeHold"]).toBe(true);
    expect(forced["stage"]).toBe("sent");
    expect(sentPrompts).toHaveLength(1);
  });

  it("shows the per-org voice actually reaching the prompt", async () => {
    harness({
      voice: "patient and encouraging",
      replyMaxWords: 140,
      languages: "English, Hindi",
    });
    await run({ text: "what courses do you run?" });

    expect(sentPrompts[0]).toContain("- Tone: patient and encouraging");
    expect(sentPrompts[0]).toContain("under 140 words");
    expect(sentPrompts[0]).toContain("English, Hindi");
  });

  // The console is the reply path minus the sending, so it has to read the diary the DO
  // reads. A console built without this offers no times at all on a client whose live bot
  // books happily, and reports that difference as the client's behaviour.
  it("offers the same free times the live bot would", async () => {
    harness({ slots: ["2030-01-07T04:30:00.000Z", "2030-01-07T05:00:00.000Z"] });

    const res = await run({ text: "can I come Monday?" });
    expect(((await res.json()) as { slotsOffered: number }).slotsOffered).toBe(2);
    expect(sentPrompts[0]).toContain("Mon 7 Jan, 10:00 am");
    expect(sentPrompts[0]).toContain("Mon 7 Jan, 10:30 am");
  });

  it("says nothing about booking for a client with no hours", async () => {
    harness();
    await run({ text: "can I come Monday?" });

    expect(sentPrompts[0]).not.toContain("booking");
    expect(sentPrompts[0]).not.toContain("appointment times are free");
  });

  // The console writes a usage row and an audit row, and nothing else ever. A slot held
  // for a customer who does not exist would be a real appointment blocking a real one.
  it("reports the slot the model chose without taking it", async () => {
    const rest = harness({
      slots: ["2030-01-07T04:30:00.000Z"],
      booking: "Mon 7 Jan, 10:00 am",
      reply: "Booked you in for Monday at 10.",
    });

    const res = await run({ text: "monday 10 please" });
    expect(((await res.json()) as { booking: string | null }).booking).toBe("Mon 7 Jan, 10:00 am");
    expect(writesTo(rest, "appointments")).toHaveLength(0);
    expect(rest.some((c) => c.table.startsWith("rpc/book_appointment"))).toBe(false);
  });

  it("replays browser-held history as the conversation the model sees", async () => {
    harness();
    const res = await run({
      text: "and on Sunday?",
      history: [
        { direction: "inbound", body: "are you open today?" },
        { direction: "outbound", body: "Yes, until 8pm." },
      ],
    });
    expect(res.status).toBe(200);
    expect(sentPrompts).toHaveLength(1);
  });

  it("rejects an empty message and a malformed history", async () => {
    harness();
    expect((await run({ text: "   " })).status).toBe(400);
    expect((await run({ text: "hi", history: [{ direction: "sideways" }] })).status).toBe(400);
  });
});
