import { createServiceClient } from "@wa/shared";
import type { Env } from "./env.js";

export interface WaAccountRoute {
  id: string;
  org_id: string;
  phone_number_id: string;
  app_secret_ciphertext: string;
  app_secret_iv: string;
  app_secret_key_version: number;
}

/**
 * Resolves a webhook slug to the client it belongs to.
 *
 * This is the one query in the codebase that is not org-scoped, because it is the
 * query that *determines* the org. Everything downstream of it takes the org_id it
 * returns and goes through OrgDb.
 */
export async function lookupAccountBySlug(
  env: Env,
  slug: string,
): Promise<WaAccountRoute | null> {
  // Retried once because this is the first await in the webhook: a throw here is a
  // non-2xx to Meta, and Meta answers that by backing the whole client off for
  // minutes. A single transient 522 is not worth that. Waiting is I/O, so the retry
  // costs no CPU against the 10ms budget.
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250));

    const { data, error } = await createServiceClient(env)
      .from("wa_accounts")
      .select("id,org_id,phone_number_id,app_secret_ciphertext,app_secret_iv,app_secret_key_version")
      .eq("webhook_slug", slug)
      .maybeSingle<WaAccountRoute>();

    // A slug that matches nothing is an answer, not a failure — returning null is the
    // 404 path and must never be retried.
    if (!error) return data;
    lastError = error.message;
  }

  throw new Error(`wa_accounts lookup failed: ${lastError}`);
}
