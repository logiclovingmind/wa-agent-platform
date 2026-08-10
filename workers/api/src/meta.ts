import { decryptSecret } from "./crypto.js";
import type { Env } from "./env.js";

export interface SendTarget {
  phoneNumberId: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenKeyVersion: number;
}

/**
 * The one message type Meta accepts outside the 24h window. The body is fixed at
 * approval time, so nothing model-generated can ride along — which is also why this
 * cannot be used to deliver a late reply, only to invite the customer to write back.
 */
export async function sendTemplate(
  env: Env,
  target: SendTarget,
  to: string,
  template: { name: string; language: string },
): Promise<string> {
  return metaSend(env, target, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: { name: template.name, language: { code: template.language } },
  });
}

/**
 * Resolves a media id to bytes. Two hops: the id yields a short-lived CDN URL, which
 * must then be fetched with the same bearer token. Meta expires that URL in ~5 minutes,
 * which is why the bytes are copied at inbound time rather than linked to on demand.
 */
export async function downloadMedia(
  env: Env,
  target: SendTarget,
  mediaId: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  const token = await decryptSecret(
    env,
    target.tokenCiphertext,
    target.tokenIv,
    target.tokenKeyVersion,
  );
  const auth = { authorization: `Bearer ${token}` };

  const lookup = await fetch(`${env.META_GRAPH_URL}/${mediaId}`, { headers: auth });
  if (!lookup.ok) return null;

  const { url, mime_type } = (await lookup.json()) as { url?: string; mime_type?: string };
  if (!url) return null;

  // Meta serves media from a lookaside host that still demands the token.
  const bytes = await fetch(url, { headers: auth });
  if (!bytes.ok || !bytes.body) return null;

  return { body: bytes.body, contentType: mime_type ?? "application/octet-stream" };
}

/**
 * One text message to one customer. The caller must have claimed the reply first —
 * see ConversationDO.claimReply().
 */
export async function sendText(
  env: Env,
  target: SendTarget,
  to: string,
  body: string,
): Promise<string> {
  return metaSend(env, target, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body, preview_url: false },
  });
}

/** Returns the sent wa_message_id. Throws on anything Meta did not accept. */
async function metaSend(env: Env, target: SendTarget, payload: unknown): Promise<string> {
  const token = await decryptSecret(
    env,
    target.tokenCiphertext,
    target.tokenIv,
    target.tokenKeyVersion,
  );

  const res = await fetch(`${env.META_GRAPH_URL}/${target.phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`meta send failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as { messages?: Array<{ id?: string }> };
  const id = body.messages?.[0]?.id;
  if (!id) throw new Error("meta send returned no message id");
  return id;
}
