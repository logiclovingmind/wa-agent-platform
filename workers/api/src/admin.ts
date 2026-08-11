import { Hono } from "hono";
import {
  costMicros,
  createOrgDb,
  createServiceClient,
  decideReply,
  HISTORY_LIMIT,
  HOLD_TEXT,
  holdFor,
  listMedia,
  removeMedia,
  type OrgControls,
  type PromptTurn,
} from "@wa/shared";
import { currentKeyVersion, decryptSecret, encryptSecret } from "./crypto.js";
import { STORAGE_ALARM_BYTES } from "./cron.js";
import type { Caller } from "./auth.js";
import type { Env } from "./env.js";

/**
 * The platform admin's own routes. Everything a client's dashboard needs is either a
 * direct Supabase read under RLS or one of the write routes in api.ts; this file exists
 * for the two things an admin needs that neither can do.
 *
 * The split follows docs/admin-panel.md §1. Anything answerable in SQL is a
 * `security definer` RPC (`admin_orgs`, `admin_health`) so Postgres does the counting
 * and no rows cross the wire. What is left over is here, and it is here for one reason
 * in each case: the Meta checks need a **decrypted client token**, which invariant 6
 * says may never reach a browser, and `media_bytes()` is granted to `service_role`
 * alone.
 *
 * Every route is admin-only, and every route that writes appends to `audit_log` with the
 * acting admin's user id. §1: an admin panel with unaudited writes is worse than no admin
 * panel, because it launders actions that later need explaining to a client.
 */
export const admin = new Hono<{ Bindings: Env; Variables: { caller: Caller } }>();

admin.use("/api/admin/*", async (c, next) => {
  if (c.get("caller").kind !== "platform_admin") return c.json({ error: "admin only" }, 403);
  await next();
});

/**
 * Where a GoTrue link drops the person who clicks it. Stated here rather than left to the
 * project's Site URL, which sat at GoTrue's `http://localhost:3000` default and was
 * therefore baked into every invite and recovery link this panel had ever issued — a
 * setting in a console nobody reopens is not somewhere a client-facing URL should live.
 *
 * First entry of DASHBOARD_ORIGIN, which is the canonical host; the rest are additional
 * origins CORS should accept. Supabase still has to allow this URL under Auth → URL
 * Configuration → Redirect URLs, and that list must stay exact: a wildcard there lets a
 * recovery token be aimed at someone else's site.
 */
function linkRedirect(env: Env): string {
  return `${env.DASHBOARD_ORIGIN.split(",")[0]?.trim() ?? ""}/`;
}

interface WaAccount {
  id: string;
  phone_number_id: string;
  waba_id: string;
  display_phone_number: string;
  token_ciphertext: string;
  token_iv: string;
  token_key_version: number;
  reengagement_template_name: string | null;
  reengagement_template_lang: string | null;
}

/**
 * Is this client actually connected to Meta?
 *
 * The four checks here are the ones our own database cannot answer, and between them
 * they cover every way a client can be silently dead while looking fine on the
 * all-clients table: a token that expired, an app that was never subscribed to the WABA,
 * a number Meta has throttled, and a template that was rejected.
 *
 * **One org per request, on demand.** Doing all of them on page load means one sequential
 * Meta round trip per client — I/O is free against the 10ms budget but the screen is not,
 * and the panel is read far more often than a token expires.
 */
admin.get("/api/admin/health/:orgId", async (c) => {
  const orgId = c.req.param("orgId");

  // The org comes from the URL, which is the one place in this codebase it legitimately
  // can: crossing orgs *is* what this endpoint is for, and the lock is the admin gate
  // above, not the caller's own membership. It still goes through OrgDb so the query
  // carries `org_id` (invariant 2) rather than trusting service_role to be pointed at
  // the right rows.
  const { data, error } = await createOrgDb(c.env, orgId).select(
    "wa_accounts",
    "id,phone_number_id,waba_id,display_phone_number,token_ciphertext,token_iv,token_key_version,reengagement_template_name,reengagement_template_lang",
  );
  if (error) throw new Error(`wa_accounts lookup failed: ${error.message}`);

  const accounts = (data ?? []) as unknown as WaAccount[];
  return c.json({ numbers: await Promise.all(accounts.map((a) => numberHealth(c.env, a))) });
});

async function numberHealth(env: Env, account: WaAccount) {
  const token = await decryptSecret(
    env,
    account.token_ciphertext,
    account.token_iv,
    account.token_key_version,
  );
  const auth = { authorization: `Bearer ${token}` };

  // Independent checks, so they overlap. All four are I/O and cost no CPU; run
  // sequentially and a slow Graph API turns into four slow round trips on one screen.
  const [token_status, subscribed, number, template] = await Promise.all([
    tokenStatus(env, auth, token),
    subscriptionStatus(env, auth, account.waba_id),
    numberStatus(env, auth, account.phone_number_id),
    templateStatus(env, auth, account),
  ]);

  return {
    // The panel needs it to address the template write below; the phone_number_id is
    // Meta's key, not ours.
    wa_account_id: account.id,
    phone_number_id: account.phone_number_id,
    display_phone_number: account.display_phone_number,
    waba_id: account.waba_id,
    token: token_status,
    subscribed,
    number,
    template,
  };
}

/**
 * A Graph read that reports its own failure instead of throwing.
 *
 * A dead token makes several of these calls fail at once, and that *is* the finding —
 * turning it into a 500 would replace the diagnosis with a blank screen.
 */
async function graph<T>(env: Env, path: string, auth: Record<string, string>): Promise<T | null> {
  const res = await fetch(`${env.META_GRAPH_URL}${path}`, { headers: auth });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/**
 * `expires_at: 0` means a permanent system-user token, which is what a client should
 * have. A real timestamp is a countdown to the client going quiet, so it is worth seeing
 * long before it arrives.
 */
async function tokenStatus(env: Env, auth: Record<string, string>, token: string) {
  const body = await graph<{ data?: { is_valid?: boolean; expires_at?: number } }>(
    env,
    `/debug_token?input_token=${encodeURIComponent(token)}`,
    auth,
  );
  if (!body?.data) return { valid: null, expires_at: null };

  const expires = body.data.expires_at;
  return {
    valid: body.data.is_valid ?? null,
    // Meta reports seconds; 0 is "never", and null is "Meta did not say".
    expires_at: typeof expires === "number" && expires > 0 ? expires : null,
  };
}

/**
 * The most valuable check on the screen. An onboarding that never got the app subscribed
 * to the WABA receives **no webhooks at all** — no error anywhere, no row in any table,
 * and on the all-clients view it is indistinguishable from a client whose customers
 * simply have not written this week.
 */
async function subscriptionStatus(env: Env, auth: Record<string, string>, wabaId: string) {
  const body = await graph<{ data?: unknown[] }>(env, `/${wabaId}/subscribed_apps`, auth);
  if (!body?.data) return null;
  return body.data.length > 0;
}

/**
 * Meta throttles quietly. The client experiences it as "the bot stopped replying to new
 * people", reports it as a bug in our software, and nothing on our side looks wrong.
 */
async function numberStatus(env: Env, auth: Record<string, string>, phoneNumberId: string) {
  return graph<{ quality_rating?: string; messaging_limit_tier?: string; verified_name?: string }>(
    env,
    `/${phoneNumberId}?fields=quality_rating,messaging_limit_tier,verified_name`,
    auth,
  );
}

/**
 * Only meaningful once a template is configured. No template is not a fault — the send
 * path falls back to the ordinary handoff when the 24h window is shut — so it reports
 * `null` rather than a failure.
 */
async function templateStatus(env: Env, auth: Record<string, string>, account: WaAccount) {
  const name = account.reengagement_template_name;
  if (!name) return null;

  const body = await graph<{ data?: Array<{ name?: string; status?: string; language?: string }> }>(
    env,
    `/${account.waba_id}/message_templates?fields=name,status,language&name=${encodeURIComponent(name)}`,
    auth,
  );
  const match = body?.data?.find(
    (t) => t.name === name && (!account.reengagement_template_lang || t.language === account.reengagement_template_lang),
  );

  return {
    name,
    language: account.reengagement_template_lang,
    // `null` means configured but not found in this WABA, which is a real fault and a
    // different one from "rejected".
    status: match?.status ?? null,
  };
}

/**
 * The runtime controls of docs/admin-panel.md §3.
 *
 * Every one of these is a row edit, never a deploy — that is the whole test of whether
 * "client #21 is an INSERT" still holds. A partial patch: the panel sends only what
 * changed, so a field left out is left alone, and `null` is a real value meaning "back
 * to the platform default".
 *
 * Hand-validated rather than schema-validated because the set is tiny and closed, and an
 * unrecognised key must be dropped rather than reach the UPDATE: this route holds
 * service_role, so an unfiltered patch body would be an arbitrary write to
 * `organizations` from the browser.
 */
const CONTROLS = {
  ai_paused: bool,
  cap_micros: positiveIntOrNull,
  retention_months: (v: unknown) => rangeOrNull(v, 1, 84),
  media_retention_days: (v: unknown) => rangeOrNull(v, 1, 3650),
  hours_open_ist: timeOrNull,
  hours_close_ist: timeOrNull,
  out_of_hours: (v: unknown) => (v === "reply" || v === "handoff" ? v : undefined),
  // §10. Bounds mirror the check constraints in 0018 so a bad value is a 400 here rather
  // than a 500 out of Postgres.
  voice: (v: unknown) => textOrNull(v, 500),
  reply_max_words: (v: unknown) => rangeOrNull(v, 20, 300),
  languages: (v: unknown) => textOrNull(v, 200),
} as const;

function bool(v: unknown) {
  return typeof v === "boolean" ? v : undefined;
}

function positiveIntOrNull(v: unknown) {
  if (v === null) return null;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

function rangeOrNull(v: unknown, min: number, max: number) {
  if (v === null) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/** Empty and whitespace-only both mean null: an empty textarea is "unset", not "". */
function textOrNull(v: unknown, max: number) {
  if (v === null) return null;
  if (typeof v !== "string" || v.length > max) return undefined;
  return v.trim() === "" ? null : v.trim();
}

/** `HH:MM`, which is what the panel's time input emits and what Postgres `time` takes. */
function timeOrNull(v: unknown) {
  if (v === null) return null;
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined;
}

admin.patch("/api/admin/orgs/:orgId/controls", async (c) => {
  const orgId = c.req.param("orgId");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "invalid body" }, 400);

  const patch: Record<string, unknown> = {};
  for (const [key, parse] of Object.entries(CONTROLS)) {
    if (!(key in body)) continue;
    const value = parse(body[key]);
    if (value === undefined) return c.json({ error: `invalid ${key}` }, 400);
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "nothing to change" }, 400);

  const db = createOrgDb(c.env, orgId);

  // organizations is keyed by id, not org_id, so this is the one write here that cannot
  // go through OrgDb.update(). The filter is still the org from the URL.
  const { error } = await createServiceClient(c.env)
    .from("organizations")
    .update(patch)
    .eq("id", orgId);
  if (error) throw new Error(`controls update failed: ${error.message}`);

  // After the write, not before: an audit row for an UPDATE that failed is a lie about
  // what happened, and the update is the thing the client would be asking about.
  const audit = await db.insert("audit_log", {
    actor_user_id: c.get("caller").userId,
    action: "org_controls_changed",
    detail: patch,
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  return c.json({ updated: patch });
});

/**
 * The re-engagement template, per WhatsApp number. Its columns have existed since 0005
 * and until now the only way to set them was an UPDATE by hand.
 *
 * Both fields move together on purpose: a name without a language cannot be sent, and
 * the send path treats that pair as all-or-nothing.
 */
admin.patch("/api/admin/wa-accounts/:id/template", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const orgId = typeof body?.["org_id"] === "string" ? body["org_id"] : null;
  if (!orgId) return c.json({ error: "org_id required" }, 400);

  const name = body?.["name"];
  const lang = body?.["language"];
  const clearing = name === null || name === "";
  if (!clearing && (typeof name !== "string" || typeof lang !== "string" || !lang)) {
    return c.json({ error: "name and language must be set together" }, 400);
  }

  const db = createOrgDb(c.env, orgId);
  const patch = {
    reengagement_template_name: clearing ? null : (name as string),
    reengagement_template_lang: clearing ? null : (lang as string),
  };

  const { error } = await db.update("wa_accounts", patch).eq("id", c.req.param("id"));
  if (error) throw new Error(`template update failed: ${error.message}`);

  const audit = await db.insert("audit_log", {
    actor_user_id: c.get("caller").userId,
    action: "reengagement_template_changed",
    detail: { wa_account_id: c.req.param("id"), ...patch },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  return c.json({ updated: patch });
});

/**
 * Resolve one safety flag (docs/admin-panel.md §5).
 *
 * The queue itself is `admin_flags()` — a definer RPC, because `safety_flags` has no
 * platform-admin read policy and is not getting one. Resolving is a write, so it comes
 * here, and it carries a note: `resolved_at` on its own records that somebody closed a
 * distress flag without recording who or why, which is useless in the one situation
 * these rows exist for.
 *
 * `org_id` comes from the body rather than being looked up from the flag: invariant 2
 * wants the filter in code, and a route that resolves whatever org the id happens to
 * belong to is a route with no org filter at all.
 */
admin.post("/api/admin/flags/:flagId/resolve", async (c) => {
  const flagId = c.req.param("flagId");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const orgId = typeof body?.["org_id"] === "string" ? body["org_id"] : null;
  if (!orgId) return c.json({ error: "org_id required" }, 400);

  const raw = body?.["note"];
  const note = typeof raw === "string" ? raw.trim().slice(0, 500) : "";
  if (!note) return c.json({ error: "note required" }, 400);

  const db = createOrgDb(c.env, orgId);
  const caller = c.get("caller").userId;

  // `resolved_at is null` makes this idempotent in the way that matters: a double click
  // cannot overwrite the first admin's note with the second one's.
  const { data, error } = await db
    .update("safety_flags", {
      resolved_at: new Date().toISOString(),
      resolved_by: caller,
      resolution_note: note,
    })
    .eq("id", flagId)
    .is("resolved_at", null)
    .select("id");
  if (error) throw new Error(`flag resolve failed: ${error.message}`);
  if (!data || data.length === 0) return c.json({ error: "not found or already resolved" }, 404);

  const audit = await db.insert("audit_log", {
    actor_user_id: caller,
    action: "safety_flag_resolved",
    // The note, not the conversation. Nothing a customer wrote is copied into this row.
    detail: { flag_id: flagId, note },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  return c.json({ resolved: flagId });
});

/**
 * Access management (docs/admin-panel.md §6).
 *
 * Every route below both creates a login and grants it access to exactly one client, and
 * the two halves live in different places — GoTrue owns the password, `org_members` owns
 * the role. Doing one without the other is the failure `scripts/accounts.sql` was written
 * to clean up: an account that signs in successfully and then sees an empty dashboard.
 *
 * No password is ever chosen here, sent here, or stored here. The admin gets a one-time
 * link and hands it over; the person sets their own. The link is a credential, so it is
 * returned once and never written to `audit_log`.
 */
interface Membership {
  user_id: string;
  role: string;
}

admin.post("/api/admin/orgs/:orgId/users", async (c) => {
  const orgId = c.req.param("orgId");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const email = typeof body?.["email"] === "string" ? body["email"].trim().toLowerCase() : "";
  const role = body?.["role"];
  if (!email.includes("@")) return c.json({ error: "valid email required" }, 400);
  if (role !== "owner" && role !== "staff") return c.json({ error: "invalid role" }, 400);

  const sb = createServiceClient(c.env);
  const db = createOrgDb(c.env, orgId);

  // `invite` creates the auth user and returns the link in one call. It does not send
  // mail — this project has no SMTP, and a link the admin passes on by hand is the
  // honest version of that rather than an invitation that silently never arrives.
  const { data: link, error: linkError } = await sb.auth.admin.generateLink({
    type: "invite",
    email,
    options: { redirectTo: linkRedirect(c.env) },
  });
  if (linkError || !link.user) return c.json({ error: linkError?.message ?? "invite failed" }, 400);

  const userId = link.user.id;
  const profile = await db.insert("users", { id: userId, email, is_platform_admin: false });
  const member = profile.error ? null : await db.insert("org_members", { user_id: userId, role });

  if (profile.error || member?.error) {
    // Roll the login back rather than leave one that can sign in and reach nothing.
    await sb.auth.admin.deleteUser(userId);
    throw new Error(`user create failed: ${(profile.error ?? member?.error)?.message}`);
  }

  const audit = await db.insert("audit_log", {
    actor_user_id: c.get("caller").userId,
    action: "user_added",
    detail: { user_id: userId, email, role },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  return c.json({ user_id: userId, invite_link: link.properties?.action_link ?? null });
});

admin.patch("/api/admin/orgs/:orgId/users/:userId", async (c) => {
  const orgId = c.req.param("orgId");
  const userId = c.req.param("userId");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const role = body?.["role"];
  if (role !== "owner" && role !== "staff") return c.json({ error: "invalid role" }, 400);

  const db = createOrgDb(c.env, orgId);
  if (role === "staff" && (await isLastOwner(db, userId))) {
    return c.json({ error: "this is the org's only owner" }, 409);
  }

  const { data, error } = await db
    .update("org_members", { role })
    .eq("user_id", userId)
    .select("user_id");
  if (error) throw new Error(`role change failed: ${error.message}`);
  if (!data || data.length === 0) return c.json({ error: "not a member of this org" }, 404);

  const audit = await db.insert("audit_log", {
    actor_user_id: c.get("caller").userId,
    action: "user_role_changed",
    detail: { user_id: userId, role },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  return c.json({ user_id: userId, role });
});

admin.delete("/api/admin/orgs/:orgId/users/:userId", async (c) => {
  const orgId = c.req.param("orgId");
  const userId = c.req.param("userId");
  const db = createOrgDb(c.env, orgId);

  // Membership is checked before the delete, not after: `auth.admin.deleteUser` is not
  // scoped to an org and would happily remove a different client's owner.
  const { data: rows, error: readError } = await db
    .select("org_members", "user_id,role", { limit: 1 })
    .eq("user_id", userId);
  if (readError) throw new Error(`membership read failed: ${readError.message}`);
  if (!rows || rows.length === 0) return c.json({ error: "not a member of this org" }, 404);
  if (await isLastOwner(db, userId)) {
    return c.json({ error: "this is the org's only owner" }, 409);
  }

  // Audited first, and deliberately: `users` and `org_members` both cascade off
  // `auth.users`, so once the login is gone there is no row left to name in the detail.
  const audit = await db.insert("audit_log", {
    actor_user_id: c.get("caller").userId,
    action: "user_removed",
    detail: { user_id: userId },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  const { error } = await createServiceClient(c.env).auth.admin.deleteUser(userId);
  if (error) throw new Error(`user delete failed: ${error.message}`);

  return c.json({ removed: userId });
});

admin.post("/api/admin/orgs/:orgId/users/:userId/reset", async (c) => {
  const orgId = c.req.param("orgId");
  const userId = c.req.param("userId");
  const db = createOrgDb(c.env, orgId);

  const { data: rows, error: readError } = await db
    .select("users", "id,email", { limit: 1 })
    .eq("id", userId);
  if (readError) throw new Error(`user read failed: ${readError.message}`);
  const email = (rows?.[0] as { email?: string } | undefined)?.email;
  if (!email) return c.json({ error: "not a user of this org" }, 404);

  const { data: link, error } = await createServiceClient(c.env).auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: linkRedirect(c.env) },
  });
  if (error) return c.json({ error: error.message }, 400);

  const audit = await db.insert("audit_log", {
    actor_user_id: c.get("caller").userId,
    action: "password_reset_link_issued",
    // The email, never the link. An audit row that contains a working credential is a
    // second copy of that credential, sitting somewhere with a longer retention.
    detail: { user_id: userId, email },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  return c.json({ reset_link: link.properties?.action_link ?? null });
});

/**
 * An org with no owner cannot manage its own staff or read its own billing, and nothing
 * in the client dashboard can fix that — it would need us, through this panel, which is
 * the situation worth not creating in the first place.
 */
async function isLastOwner(db: ReturnType<typeof createOrgDb>, userId: string): Promise<boolean> {
  const { data } = await db.select("org_members", "user_id,role").eq("role", "owner");
  const owners = (data ?? []) as unknown as Membership[];
  return owners.length === 1 && owners[0]?.user_id === userId;
}

/**
 * Grant or revoke platform admin, by email (docs/admin-panel.md §6).
 *
 * By email and never seeded, for the reason at the bottom of `scripts/demo-seed.sql`:
 * every other script in this repo picks its org by "oldest wa_account", so a seeded grant
 * would hand this flag to client 1's owner on the day they onboard.
 *
 * The only route here that touches no org. That is what `audit_log.org_id` was made
 * nullable for in 0015 — an admin action with no client attached still has to be
 * auditable, and the alternative was attributing it to an arbitrary org.
 */
admin.post("/api/admin/platform-admins", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const email = typeof body?.["email"] === "string" ? body["email"].trim().toLowerCase() : "";
  const grant = body?.["grant"];
  if (!email.includes("@")) return c.json({ error: "valid email required" }, 400);
  if (typeof grant !== "boolean") return c.json({ error: "grant must be a boolean" }, 400);

  const caller = c.get("caller").userId;
  const sb = createServiceClient(c.env);

  const { data, error } = await sb
    .from("users")
    .update({ is_platform_admin: grant })
    .eq("email", email)
    .select("id");
  if (error) throw new Error(`platform admin update failed: ${error.message}`);
  const target = (data?.[0] as { id?: string } | undefined)?.id;
  if (!target) return c.json({ error: "no account with that email" }, 404);

  // Checked after the update reveals who the email belongs to, and reversed immediately:
  // an admin who revokes their own flag mid-session locks the panel for everyone, and
  // there is no second admin to undo it.
  if (!grant && target === caller) {
    await sb.from("users").update({ is_platform_admin: true }).eq("id", caller);
    return c.json({ error: "cannot revoke your own admin access" }, 409);
  }

  const audit = await sb.from("audit_log").insert({
    org_id: null,
    actor_user_id: caller,
    action: grant ? "platform_admin_granted" : "platform_admin_revoked",
    detail: { email },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  return c.json({ email, is_platform_admin: grant });
});

/**
 * Onboarding, in one request (docs/admin-panel.md §4).
 *
 * **The most dangerous surface in the panel**, because it is the only place in the Worker
 * that turns a plaintext Meta token into stored ciphertext. Everything that follows from
 * that is deliberate: the plaintext is read from the body once, sealed, and never appears
 * in a response, in `audit_log`, or in an error message. `MASTER_KEY_V*` stays a
 * write-only Wrangler secret and the browser never sees it — invariant 6.
 *
 * The whole thing is an INSERT, which is the claim CLAUDE.md makes about client #21. This
 * route makes that INSERT convenient. It does not make it a deploy.
 */
interface Onboarding {
  name: string;
  sector: string;
  phone_number_id: string;
  waba_id: string;
  display_phone_number: string;
  token: string;
  app_secret: string;
  owner_email: string;
}

const SECTORS = ["general", "real_estate", "healthcare", "pharmacy"];

function onboarding(body: Record<string, unknown> | null): Onboarding | string {
  const fields: Array<keyof Onboarding> = [
    "name",
    "sector",
    "phone_number_id",
    "waba_id",
    "display_phone_number",
    "token",
    "app_secret",
    "owner_email",
  ];

  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = body?.[field];
    if (typeof value !== "string" || !value.trim()) return `${field} is required`;
    out[field] = value.trim();
  }
  if (!SECTORS.includes(out["sector"] as string)) return "unknown sector";
  if (!out["owner_email"]?.includes("@")) return "owner_email is not an email";
  return out as unknown as Onboarding;
}

/**
 * The slug *is* the per-client secret — one `META_VERIFY_TOKEN` covers every client, so
 * an unguessable path is what stops one client's webhook reaching another's. 128 bits
 * from the platform CSPRNG, never a name or a number.
 */
function webhookSlug(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

admin.post("/api/admin/orgs", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const input = onboarding(body);
  if (typeof input === "string") return c.json({ error: input }, 400);

  const sb = createServiceClient(c.env);

  const org = await sb
    .from("organizations")
    .insert({ name: input.name, sector: input.sector })
    .select("id")
    .maybeSingle<{ id: string }>();
  if (org.error || !org.data) {
    throw new Error(`org create failed: ${org.error?.message ?? "no row"}`);
  }
  const orgId = org.data.id;
  const db = createOrgDb(c.env, orgId);
  const caller = c.get("caller").userId;

  const version = currentKeyVersion(c.env);
  const [token, appSecret] = await Promise.all([
    encryptSecret(c.env, input.token, version),
    encryptSecret(c.env, input.app_secret, version),
  ]);

  const slug = webhookSlug();
  const account = await db.insert("wa_accounts", {
    phone_number_id: input.phone_number_id,
    waba_id: input.waba_id,
    display_phone_number: input.display_phone_number,
    webhook_slug: slug,
    token_ciphertext: token.ciphertext,
    token_iv: token.iv,
    token_key_version: version,
    app_secret_ciphertext: appSecret.ciphertext,
    app_secret_iv: appSecret.iv,
    app_secret_key_version: version,
  });
  if (account.error) {
    // An org with no number is a row that shows up on the all-clients table and can never
    // receive anything. Undo it rather than leave the panel lying.
    await sb.from("organizations").delete().eq("id", orgId);
    throw new Error(`wa_account create failed: ${account.error.message}`);
  }

  // Not rolled back when it fails, on purpose: the org is real and correct at this point,
  // and an unsubscribed WABA is exactly what the health screen reports as a fault. Losing
  // the encrypted token to a Meta outage would be the worse trade.
  const subscribed = await subscribeApp(c.env, input.waba_id, input.token);

  const invite = await sb.auth.admin.generateLink({ type: "invite", email: input.owner_email });
  if (!invite.error && invite.data.user) {
    const userId = invite.data.user.id;
    await db.insert("users", { id: userId, email: input.owner_email, is_platform_admin: false });
    await db.insert("org_members", { user_id: userId, role: "owner" });
  }

  // No token, no app secret, no invite link. Everything here is a fact about the client
  // that a support conversation would need six months from now.
  const audit = await db.insert("audit_log", {
    actor_user_id: caller,
    action: "org_onboarded",
    detail: {
      name: input.name,
      sector: input.sector,
      phone_number_id: input.phone_number_id,
      waba_id: input.waba_id,
      key_version: version,
      subscribed,
    },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  return c.json({
    org_id: orgId,
    // The one thing that has to be copied into Meta by hand, and the one thing that must
    // not be guessable.
    webhook_url: `${new URL(c.req.url).origin}/webhook/${slug}`,
    subscribed,
    invite_link: invite.data?.properties?.action_link ?? null,
    invite_error: invite.error?.message ?? null,
  });
});

async function subscribeApp(env: Env, wabaId: string, token: string): Promise<boolean> {
  const res = await fetch(`${env.META_GRAPH_URL}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  return res?.ok === true;
}

/**
 * The last step of onboarding: prove the number can actually send, before the client
 * touches it.
 *
 * A template, not free text. There is no open 24-hour window with a number nobody has
 * messaged yet, so a free-form send would fail for a reason that has nothing to do with
 * whether the setup works. `hello_world` is approved in every new WABA by default.
 */
admin.post("/api/admin/orgs/:orgId/test-message", async (c) => {
  const orgId = c.req.param("orgId");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const to = typeof body?.["to"] === "string" ? body["to"].replace(/\D/g, "") : "";
  if (!to) return c.json({ error: "a destination number is required" }, 400);

  const db = createOrgDb(c.env, orgId);
  const { data, error } = await db
    .select(
      "wa_accounts",
      "phone_number_id,token_ciphertext,token_iv,token_key_version",
      { limit: 1 },
    )
    .maybeSingle<WaAccount>();
  if (error) throw new Error(`wa_account lookup failed: ${error.message}`);
  if (!data) return c.json({ error: "no WhatsApp number for this client" }, 404);

  const token = await decryptSecret(
    c.env,
    data.token_ciphertext,
    data.token_iv,
    data.token_key_version,
  );

  const res = await fetch(`${c.env.META_GRAPH_URL}/${data.phone_number_id}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: "hello_world", language: { code: "en_US" } },
    }),
  });
  const reply = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  const audit = await db.insert("audit_log", {
    actor_user_id: c.get("caller").userId,
    action: "test_message_sent",
    detail: { to, ok: res.ok },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  // Meta's own error, verbatim. The whole value of this button is the message Meta gives
  // back when it refuses — paraphrasing it would throw away the diagnosis.
  return c.json({ ok: res.ok, meta: reply }, res.ok ? 200 : 502);
});

/**
 * Offboarding, in the order §4 sets out: export, then erase, then delete.
 *
 * The order is enforced rather than documented — the delete refuses until an
 * `org_exported` row exists for this client. A DPDP erasure that ran before the client
 * got their data is not recoverable by apologising.
 */
admin.post("/api/admin/orgs/:orgId/export", async (c) => {
  const orgId = c.req.param("orgId");
  const sb = createServiceClient(c.env);

  // Past OrgDb's 20-row cap and deliberately so: a partial export is not an export. Named
  // columns (invariant 7) and org-filtered in code (invariant 2). Media as keys, never
  // bytes — one offboarding must not pull the egress budget through the Worker.
  const [conversations, messages] = await Promise.all([
    sb
      .from("conversations")
      .select("id,customer_wa_id,customer_name,handoff_state,created_at,last_message_at")
      .eq("org_id", orgId),
    sb
      .from("messages")
      .select("conversation_id,wa_message_id,direction,type,body,media_key,created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: true }),
  ]);
  if (conversations.error || messages.error) {
    throw new Error(`export failed: ${(conversations.error ?? messages.error)?.message}`);
  }

  const audit = await createOrgDb(c.env, orgId).insert("audit_log", {
    actor_user_id: c.get("caller").userId,
    action: "org_exported",
    detail: {
      conversations: conversations.data.length,
      messages: messages.data.length,
    },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  return c.json({
    exported_at: new Date().toISOString(),
    conversations: conversations.data,
    messages: messages.data,
  });
});

admin.delete("/api/admin/orgs/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const confirm = typeof body?.["confirm"] === "string" ? body["confirm"] : "";

  const sb = createServiceClient(c.env);
  const org = await sb
    .from("organizations")
    .select("id,name")
    .eq("id", orgId)
    .maybeSingle<{ id: string; name: string }>();
  if (org.error) throw new Error(`org lookup failed: ${org.error.message}`);
  if (!org.data) return c.json({ error: "no such client" }, 404);

  // Typing the name is the only guard between a mis-click and a client's entire history.
  if (confirm !== org.data.name) {
    return c.json({ error: "type the client's name exactly to confirm" }, 400);
  }

  const exported = await sb
    .from("audit_log")
    .select("id")
    .eq("org_id", orgId)
    .eq("action", "org_exported")
    .limit(1);
  if (exported.error) throw new Error(`export check failed: ${exported.error.message}`);
  if (exported.data.length === 0) {
    return c.json({ error: "export this client's data before deleting it" }, 409);
  }

  // Storage is not in Postgres and no cascade reaches it. Media first, because a failure
  // here should stop the delete rather than orphan a client's photographs in a bucket
  // nothing points at any more.
  const keys = await listMedia(c.env, orgId);
  if (keys.length > 0) await removeMedia(c.env, keys);

  // Logins do not cascade from `organizations`: `public.users` is deleted by the cascade,
  // but the `auth.users` row behind it survives and can still sign in.
  const members = await sb.from("users").select("id").eq("org_id", orgId);
  if (members.error) throw new Error(`member lookup failed: ${members.error.message}`);

  // org_id null so the row outlives the org. `audit_log.org_id` cascades, so an audit of
  // this delete written against the org would be deleted by the very thing it records.
  const audit = await sb.from("audit_log").insert({
    org_id: null,
    actor_user_id: c.get("caller").userId,
    action: "org_offboarded",
    detail: { org_id: orgId, name: org.data.name, media_objects: keys.length },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  for (const member of members.data as Array<{ id: string }>) {
    await sb.auth.admin.deleteUser(member.id);
  }

  const { error } = await sb.from("organizations").delete().eq("id", orgId);
  if (error) throw new Error(`org delete failed: ${error.message}`);

  return c.json({ deleted: orgId, media_objects: keys.length });
});

/**
 * The free-tier ceilings that are shared by every client, so no client's own screen can
 * show them and no client's own screen should.
 *
 * Only the media bucket is here. Egress against the 5GB budget is not readable from
 * Postgres, and the backup and dead-man's-switch states live in GitHub and
 * healthchecks.io — both need their own credentials, which is a separate decision from
 * this one.
 */
admin.get("/api/admin/platform", async (c) => {
  // Metadata only: media_bytes() sums the size Storage recorded at upload time and never
  // touches an object, which matters for a number whose job is protecting egress.
  const { data, error } = await createServiceClient(c.env).rpc("media_bytes");
  if (error) throw new Error(`media_bytes failed: ${error.message}`);

  return c.json({
    media_bytes: Number(data ?? 0),
    // The cron's own threshold, imported rather than restated, so the screen and the
    // nightly alarm can never disagree about what "nearly full" means.
    media_alarm_bytes: STORAGE_ALARM_BYTES,
    media_limit_bytes: 1024 * 1024 * 1024,
  });
});

// --- training console -------------------------------------------------------

const CONSOLE_MAX_CHARS = 2_000;

/**
 * The training console — docs/admin-panel.md §11.
 *
 * Runs `decideReply()`, which is the same function the Durable Object runs, so what this
 * returns is what a customer would have received. It is not a simulation of the reply
 * path; it *is* the reply path, minus the sending. That is the whole reason the decision
 * was split out of the DO: a second implementation would drift and then report confidence
 * that is false.
 *
 * Structurally incapable of messaging anyone. A verdict carries no send in it, there is no
 * conversation, and Meta is never called. It writes exactly two rows: the `usage_events`
 * row for money it really spent, and the `audit_log` row for having spent it.
 *
 * History is supplied by the caller and held in the browser. Nothing here reads or writes
 * `messages`, so §1's rule that the admin never sees customer content survives — the only
 * text in play is what the admin typed.
 */
admin.post("/api/admin/console/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "invalid body" }, 400);

  const text = typeof body["text"] === "string" ? body["text"].trim() : "";
  if (!text) return c.json({ error: "text required" }, 400);
  if (text.length > CONSOLE_MAX_CHARS) return c.json({ error: "text too long" }, 400);

  const history = consoleHistory(body["history"]);
  if (!history) return c.json({ error: "invalid history" }, 400);

  const db = createOrgDb(c.env, orgId);

  const { data: org } = await db
    .organization(
      "name,sector,ai_paused,cap_micros,hours_open_ist,hours_close_ist,out_of_hours," +
        "voice,reply_max_words,languages",
    )
    .maybeSingle<OrgControls>();
  if (!org) return c.json({ error: "unknown org" }, 404);

  // Reported whether or not it is applied. A console that went dark on a paused client
  // would be unavailable exactly when "why has this client stopped replying?" is the
  // question being asked.
  const hold = await holdFor(org, async () => {
    const { data, error } = await db.monthSpendMicros();
    return error ? null : Number(data ?? 0);
  });
  const override = body["overrideHold"] === true;

  const { data: docs } = await db
    .select("kb_documents", "raw", { limit: 5 })
    .returns<Array<{ raw: string }>>();
  const kb = (docs ?? []).map((d) => d.raw).join("\n\n");

  const verdict = await decideReply(c.env, {
    customerText: text,
    types: ["text"],
    imageIds: [],
    loadContext: async () => ({
      businessName: org.name,
      sector: org.sector,
      kb,
      history,
      hold: hold && !override ? HOLD_TEXT[hold] : null,
      voice: org.voice,
      replyMaxWords: org.reply_max_words,
      languages: org.languages,
    }),
  });

  const usage = "usage" in verdict ? verdict.usage : undefined;
  const cost = usage ? costMicros(usage) : 0;

  // Metered under its own category: this is our testing, not the client's traffic, and
  // folding it into `reply` would inflate the per-reply figure the cost screen exists to
  // report. `conversation_id` is null, which the column has always allowed.
  if (cost > 0) {
    const { error } = await db.insert("usage_events", {
      conversation_id: null,
      pricing_category: "console",
      cost_micros: cost,
    });
    if (error) throw new Error(`usage_events insert failed: ${error.message}`);
  }

  // The typed message is deliberately NOT in the audit row. It spends from the shared
  // wallet, so the spend is audited; the text is scratch input and nothing is served by
  // keeping it for a year.
  const audit = await db.insert("audit_log", {
    actor_user_id: c.get("caller").userId,
    action: "console_run",
    detail: {
      stage: verdict.stage,
      action: verdict.action,
      cost_micros: cost,
      overrode_hold: override && hold !== null,
    },
  });
  if (audit.error) throw new Error(`audit_log insert failed: ${audit.error.message}`);

  return c.json({
    action: verdict.action,
    stage: verdict.stage,
    text: "text" in verdict ? verdict.text : null,
    kind: verdict.action === "safe" ? verdict.kind : null,
    hold,
    overrodeHold: override && hold !== null,
    costMicros: cost,
    usage: usage ?? null,
    kbBytes: kb.length,
    sector: org.sector,
    voice: org.voice,
    replyMaxWords: org.reply_max_words,
    languages: org.languages,
    // The exact system prompt that was sent. "Why did it say that" is usually answered
    // by reading this rather than by arguing with the model.
    systemPrompt: "messages" in verdict ? (verdict.messages?.[0]?.content ?? null) : null,
  });
});

/** Browser-held history. Rejected rather than trimmed: a silently shortened conversation
 * would make the console disagree with the DO for reasons nobody could see. */
function consoleHistory(v: unknown): PromptTurn[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > HISTORY_LIMIT * 2) return null;

  const turns: PromptTurn[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) return null;
    const turn = raw as Record<string, unknown>;
    const direction = turn["direction"];
    const body = turn["body"];
    if (direction !== "inbound" && direction !== "outbound") return null;
    if (typeof body !== "string" || body.length > CONSOLE_MAX_CHARS) return null;
    turns.push({ direction, body });
  }
  return turns;
}
