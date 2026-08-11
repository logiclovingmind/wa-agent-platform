import { Hono } from "hono";
import { createOrgDb, parseMetaTimestamp } from "@wa/shared";
import { lookupAccountBySlug, type WaAccountRoute } from "./accounts.js";
import { decryptSecret, verifyMetaSignature } from "./crypto.js";
import type { Env } from "./env.js";
import { guard } from "./monitor.js";
import type { InboundMessage } from "./do/conversation.js";

export const webhook = new Hono<{ Bindings: Env }>();

/** Meta's subscription handshake. One global verify token; the slug is the secret. */
webhook.get("/webhook/:slug", async (c) => {
  const account = await lookupAccountBySlug(c.env, c.req.param("slug"));
  if (!account) return c.text("not found", 404);

  const params = c.req.query();
  if (params["hub.mode"] !== "subscribe" || params["hub.verify_token"] !== c.env.META_VERIFY_TOKEN) {
    return c.text("forbidden", 403);
  }
  return c.text(params["hub.challenge"] ?? "");
});

webhook.post("/webhook/:slug", async (c) => {
  // 1. Unknown slug stops here, before the body is read.
  const account = await lookupAccountBySlug(c.env, c.req.param("slug"));
  if (!account) return c.text("not found", 404);

  // 2. The exact bytes Meta signed. No parse before the HMAC.
  const raw = await c.req.text();

  // 3. An unverified body is untrusted input.
  const appSecret = await decryptSecret(
    c.env,
    account.app_secret_ciphertext,
    account.app_secret_iv,
    account.app_secret_key_version,
  );
  const signed = await verifyMetaSignature(appSecret, c.req.header("x-hub-signature-256"), raw);
  if (!signed) return c.text("bad signature", 401);

  // 4. A substring test is not a parse. Delivery receipts outnumber messages and must
  // not pay for the message path.
  if (raw.includes('"statuses"')) {
    c.executionCtx.waitUntil(
      guard(c.env, { path: "statuses", org: account.org_id }, () =>
        persistStatuses(c.env, account, raw),
      ),
    );
    return c.text("ok");
  }

  // 5. Before the parse, so a flood costs one binding call and no CPU. 429 rather than
  // a silent drop: Meta re-delivers on a non-2xx and the DO dedupes the eventual
  // duplicate, so the customer's message is deferred instead of lost.
  const { success } = await c.env.ORG_LIMITER.limit({ key: account.org_id });
  if (!success) return c.text("rate limited", 429);

  // 6.
  const inbound = extractInbound(raw, account);

  // 7. Everything past the 200 runs on the same CPU meter, so it is all I/O.
  if (inbound.length > 0) {
    // The 200 has already gone out, so a throw in here would otherwise be invisible.
    c.executionCtx.waitUntil(
      guard(c.env, { path: "inbound", org: account.org_id }, () => dispatch(c.env, inbound)),
    );
  }
  return c.text("ok");
});

function extractInbound(raw: string, account: WaAccountRoute): InboundMessage[] {
  const payload = JSON.parse(raw) as MetaWebhook;
  const out: InboundMessage[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // A second phone number on the same WABA posts to the same slug.
      if (change.value?.metadata?.phone_number_id !== account.phone_number_id) continue;

      for (const msg of change.value?.messages ?? []) {
        if (!msg.id || !msg.from) continue;
        const media = msg.image ?? msg.video ?? msg.audio ?? msg.document ?? msg.sticker;
        out.push({
          orgId: account.org_id,
          waAccountId: account.id,
          customerWaId: msg.from,
          waMessageId: msg.id,
          type: msg.type ?? "unknown",
          // A caption is the only text a media message carries, and it is what the
          // model gets to see — the bytes themselves never reach the prompt.
          body: msg.text?.body ?? media?.caption ?? null,
          // No media id means nothing is downloaded or stored. Video is dropped here
          // rather than in the DO so the bytes never touch the 1GB bucket at all; the
          // caption still comes through, and the DO answers with VIDEO_REPLY.
          mediaId: msg.type === "video" ? null : (media?.id ?? null),
          sentAt: parseMetaTimestamp(msg.timestamp ?? "0").getTime(),
        });
      }
    }
  }
  return out;
}

async function dispatch(env: Env, messages: InboundMessage[]): Promise<void> {
  for (const msg of messages) {
    // One DO per conversation, so the name has to be stable per customer and unique
    // across orgs sharing a namespace.
    const id = env.CONVERSATION.idFromName(`${msg.orgId}:${msg.waAccountId}:${msg.customerWaId}`);
    await env.CONVERSATION.get(id).onInbound(msg);
  }
}

async function persistStatuses(env: Env, account: WaAccountRoute, raw: string): Promise<void> {
  const payload = JSON.parse(raw) as MetaWebhook;
  const db = createOrgDb(env, account.org_id);

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const status of change.value?.statuses ?? []) {
        if (!status.id || !status.status) continue;
        const { error } = await db
          .update("messages", {
            status: status.status,
            status_at: parseMetaTimestamp(status.timestamp ?? "0").toISOString(),
          })
          .eq("wa_message_id", status.id);
        if (error) throw new Error(`status update failed: ${error.message}`);
      }
    }
  }
}

/** Every media kind carries this shape; audio and sticker never carry a caption. */
interface MetaMedia {
  id?: string;
  caption?: string;
}

interface MetaWebhook {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{
          id?: string;
          from?: string;
          type?: string;
          timestamp?: string;
          text?: { body?: string };
          image?: MetaMedia;
          video?: MetaMedia;
          audio?: MetaMedia;
          document?: MetaMedia;
          sticker?: MetaMedia;
        }>;
        statuses?: Array<{ id?: string; status?: string; timestamp?: string }>;
      };
    }>;
  }>;
}
