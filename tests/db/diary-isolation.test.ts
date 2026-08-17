// Test 3's shape, applied to the two tables the Diary tab added to the browser's reach.
//
// The client diary is the first screen to read `appointments` and `business_hours` from
// the browser — the training console reaches them through the Worker instead, so until
// this file the RLS on both was never exercised by a logged-in client at all. What one
// salon has booked, and who by name, is exactly the kind of row that must not cross an org.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asUser, connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;
/** A second account in org A, staff rather than owner — the role split 0029 encodes. */
let staffA: string;

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);

  for (const org of [fx.orgA, fx.orgB]) {
    await db.query(
      `insert into business_hours (org_id, weekday, opens_at, closes_at, slot_minutes)
       select $1, d, time '09:30', time '19:00', 30 from generate_series(1, 6) as d`,
      [org],
    );
    await db.query(
      `insert into appointments (org_id, starts_at, customer_name, service)
       values ($1, now() + interval '2 days', $2, 'Haircut')`,
      [org, `customer of ${org}`],
    );
  }

  const user = (
    await db.query<{ id: string }>(
      "insert into auth.users (email) values ('staff@alpha.test') returning id",
    )
  ).rows[0]!.id;
  await db.query("insert into users (id, org_id, email) values ($1, $2, 'staff@alpha.test')", [
    user,
    fx.orgA,
  ]);
  await db.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'staff')", [
    fx.orgA,
    user,
  ]);
  staffA = user;
});

afterAll(async () => {
  await db.end();
});

describe("diary isolation, browser path", () => {
  it("shows an owner only their own diary", async () => {
    const seen = await asUser(db, fx.userA, async () => ({
      appointments: (await db.query<{ org_id: string }>("select org_id from appointments")).rows,
      hours: (await db.query("select id from business_hours")).rowCount,
    }));

    expect(seen.appointments).toHaveLength(1);
    expect(seen.appointments[0]!.org_id).toBe(fx.orgA);
    // Six weekdays for org A and not the twelve rows in the table.
    expect(seen.hours).toBe(6);
  });

  it("returns nothing when it asks for org B's diary directly", async () => {
    for (const table of ["appointments", "business_hours"]) {
      const count = await asUser(db, fx.userA, async () =>
        (
          await db.query<{ n: string }>(
            `select count(*)::text as n from ${table} where org_id = $1`,
            [fx.orgB],
          )
        ).rows[0]!.n,
      );

      expect(count, `${table} leaked org B to org A`).toBe("0");
    }
  });

  // The Cancel button on the Diary tab. Staff answer the inbox and mark bookings
  // (data-model.md's roles table), so this is deliberately not owner-gated.
  it("lets staff cancel a booking", async () => {
    const cancelled = await asUser(db, staffA, async () =>
      (
        await db.query(
          "update appointments set status = 'cancelled' where org_id = $1 returning id",
          [fx.orgA],
        )
      ).rowCount,
    );

    expect(cancelled).toBe(1);
  });

  // ...and the hours editor above it is rendered for owners only. That gate is a courtesy
  // in React; this is the lock. Opening hours decide what the assistant promises customers
  // on every future turn, which is not a thing an inbox seat should be able to rewrite.
  it("refuses staff the opening hours", async () => {
    await expect(
      asUser(db, staffA, () =>
        db.query(
          `insert into business_hours (org_id, weekday, opens_at, closes_at)
           values ($1, 0, time '08:00', time '20:00')`,
          [fx.orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses an owner a booking written into another org", async () => {
    await expect(
      asUser(db, fx.userA, () =>
        db.query(
          "insert into appointments (org_id, starts_at) values ($1, now() + interval '3 days')",
          [fx.orgB],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
