import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asServiceRole, connect, seed, type Fixture } from "./seed.js";

// Test 1, Postgres layer. The DO half lives in workers/api/test/dedupe.test.ts.
// This is the line of defence that survives the DO being evicted.

let db: Client;
let fx: Fixture;

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);
});

afterAll(async () => {
  await db.end();
});

describe("duplicate wa_message_id", () => {
  it("is rejected by the unique index on messages", async () => {
    await asServiceRole(db, async () => {
      await expect(
        db.query(
          `insert into messages (org_id, conversation_id, wa_message_id, direction, body)
           values ($1, $2, 'wamid.alpha.1', 'inbound', 'retry')`,
          [fx.orgA, fx.convA],
        ),
      ).rejects.toThrow(/messages_wa_message_id_key|duplicate key/);
    });
  });

  it("is rejected across orgs too, because the index is not org-scoped", async () => {
    // Meta ids are globally unique, so a collision here is a bug, not a tenant clash.
    await asServiceRole(db, async () => {
      await expect(
        db.query(
          `insert into messages (org_id, conversation_id, wa_message_id, direction, body)
           values ($1, $2, 'wamid.alpha.1', 'inbound', 'retry')`,
          [fx.orgB, fx.convB],
        ),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  it("is rejected by inbound_dedupe after the DO has been evicted", async () => {
    await asServiceRole(db, async () => {
      await db.query("insert into inbound_dedupe (org_id, wa_message_id) values ($1, $2)", [
        fx.orgA,
        "wamid.evicted",
      ]);
      await expect(
        db.query("insert into inbound_dedupe (org_id, wa_message_id) values ($1, $2)", [
          fx.orgA,
          "wamid.evicted",
        ]),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  it("still accepts a genuinely new id", async () => {
    await asServiceRole(db, async () => {
      const res = await db.query(
        `insert into messages (org_id, conversation_id, wa_message_id, direction, body)
         values ($1, $2, 'wamid.alpha.2', 'inbound', 'second') returning id`,
        [fx.orgA, fx.convA],
      );
      expect(res.rowCount).toBe(1);
    });
  });

  it("cannot attach a message to another org's conversation", async () => {
    await asServiceRole(db, async () => {
      await expect(
        db.query(
          `insert into messages (org_id, conversation_id, wa_message_id, direction, body)
           values ($1, $2, 'wamid.crossorg', 'inbound', 'nope')`,
          [fx.orgA, fx.convB],
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });
});
