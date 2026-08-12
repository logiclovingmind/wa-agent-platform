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
  // `mfa` sits on this variant alone because it is admin privilege that is worth a
  // second factor, and a client route then has no field it could forget to check. A
  // member holding a factor is still challenged at sign-in — that is GoTrue's doing,
  // not ours.
  | { kind: "platform_admin"; userId: string; mfa: MfaState };

/**
 * Whether a second factor has been satisfied — and first, whether one is owed at all.
 *
 * `none` is what makes this safe to deploy: an account with no verified factor is owed
 * nothing, so the enrolment screen is reachable from an ordinary session and the guard
 * cannot lock out an admin who has not set it up yet. The demand appears the moment the
 * factor does, and never before.
 */
export type MfaState = "none" | "satisfied" | "required";

/** A factor GoTrue returns on the user object. Unverified ones are half-finished
 *  enrolments and demand nothing. */
type Factor = { status?: string };

/**
 * The session's assurance level, read from the token's own claims.
 *
 * Decoding without verifying is normally the classic JWT mistake; it is sound here only
 * because it happens *after* `/auth/v1/user` has answered 200 for this exact string,
 * which is what establishes the signature. Doing it this way keeps the promise made
 * above — the JWT secret never enters the Worker — and costs no second round trip.
 *
 * Anything unreadable returns null, which reads as "not aal2" and therefore denies. A
 * malformed token must never be the thing that satisfies the requirement.
 */
function sessionAal(token: string): string | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const payload = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return (JSON.parse(payload) as { aal?: string }).aal ?? null;
  } catch {
    return null;
  }
}

function mfaState(token: string, factors: Factor[] | undefined): MfaState {
  if (!factors?.some((f) => f.status === "verified")) return "none";
  return sessionAal(token) === "aal2" ? "satisfied" : "required";
}

/**
 * The whole admission rule for admin routes, in one place because it has two call
 * sites — the `/api/admin/*` middleware and `/api/usage/balance` — and a gate that
 * exists twice is a gate that eventually disagrees with itself.
 *
 * Returns the refusal, or null to let the caller through. `mfa_required` is on the body
 * so the dashboard can tell "you are not an admin" apart from "you are, but this
 * session is one factor short" — the second is fixed by typing six digits, and a screen
 * that said "admin only" to that would be lying.
 */
export function denyAdmin(caller: Caller): { error: string; mfa_required?: true } | null {
  if (caller.kind !== "platform_admin") return { error: "admin only" };
  if (caller.mfa === "required") return { error: "two-factor required", mfa_required: true };
  return null;
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

  // `factors` rides on the call already being made — the same one supabase-js reads for
  // listFactors() — so the second factor costs no extra I/O and no extra CPU.
  const user = (await res.json()) as { id?: string; factors?: Factor[] };
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
  if (admin.data?.is_platform_admin) {
    return { kind: "platform_admin", userId: user.id, mfa: mfaState(token, user.factors) };
  }

  return null;
}
