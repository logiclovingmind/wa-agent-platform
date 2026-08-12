// A lead is the one thing in this database a competitor would actually want: names,
// numbers, and what each person is about to spend. It is also the only table written by
// an upsert, so both halves are worth holding down — that org B cannot read it, and that
// a later reply cannot erase what an earlier one learned.
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
  }>("select name, intent, budget from leads where conversation_id = $1", [conversationId]);
  return rows[0];
}

describe("leads", () => {
  it("merges a later turn into the earlier one", async () => {
    await db.query("select public.record_lead($1, $2, $3, $4, $5, $6, $7)", [
      fx.orgA,
      fx.convA,
      "Ananya",
      "Weekend batch",
      null,
      "₹18,000",
      null,
    ]);

    // The second reply knows the name and not the budget, which is the ordinary case: the
    // customer said it once, ten messages ago. A plain upsert would blank it here, and
    // the owner would watch a lead get worse the longer the conversation ran.
    await db.query("select public.record_lead($1, $2, $3, $4, $5, $6, $7)", [
      fx.orgA,
      fx.convA,
      "Ananya Rao",
      "Weekend batch — data science",
      null,
      "",
      null,
    ]);

    expect(await lead(fx.convA)).toEqual({
      name: "Ananya Rao",
      intent: "Weekend batch — data science",
      budget: "₹18,000",
    });
  });

  it("keeps one row per conversation", async () => {
    const { rows } = await db.query<{ n: string }>(
      "select count(*)::text as n from leads where conversation_id = $1",
      [fx.convA],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("hides org B's leads from org A", async () => {
    await db.query("select public.record_lead($1, $2, $3, $4, $5, $6, $7)", [
      fx.orgB,
      fx.convB,
      "Someone else",
      "Not org A's business",
      null,
      null,
      null,
    ]);

    const rows = await asUser(db, fx.userA, async () =>
      (await db.query<{ org_id: string }>("select org_id from leads")).rows,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(fx.orgA);
  });

  // record_lead is security definer, so it runs as the owner of the function and RLS
  // does not apply inside it. Nothing but the Worker's service_role may call it — a
  // logged-in browser holding the anon key must not be able to write a lead into any
  // org, least of all one it names itself.
  it("refuses record_lead to a logged-in owner", async () => {
    await expect(
      asUser(db, fx.userA, () =>
        db.query("select public.record_lead($1, $2, $3, $4, $5, $6, $7)", [
          fx.orgB,
          fx.convB,
          null,
          "forged",
          null,
          null,
          null,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  // Unlike a usage event, a lead has nothing to prove once the thread is gone — and
  // keeping the contact details of a conversation someone asked us to erase is the
  // failure mode that matters here, not a lost row.
  it("goes with its conversation", async () => {
    await db.query("delete from conversations where id = $1", [fx.convA]);
    expect(await lead(fx.convA)).toBeUndefined();
  });
});
