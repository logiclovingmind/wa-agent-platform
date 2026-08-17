// The search box reads three tables at once as security definer, which makes it the
// widest single read in the dashboard. Two things are worth holding down: that it only
// ever answers for an org the caller belongs to, and that the anon key cannot call it —
// a definer function is a way past RLS if the grant is wrong.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asUser, connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);

  await db.query("update conversations set customer_name = 'Ananya Rao' where id = $1", [
    fx.convA,
  ]);
  await db.query("update conversations set customer_name = 'Ananya Rao' where id = $1", [
    fx.convB,
  ]);
  await db.query("select public.record_lead($1, $2, $3, $4, $5, $6, $7)", [
    fx.orgA,
    fx.convA,
    "Ananya Rao",
    "Weekend batch",
    null,
    null,
    null,
  ]);

  // Pinned to 19:00 UTC on 1 March, which is 00:30 IST on the 2nd — the hour that tells
  // an IST-day filter apart from one that compares UTC.
  await db.query(
    `insert into messages (org_id, conversation_id, wa_message_id, direction, body, created_at)
     values ($1, $2, 'wamid.ist-midnight', 'inbound', 'what is the timetable',
             '2027-03-01T19:00:00Z')`,
    [fx.orgA, fx.convA],
  );
});

afterAll(async () => {
  await db.end();
});

function search(userId: string, orgId: string, query: string) {
  return asUser(db, userId, async () =>
    (
      await db.query<{ kind: string; conversation_id: string }>(
        "select kind, conversation_id from public.search_everything($1, $2)",
        [orgId, query],
      )
    ).rows,
  );
}

function searchBetween(
  userId: string,
  orgId: string,
  query: string,
  from: string | null,
  to: string | null,
) {
  return asUser(db, userId, async () =>
    (
      await db.query<{ kind: string; conversation_id: string }>(
        "select kind, conversation_id from public.search_everything($1, $2, $3, $4)",
        [orgId, query, from, to],
      )
    ).rows,
  );
}

describe("search_everything", () => {
  it("finds a person, a lead and a message under one query", async () => {
    const byName = await search(fx.userA, fx.orgA, "Ananya");
    expect(byName.map((r) => r.kind).sort()).toEqual(["lead", "person"]);
    expect(new Set(byName.map((r) => r.conversation_id))).toEqual(new Set([fx.convA]));

    const byBody = await search(fx.userA, fx.orgA, "hello from alpha");
    expect(byBody).toEqual([{ kind: "message", conversation_id: fx.convA }]);
  });

  // Nobody types a wa_id the way Meta stores it, so the digits are matched with any
  // punctuation stripped. A number is the one thing an owner searches by exactly.
  it("finds a person by a number typed with a plus", async () => {
    const hits = await search(fx.userA, fx.orgA, "+91987654325");
    expect(hits).toEqual([{ kind: "person", conversation_id: fx.convA }]);
  });

  it("returns nothing below three characters", async () => {
    expect(await search(fx.userA, fx.orgA, "An")).toEqual([]);
  });

  // Both orgs have a customer of the same name here on purpose: a query that matches in
  // org B must still come back empty, not merely unranked.
  it("never crosses into another org", async () => {
    const hits = await search(fx.userA, fx.orgA, "Ananya");
    expect(hits.every((r) => r.conversation_id === fx.convA)).toBe(true);

    await expect(search(fx.userA, fx.orgB, "Ananya")).rejects.toThrow(/not a member/i);
  });

  it("keeps answering when no dates are given", async () => {
    // The old two-argument signature was dropped for this one. Both shapes have to keep
    // working or every deployed browser tab loses its search box at once.
    expect(await searchBetween(fx.userA, fx.orgA, "timetable", null, null)).toEqual([
      { kind: "message", conversation_id: fx.convA },
    ]);
  });

  it("counts the last day by IST, not by UTC", async () => {
    const hit = [{ kind: "message", conversation_id: fx.convA }];

    // 00:30 IST on the 2nd. A range ending on the 1st must not reach it, and a range
    // starting on the 2nd must. Comparing the raw UTC instant gets both of these
    // backwards, and the failure is invisible: the owner simply sees no results.
    expect(await searchBetween(fx.userA, fx.orgA, "timetable", "2027-03-02", "2027-03-02")).toEqual(
      hit,
    );
    expect(
      await searchBetween(fx.userA, fx.orgA, "timetable", "2027-03-01", "2027-03-01"),
    ).toEqual([]);

    // Inclusive at both ends, the way a person reads "1 March to 3 March".
    expect(await searchBetween(fx.userA, fx.orgA, "timetable", "2027-03-01", "2027-03-03")).toEqual(
      hit,
    );
  });

  it("takes one bound on its own", async () => {
    expect(await searchBetween(fx.userA, fx.orgA, "timetable", "2027-03-02", null)).toEqual([
      { kind: "message", conversation_id: fx.convA },
    ]);
    expect(await searchBetween(fx.userA, fx.orgA, "timetable", null, "2027-03-01")).toEqual([]);
  });

  it("still refuses another org with dates supplied", async () => {
    await expect(
      searchBetween(fx.userA, fx.orgB, "Ananya", "2027-03-01", "2027-03-31"),
    ).rejects.toThrow(/not a member/i);
  });

  it("does not let the anon key call it at all", async () => {
    await db.query("begin");
    try {
      await db.query("set local role anon");
      await expect(
        db.query("select * from public.search_everything($1, $2)", [fx.orgA, "Ananya"]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await db.query("rollback");
    }
  });
});
