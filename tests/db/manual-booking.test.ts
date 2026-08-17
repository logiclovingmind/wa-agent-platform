// Hand-entered bookings, for the customer who phoned or who was handed to a person before
// a time was ever agreed.
//
// The case that matters most here is "refuses a time off the grid". `free_slots` decides
// availability by comparing `starts_at` for equality, so a 09:15 booking would sit between
// two slots the assistant still believes are free and it would book a second customer on
// top of the walk-in. Nothing else in the system would notice: the unique index is on the
// instant, and 09:15 collides with nothing.
//
// `asUser` rolls back, so every assertion has to happen inside the same call.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asUser, connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;

const MONDAY = "2027-03-01";
const at = (time: string) => `${MONDAY}T${time}:00+05:30`;
/** A Sunday, which the seeded week below does not open. */
const SUNDAY = "2027-02-28";

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);
  for (const org of [fx.orgA, fx.orgB]) {
    await db.query(
      `insert into business_hours (org_id, weekday, opens_at, closes_at, slot_minutes)
       select $1, d, time '09:30', time '19:00', 30 from generate_series(1, 6) as d`,
      [org],
    );
  }
});

afterAll(async () => {
  await db.end();
});

function asOwnerA<T>(fn: () => Promise<T>): Promise<T> {
  return asUser(db, fx.userA, fn);
}

async function book(org: string, startsAt: string, name: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string | null }>(
    "select public.book_manual($1, $2, $3, 'Course counselling') as id",
    [org, startsAt, name],
  );
  return rows[0]!.id;
}

async function slotTimes(org: string, day: string): Promise<string[]> {
  const { rows } = await db.query<{ ist: string }>(
    `select to_char(starts_at at time zone 'Asia/Kolkata', 'HH24:MI') as ist
     from public.day_slots($1, $2)`,
    [org, day],
  );
  return rows.map((r) => r.ist);
}

describe("book_manual", () => {
  it("takes a slot on the grid and records no conversation", async () => {
    await asOwnerA(async () => {
      const id = await book(fx.orgA, at("11:00"), "Walk-in Ravi");
      expect(id).not.toBeNull();

      const { rows } = await db.query<{
        conversation_id: string | null;
        duration_minutes: number;
        customer_name: string;
        kind: string;
      }>(
        `select conversation_id, duration_minutes, customer_name, kind
         from appointments where id = $1`,
        [id],
      );
      // Null conversation is how the diary tells a hand-entered booking from one the
      // assistant took, and it is the only way an owner can tell whether there is a thread
      // to go and read.
      expect(rows[0]).toEqual({
        conversation_id: null,
        duration_minutes: 30,
        customer_name: "Walk-in Ravi",
        kind: "appointment",
      });
    });
  });

  it("refuses a time that is not on the grid", async () => {
    await asOwnerA(async () => {
      // Inside opening hours, and still not a slot anyone was ever offered.
      expect(await book(fx.orgA, at("11:17"), "Off grid")).toBeNull();
      // The neighbours have to survive, or the refusal has quietly cost two real slots.
      const free = await slotTimes(fx.orgA, MONDAY);
      expect(free).toContain("11:00");
      expect(free).toContain("11:30");
    });
  });

  it("refuses a slot somebody already has", async () => {
    await asOwnerA(async () => {
      expect(await book(fx.orgA, at("11:00"), "First")).not.toBeNull();
      expect(await book(fx.orgA, at("11:00"), "Second")).toBeNull();
    });
  });

  it("refuses a day the business is closed", async () => {
    await asOwnerA(async () => {
      expect(await book(fx.orgA, `${SUNDAY}T11:00:00+05:30`, "Sunday")).toBeNull();
      expect(await slotTimes(fx.orgA, SUNDAY)).toEqual([]);
    });
  });

  it("cannot book into another org's diary", async () => {
    await asOwnerA(async () => {
      // Org B's `business_hours` are invisible under org A's session, so there is no slot
      // length to be found and the booking is refused. A `security definer` version of
      // this function would take the org id at its word and write the row.
      expect(await book(fx.orgB, at("11:00"), "Trespass")).toBeNull();
      expect(await slotTimes(fx.orgB, MONDAY)).toEqual([]);
    });
  });
});

describe("day_slots", () => {
  it("stops offering a slot once it is taken", async () => {
    await asOwnerA(async () => {
      expect(await slotTimes(fx.orgA, MONDAY)).toContain("11:00");
      await book(fx.orgA, at("11:00"), "Ravi");
      expect(await slotTimes(fx.orgA, MONDAY)).not.toContain("11:00");
    });
  });

  it("offers the time again when a booking is cancelled", async () => {
    await asOwnerA(async () => {
      const id = await book(fx.orgA, at("11:00"), "Ravi");
      await db.query("update appointments set status = 'cancelled' where id = $1", [id]);
      // Same rule as everywhere else: a cancelled row is kept as proof, and is not a
      // reason to keep the time off the market.
      expect(await slotTimes(fx.orgA, MONDAY)).toContain("11:00");
    });
  });
});
