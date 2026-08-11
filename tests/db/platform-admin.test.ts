// The platform admin is a separate account from any client's owner, and the separation
// has to hold in Postgres rather than in the dashboard's tab list. An admin belongs to
// no org: every client table is gated on `app.is_member(org_id)` with no platform-admin
// escape, so the account that can see the all-clients rollup cannot read a single
// customer message behind it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asUser, connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;
let admin: string;

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);

  const user = (
    await db.query<{ id: string }>(
      "insert into auth.users (email) values ($1) returning id",
      ["platform@test"],
    )
  ).rows[0]!.id;

  // org_id null and no org_members row — this is the shape 0013 made legal, and it is
  // the whole account. A placeholder org here would defeat the test.
  await db.query(
    "insert into users (id, org_id, email, is_platform_admin) values ($1, null, $2, true)",
    [user, "platform@test"],
  );
  admin = user;
});

afterAll(async () => {
  await db.end();
});

describe("platform admin", () => {
  it("reads no customer data from any org", async () => {
    for (const table of ["conversations", "messages", "usage_events", "safety_flags"]) {
      const count = await asUser(db, admin, async () =>
        (await db.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]!.n,
      );

      expect(count, `${table} was readable by a platform admin`).toBe("0");
    }
  });

  it("still gets the all-clients rollup", async () => {
    const rows = await asUser(db, admin, async () =>
      (await db.query<{ org_id: string; conversations: string }>(
        "select org_id, conversations from public.admin_orgs()",
      )).rows,
    );

    // Counts arrive through the security-definer rollup even though the rows they were
    // computed from are unreadable to this caller — which is the point of the split.
    expect(rows.map((r) => r.org_id).sort()).toEqual([fx.orgA, fx.orgB].sort());
    expect(rows.map((r) => r.conversations)).toEqual(["1", "1"]);
  });

  it("sorts the demo org below paying clients", async () => {
    await db.query("begin");
    try {
      await db.query("update organizations set is_demo = true where id = $1", [fx.orgA]);
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: admin, role: "authenticated" }),
      ]);
      await db.query("set local role authenticated");

      const rows = (
        await db.query<{ org_id: string; is_demo: boolean }>(
          "select org_id, is_demo from public.admin_orgs()",
        )
      ).rows;

      // alpha sorts before bravo by name, so demo-last is the only thing that can put
      // it second here.
      expect(rows.map((r) => r.org_id)).toEqual([fx.orgB, fx.orgA]);
      expect(rows.map((r) => r.is_demo)).toEqual([false, true]);
    } finally {
      await db.query("rollback");
    }
  });

  // Where the line falls for the management panel: an admin may see that an org exists
  // and who its people are, because onboarding and support need exactly that, and may
  // not see what those people's customers said.
  it("sees orgs and their members, but not their conversations", async () => {
    const seen = await asUser(db, admin, async () => ({
      orgs: (await db.query("select id from organizations")).rowCount,
      members: (await db.query("select id from org_members")).rowCount,
      conversations: (await db.query("select id from conversations")).rowCount,
    }));

    expect(seen.orgs).toBe(2);
    expect(seen.members).toBe(2);
    expect(seen.conversations).toBe(0);
  });
});
