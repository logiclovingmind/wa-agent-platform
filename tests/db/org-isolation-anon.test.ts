// Test 3 from .claude/rules/testing.md — org isolation on the anon/browser path.
// This is what stands between client A and client B in the dashboard.
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

describe("org isolation, anon path", () => {
  it("sees only its own org's messages", async () => {
    const rows = await asUser(db, fx.userA, async () =>
      (await db.query<{ org_id: string }>("select org_id from messages")).rows,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(fx.orgA);
  });

  it("returns zero rows when it asks for org B directly", async () => {
    for (const table of ["messages", "conversations", "usage_events", "safety_flags"]) {
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

  // The cost screen reads spend through an aggregate, which is the one place a
  // function could quietly sum across orgs. It is security invoker precisely so RLS
  // still applies inside it.
  it("aggregates only the caller's own spend in usage_daily", async () => {
    const rows = await asUser(db, fx.userA, async () =>
      (await db.query<{ cost_micros: string }>("select cost_micros from public.usage_daily(30)"))
        .rows,
    );

    // One row per IST day, and the seed gives each org exactly one event of 1000.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cost_micros).toBe("1000");
  });

  it("does not let the anon key call usage_daily at all", async () => {
    await db.query("begin");
    try {
      await db.query("set local role anon");
      await expect(db.query("select * from public.usage_daily(30)")).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await db.query("rollback");
    }
  });

  it("cannot see org B's members or users", async () => {
    const emails = await asUser(db, fx.userA, async () =>
      (await db.query<{ email: string }>("select email from users")).rows.map((r) => r.email),
    );

    expect(emails).toEqual(["owner@alpha.test"]);
  });

  it("denies wa_accounts outright, to owner and staff alike", async () => {
    await expect(
      asUser(db, fx.userA, () => db.query("select * from wa_accounts")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("exposes only the ciphertext-free view, scoped to its own org", async () => {
    const rows = await asUser(db, fx.userA, async () =>
      (
        await db.query<{ org_id: string; display_phone_number: string }>(
          "select org_id, display_phone_number from wa_accounts_public",
        )
      ).rows,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(fx.orgA);
  });

  it("cannot mint a platform admin or move itself to another org", async () => {
    await expect(
      asUser(db, fx.userA, () =>
        db.query("update users set is_platform_admin = true where id = $1", [fx.userA]),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asUser(db, fx.userA, () =>
        db.query("update users set org_id = $1 where id = $2", [fx.orgB, fx.userA]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot write messages from the browser at all", async () => {
    await expect(
      asUser(db, fx.userA, () =>
        db.query(
          `insert into messages (org_id, conversation_id, wa_message_id, direction, body)
           values ($1, $2, 'wamid.forged', 'outbound', 'forged')`,
          [fx.orgA, fx.convA],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
