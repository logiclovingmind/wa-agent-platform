// The second factor, enforced where it actually has to hold.
//
// The Worker's `denyAdmin()` only sees traffic that goes through the Worker, and the
// admin panel does not: `Admin.tsx` calls `admin_orgs()` and `admin_health()` straight
// from the browser, and reads `audit_log` over PostgREST under an RLS policy. So the
// question this file asks is the one the Worker cannot answer — with a password alone
// and a factor enrolled, what can a session still read?
//
// The rule is conditional on purpose. No verified factor means no aal2 demand, because
// the screen that enrols one sits behind the same session. Getting that backwards locks
// out the only account that could undo it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;
let admin: string;

/** `asUser`, plus the claim that says whether this session cleared a second factor. */
async function asUserAtAal<T>(userId: string, aal: string, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aal }),
    ]);
    await db.query("set local role authenticated");
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

async function enrolFactor(status: "verified" | "unverified") {
  await db.query("delete from auth.mfa_factors where user_id = $1", [admin]);
  await db.query("insert into auth.mfa_factors (user_id, status) values ($1, $2)", [
    admin,
    status,
  ]);
}

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);

  const user = (
    await db.query<{ id: string }>(
      "insert into auth.users (email) values ($1) returning id",
      ["mfa-admin@test"],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into users (id, org_id, email, is_platform_admin) values ($1, null, $2, true)",
    [user, "mfa-admin@test"],
  );
  admin = user;
});

afterAll(async () => {
  await db.end();
});

describe("app.is_platform_admin() and the second factor", () => {
  it("holds for an admin who has enrolled nothing, so enrolment stays reachable", async () => {
    await db.query("delete from auth.mfa_factors where user_id = $1", [admin]);
    const ok = await asUserAtAal(admin, "aal1", async () =>
      (await db.query<{ ok: boolean }>("select app.is_platform_admin() as ok")).rows[0]!.ok,
    );
    expect(ok).toBe(true);
  });

  it("ignores a half-finished enrolment", async () => {
    // `enroll()` writes the factor before any code is typed. Counting an unverified one
    // would lock the account out of the very screen that finishes the job.
    await enrolFactor("unverified");
    const ok = await asUserAtAal(admin, "aal1", async () =>
      (await db.query<{ ok: boolean }>("select app.is_platform_admin() as ok")).rows[0]!.ok,
    );
    expect(ok).toBe(true);
  });

  it("fails at aal1 once a factor is verified, and passes at aal2", async () => {
    await enrolFactor("verified");
    const at = async (aal: string) =>
      asUserAtAal(admin, aal, async () =>
        (await db.query<{ ok: boolean }>("select app.is_platform_admin() as ok")).rows[0]!.ok,
      );
    expect(await at("aal1")).toBe(false);
    expect(await at("aal2")).toBe(true);
  });

  it("treats a session with no aal claim as unverified", async () => {
    // A missing claim must never be the thing that satisfies the requirement.
    await enrolFactor("verified");
    const ok = await asUserAtAal(admin, "", async () =>
      (await db.query<{ ok: boolean }>("select app.is_platform_admin() as ok")).rows[0]!.ok,
    );
    expect(ok).toBe(false);
  });
});

describe("what an aal1 admin can still reach over PostgREST", () => {
  it("is refused by every admin RPC the browser calls directly", async () => {
    await enrolFactor("verified");

    // These three are the whole admin panel's data, and none of them passes through the
    // Worker. Each inlined its own copy of the admin test until 0025 pointed them at
    // the helper — which is why they are asserted by name rather than in the abstract.
    for (const fn of ["admin_orgs", "admin_health", "admin_flags"]) {
      await expect(
        asUserAtAal(admin, "aal1", () => db.query(`select * from public.${fn}()`)),
        `${fn}() answered a session that had not cleared its second factor`,
      ).rejects.toThrow(/admin only/);
    }
  });

  it("reads no audit_log rows, which are guarded by RLS rather than a raise", async () => {
    await enrolFactor("verified");
    await db.query(
      "insert into audit_log (org_id, actor_user_id, action) values ($1, $2, 'test_action')",
      [fx.orgA, admin],
    );

    // RLS answers with silence, not an error, so the assertion has to be a count. An
    // empty result here is the policy working; the aal2 case below proves the row
    // existed to be hidden.
    const hidden = await asUserAtAal(admin, "aal1", async () =>
      (await db.query<{ n: string }>("select count(*)::text as n from audit_log")).rows[0]!.n,
    );
    expect(hidden).toBe("0");

    const visible = await asUserAtAal(admin, "aal2", async () =>
      (await db.query<{ n: string }>("select count(*)::text as n from audit_log")).rows[0]!.n,
    );
    expect(Number(visible)).toBeGreaterThan(0);
  });

  it("lets the three RPCs through again at aal2", async () => {
    await enrolFactor("verified");
    for (const fn of ["admin_orgs", "admin_health", "admin_flags"]) {
      await expect(
        asUserAtAal(admin, "aal2", () => db.query(`select * from public.${fn}()`)),
      ).resolves.toBeDefined();
    }
  });
});
