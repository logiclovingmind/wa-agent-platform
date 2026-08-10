import { Hono } from "hono";
import { cors } from "hono/cors";
import { createOrgDb } from "@wa/shared";
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
