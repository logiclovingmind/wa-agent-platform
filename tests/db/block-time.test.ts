// `block_time` is the first write the browser makes through an RPC rather than a plain
// insert, and it is `security invoker` precisely so that the two policies on the tables it
// touches stay the only thing deciding whose diary it may write to. That claim is worth a
// test: if the function were ever changed to `security definer` to "make it work", the org
// id would become a bare argument and any logged-in client could block any other client's
// calendar. The last case here is the one that would catch it.
//
// `asUser` rolls back, so every assertion about what was written has to happen inside the
// same call — which also means these cases cannot leak rows into each other.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asUser, connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;

/** Monday to Saturday, 09:30-19:00 in 30-minute slots — the shape the demo org uses. */
async function openTheWeek(org: string) {
  await db.query(
    `insert into business_hours (org_id, weekday, opens_at, closes_at, slot_minutes)
     select $1, d, time '09:30', time '19:00', 30 from generate_series(1, 6) as d`,
    [org],
  );
}

/** A fixed Monday well in the future, so "now" never moves a case under it. */
const MONDAY = "2027-03-01";
const at = (time: string) => `${MONDAY}T${time}:00+05:30`;

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);
  await openTheWeek(fx.orgA);
  await openTheWeek(fx.orgB);
});

afterAll(async () => {
  await db.end();
});

/** Signed in as org A's owner, which is the only way this function is ever called. */
function asOwnerA<T>(fn: () => Promise<T>): Promise<T> {
  return asUser(db, fx.userA, fn);
}

async function block(org: string, from: string, to: string): Promise<number> {
  const { rows } = await db.query<{ block_time: number }>(
    "select public.block_time($1, $2, $3, 'Away') as block_time",
    [org, from, to],
  );
  return rows[0]!.block_time;
}

async function blocksAt(org: string): Promise<string[]> {
  const { rows } = await db.query<{ ist: string }>(
    `select to_char(starts_at at time zone 'Asia/Kolkata', 'HH24:MI') as ist
     from appointments where org_id = $1 and kind = 'block' order by starts_at`,
    [org],
  );
  return rows.map((r) => r.ist);
}

describe("block_time", () => {
  it("takes one row per slot, not one row for the range", async () => {
    // The whole trap: `free_slots` matches a booking to a slot by equality on `starts_at`,
    // so a single row covering 14:00-18:00 would leave 14:30 through 17:30 bookable.
    await asOwnerA(async () => {
      expect(await block(fx.orgA, at("14:00"), at("18:00"))).toBe(8);
      expect(await blocksAt(fx.orgA)).toEqual([
        "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30",
      ]);
    });
  });

  it("stops the assistant offering the time it blocked", async () => {
    await asOwnerA(async () => {
      await block(fx.orgA, at("14:00"), at("18:00"));
      const { rows } = await db.query<{ n: string }>(
        `select count(*) as n from public.free_slots($1, 400, 1000, 0) f
         where f.starts_at >= $2 and f.starts_at < $3`,
        [fx.orgA, at("14:00"), at("18:00")],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });

  it("leaves a booking that is already in the range alone", async () => {
    await asOwnerA(async () => {
      await db.query(
        `insert into appointments (org_id, starts_at, customer_name) values ($1, $2, 'Priya')`,
        [fx.orgA, at("10:00")],
      );

      // Three slots in the range, one of them already taken.
      expect(await block(fx.orgA, at("09:30"), at("11:00"))).toBe(2);

      const { rows } = await db.query<{ kind: string }>(
        "select kind from appointments where org_id = $1 and starts_at = $2",
        [fx.orgA, at("10:00")],
      );
      // A customer promised this time is not unpromised it by the owner marking themselves
      // away. The count coming back short is how the owner is told to deal with it.
      expect(rows).toEqual([{ kind: "appointment" }]);
    });
  });

  it("refuses a range wide enough to be a typo", async () => {
    await expect(
      asOwnerA(() => block(fx.orgA, at("09:30"), "2028-03-01T09:30:00+05:30")),
    ).rejects.toThrow(/90 days/);
  });

  it("cannot block another org's diary", async () => {
    await asOwnerA(async () => {
      // Zero, and no error. Org B's `business_hours` are invisible under org A's session,
      // so the grid comes back empty and there is nothing to insert. The number is the
      // assertion that matters: a `security definer` version of this function would
      // happily answer 8 here.
      expect(await block(fx.orgB, at("14:00"), at("18:00"))).toBe(0);
      expect(await blocksAt(fx.orgB)).toEqual([]);
    });
  });
});
