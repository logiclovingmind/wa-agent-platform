import { createServiceClient } from "@wa/shared";
import type { Env } from "./env.js";

export interface Caller {
  userId: string;
  orgId: string;
  role: "owner" | "staff";
}

/**
 * Who is calling, and which org they may act on.
 *
 * The token is verified by asking Supabase rather than by checking a signature here:
 * that keeps the JWT secret out of the Worker entirely, and the round trip is I/O,
 * which is free against the 10ms CPU budget.
 */
export async function authenticate(env: Env, authorization: string | undefined): Promise<Caller | null> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!token) return null;

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!res.ok) return null;

  const user = (await res.json()) as { id?: string };
  if (!user.id) return null;

  // Membership decides the org. Nothing the browser sends may choose it, or one client
  // could act as another by changing a request body.
  const { data, error } = await createServiceClient(env)
    .from("org_members")
    .select("org_id,role")
    .eq("user_id", user.id)
    .maybeSingle<{ org_id: string; role: "owner" | "staff" }>();

  if (error) throw new Error(`membership lookup failed: ${error.message}`);
  if (!data) return null;

  return { userId: user.id, orgId: data.org_id, role: data.role };
}
