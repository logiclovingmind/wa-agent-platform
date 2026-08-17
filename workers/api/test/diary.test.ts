import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { stubSupabase, type RestCall } from "./fake-supabase.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ADMIN = "55555555-5555-5555-5555-555555555555";
const APPT = "aaaaaaaa-0000-4000-8000-00000000000a";

interface Scenario {
  admin?: boolean;
  hours?: Array<Record<string, unknown>>;
  appointments?: Array<Record<string, unknown>>;
  /** What the cancel is answered with — empty means "no row matched". */
  cancelled?: Array<Record<string, unknown>>;
}

function harness(scenario: Scenario = {}) {
  return stubSupabase(
    (call) => {
      switch (call.table.split("?")[0]) {
        case "org_members":
          return scenario.admin === false ? [{ org_id: ORG_A, role: "owner" }] : [];
        case "users":
          return [{ id: ADMIN, email: "admin@x.test", is_platform_admin: scenario.admin !== false }];
        case "business_hours":
          return call.method === "GET" ? (scenario.hours ?? []) : [];
        case "appointments":
          if (call.method === "GET") return scenario.appointments ?? [];
          return scenario.cancelled ?? [{ id: APPT, starts_at: "2026-08-18T05:00:00Z" }];
        default:
          return [];
      }
    },
    async (_req, url) => {
      if (url.pathname === "/auth/v1/user") return Response.json({ id: ADMIN });
      throw new Error(`unexpected outbound fetch: ${url.pathname}`);
    },
  );
}

async function call(method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const on = (rest: RestCall[], method: string, table: string) =>
  rest.filter((c) => c.method === method && c.table.split("?")[0] === table);

const day = (weekday: number) => ({
  weekday,
  opens_at: "09:30",
  closes_at: "19:00",
  slot_minutes: 30,
});

afterEach(() => vi.unstubAllGlobals());

describe("diary", () => {
  it("is closed to a client owner", async () => {
    harness({ admin: false });
    expect((await call("GET", `/api/admin/hours/${ORG_A}`)).status).toBe(403);
    expect((await call("PUT", `/api/admin/hours/${ORG_A}`, { hours: [day(1)] })).status).toBe(403);
    expect((await call("DELETE", `/api/admin/appointments/${ORG_A}/${APPT}`)).status).toBe(403);
  });

  // A cancelled row is free again in `free_slots` and a past one cannot be acted on, so
  // either one in this list is the single place the diary disagrees with the bot.
  it("asks only for bookings that are ahead and still standing", async () => {
    const rest = harness();
    expect((await call("GET", `/api/admin/hours/${ORG_A}`)).status).toBe(200);

    const query = on(rest, "GET", "appointments")[0]!.url.searchParams;
    expect(query.get("status")).toBe("neq.cancelled");
    expect(query.get("starts_at")).toMatch(/^gte\./);
  });

  it("replaces the whole week, so a day left out is a day the client is closed", async () => {
    const rest = harness({ hours: [day(1), day(2), day(3)] });

    const res = await call("PUT", `/api/admin/hours/${ORG_A}`, { hours: [day(1), day(6)] });
    expect(res.status).toBe(200);

    expect(on(rest, "DELETE", "business_hours")).toHaveLength(1);
    const written = on(rest, "POST", "business_hours")[0]!.body as Array<{ weekday: number }>;
    expect(written.map((r) => r.weekday)).toEqual([1, 6]);
  });

  it("closes every day when the week is emptied", async () => {
    const rest = harness();

    expect((await call("PUT", `/api/admin/hours/${ORG_A}`, { hours: [] })).status).toBe(200);
    expect(on(rest, "DELETE", "business_hours")).toHaveLength(1);
    expect(on(rest, "POST", "business_hours")).toHaveLength(0);
  });

  // The all-or-nothing rule. A week that saved its good days and dropped the rest would
  // leave the form disagreeing with the diary, which is worse than saving nothing.
  it("rejects a bad week without touching the stored one", async () => {
    for (const bad of [
      [{ ...day(1), closes_at: "09:00" }],
      [{ ...day(1), weekday: 7 }],
      [day(1), day(1)],
      [{ ...day(1), slot_minutes: 3 }],
      [{ ...day(1), opens_at: "9:30" }],
    ]) {
      const rest = harness();
      const res = await call("PUT", `/api/admin/hours/${ORG_A}`, { hours: bad });

      expect(res.status).toBe(400);
      expect(on(rest, "DELETE", "business_hours")).toHaveLength(0);
      expect(on(rest, "POST", "business_hours")).toHaveLength(0);
      vi.unstubAllGlobals();
    }
  });

  // Narrowing the hours must not silently cancel a customer who already holds a slot.
  it("leaves booked appointments alone when the hours change", async () => {
    const rest = harness();
    await call("PUT", `/api/admin/hours/${ORG_A}`, { hours: [day(1)] });

    expect(rest.filter((c) => c.table.split("?")[0] === "appointments")).toHaveLength(0);
  });

  it("cancels a booking rather than deleting it", async () => {
    const rest = harness();

    const res = await call("DELETE", `/api/admin/appointments/${ORG_A}/${APPT}`);
    expect(res.status).toBe(200);

    expect(on(rest, "DELETE", "appointments")).toHaveLength(0);
    const patch = on(rest, "PATCH", "appointments")[0]!;
    expect(patch.body).toEqual({ status: "cancelled" });
    expect(patch.url.searchParams.get("id")).toBe(`eq.${APPT}`);

    expect(on(rest, "POST", "audit_log")[0]!.body).toEqual([
      {
        org_id: ORG_A,
        actor_user_id: ADMIN,
        action: "appointment_cancelled",
        detail: { appointment_id: APPT, starts_at: "2026-08-18T05:00:00Z" },
      },
    ]);
  });

  it("404s on an appointment that is not this org's", async () => {
    const rest = harness({ cancelled: [] });

    expect((await call("DELETE", `/api/admin/appointments/${ORG_A}/${APPT}`)).status).toBe(404);
    expect(on(rest, "POST", "audit_log")).toHaveLength(0);
  });
});
