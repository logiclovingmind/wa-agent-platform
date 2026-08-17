// The desk's queue moved into Postgres because the browser was ranking the fifty most
// recent conversations and calling the result "everything that needs you". Two things are
// worth holding down now that it is a function: that it answers for one org only, and
// that a callback owed months ago still comes back — which is the entire reason it exists.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asUser, connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;
let stale: string;

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);

  // Org A's own conversation asked for a person, and is flagged on top of that.
  await db.query(
    `update conversations
       set handoff_state = 'requested',
           window_expires_at = now() + interval '2 hours',
           last_message_at = now()
     where id = $1`,
    [fx.convA],
  );
  await db.query(
    "insert into safety_flags (org_id, conversation_id, kind) values ($1, $2, 'distress')",
    [fx.orgA, fx.convA],
  );

  // A second conversation in org A that nobody has called back, last heard from months
  // ago. This is the row the old fifty-row list could never see.
  const wa = (
    await db.query<{ id: string }>("select id from wa_accounts where org_id = $1", [fx.orgA])
  ).rows[0]!.id;
  stale = (
    await db.query<{ id: string }>(
      `insert into conversations (org_id, wa_account_id, customer_wa_id, last_message_at)
       values ($1, $2, '919000000777', now() - interval '120 days') returning id`,
      [fx.orgA, wa],
    )
  ).rows[0]!.id;
  await db.query("select public.record_lead($1, $2, $3, $4, null, null, null)", [
    fx.orgA,
    stale,
    "Old Enquiry",
    "Wanted a quote",
  ]);

  // Org B's conversation is waiting too, so a leak would be visible rather than merely
  // possible.
  await db.query("update conversations set handoff_state = 'human' where id = $1", [fx.convB]);
});

afterAll(async () => {
  await db.end();
});

interface Row {
  id: string;
  reason: string;
  rank: number;
  flag_kinds: string[];
  intent: string | null;
}

function queue(userId: string, orgId: string) {
  return asUser(db, userId, async () =>
    (
      await db.query<Row>(
        "select id, reason, rank, flag_kinds, intent from public.desk_queue($1)",
        [orgId],
      )
    ).rows,
  );
}

describe("desk_queue", () => {
  it("returns a callback nobody made four months ago", async () => {
    const rows = await queue(fx.userA, fx.orgA);
    const old = rows.find((r) => r.id === stale);
    expect(old).toMatchObject({ rank: 3, reason: "never called back", intent: "Wanted a quote" });
  });

  // A safety flag outranks a customer who merely asked for a person, and the flag has to
  // arrive with the row: the list draws its red badge from this and nothing else.
  it("ranks the flagged conversation first and names the flag", async () => {
    const rows = await queue(fx.userA, fx.orgA);
    expect(rows[0]).toMatchObject({ id: fx.convA, rank: 0, reason: "flagged" });
    expect(rows[0]!.flag_kinds).toEqual(["distress"]);
  });

  // `security invoker`, so this is RLS answering rather than a hand-written org check. A
  // definer version would take the argument at its word.
  it("returns nothing for an org the caller does not belong to", async () => {
    expect(await queue(fx.userA, fx.orgB)).toEqual([]);
    expect((await queue(fx.userB, fx.orgB)).map((r) => r.id)).toEqual([fx.convB]);
  });

  it("does not let the anon key call it at all", async () => {
    await db.query("begin");
    try {
      await db.query("set local role anon");
      await expect(db.query("select * from public.desk_queue($1)", [fx.orgA])).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await db.query("rollback");
    }
  });
});
