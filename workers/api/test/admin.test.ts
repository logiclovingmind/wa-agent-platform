import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { stubSupabase, storedMedia, type RestCall } from "./fake-supabase.js";
import { decryptUnderMasterKey, encryptUnderMasterKey } from "./fixtures.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const WA_ACCOUNT_A = "22222222-2222-2222-2222-222222222222";
const ADMIN = "55555555-5555-5555-5555-555555555555";
const OWNER = "66666666-6666-6666-6666-666666666666";
const STAFF = "77777777-7777-7777-7777-777777777777";
const INVITED = "88888888-8888-8888-8888-888888888888";
const FLAG = "99999999-9999-9999-9999-999999999999";
const ORG_NEW = "33333333-3333-3333-3333-333333333333";
const ORG_NAME = "Acme Dental";

/** GoTrue admin calls, which are not PostgREST and so are recorded separately. */
const authCalls: Array<{ method: string; path: string; redirectTo?: string | null }> = [];

/** PostgREST inserts arrive as an array of rows, even when there is one. */
const rows = (c: RestCall | undefined) => c?.body as Array<Record<string, unknown>> | undefined;

/**
 * `admin` is the account 0013 made possible: a real login with **no `org_members` row**.
 * That shape used to be indistinguishable from a stranger, so every admin route answered
 * 401 — including the wallet, whose entire purpose is that only this account may read it.
 */
async function harness(
  opts: {
    admin?: boolean;
    graph?: (url: URL) => Response | null;
    /** Whether an `org_exported` row already exists — the gate on offboarding. */
    exported?: boolean;
  } = {},
) {
  const token = await encryptUnderMasterKey("meta-token");

  authCalls.length = 0;

  return stubSupabase(
    (call) => {
      switch (call.table.split("?")[0]) {
        case "org_members": {
          // The access-management routes query this table three different ways, and the
          // filter is what tells them apart: by member, by role, or not at all (auth.ts
          // resolving who the caller is).
          const member = call.url.searchParams.get("user_id");
          if (member === `eq.${STAFF}`) return [{ user_id: STAFF, role: "staff" }];
          if (member === `eq.${OWNER}`) return [{ user_id: OWNER, role: "owner" }];
          if (call.url.searchParams.get("role") === "eq.owner") {
            return [{ user_id: OWNER, role: "owner" }];
          }
          return opts.admin ? [] : [{ org_id: ORG_A, role: "owner" }];
        }
        case "users": {
          const email = call.url.searchParams.get("email");
          if (email) return [{ id: email === "other@x.test" ? OWNER : ADMIN }];
          return [{ id: ADMIN, email: "admin@x.test", is_platform_admin: opts.admin === true }];
        }
        case "safety_flags":
          return [{ id: FLAG }];
        case "organizations":
          // A create returns the new id; every other read is the existing client, whose
          // name is what the offboard confirmation has to match.
          return call.method === "POST" ? [{ id: ORG_NEW }] : [{ id: ORG_A, name: ORG_NAME }];
        case "audit_log":
          return call.method === "GET" && opts.exported ? [{ id: "exported" }] : [];
        case "conversations":
        case "messages":
          return [];
        case "wa_accounts":
          return [
            {
              id: WA_ACCOUNT_A,
              phone_number_id: "1555",
              waba_id: "waba-1",
              display_phone_number: "+15556696700",
              token_ciphertext: token.ciphertext,
              token_iv: token.iv,
              token_key_version: 1,
              reengagement_template_name: "come_back",
              reengagement_template_lang: "en",
            },
          ];
        case "rpc/media_bytes":
          return 123_456;
        default:
          return [];
      }
    },
    async (req, url) => {
      if (url.pathname === "/auth/v1/user") return Response.json({ id: ADMIN });
      if (url.pathname.startsWith("/auth/v1/admin/")) {
        // GoTrue returns the user with the link flattened onto it; supabase-js splits the
        // two apart into `data.user` and `data.properties`.
        if (url.pathname.endsWith("/generate_link")) {
          const body = (await req.json()) as { email: string; type: string };
          // supabase-js puts `redirectTo` in the query string here, not the body.
          authCalls.push({
            method: req.method,
            path: url.pathname,
            redirectTo: url.searchParams.get("redirect_to"),
          });
          return Response.json({
            id: body.type === "invite" ? INVITED : STAFF,
            email: body.email,
            action_link: "https://auth.test/verify?token=one-time",
          });
        }
        authCalls.push({ method: req.method, path: url.pathname });
        return Response.json({});
      }
      if (url.pathname === "/api/v1/credits") {
        return Response.json({ data: { credits_inr: 408.42 } });
      }
      if (url.hostname === "graph.test") {
        return opts.graph?.(url) ?? new Response("bad token", { status: 400 });
      }
      throw new Error(`unexpected outbound fetch: ${req.method} ${req.url}`);
    },
  );
}

/** Healthy Meta: permanent token, app subscribed, good number, approved template. */
function healthyGraph(url: URL): Response | null {
  if (url.pathname.endsWith("/debug_token")) {
    return Response.json({ data: { is_valid: true, expires_at: 0 } });
  }
  if (url.pathname.endsWith("/subscribed_apps")) {
    return Response.json({ data: [{ whatsapp_business_api_data: { id: "app-1" } }] });
  }
  if (url.pathname.endsWith("/message_templates")) {
    return Response.json({ data: [{ name: "come_back", status: "APPROVED", language: "en" }] });
  }
  if (url.pathname.endsWith("/1555")) {
    return Response.json({ quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" });
  }
  return null;
}

async function patch(path: string, body: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method: "PATCH",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function send(method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: {
        authorization: "Bearer good",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function get(path: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      headers: { authorization: "Bearer good" },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

afterEach(() => vi.unstubAllGlobals());

describe("platform admin API", () => {
  // The regression that made this whole surface unreachable: authentication resolved the
  // org from org_members and gave up when there was none, which is the admin's defining
  // property. The wallet was 401ing for the only account allowed to see it.
  it("authenticates an admin who belongs to no org", async () => {
    await harness({ admin: true });
    const res = await get("/api/usage/balance");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ balance_inr: 408.42 });
  });

  it("refuses the admin routes to a client's owner", async () => {
    await harness();
    expect((await get(`/api/admin/health/${ORG_A}`)).status).toBe(403);
    expect((await get("/api/admin/platform")).status).toBe(403);
  });

  it("reports Meta health for one client", async () => {
    await harness({ admin: true, graph: healthyGraph });
    const res = await get(`/api/admin/health/${ORG_A}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      numbers: [
        {
          wa_account_id: WA_ACCOUNT_A,
          phone_number_id: "1555",
          display_phone_number: "+15556696700",
          waba_id: "waba-1",
          // expires_at 0 is a permanent system-user token, which reads as "no countdown".
          token: { valid: true, expires_at: null },
          subscribed: true,
          number: { quality_rating: "GREEN", messaging_limit_tier: "TIER_1K" },
          template: { name: "come_back", language: "en", status: "APPROVED" },
        },
      ],
    });
  });

  // An onboarding that never got the app subscribed is the failure this screen exists to
  // catch, and it is invisible everywhere else: no webhooks arrive, so no row is ever
  // written and the client looks merely quiet.
  it("shows an unsubscribed WABA as a fault, not as silence", async () => {
    await harness({
      admin: true,
      graph: (url) =>
        url.pathname.endsWith("/subscribed_apps")
          ? Response.json({ data: [] })
          : healthyGraph(url),
    });

    const body = (await (await get(`/api/admin/health/${ORG_A}`)).json()) as {
      numbers: Array<{ subscribed: boolean | null }>;
    };
    expect(body.numbers[0]!.subscribed).toBe(false);
  });

  // A dead token fails several Graph calls at once. That *is* the diagnosis, so it has to
  // arrive as an answer — a 500 would replace it with a blank screen.
  //
  // Meta answering `code: 190` is a verdict, not a gap. This used to report null, null
  // read as "not checked", and the onboarding rehearsal found a client whose token Meta
  // refuses outright sitting on the all-clients table as a green "OK".
  it("reports a token Meta refuses as invalid, not as unchecked", async () => {
    await harness({ admin: true });
    const res = await get(`/api/admin/health/${ORG_A}`);

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      numbers: [
        {
          token: { valid: false, expires_at: null },
          subscribed: false,
          number: null,
          template: { status: null },
        },
      ],
    });
  });

  // The other half of the same rule, and the reason a refusal cannot simply be assumed:
  // Meta being down says nothing about this client, so it must not be recorded as a fault
  // against them. Null now means exactly one thing, which is what lets the panel treat it
  // as "not checked" rather than "fine".
  it("answers with nulls when Meta cannot be reached at all", async () => {
    await harness({ admin: true, graph: () => new Response("upstream", { status: 503 }) });
    const res = await get(`/api/admin/health/${ORG_A}`);

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      numbers: [
        {
          token: { valid: null, expires_at: null },
          subscribed: null,
          number: null,
          template: { status: null },
        },
      ],
    });
  });

  it("scopes the wa_accounts read to the org in the URL", async () => {
    const rest = await harness({ admin: true, graph: healthyGraph });
    await get(`/api/admin/health/${ORG_A}`);

    // Crossing orgs is the point of this endpoint, and the admin gate is the lock — but
    // the query still carries org_id, because service_role bypasses RLS (invariant 2).
    const read = rest.find((c) => c.table.startsWith("wa_accounts"));
    expect(read?.url.searchParams.get("org_id")).toBe(`eq.${ORG_A}`);
  });

  it("reports the media bucket against the alarm the cron uses", async () => {
    await harness({ admin: true });
    const res = await get("/api/admin/platform");

    expect(await res.json()).toEqual({
      media_bytes: 123_456,
      media_alarm_bytes: 800 * 1024 * 1024,
      media_limit_bytes: 1024 * 1024 * 1024,
    });
  });

  // §1: every admin write appends to audit_log with the acting admin's id. An admin panel
  // with unaudited writes launders actions that later need explaining to a client.
  it("writes and audits a runtime control change", async () => {
    const rest = await harness({ admin: true });
    const res = await patch(`/api/admin/orgs/${ORG_A}/controls`, { ai_paused: true });

    expect(res.status).toBe(200);

    const update = rest.find((c) => c.table.startsWith("organizations") && c.method === "PATCH");
    expect(update?.url.searchParams.get("id")).toBe(`eq.${ORG_A}`);
    expect(update?.body).toEqual({ ai_paused: true });

    const audit = rest.find((c) => c.table.startsWith("audit_log") && c.method === "POST");
    expect(audit?.body).toEqual([
      {
        org_id: ORG_A,
        actor_user_id: ADMIN,
        action: "org_controls_changed",
        detail: { ai_paused: true },
      },
    ]);
  });

  // The route holds service_role, so an unfiltered patch body would be an arbitrary write
  // to `organizations` from a browser.
  it("refuses a key it does not recognise and a value it cannot use", async () => {
    const rest = await harness({ admin: true });

    expect((await patch(`/api/admin/orgs/${ORG_A}/controls`, { is_demo: true })).status).toBe(400);
    expect((await patch(`/api/admin/orgs/${ORG_A}/controls`, { cap_micros: -5 })).status).toBe(400);
    expect(
      (await patch(`/api/admin/orgs/${ORG_A}/controls`, { hours_open_ist: "25:00" })).status,
    ).toBe(400);
    expect(
      (await patch(`/api/admin/orgs/${ORG_A}/controls`, { out_of_hours: "ignore" })).status,
    ).toBe(400);

    expect(rest.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("lets a control be cleared back to the platform default", async () => {
    const rest = await harness({ admin: true });
    const res = await patch(`/api/admin/orgs/${ORG_A}/controls`, { retention_months: null });

    expect(res.status).toBe(200);
    expect(
      rest.find((c) => c.table.startsWith("organizations") && c.method === "PATCH")?.body,
    ).toEqual({ retention_months: null });
  });

  it("refuses a control change from a client's owner", async () => {
    await harness();
    expect((await patch(`/api/admin/orgs/${ORG_A}/controls`, { ai_paused: true })).status).toBe(403);
  });

  it("moves the template name and language together, and audits it", async () => {
    const rest = await harness({ admin: true });
    const res = await patch(`/api/admin/wa-accounts/${WA_ACCOUNT_A}/template`, {
      org_id: ORG_A,
      name: "come_back",
      language: "en",
    });

    expect(res.status).toBe(200);
    const update = rest.find((c) => c.table.startsWith("wa_accounts") && c.method === "PATCH");
    expect(update?.url.searchParams.get("org_id")).toBe(`eq.${ORG_A}`);
    expect(update?.body).toEqual({
      reengagement_template_name: "come_back",
      reengagement_template_lang: "en",
    });

    const audit = rest.find((c) => c.table.startsWith("audit_log") && c.method === "POST");
    const rows = audit?.body as Array<Record<string, unknown>> | undefined;
    expect(rows?.[0]).toMatchObject({
      action: "reengagement_template_changed",
      actor_user_id: ADMIN,
    });
  });

  it("refuses a template name with no language", async () => {
    const rest = await harness({ admin: true });
    const res = await patch(`/api/admin/wa-accounts/${WA_ACCOUNT_A}/template`, {
      org_id: ORG_A,
      name: "come_back",
    });

    // A name without a language cannot be sent, so half a template is worse than none.
    expect(res.status).toBe(400);
    expect(rest.some((c) => c.method === "PATCH")).toBe(false);
  });
});

/**
 * §5 and §6. These routes hold `service_role` and reach GoTrue, so what is asserted here
 * is mostly what they *refuse* to do: resolve without a reason, strip an org of its last
 * owner, or let the one admin lock everybody out.
 */
describe("flag queue and access management", () => {
  it("resolves a flag with a reason, and records who closed it", async () => {
    const rest = await harness({ admin: true });
    const res = await send("POST", `/api/admin/flags/${FLAG}/resolve`, {
      org_id: ORG_A,
      note: "called the owner, they spoke to her",
    });

    expect(res.status).toBe(200);
    const update = rest.find((c) => c.table.startsWith("safety_flags") && c.method === "PATCH");
    expect(update?.url.searchParams.get("id")).toBe(`eq.${FLAG}`);
    expect(update?.url.searchParams.get("org_id")).toBe(`eq.${ORG_A}`);
    // Idempotence: a second click cannot overwrite the first admin's note.
    expect(update?.url.searchParams.get("resolved_at")).toBe("is.null");
    expect(update?.body).toMatchObject({ resolved_by: ADMIN });

    const audit = rest.find((c) => c.table.startsWith("audit_log") && c.method === "POST");
    expect((audit?.body as Array<Record<string, unknown>> | undefined)?.[0]).toMatchObject({
      action: "safety_flag_resolved",
      org_id: ORG_A,
    });
  });

  it("refuses to resolve a flag with no reason", async () => {
    const rest = await harness({ admin: true });
    const res = await send("POST", `/api/admin/flags/${FLAG}/resolve`, { org_id: ORG_A, note: " " });

    // A closed flag with nobody's reason on it looks handled and is not.
    expect(res.status).toBe(400);
    expect(rest.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("adds a login, its membership and a one-time link in one go", async () => {
    const rest = await harness({ admin: true });
    const res = await send("POST", `/api/admin/orgs/${ORG_A}/users`, {
      email: "New@Client.com",
      role: "staff",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user_id: INVITED,
      invite_link: "https://auth.test/verify?token=one-time",
    });

    // Both halves, or the account signs in and reaches an empty dashboard.
    const inserted = rest.filter((c) => c.method === "POST");
    const users = rows(inserted.find((c) => c.table.startsWith("users")));
    const members = rows(inserted.find((c) => c.table.startsWith("org_members")));
    expect(users?.[0]).toMatchObject({
      id: INVITED,
      email: "new@client.com",
      org_id: ORG_A,
      is_platform_admin: false,
    });
    expect(members?.[0]).toMatchObject({
      user_id: INVITED,
      role: "staff",
      org_id: ORG_A,
    });
    // The link is a credential. It is handed back once and never written down.
    const audit = inserted.find((c) => c.table.startsWith("audit_log"));
    expect(JSON.stringify(audit?.body)).not.toContain("one-time");
  });

  // Left to GoTrue, both links land on the project's Site URL, which was its untouched
  // `http://localhost:3000` default — a link that signs in fine and goes nowhere.
  it.each([
    ["invite", () => send("POST", `/api/admin/orgs/${ORG_A}/users`, { email: "a@b.test", role: "staff" })],
    ["recovery", () => send("POST", `/api/admin/orgs/${ORG_A}/users/${STAFF}/reset`)],
  ])("points the %s link at the canonical dashboard host", async (_type, call) => {
    await harness({ admin: true });
    const res = await call();

    expect(res.status).toBe(200);
    const link = authCalls.find((c) => c.path.endsWith("/generate_link"));
    expect(link?.redirectTo).toBe("https://app.logiclovingmind.com/");
  });

  it("refuses to demote or remove an org's only owner", async () => {
    const rest = await harness({ admin: true });
    const demote = await send("PATCH", `/api/admin/orgs/${ORG_A}/users/${OWNER}`, {
      role: "staff",
    });
    const remove = await send("DELETE", `/api/admin/orgs/${ORG_A}/users/${OWNER}`);

    // An org with no owner cannot manage its own staff or read its own billing, and
    // nothing in the client dashboard can put that right.
    expect(demote.status).toBe(409);
    expect(remove.status).toBe(409);
    expect(rest.some((c) => c.table.startsWith("org_members") && c.method === "PATCH")).toBe(false);
    expect(authCalls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("grants platform admin by email, audited against no client", async () => {
    const rest = await harness({ admin: true });
    const res = await send("POST", "/api/admin/platform-admins", {
      email: "other@x.test",
      grant: true,
    });

    expect(res.status).toBe(200);
    const audit = rest.find((c) => c.table.startsWith("audit_log") && c.method === "POST");
    // Nullable since 0015. An admin action with no client attached is still auditable.
    expect(audit?.body).toMatchObject({ org_id: null, action: "platform_admin_granted" });
  });

  it("will not let an admin revoke their own access, and puts it straight back", async () => {
    const rest = await harness({ admin: true });
    const res = await send("POST", "/api/admin/platform-admins", {
      email: "admin@x.test",
      grant: false,
    });

    expect(res.status).toBe(409);
    // The revoke lands before the caller is known, so the second write is the undo.
    const writes = rest.filter((c) => c.table.startsWith("users") && c.method === "PATCH");
    expect(writes.at(-1)?.body).toEqual({ is_platform_admin: true });
    expect(rest.some((c) => c.table.startsWith("audit_log"))).toBe(false);
  });
});

const ONBOARDING = {
  name: "Acme Dental",
  sector: "healthcare",
  phone_number_id: "1555",
  waba_id: "waba-1",
  display_phone_number: "+919876500000",
  token: "EAAG-real-meta-token",
  app_secret: "real-app-secret",
  owner_email: "owner@acme.test",
};

/**
 * §4 — the screen that decides whether "client #21 is an INSERT, not a deploy" holds.
 * The two things worth asserting are that the secrets are sealed before they reach
 * Postgres, and that the delete cannot run ahead of the export.
 */
describe("onboarding and offboarding", () => {
  it("seals the token and the app secret before either reaches the database", async () => {
    const rest = await harness({ admin: true, graph: healthyGraph });
    const res = await send("POST", "/api/admin/orgs", ONBOARDING);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhook_url: string; subscribed: boolean };
    expect(body.subscribed).toBe(true);

    const account = rows(
      rest.find((c) => c.table.startsWith("wa_accounts") && c.method === "POST"),
    )?.[0] as Record<string, string | number>;

    // Not the plaintext, anywhere in the row — and sealed under the highest key version
    // that is set, so a client onboarded mid-rotation is not left behind by it.
    expect(JSON.stringify(account)).not.toContain(ONBOARDING.token);
    expect(JSON.stringify(account)).not.toContain(ONBOARDING.app_secret);
    expect(account["token_key_version"]).toBe(1);
    expect(
      await decryptUnderMasterKey(account["token_ciphertext"] as string, account["token_iv"] as string),
    ).toBe(ONBOARDING.token);
    expect(
      await decryptUnderMasterKey(
        account["app_secret_ciphertext"] as string,
        account["app_secret_iv"] as string,
      ),
    ).toBe(ONBOARDING.app_secret);
    // A reused IV under one key leaks the key stream, so the two secrets cannot share one.
    expect(account["token_iv"]).not.toBe(account["app_secret_iv"]);

    // 128 bits of CSPRNG. The slug is the client's only per-client secret.
    const slug = account["webhook_slug"] as string;
    expect(slug).toMatch(/^[0-9a-f]{32}$/);
    expect(body.webhook_url).toBe(`https://api.test/webhook/${slug}`);

    // The audit row is the support record six months from now, and holds neither secret.
    const audit = rows(rest.find((c) => c.table.startsWith("audit_log") && c.method === "POST"));
    expect(audit?.[0]).toMatchObject({ action: "org_onboarded", actor_user_id: ADMIN });
    expect(JSON.stringify(audit)).not.toContain(ONBOARDING.token);
  });

  it("refuses an incomplete onboarding before creating anything", async () => {
    const rest = await harness({ admin: true });
    const { app_secret: _omitted, ...missing } = ONBOARDING;

    expect((await send("POST", "/api/admin/orgs", missing)).status).toBe(400);
    expect(
      (await send("POST", "/api/admin/orgs", { ...ONBOARDING, sector: "lending" })).status,
    ).toBe(400);

    // Half a client is worse than none: it shows on the all-clients table and can receive
    // nothing.
    expect(rest.some((c) => c.method === "POST")).toBe(false);
  });

  it("hands back Meta's refusal of the test message verbatim", async () => {
    const refusal = { error: { message: "Template name does not exist", code: 132001 } };
    await harness({
      admin: true,
      graph: (url) =>
        url.pathname.endsWith("/messages")
          ? Response.json(refusal, { status: 400 })
          : healthyGraph(url),
    });

    const res = await send("POST", `/api/admin/orgs/${ORG_A}/test-message`, { to: "91 98765 43210" });

    // 502, because the send failed — but Meta's own words come through, since they are
    // the entire diagnosis.
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, meta: refusal });
  });

  it("will not delete a client whose data has never been exported", async () => {
    const rest = await harness({ admin: true });
    const res = await send("DELETE", `/api/admin/orgs/${ORG_A}`, { confirm: ORG_NAME });

    // Export, then erase, then delete — enforced here rather than written down, because a
    // DPDP erasure that ran before the client got their data cannot be apologised away.
    expect(res.status).toBe(409);
    expect(rest.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("will not delete on a name that does not match exactly", async () => {
    const rest = await harness({ admin: true, exported: true });
    const res = await send("DELETE", `/api/admin/orgs/${ORG_A}`, { confirm: "acme dental" });

    expect(res.status).toBe(400);
    expect(rest.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes the media, the logins and the client, audited against no client", async () => {
    const rest = await harness({ admin: true, exported: true });
    storedMedia.set(`${ORG_A}/inbound/photo.jpg`, { body: "bytes", contentType: "image/jpeg" });

    const res = await send("DELETE", `/api/admin/orgs/${ORG_A}`, { confirm: ORG_NAME });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: ORG_A, media_objects: 1 });
    // No cascade reaches Storage or auth.users, so both are done by hand.
    expect(storedMedia.size).toBe(0);
    expect(authCalls.some((c) => c.method === "DELETE")).toBe(true);
    expect(
      rest.some((c) => c.table.startsWith("organizations") && c.method === "DELETE"),
    ).toBe(true);

    // org_id null, or the cascade this delete triggers would erase the record of it.
    const audit = rest.find((c) => c.table.startsWith("audit_log") && c.method === "POST");
    expect(audit?.body).toMatchObject({ org_id: null, action: "org_offboarded" });
  });

  // The custom domain and the pages.dev origin are both named, because the second is
  // what a deploy prints and what still answers if DNS is in flight. A method missing
  // from the preflight fails before the handler runs, which reads as a broken route
  // rather than a wrong CORS policy — and the panel uses PATCH and DELETE throughout, plus
  // PUT for the diary. PUT shipped missing from the policy: every other test in this suite
  // calls the Worker with no `origin` header, so this is the only place CORS is exercised
  // at all, and a new method is invisible until someone clicks the button.
  it("clears the preflight for both origins and every method the panel uses", async () => {
    await harness({ admin: true });

    for (const origin of [
      "https://app.logiclovingmind.com",
      "https://wa-agent-dashboard.pages.dev",
    ]) {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const ctx = createExecutionContext();
        const res = await worker.fetch(
          new Request(`https://api.test/api/admin/orgs/${ORG_A}`, {
            method: "OPTIONS",
            headers: { origin, "access-control-request-method": method },
          }),
          env,
          ctx,
        );
        await waitOnExecutionContext(ctx);
        expect(res.headers.get("access-control-allow-origin")).toBe(origin);
        expect(res.headers.get("access-control-allow-methods")).toContain(method);
      }
    }
  });
});
