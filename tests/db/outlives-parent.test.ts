// Two rows are meant to outlive the row they point at: a usage event outlives its
// conversation, and a safety flag outlives the message it was raised on — "delete the
// payload, keep the proof". Both said `on delete set null` and neither did it: the keys
// are composite, plain `set null` nulls every column in the key, and `org_id` is
// `not null` on both children, so the parent delete raised instead. 0021 narrows both to
// `set null (column)`.
//
// Worth a test rather than a comment because the failure is a year out. Retention
// hard-deletes messages at 12 months and would have thrown on the first flagged one —
// cross-org in a single DELETE, with no cron retry, for every client at once.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);
});

afterAll(async () => {
  await db.end();
});

describe("children that outlive their parent", () => {
  it("keeps the usage event when its conversation goes", async () => {
    await db.query("delete from conversations where id = $1", [fx.convA]);

    const { rows } = await db.query<{ conversation_id: string | null; org_id: string }>(
      "select conversation_id, org_id from usage_events where org_id = $1",
      [fx.orgA],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversation_id).toBeNull();
    expect(rows[0]!.org_id).toBe(fx.orgA);
  });

  it("keeps the safety flag when its message goes", async () => {
    const message = (
      await db.query<{ id: string }>("select id from messages where org_id = $1", [fx.orgB])
    ).rows[0]!.id;

    await db.query(
      `insert into safety_flags (org_id, conversation_id, message_id, kind)
       values ($1, $2, $3, 'distress')`,
      [fx.orgB, fx.convB, message],
    );

    await db.query("delete from messages where id = $1", [message]);

    const { rows } = await db.query<{ message_id: string | null; org_id: string }>(
      "select message_id, org_id from safety_flags where org_id = $1",
      [fx.orgB],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.message_id).toBeNull();
    expect(rows[0]!.org_id).toBe(fx.orgB);
  });

  // The narrowing must not have cost the tenant guarantee the composite key exists for.
  it("still refuses a usage event pointed at another org's conversation", async () => {
    await expect(
      db.query(
        `insert into usage_events (org_id, conversation_id, pricing_category, cost_micros)
         values ($1, $2, 'service', 1000)`,
        [fx.orgA, fx.convB],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});
