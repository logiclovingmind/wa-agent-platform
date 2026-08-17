// Moving a booking, and marking what happened at the hour.
//
// The case that matters here is the half-done move. A reschedule is two writes — take the
// new slot, close the old row — and if the new slot has gone in between, stopping after the
// first one leaves a customer with no time at all while the diary says they were seen to.
// So the old booking has to survive a refusal intact.
//
// The second case is the no-show, which must *not* be closed when it is rebooked: it is what
// `desk_queue` reads to put the customer back on the desk, and losing it loses the callback.
//
// `asUser` rolls back, so every assertion has to happen inside the same call.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asUser, connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;

const MONDAY = "2027-03-01";
const at = (time: string) => `${MONDAY}T${time}:00+05:30`;

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

async function book(org: string, startsAt: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "select public.book_manual($1, $2, $3, 'Course counselling') as id",
    [org, startsAt, name],
  );
  return rows[0]!.id;
}

async function moveTo(org: string, id: string, startsAt: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string | null }>(
    "select public.reschedule_appointment($1, $2, $3) as id",
    [org, id, startsAt],
  );
  return rows[0]!.id;
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    "select status from appointments where id = $1",
    [id],
  );
  return rows[0]!.status;
}

describe("reschedule_appointment", () => {
  it("takes the new slot, cancels the old row and carries the customer over", async () => {
    await asOwnerA(async () => {
      const first = await book(fx.orgA, at("11:00"), "Ravi");
      const second = await moveTo(fx.orgA, first, at("15:00"));
      expect(second).not.toBeNull();

      // Cancelled, never deleted: the row is the proof this customer was once promised
      // eleven o'clock, and the diary reads it that way everywhere else.
      expect(await statusOf(first)).toBe("cancelled");

      const { rows } = await db.query<{ customer_name: string; service: string; ist: string }>(
        `select customer_name, service,
                to_char(starts_at at time zone 'Asia/Kolkata', 'HH24:MI') as ist
         from appointments where id = $1`,
        [second],
      );
      expect(rows[0]).toEqual({
        customer_name: "Ravi",
        service: "Course counselling",
        ist: "15:00",
      });
    });
  });

  it("leaves the booking where it is when the new slot has gone", async () => {
    await asOwnerA(async () => {
      const mine = await book(fx.orgA, at("11:00"), "Ravi");
      await book(fx.orgA, at("15:00"), "Somebody quicker");

      expect(await moveTo(fx.orgA, mine, at("15:00"))).toBeNull();
      // The whole point. A refusal that had already cancelled this row would leave Ravi
      // with no appointment and nobody any the wiser.
      expect(await statusOf(mine)).toBe("booked");
    });
  });

  it("refuses a time that is not on the grid", async () => {
    await asOwnerA(async () => {
      const mine = await book(fx.orgA, at("11:00"), "Ravi");
      // Same grid as every other writer. 11:17 collides with nothing, so the assistant
      // would go on offering 11:00 and 11:30 on top of it.
      expect(await moveTo(fx.orgA, mine, at("11:17"))).toBeNull();
      expect(await statusOf(mine)).toBe("booked");
    });
  });

  it("keeps a no-show standing when it is rebooked", async () => {
    await asOwnerA(async () => {
      const missed = await book(fx.orgA, at("11:00"), "Ravi");
      await db.query("update appointments set status = 'no_show' where id = $1", [missed]);

      expect(await moveTo(fx.orgA, missed, at("15:00"))).not.toBeNull();
      // Cancelling it would take the customer off the desk's callback list at the exact
      // moment somebody proved they were worth calling.
      expect(await statusOf(missed)).toBe("no_show");
    });
  });

  it("does not move a block", async () => {
    await asOwnerA(async () => {
      await db.query("select public.block_time($1, $2, $3, 'Staff training')", [
        fx.orgA,
        at("11:00"),
        at("11:30"),
      ]);
      const { rows } = await db.query<{ id: string }>(
        "select id from appointments where org_id = $1 and kind = 'block'",
        [fx.orgA],
      );
      // A block is unblocked and blocked again. Moving one through here would take the
      // reason text with it and leave the original stretch quietly open.
      expect(await moveTo(fx.orgA, rows[0]!.id, at("15:00"))).toBeNull();
    });
  });

  it("cannot move another org's booking", async () => {
    // Written outside the session under test, because org A cannot create it either.
    const { rows } = await db.query<{ id: string }>(
      `insert into appointments (org_id, starts_at, duration_minutes, customer_name)
       values ($1, $2, 30, 'Not yours') returning id`,
      [fx.orgB, at("16:00")],
    );
    const theirs = rows[0]!.id;

    await asOwnerA(async () => {
      // Org A's session cannot see the row, so there is nothing to move. A `security
      // definer` version of this function would take the org id at its word.
      expect(await moveTo(fx.orgB, theirs, at("15:00"))).toBeNull();
    });

    const still = await statusOf(theirs);
    expect(still).toBe("booked");
    await db.query("delete from appointments where id = $1", [theirs]);
  });
});

describe("attendance", () => {
  it("keeps the slot spent whichever way the hour went", async () => {
    await asOwnerA(async () => {
      const id = await book(fx.orgA, at("11:00"), "Ravi");
      for (const status of ["attended", "no_show"]) {
        await db.query("update appointments set status = $2 where id = $1", [id, status]);
        const { rows } = await db.query<{ ist: string }>(
          `select to_char(starts_at at time zone 'Asia/Kolkata', 'HH24:MI') as ist
           from public.day_slots($1, $2)`,
          [fx.orgA, MONDAY],
        );
        // Offering 11:00 to somebody new because the last customer did not turn up is a
        // lie about an hour that has already been spent.
        expect(rows.map((r) => r.ist)).not.toContain("11:00");
      }
    });
  });
});
