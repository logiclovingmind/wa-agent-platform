// Test 4 from .claude/rules/testing.md — org isolation on the Worker path.
// The one that matters most: service_role bypasses RLS, so test 3 passes even if
// the Worker is wide open. What actually protects org B here is the org_id filter
// that OrgDb puts on every query. This test proves both halves of that sentence.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { MAX_PAGE, ORG_SCOPED_TABLES, createOrgDb } from "@wa/shared";
import { asServiceRole, connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);
});

afterAll(async () => {
  await db.end();
});

/** Builders are lazy — nothing is sent until awaited, so a dummy origin is fine. */
function orgDb(orgId: string) {
  return createOrgDb(
    { SUPABASE_URL: "http://db.invalid", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" },
    orgId,
  );
}

// url and body are protected on PostgrestBuilder. Reaching them is the point:
// these assertions check the request the Worker would actually send.
function filtersOf(builder: unknown): URLSearchParams {
  return (builder as { url: URL }).url.searchParams;
}

function bodyOf(builder: unknown): Array<Record<string, unknown>> {
  return (builder as { body: Array<Record<string, unknown>> }).body;
}

describe("service_role really does bypass RLS", () => {
  // If this test ever fails, test 3 has become the only lock and test 4 is moot.
  it("reads both orgs when no org_id filter is applied", async () => {
    const n = await asServiceRole(db, async () =>
      (await db.query<{ n: string }>("select count(*)::text as n from messages")).rows[0]!.n,
    );

    expect(n).toBe("2");
  });
});

describe("org isolation, service path", () => {
  it("puts org_id on every read, write and delete", () => {
    const scoped = orgDb(fx.orgA);

    for (const table of ORG_SCOPED_TABLES) {
      expect(filtersOf(scoped.select(table, "id")).get("org_id"), table).toBe(`eq.${fx.orgA}`);
      expect(filtersOf(scoped.update(table, { updated_at: "now" })).get("org_id"), table)
        .toBe(`eq.${fx.orgA}`);
      expect(filtersOf(scoped.delete(table)).get("org_id"), table).toBe(`eq.${fx.orgA}`);
    }
  });

  it("stamps org_id onto inserts and rejects a foreign one", () => {
    const scoped = orgDb(fx.orgA);

    expect(bodyOf(scoped.insert("messages", { wa_message_id: "wamid.x" }))).toEqual([
      { wa_message_id: "wamid.x", org_id: fx.orgA },
    ]);

    expect(() => scoped.insert("messages", { org_id: fx.orgB, wa_message_id: "wamid.y" })).toThrow(
      /scoped to/,
    );
    expect(() => scoped.update("messages", { org_id: fx.orgB })).toThrow(/between orgs/);
  });

  it("cannot read org B through a handler scoped to org A", async () => {
    // Take the filter the Worker would actually send and run it against real rows.
    const admitted = filtersOf(orgDb(fx.orgA).select("messages", "id,body"))
      .get("org_id")!
      .replace("eq.", "");

    expect(admitted).toBe(fx.orgA);

    const rows = await asServiceRole(db, async () =>
      (
        await db.query<{ org_id: string }>("select org_id from messages where org_id = $1", [
          admitted,
        ])
      ).rows,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(fx.orgA);
  });

  it("cannot write into org B through a handler scoped to org A", async () => {
    const scoped = orgDb(fx.orgA);
    const stamped = bodyOf(
      scoped.insert("messages", { conversation_id: fx.convB, wa_message_id: "wamid.cross" }),
    );

    expect(stamped[0]!["org_id"]).toBe(fx.orgA);

    // org A's stamp against org B's conversation is a row that cannot exist.
    await expect(
      asServiceRole(db, () =>
        db.query(
          `insert into messages (org_id, conversation_id, wa_message_id, direction)
           values ($1, $2, 'wamid.cross', 'outbound')`,
          [stamped[0]!["org_id"], fx.convB],
        ),
      ),
    ).rejects.toThrow();
  });

  it("refuses select * and caps the page at 20", () => {
    const scoped = orgDb(fx.orgA);

    expect(() => scoped.select("messages", "*")).toThrow(/not "\*"/);
    expect(filtersOf(scoped.select("messages", "id,body", { limit: 500 })).get("limit")).toBe(
      String(MAX_PAGE),
    );
  });

  it("refuses to build without an org at all", () => {
    expect(() => orgDb("")).toThrow(/requires an org_id/);
  });
});
