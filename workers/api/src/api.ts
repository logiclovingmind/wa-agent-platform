import { Hono } from "hono";
import { cors } from "hono/cors";
import { createOrgDb, createServiceClient } from "@wa/shared";
import { authenticate, type Caller } from "./auth.js";
import type { Env } from "./env.js";

/**
 * The dashboard's write path. Reads are not here on purpose: the browser queries
 * Supabase directly under RLS, which is what makes Realtime work and keeps this
 * Worker off the read path entirely.
 *
 * What must go through here is anything the browser is not allowed to hold — Meta
 * tokens (invariant 6) — and anything that has to be serialised per conversation, which
 * is the handoff lock in the DO.
 */
export const api = new Hono<{ Bindings: Env; Variables: { caller: Caller } }>();

// The dashboard is on Pages and the API is on workers.dev, so this is cross-origin.
// One exact origin, not "*": with credentials in a header, a wildcard would let any
// site spend a client's Meta quota.
api.use("/api/*", (c, next) =>
  cors({
    origin: c.env.DASHBOARD_ORIGIN,
    allowHeaders: ["authorization", "content-type"],
    allowMethods: ["POST", "OPTIONS"],
  })(c, next),
);

api.use("/api/*", async (c, next) => {
  const caller = await authenticate(c.env, c.req.header("authorization"));
  if (!caller) return c.json({ error: "unauthorized" }, 401);
  c.set("caller", caller);
  await next();
});

/** Resolves the conversation inside the caller's org, then names its Durable Object. */
async function conversationStub(c: {
  env: Env;
  get: (key: "caller") => Caller;
  req: { param: (name: string) => string };
}) {
  const caller = c.get("caller");
  const { data, error } = await createOrgDb(c.env, caller.orgId)
    .select("conversations", "id,wa_account_id,customer_wa_id", { limit: 1 })
    .eq("id", c.req.param("id"))
    .maybeSingle<{ id: string; wa_account_id: string; customer_wa_id: string }>();

  if (error) throw new Error(`conversation lookup failed: ${error.message}`);
  if (!data) return null;

  const name = `${caller.orgId}:${data.wa_account_id}:${data.customer_wa_id}`;
  const stub = c.env.CONVERSATION.get(c.env.CONVERSATION.idFromName(name));

  // Postgres already told us who this conversation is, so the DO never has to have
  // seen an inbound to be able to act.
  await stub.attach({
    orgId: caller.orgId,
    waAccountId: data.wa_account_id,
    customerWaId: data.customer_wa_id,
    conversationId: data.id,
  });
  return stub;
}

api.post("/api/conversations/:id/takeover", async (c) => {
  const stub = await conversationStub(c);
  if (!stub) return c.json({ error: "not found" }, 404);

  await stub.takeOver();
  return c.json(await stub.getState());
});

api.post("/api/conversations/:id/release", async (c) => {
  const stub = await conversationStub(c);
  if (!stub) return c.json({ error: "not found" }, 404);

  await stub.release();
  return c.json(await stub.getState());
});

api.post("/api/conversations/:id/reply", async (c) => {
  const stub = await conversationStub(c);
  if (!stub) return c.json({ error: "not found" }, 404);

  const { body } = await c.req.json<{ body?: string }>();
  const text = body?.trim();
  if (!text) return c.json({ error: "empty message" }, 400);
  // Meta rejects anything longer, and a dashboard bug should not find that out in
  // production.
  if (text.length > 4096) return c.json({ error: "message too long" }, 400);

  // The DO owns the lock, so it is the only thing that can answer "is this yours".
  if ((await stub.sendHuman(text)) === "not_human") {
    return c.json({ error: "take over the conversation first" }, 409);
  }
  return c.json(await stub.getState());
});

// Erasure is irreversible and is a DPDP data-principal right, so only the owner may
// trigger it, and it is audited. The DO decides what to keep (flagged conversations
// keep their safety proof).
api.post("/api/conversations/:id/erase", async (c) => {
  if (c.get("caller").role !== "owner") return c.json({ error: "owner only" }, 403);

  const stub = await conversationStub(c);
  if (!stub) return c.json({ error: "not found" }, 404);

  await stub.erase();
  const { error } = await createOrgDb(c.env, c.get("caller").orgId).insert("audit_log", {
    actor_user_id: c.get("caller").userId,
    action: "conversation_erased",
    detail: { conversation_id: c.req.param("id") },
  });
  if (error) throw new Error(`audit_log insert failed: ${error.message}`);

  return c.json({ erased: true });
});

/**
 * The other half of the DPDP data-principal rights the DPA commits us to (§3.6):
 * access, where erasure is the deletion half. Owner-gated and audited for the same
 * reason — it emits one customer's entire conversation history in a single response.
 *
 * POST rather than GET because it writes the audit row, and because the CORS policy
 * above only allows POST.
 */
api.post("/api/conversations/:id/export", async (c) => {
  const caller = c.get("caller");
  if (caller.role !== "owner") return c.json({ error: "owner only" }, 403);

  const conversationId = c.req.param("id");
  const conversation = await createOrgDb(c.env, caller.orgId)
    .select("conversations", "id,customer_wa_id,customer_name,handoff_state,created_at,last_message_at", {
      limit: 1,
    })
    .eq("id", conversationId)
    .maybeSingle<Record<string, unknown>>();
  if (conversation.error) throw new Error(`export lookup failed: ${conversation.error.message}`);
  if (!conversation.data) return c.json({ error: "not found" }, 404);

  // Deliberately past OrgDb's 20-row cap: a partial export is not an access right.
  // Named columns, never `select *` (invariant 7), and org-filtered in code because
  // service_role bypasses RLS (invariant 2). Rare and owner-only, so the egress cost
  // is bounded by how often a data principal actually asks.
  const messages = await createServiceClient(c.env)
    .from("messages")
    .select("wa_message_id,direction,type,body,media_key,created_at")
    .eq("org_id", caller.orgId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (messages.error) throw new Error(`export failed: ${messages.error.message}`);

  const { error } = await createOrgDb(c.env, caller.orgId).insert("audit_log", {
    actor_user_id: caller.userId,
    action: "conversation_exported",
    detail: { conversation_id: conversationId, message_count: messages.data.length },
  });
  if (error) throw new Error(`audit_log insert failed: ${error.message}`);

  return c.json({
    exported_at: new Date().toISOString(),
    conversation: conversation.data,
    // Keys, not bytes. Media is fetched from Storage separately so one export cannot
    // pull gigabytes through the Worker.
    messages: messages.data,
  });
});
