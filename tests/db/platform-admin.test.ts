// The platform admin is a separate account from any client's owner, and the separation
// has to hold in Postgres rather than in the dashboard's tab list. An admin belongs to
// no org: every client table is gated on `app.is_member(org_id)` with no platform-admin
// escape, so the account that can see the all-clients rollup cannot read a single
// customer message behind it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asUser, connect, seed, type Fixture } from "./seed.js";

let db: Client;
let fx: Fixture;
let admin: string;

beforeAll(async () => {
  db = await connect();
  fx = await seed(db);

  const user = (
    await db.query<{ id: string }>(
      "insert into auth.users (email) values ($1) returning id",
      ["platform@test"],
    )
  ).rows[0]!.id;

  // org_id null and no org_members row — this is the shape 0013 made legal, and it is
  // the whole account. A placeholder org here would defeat the test.
  await db.query(
    "insert into users (id, org_id, email, is_platform_admin) values ($1, null, $2, true)",
    [user, "platform@test"],
  );
  admin = user;
});

afterAll(async () => {
  await db.end();
});

describe("platform admin", () => {
  it("reads no customer data from any org", async () => {
    for (const table of ["conversations", "messages", "usage_events", "safety_flags"]) {
      const count = await asUser(db, admin, async () =>
        (await db.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]!.n,
      );

      expect(count, `${table} was readable by a platform admin`).toBe("0");
    }
  });

  it("still gets the all-clients rollup", async () => {
    const rows = await asUser(db, admin, async () =>
      (await db.query<{ org_id: string; conversations: string }>(
        "select org_id, conversations from public.admin_orgs()",
      )).rows,
    );

    // Counts arrive through the security-definer rollup even though the rows they were
    // computed from are unreadable to this caller — which is the point of the split.
    expect(rows.map((r) => r.org_id).sort()).toEqual([fx.orgA, fx.orgB].sort());
    expect(rows.map((r) => r.conversations)).toEqual(["1", "1"]);
  });

  it("sorts the demo org below paying clients", async () => {
    await db.query("begin");
    try {
      await db.query("update organizations set is_demo = true where id = $1", [fx.orgA]);
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: admin, role: "authenticated" }),
      ]);
      await db.query("set local role authenticated");

      const rows = (
        await db.query<{ org_id: string; is_demo: boolean }>(
          "select org_id, is_demo from public.admin_orgs()",
        )
      ).rows;

      // alpha sorts before bravo by name, so demo-last is the only thing that can put
      // it second here.
      expect(rows.map((r) => r.org_id)).toEqual([fx.orgB, fx.orgA]);
      expect(rows.map((r) => r.is_demo)).toEqual([false, true]);
    } finally {
      await db.query("rollback");
    }
  });

  it("refuses admin_health to an ordinary owner", async () => {
    await expect(
      asUser(db, fx.userA, () => db.query("select * from public.admin_health()")),
    ).rejects.toThrow(/admin only/);
  });

  // The health rollup answers "is this client working", which means it has to be able to
  // report on rows the caller cannot read — the same definer trick as admin_orgs, and
  // the same reason it needs its own guard.
  it("reports per-client health without exposing message content", async () => {
    await db.query("begin");
    try {
      await db.query(
        `insert into messages (org_id, conversation_id, wa_message_id, direction, body, status, status_at)
         values ($1, $2, 'wamid.alpha.failed', 'outbound', 'never arrived', 'failed', now())`,
        [fx.orgA, fx.convA],
      );
      await db.query(
        "insert into safety_flags (org_id, conversation_id, kind) values ($1, $2, 'minor')",
        [fx.orgA, fx.convA],
      );
      await db.query(
        "update conversations set handoff_state = 'requested' where id = $1",
        [fx.convA],
      );

      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: admin, role: "authenticated" }),
      ]);
      await db.query("set local role authenticated");

      const rows = (
        await db.query<{
          org_id: string;
          last_inbound_at: Date | null;
          last_failed_at: Date | null;
          waiting_since: Date | null;
          open_flags_by_kind: Record<string, number>;
          media_bytes: string;
        }>("select * from public.admin_health()")
      ).rows;

      const a = rows.find((r) => r.org_id === fx.orgA)!;
      expect(a.last_inbound_at).not.toBeNull();
      expect(a.last_failed_at).not.toBeNull();
      expect(a.waiting_since).not.toBeNull();
      expect(a.open_flags_by_kind).toEqual({ minor: 1 });
      // No `storage` schema on a plain local cluster, so this is the deferred-reference
      // path in the function rather than a real total.
      expect(a.media_bytes).toBe("0");

      // Kinds and counts, never a body. The admin holds no membership precisely so that
      // "we cannot read your customers' messages" survives features like this one.
      expect(JSON.stringify(rows)).not.toContain("never arrived");

      const b = rows.find((r) => r.org_id === fx.orgB)!;
      expect(b.last_failed_at).toBeNull();
      expect(b.open_flags_by_kind).toEqual({});
    } finally {
      await db.query("rollback");
    }
  });

  it("refuses admin_flags to an ordinary owner", async () => {
    await expect(
      asUser(db, fx.userA, () => db.query("select * from public.admin_flags()")),
    ).rejects.toThrow(/admin only/);
  });

  // The queue crosses every client, which is the only way a distress flag raised at 2am
  // for a client whose owner is asleep gets seen at all. What crosses with it is the kind
  // and the clock, and nothing a customer wrote.
  it("queues open flags across clients, resolved ones not at all", async () => {
    await db.query("begin");
    try {
      await db.query(
        `insert into messages (org_id, conversation_id, wa_message_id, direction, body)
         values ($1, $2, 'wamid.alpha.flagged', 'inbound', 'i want to hurt myself')`,
        [fx.orgA, fx.convA],
      );
      await db.query(
        "insert into safety_flags (org_id, conversation_id, kind) values ($1, $2, 'distress')",
        [fx.orgA, fx.convA],
      );
      // Already dealt with, so no longer the queue's problem.
      await db.query(
        `insert into safety_flags (org_id, conversation_id, kind, resolved_at, resolution_note)
         values ($1, $2, 'abuse', now(), 'blocked the number')`,
        [fx.orgB, fx.convB],
      );

      const rows = await asUser(db, admin, async () =>
        (await db.query<{ org_id: string; kind: string }>("select * from public.admin_flags()"))
          .rows,
      );

      expect(rows.map((r) => [r.org_id, r.kind])).toEqual([[fx.orgA, "distress"]]);
      expect(JSON.stringify(rows)).not.toContain("hurt myself");
    } finally {
      await db.query("rollback");
    }
  });

  // Where the line falls for the management panel: an admin may see that an org exists
  // and who its people are, because onboarding and support need exactly that, and may
  // not see what those people's customers said.
  it("sees orgs and their members, but not their conversations", async () => {
    const seen = await asUser(db, admin, async () => ({
      orgs: (await db.query("select id from organizations")).rowCount,
      members: (await db.query("select id from org_members")).rowCount,
      conversations: (await db.query("select id from conversations")).rowCount,
    }));

    expect(seen.orgs).toBe(2);
    expect(seen.members).toBe(2);
    expect(seen.conversations).toBe(0);
  });
});
