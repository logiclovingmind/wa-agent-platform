import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { stubSupabase, type RestCall } from "./fake-supabase.js";
import { encryptUnderMasterKey } from "./fixtures.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const CONVERSATION = "33333333-3333-3333-3333-333333333333";
const USER = "44444444-4444-4444-4444-444444444444";

interface Harness {
  rest: RestCall[];
  sent: string[];
}

/** `member` false means a valid login with no org_members row — a user of another product. */
async function harness(
  opts: { authorized?: boolean; member?: boolean; customer?: string; role?: "owner" | "staff" } = {},
) {
  const token = await encryptUnderMasterKey("meta-token");
  const out: Harness = { rest: [], sent: [] };

  out.rest = stubSupabase(
    (call) => {
      switch (call.table.split("?")[0]) {
        case "org_members":
          return opts.member === false ? [] : [{ org_id: ORG_A, role: opts.role ?? "owner" }];
        case "conversations":
          return [
            {
              id: CONVERSATION,
              wa_account_id: "22222222-2222-2222-2222-222222222222",
              customer_wa_id: opts.customer ?? "919876543210",
            },
          ];
        case "wa_accounts":
          return [
            {
              phone_number_id: "1555",
              token_ciphertext: token.ciphertext,
              token_iv: token.iv,
              token_key_version: 1,
            },
          ];
        default:
          return [];
      }
    },
    async (req, url) => {
      if (url.pathname === "/auth/v1/user") {
        return opts.authorized === false
          ? new Response("bad jwt", { status: 401 })
          : Response.json({ id: USER });
      }
      if (url.hostname === "graph.test") {
        const body = (await req.json()) as { text: { body: string } };
        out.sent.push(body.text.body);
        return Response.json({ messages: [{ id: "wamid.HUMAN" }] });
      }
      throw new Error(`unexpected outbound fetch: ${req.method} ${req.url}`);
    },
  );

  return out;
}

async function call(path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body ?? {}),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

afterEach(() => vi.unstubAllGlobals());

describe("dashboard write API", () => {
  it("refuses a request with no token", async () => {
    await harness();
    const res = await call(`/api/conversations/${CONVERSATION}/takeover`);
    expect(res.status).toBe(401);
  });

  it("refuses a token Supabase does not recognise", async () => {
    await harness({ authorized: false });
    const res = await call(`/api/conversations/${CONVERSATION}/takeover`, { token: "forged" });
    expect(res.status).toBe(401);
  });

  it("refuses a real login that belongs to no org", async () => {
    await harness({ member: false });
    const res = await call(`/api/conversations/${CONVERSATION}/takeover`, { token: "good" });
    expect(res.status).toBe(401);
  });

  it("scopes the conversation lookup to the caller's own org", async () => {
    const h = await harness({ customer: "919000000001" });
    await call(`/api/conversations/${CONVERSATION}/takeover`, { token: "good" });

    // The org comes from org_members, never from the request. A conversation in another
    // org simply is not found.
    const lookup = h.rest.find((c) => c.table.startsWith("conversations") && c.method === "GET");
    expect(lookup?.url.searchParams.get("org_id")).toBe(`eq.${ORG_A}`);
  });

  it("takes over, sends as the human, and releases", async () => {
    const h = await harness({ customer: "919000000002" });

    const taken = await call(`/api/conversations/${CONVERSATION}/takeover`, { token: "good" });
    expect(await taken.json()).toMatchObject({ handoff: "human", canBotReply: false });

    const sent = await call(`/api/conversations/${CONVERSATION}/reply`, {
      token: "good",
      body: { body: "Hi, this is Priya — 6pm is free." },
    });
    expect(sent.status).toBe(200);
    expect(h.sent).toEqual(["Hi, this is Priya — 6pm is free."]);

    const released = await call(`/api/conversations/${CONVERSATION}/release`, { token: "good" });
    expect(await released.json()).toMatchObject({ handoff: "returned" });
  });

  it("refuses to send on a conversation nobody has taken over", async () => {
    const h = await harness({ customer: "919000000003" });
    const res = await call(`/api/conversations/${CONVERSATION}/reply`, {
      token: "good",
      body: { body: "sneaking a reply in" },
    });

    expect(res.status).toBe(409);
    expect(h.sent).toEqual([]);
  });

  it("refuses an empty message rather than sending a blank WhatsApp", async () => {
    const h = await harness({ customer: "919000000004" });
    await call(`/api/conversations/${CONVERSATION}/takeover`, { token: "good" });
    const res = await call(`/api/conversations/${CONVERSATION}/reply`, {
      token: "good",
      body: { body: "   " },
    });

    expect(res.status).toBe(400);
    expect(h.sent).toEqual([]);
  });

  it("lets the owner erase a conversation and audits it", async () => {
    const h = await harness();
    const res = await call(`/api/conversations/${CONVERSATION}/erase`, { token: "good" });

    expect(res.status).toBe(200);
    const audit = h.rest.find((c) => c.table.startsWith("audit_log"));
    expect(audit?.method).toBe("POST");
    const auditRow = (audit?.body as Array<Record<string, unknown>>)[0];
    expect(auditRow).toMatchObject({ action: "conversation_erased" });
  });

  it("refuses erasure for staff", async () => {
    await harness({ role: "staff" });
    const res = await call(`/api/conversations/${CONVERSATION}/erase`, { token: "good" });
    expect(res.status).toBe(403);
  });
});
