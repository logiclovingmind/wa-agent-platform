import { decryptSecret } from "./crypto.js";
import type { Env } from "./env.js";

export interface SendTarget {
  phoneNumberId: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenKeyVersion: number;
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
  const token = await decryptSecret(
    env,
    target.tokenCiphertext,
    target.tokenIv,
    target.tokenKeyVersion,
  );

  const res = await fetch(`${env.META_GRAPH_URL}/${target.phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body, preview_url: false },
    }),
  });

  if (!res.ok) throw new Error(`meta send failed: ${res.status} ${await res.text()}`);

  const payload = (await res.json()) as { messages?: Array<{ id?: string }> };
  const id = payload.messages?.[0]?.id;
  if (!id) throw new Error("meta send returned no message id");
  return id;
}
