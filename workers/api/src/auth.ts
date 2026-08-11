import { createServiceClient } from "@wa/shared";
import type { Env } from "./env.js";

/**
 * Two kinds of caller, and no way to be both.
 *
 * A platform admin deliberately holds **no `org_members` row** (0013), which is what
 * makes "we cannot read your customers' conversations" a fact about Postgres rather than
 * a promise. The consequence is that they have no `orgId` at all, so this is a union
 * rather than an optional field: every route has to say which kind it serves, and
 * `createOrgDb` can never be handed an empty org.
 */
export type Caller =
  | { kind: "member"; userId: string; orgId: string; role: "owner" | "staff" }
  | { kind: "platform_admin"; userId: string };

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

  const sb = createServiceClient(env);

  // Membership decides the org. Nothing the browser sends may choose it, or one client
  // could act as another by changing a request body.
  const { data, error } = await sb
    .from("org_members")
    .select("org_id,role")
    .eq("user_id", user.id)
    .maybeSingle<{ org_id: string; role: "owner" | "staff" }>();

  if (error) throw new Error(`membership lookup failed: ${error.message}`);
  if (data) return { kind: "member", userId: user.id, orgId: data.org_id, role: data.role };

  // No membership is the normal state for exactly one account: us. Before 0013 that was
  // indistinguishable from a stranger and every admin route answered 401 — including
  // `/api/usage/balance`, whose whole point is that only a platform admin may call it.
  // Second lookup rather than a join, and only on the path where the first found
  // nothing, so a client's request still costs one round trip.
  const admin = await sb
    .from("users")
    .select("is_platform_admin")
    .eq("id", user.id)
    .maybeSingle<{ is_platform_admin: boolean }>();

  if (admin.error) throw new Error(`admin lookup failed: ${admin.error.message}`);
  if (admin.data?.is_platform_admin) return { kind: "platform_admin", userId: user.id };

  return null;
}
