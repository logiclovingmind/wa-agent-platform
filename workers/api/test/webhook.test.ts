import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { stubSupabase, type RestCall } from "./fake-supabase.js";

const ORG = "11111111-1111-1111-1111-111111111111";
const ACCOUNT = "22222222-2222-2222-2222-222222222222";
const CONVERSATION = "33333333-3333-3333-3333-333333333333";
const PHONE_NUMBER_ID = "1555";
const CUSTOMER = "919876543210";
const APP_SECRET = "meta-app-secret";

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Encrypted under MASTER_KEY_V1 from vitest.config.ts: 32 zero bytes. */
async function encryptAppSecret(): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(APP_SECRET),
  );
  return { ciphertext: b64(new Uint8Array(ct)), iv: b64(iv) };
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function account(): Promise<Record<string, unknown>> {
  const { ciphertext, iv } = await encryptAppSecret();
  return {
    id: ACCOUNT,
    org_id: ORG,
    phone_number_id: PHONE_NUMBER_ID,
    app_secret_ciphertext: ciphertext,
    app_secret_iv: iv,
    app_secret_key_version: 1,
  };
}

function stub(row: Record<string, unknown> | null): RestCall[] {
  return stubSupabase((call) => {
    if (call.table.startsWith("wa_accounts")) return row === null ? [] : [row];
    if (call.table === "conversations") return [{ id: CONVERSATION }];
    return [];
  });
}

function messagePayload(
  waMessageId: string,
  phoneNumberId = PHONE_NUMBER_ID,
  contacts?: Array<{ wa_id: string; profile: { name: string } }>,
): string {
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              ...(contacts ? { contacts } : {}),
              messages: [
                {
                  id: waMessageId,
                  from: CUSTOMER,
                  type: "text",
                  timestamp: "1772000000",
                  text: { body: "do you have a slot at 6?" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function post(body: string, signature: string | null, slug = "acme"): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers["x-hub-signature-256"] = signature;

  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://api.test/webhook/${slug}`, { method: "POST", headers, body }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /webhook/:slug", () => {
  it("echoes the challenge for the right token", async () => {
    stub(await account());
    const res = await worker.fetch(
      new Request(
        "https://api.test/webhook/acme?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=42",
      ),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("42");
  });

  it("refuses a wrong verify token", async () => {
    stub(await account());
    const res = await worker.fetch(
      new Request(
        "https://api.test/webhook/acme?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42",
      ),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /webhook/:slug", () => {
  it("404s an unknown slug before reading the body", async () => {
    const calls = stub(null);
    const res = await post(messagePayload("wamid.UNKNOWN"), await sign(messagePayload("x")));

    expect(res.status).toBe(404);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("401s an unsigned body and writes nothing", async () => {
    const calls = stub(await account());
    const res = await post(messagePayload("wamid.UNSIGNED"), null);

    expect(res.status).toBe(401);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("401s a body signed with the wrong secret", async () => {
    const calls = stub(await account());
    const body = messagePayload("wamid.FORGED");
    const forged = `sha256=${"0".repeat(64)}`;
    const res = await post(body, forged);

    expect(res.status).toBe(401);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("accepts a signed message and hands it to the conversation's DO", async () => {
    const calls = stub(await account());
    const body = messagePayload("wamid.LIVE");
    const res = await post(body, await sign(body));
    expect(res.status).toBe(200);

    const id = env.CONVERSATION.idFromName(`${ORG}:${ACCOUNT}:${CUSTOMER}`);
    const state = await env.CONVERSATION.get(id).getState();
    expect(state.pending).toBe(1);

    const inserted = calls
      .filter((c) => c.table === "messages")
      .flatMap((c) => c.body as Array<Record<string, unknown>>);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      org_id: ORG,
      wa_message_id: "wamid.LIVE",
      direction: "inbound",
      // Meta's timestamp, not our clock.
      created_at: "2026-02-25T06:13:20.000Z",
    });
  });

  it("stores the WhatsApp profile name belonging to the sender", async () => {
    const calls = stub(await account());
    // Two contacts, deliberately with the sender second: one webhook can carry several
    // customers, so taking contacts[0] would file the reply under the wrong name.
    const body = messagePayload("wamid.NAMED", PHONE_NUMBER_ID, [
      { wa_id: "919999999999", profile: { name: "Someone Else" } },
      { wa_id: CUSTOMER, profile: { name: "Ananya Rao" } },
    ]);
    expect((await post(body, await sign(body))).status).toBe(200);

    const upserted = calls
      .filter((c) => c.table === "conversations" && c.method !== "GET")
      .flatMap((c) => c.body as Array<Record<string, unknown>>);
    expect(upserted[0]).toMatchObject({ customer_name: "Ananya Rao" });
  });

  it("ignores a message for another phone number on the same WABA", async () => {
    const calls = stub(await account());
    const body = messagePayload("wamid.OTHER", "9999");
    const res = await post(body, await sign(body));

    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.table === "messages")).toEqual([]);
  });

  it("429s a client over its burst cap instead of dropping the message", async () => {
    stub(await account());

    let last = new Response(null, { status: 200 });
    for (let i = 0; i < 40 && last.status === 200; i++) {
      const body = messagePayload(`wamid.FLOOD${i}`);
      last = await post(body, await sign(body));
    }

    // Non-2xx on purpose: Meta re-delivers and the DO dedupes, so the customer's
    // message is deferred rather than lost.
    expect(last.status).toBe(429);
  });

  it("takes the status path without parsing on the hot path", async () => {
    const calls = stub(await account());
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                statuses: [{ id: "wamid.OUT", status: "delivered", timestamp: "1772000000" }],
              },
            },
          ],
        },
      ],
    });
    const res = await post(body, await sign(body));

    expect(res.status).toBe(200);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.table).toBe("messages");
    expect(patch?.url.searchParams.get("org_id")).toBe(`eq.${ORG}`);
    expect(patch?.url.searchParams.get("wa_message_id")).toBe("eq.wamid.OUT");
    expect(patch?.body).toMatchObject({ status: "delivered" });
  });
});
