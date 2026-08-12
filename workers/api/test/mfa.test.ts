import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { stubSupabase } from "./fake-supabase.js";

/**
 * The second factor, from the Worker's side.
 *
 * The rule under test is deliberately conditional: an admin with no verified factor is
 * owed nothing, because the screen that enrols one is behind the same session the guard
 * would otherwise refuse. Get that backwards and the only account able to fix it is the
 * account that is locked out.
 */

const ADMIN = "55555555-5555-5555-5555-555555555555";
const ORG_A = "11111111-1111-1111-1111-111111111111";

/** A token shaped like GoTrue's, carrying only the claim `authenticate` reads. */
function tokenWithAal(aal: string) {
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: ADMIN, aal })}.signature`;
}

function harness(opts: { admin?: boolean; factors?: Array<{ status: string }> } = {}) {
  return stubSupabase(
    (call) => {
      switch (call.table.split("?")[0]) {
        case "org_members":
          return opts.admin === false ? [{ org_id: ORG_A, role: "owner" }] : [];
        case "users":
          return [{ id: ADMIN, is_platform_admin: opts.admin !== false }];
        case "organizations":
          return [{ id: ORG_A, name: "Acme" }];
        default:
          return [];
      }
    },
    async (req, url) => {
      // The factor list rides on the user lookup the Worker already makes. Returning it
      // here is not a convenience of the test — it is where GoTrue actually puts it.
      if (url.pathname === "/auth/v1/user") {
        return Response.json({ id: ADMIN, factors: opts.factors ?? [] });
      }
      if (url.pathname === "/api/v1/credits") {
        return Response.json({ data: { credits_inr: 408.42 } });
      }
      throw new Error(`unexpected outbound fetch: ${req.method} ${req.url}`);
    },
  );
}

async function get(path: string, token: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, { headers: { authorization: `Bearer ${token}` } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

afterEach(() => vi.unstubAllGlobals());

describe("admin routes and the second factor", () => {
  it("lets an admin with no enrolled factor through, so enrolment is reachable", async () => {
    harness({ admin: true, factors: [] });
    const res = await get("/api/admin/platform", tokenWithAal("aal1"));
    expect(res.status).toBe(200);
  });

  it("ignores a half-finished enrolment", async () => {
    // `enroll()` creates the factor before any code is typed. Treating an unverified
    // one as a requirement would lock the account out at exactly the moment someone
    // started setting this up and then closed the tab.
    harness({ admin: true, factors: [{ status: "unverified" }] });
    const res = await get("/api/admin/platform", tokenWithAal("aal1"));
    expect(res.status).toBe(200);
  });

  it("refuses an aal1 session once a factor is verified", async () => {
    harness({ admin: true, factors: [{ status: "verified" }] });
    const res = await get("/api/admin/platform", tokenWithAal("aal1"));
    expect(res.status).toBe(403);
    // Distinguishable from "admin only": one is fixed by six digits, the other never is.
    expect(await res.json()).toEqual({ error: "two-factor required", mfa_required: true });
  });

  it("accepts the same session once it reaches aal2", async () => {
    harness({ admin: true, factors: [{ status: "verified" }] });
    const res = await get("/api/admin/platform", tokenWithAal("aal2"));
    expect(res.status).toBe(200);
  });

  it("guards the wallet too, not just /api/admin/*", async () => {
    // `/api/usage/balance` is the second call site of the same rule, and the one most
    // easily forgotten: it hangs off the client router, not the admin one.
    harness({ admin: true, factors: [{ status: "verified" }] });
    expect((await get("/api/usage/balance", tokenWithAal("aal1"))).status).toBe(403);
    expect((await get("/api/usage/balance", tokenWithAal("aal2"))).status).toBe(200);
  });

  it("denies when the token carries no readable claims", async () => {
    // An opaque or malformed token must not be the thing that satisfies the
    // requirement. Unreadable reads as aal1.
    harness({ admin: true, factors: [{ status: "verified" }] });
    expect((await get("/api/admin/platform", "opaque")).status).toBe(403);
  });

  it("still answers 'admin only' to a client owner, factor or not", async () => {
    harness({ admin: false, factors: [{ status: "verified" }] });
    const res = await get("/api/admin/platform", tokenWithAal("aal2"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin only" });
  });
});
