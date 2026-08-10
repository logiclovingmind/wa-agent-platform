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
  const { data, error } = await createServiceClient(env)
    .from("wa_accounts")
    .select("id,org_id,phone_number_id,app_secret_ciphertext,app_secret_iv,app_secret_key_version")
    .eq("webhook_slug", slug)
    .maybeSingle<WaAccountRoute>();

  if (error) throw new Error(`wa_accounts lookup failed: ${error.message}`);
  return data;
}
