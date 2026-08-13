// `demo_reset()` is a delete button reachable from a browser, so the two things worth
// proving are that it removes exactly what a walk-in added — not the seeded backdrop it
// sits on — and that nobody but a platform admin can reach it. The second half is the
// one that has gone wrong repeatedly here: Supabase grants EXECUTE on every new public
// function to `anon` by name, so the in-body guard has been the only lock four times.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client, QueryResultRow } from "pg";
import { asUser, connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;
let admin: string;
let before: { conversations: string; kb_documents: string; usage_events: string };

const SEEDED_WA = "919990010001";
const WALK_IN_WA = "919812345678";

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);

  // orgA holds the oldest wa_account, which is how every demo statement in the repo
  // identifies the demo org. `is_demo` is the second lock.
  await db.query("update organizations set is_demo = true where id = $1", [fx.orgA]);

  const wa = (
    await db.query<{ id: string }>("select id from wa_accounts where org_id = $1", [fx.orgA])
  ).rows[0]!.id;

  // The shared fixture's own rows would be indistinguishable from a walk-in here — its
  // conversation carries neither a seeded number nor a seeded title. Cleared so the
  // counts this test asserts are only the rows it created.
  await db.query("delete from usage_events where org_id = $1", [fx.orgA]);
  await db.query("delete from conversations where org_id = $1", [fx.orgA]);
  await db.query("delete from kb_documents where org_id = $1", [fx.orgA]);

  const conv = async (org: string, waAccount: string, waId: string) => {
    await db.query(
      `insert into conversations
         (org_id, wa_account_id, customer_wa_id, last_message_at, window_expires_at)
       values ($1, $2, $3, now(), now() + interval '20 hours')`,
      [org, waAccount, waId],
    );
  };

  await conv(fx.orgA, wa, SEEDED_WA);
  await conv(fx.orgA, wa, WALK_IN_WA);

  await db.query("insert into kb_documents (org_id, title, raw) values ($1, $2, $3)", [
    fx.orgA,
    "Demo — courses and fees",
    "seeded",
  ]);
  await db.query("insert into kb_documents (org_id, title, raw) values ($1, $2, $3)", [
    fx.orgA,
    "Sharma Dental — fees",
    "pasted for a prospect",
  ]);
  await db.query("insert into kb_documents (org_id, title, raw) values ($1, $2, $3)", [
    fx.orgB,
    "Client KB",
    "belongs to a paying client",
  ]);

  await db.query(
    "insert into usage_events (org_id, pricing_category, cost_micros) values ($1, $2, $3)",
    [fx.orgA, "demo_reply", 100],
  );
  await db.query(
    "insert into usage_events (org_id, pricing_category, cost_micros) values ($1, $2, $3)",
    [fx.orgA, "reply", 16600],
  );
  await db.query(
    "insert into usage_events (org_id, pricing_category, cost_micros) values ($1, $2, $3)",
    [fx.orgB, "reply", 16600],
  );

  // What a walk-in leaves behind on the org row itself.
  await db.query(
    "update organizations set name = $2, sector = $3, voice = $4 where id = $1",
    [fx.orgA, "Sharma Dental", "healthcare", "clinical"],
  );

  const user = (
    await db.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [
      "reset-admin@test",
    ])
  ).rows[0]!.id;
  await db.query(
    "insert into users (id, org_id, email, is_platform_admin) values ($1, null, $2, true)",
    [user, "reset-admin@test"],
  );
  admin = user;

  before = {
    conversations: await count("conversations", fx.orgB),
    kb_documents: await count("kb_documents", fx.orgB),
    usage_events: await count("usage_events", fx.orgB),
  };
});

afterAll(async () => {
  await db.end();
});

const count = async (table: string, org: string) =>
  (await db.query<{ n: string }>(`select count(*)::text as n from ${table} where org_id = $1`, [
    org,
  ])).rows[0]!.n;

describe("demo_reset", () => {
  it("is unreachable by anon", async () => {
    await db.query("set role anon");
    await expect(db.query("select * from public.demo_reset()")).rejects.toThrow(
      /permission denied/i,
    );
    await db.query("reset role");
  });

  it("refuses a client owner", async () => {
    await expect(
      asUser(db, fx.userA, () => db.query("select * from public.demo_reset()")),
    ).rejects.toThrow(/admin only/i);
  });

  // One test rather than three: `asUser` rolls its transaction back, so the effects of
  // the reset only exist inside that callback. Observing them from a later `it` would
  // read the untouched fixture and pass or fail for the wrong reason.
  it("removes the walk-in, keeps the backdrop, restores the identity", async () => {
    const after = await asUser(db, admin, async () => {
      const row = (
        await db.query<{
          conversations_removed: string;
          kb_documents_removed: string;
          usage_events_removed: string;
        }>("select * from public.demo_reset()")
      ).rows[0]!;

      // Back to the login role to observe: the caller above is the platform admin, who
      // by design reads zero rows from any client table, so RLS would hide the evidence.
      await db.query("set local role postgres");

      const list = async <T extends QueryResultRow>(sql: string, org: string) =>
        (await db.query<T>(sql, [org])).rows;

      return {
        row,
        conversations: (
          await list<{ customer_wa_id: string }>(
            "select customer_wa_id from conversations where org_id = $1",
            fx.orgA,
          )
        ).map((r) => r.customer_wa_id),
        titles: (
          await list<{ title: string }>(
            "select title from kb_documents where org_id = $1",
            fx.orgA,
          )
        ).map((r) => r.title),
        categories: (
          await list<{ pricing_category: string }>(
            "select pricing_category from usage_events where org_id = $1",
            fx.orgA,
          )
        ).map((r) => r.pricing_category),
        org: (
          await list<{ name: string; sector: string; voice: string; reply_max_words: number }>(
            "select name, sector, voice, reply_max_words from organizations where id = $1",
            fx.orgA,
          )
        )[0]!,
        orgB: {
          conversations: await count("conversations", fx.orgB),
          kb_documents: await count("kb_documents", fx.orgB),
          usage_events: await count("usage_events", fx.orgB),
          name: (
            await list<{ name: string }>("select name from organizations where id = $1", fx.orgB)
          )[0]!.name,
        },
      };
    });

    // Real row counts, which `returning 1 into` would have reported as 1 for any
    // non-empty delete and null for an empty one.
    expect(after.row.conversations_removed).toBe("1");
    expect(after.row.kb_documents_removed).toBe("1");
    expect(after.row.usage_events_removed).toBe("1");

    expect(after.conversations).toEqual([SEEDED_WA]);
    expect(after.titles).toEqual(["Demo — courses and fees"]);
    expect(after.categories).toEqual(["demo_reply"]);

    expect(after.org.name).toBe("Demo Institute");
    expect(after.org.sector).toBe("general");
    expect(after.org.voice).toMatch(/warm and unhurried/);
    expect(after.org.reply_max_words).toBe(120);

    // The reason both locks exist. orgB does not carry `is_demo`, and its wa_account
    // shares a created_at with orgA's — so "oldest account" alone cannot separate them,
    // which is exactly the ambiguity that must not resolve in orgB's favour.
    expect(after.orgB.conversations).toBe(before.conversations);
    expect(after.orgB.kb_documents).toBe(before.kb_documents);
    expect(after.orgB.usage_events).toBe(before.usage_events);
    expect(after.orgB.name).not.toBe("Demo Institute");
  });

});
