// The other half of `leads.test.ts`. That file holds down the model's writer, which must
// merge; this one holds down the person's, which must not. The two are one word apart in
// SQL and opposite in effect, and the one that matters here is the delete: an owner who
// has just spoken to the customer clearing a budget the assistant guessed is the entire
// reason manual entry exists, and a coalesce would silently keep the wrong number.
//
// Every assertion is made inside the `asUser` block, because that block is a transaction
// that always rolls back — a read taken after it returns sees the database as it was
// before the write, which is a green test for a function that did nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asUser, connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);
});

afterAll(async () => {
  await db.end();
});

async function lead(conversationId: string) {
  const { rows } = await db.query<{
    name: string | null;
    intent: string | null;
    budget: string | null;
    notes: string | null;
  }>("select name, intent, budget, notes from leads where conversation_id = $1", [
    conversationId,
  ]);
  return rows[0];
}

const edit = (conversationId: string, values: (string | null)[]) =>
  db.query<{ id: string | null }>(
    "select public.edit_lead($1, $2, $3, $4, $5, $6) as id",
    [conversationId, ...values],
  );

describe("edit_lead", () => {
  it("writes a lead the assistant never made", async () => {
    const written = await asUser(db, fx.userA, async () => {
      const { rows } = await edit(fx.convA, [
        "Ananya Rao",
        "Weekend batch",
        "Next Saturday",
        "₹18,000",
        "Called, keen",
      ]);
      expect(rows[0]!.id).not.toBeNull();
      return lead(fx.convA);
    });

    expect(written).toEqual({
      name: "Ananya Rao",
      intent: "Weekend batch",
      budget: "₹18,000",
      notes: "Called, keen",
    });
  });

  // The one behaviour that separates this from `record_lead`. A blank box is the owner
  // deleting something the model got wrong, not a field it failed to mention.
  it("clears a field, where record_lead would have kept it", async () => {
    const corrected = await asUser(db, fx.userA, async () => {
      await edit(fx.convA, ["Ananya Rao", "Weekend batch", null, "₹18,000", "Called, keen"]);
      await edit(fx.convA, ["Ananya Rao", "Weekend batch", null, "", null]);
      return lead(fx.convA);
    });

    expect(corrected).toEqual({
      name: "Ananya Rao",
      intent: "Weekend batch",
      budget: null,
      notes: null,
    });
  });

  // No org id in the signature, and invoker rights: org B's conversation is invisible to
  // A, so the lookup finds nothing and the function writes nothing rather than throwing.
  // A thrown error would be acceptable too; a written row would not.
  it("will not touch another org's conversation", async () => {
    await asUser(db, fx.userA, async () => {
      const { rows } = await edit(fx.convB, ["forged", "forged", null, null, null]);
      expect(rows[0]!.id).toBeNull();
      expect(await lead(fx.convB)).toBeUndefined();
    });
  });

  // The column grant, not the policy. A lead may be corrected; it may not be moved to
  // another customer, which is how one org's enquiry ends up on another's export.
  it("refuses to move a lead to another conversation", async () => {
    await expect(
      asUser(db, fx.userA, () =>
        db.query("update leads set conversation_id = $1 where conversation_id = $2", [
          fx.convB,
          fx.convA,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("book_manual from a thread", () => {
  let at: string;

  beforeAll(async () => {
    await db.query(
      `insert into business_hours (org_id, weekday, opens_at, closes_at, slot_minutes)
       select $1, d, time '09:00', time '18:00', 30 from generate_series(0, 6) as d`,
      [fx.orgA],
    );
    const { rows } = await db.query<{ starts_at: string }>(
      "select starts_at from public.free_slots($1, 7, 1)",
      [fx.orgA],
    );
    at = rows[0]!.starts_at;
  });

  it("keeps the thread and still counts as a person's booking", async () => {
    const booked = await asUser(db, fx.userA, async () => {
      const { rows } = await db.query<{ id: string | null }>(
        "select public.book_manual($1, $2, 'Ananya Rao', 'Course counselling', $3) as id",
        [fx.orgA, at, fx.convA],
      );
      const { rows: found } = await db.query<{ conversation_id: string; source: string }>(
        "select conversation_id, source from appointments where id = $1",
        [rows[0]!.id],
      );
      return found[0];
    });

    // The link is what lets `desk_queue` put this customer back on the desk if they do
    // not turn up; the source is what stops the diary crediting it to the assistant.
    expect(booked).toEqual({ conversation_id: fx.convA, source: "person" });
  });

  it("still books without a thread, as the diary's own form does", async () => {
    const booked = await asUser(db, fx.userA, async () => {
      const { rows } = await db.query<{ id: string | null }>(
        "select public.book_manual($1, $2, 'Walk-in', null) as id",
        [fx.orgA, at],
      );
      const { rows: found } = await db.query<{ conversation_id: string | null; source: string }>(
        "select conversation_id, source from appointments where id = $1",
        [rows[0]!.id],
      );
      return found[0];
    });

    expect(booked).toEqual({ conversation_id: null, source: "person" });
  });

  it("refuses a thread belonging to another org", async () => {
    await expect(
      asUser(db, fx.userA, () =>
        db.query("select public.book_manual($1, $2, 'Forged', null, $3)", [
          fx.orgA,
          at,
          fx.convB,
        ]),
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
