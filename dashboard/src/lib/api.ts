import { supabase } from "./supabase";

/**
 * The writes that need the Worker. Everything else the dashboard does is a read
 * straight from Supabase under RLS — see supabase.ts.
 */
const BASE = import.meta.env.VITE_API_URL;

async function post(path: string, body?: unknown): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("signed out");

  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function authedGet(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("signed out");

  return fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

/**
 * Rupees left in the LLM wallet, or null if the provider did not answer. Platform admin
 * only, and enforced there: one wallet funds every client, so this is our balance and
 * not a client's.
 */
export async function walletBalance(): Promise<number | null> {
  const res = await authedGet("/api/usage/balance");
  if (!res.ok) return null;
  const body = (await res.json()) as { balance_inr: number | null };
  return body.balance_inr;
}

/** One WhatsApp number as Meta currently sees it. Every field is null when Meta did not answer. */
export interface NumberHealth {
  wa_account_id: string;
  phone_number_id: string;
  display_phone_number: string;
  waba_id: string;
  token: { valid: boolean | null; expires_at: number | null };
  /** False is the silent killer: no subscription means no webhooks and no error anywhere. */
  subscribed: boolean | null;
  number: { quality_rating?: string; messaging_limit_tier?: string } | null;
  template: { name: string; language: string | null; status: string | null } | null;
}

/**
 * Live Meta checks for one client, on demand. Not fetched for every row on page load:
 * each client is its own set of Graph round trips, and a token expires far less often
 * than this screen is opened.
 */
export async function clientHealth(orgId: string): Promise<NumberHealth[]> {
  const res = await authedGet(`/api/admin/health/${orgId}`);
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { numbers: NumberHealth[] }).numbers;
}

export interface PlatformStats {
  media_bytes: number;
  media_alarm_bytes: number;
  media_limit_bytes: number;
}

/** Free-tier ceilings shared by every client, so they belong to no client's screen. */
export async function platformStats(): Promise<PlatformStats | null> {
  const res = await authedGet("/api/admin/platform");
  if (!res.ok) return null;
  return (await res.json()) as PlatformStats;
}

/**
 * A partial patch of one client's runtime controls (admin-panel.md §3). Only the keys
 * present are changed; `null` means "back to the platform default". Admin-only and
 * audited on the Worker side.
 */
export interface OrgControls {
  ai_paused: boolean;
  cap_micros: number | null;
  retention_months: number | null;
  media_retention_days: number | null;
  hours_open_ist: string | null;
  hours_close_ist: string | null;
  out_of_hours: "reply" | "handoff";
  /** admin-panel.md §10. Written from the training console, never by a client. */
  voice: string | null;
  reply_max_words: number | null;
  languages: string | null;
}

export async function setControls(
  orgId: string,
  patch: Partial<OrgControls>,
): Promise<void> {
  const res = await patchJson(`/api/admin/orgs/${orgId}/controls`, patch);
  if (!res.ok) throw new Error(await res.text());
}

/** Both fields move together: a template name with no language cannot be sent. */
export async function setTemplate(
  waAccountId: string,
  orgId: string,
  template: { name: string; language: string } | null,
): Promise<void> {
  const res = await patchJson(`/api/admin/wa-accounts/${waAccountId}/template`, {
    org_id: orgId,
    name: template?.name ?? null,
    language: template?.language ?? null,
  });
  if (!res.ok) throw new Error(await res.text());
}

async function patchJson(path: string, body: unknown): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("signed out");

  return fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Close one flag with a reason (admin-panel.md §5). The note is required by the Worker:
 * a resolved flag with nobody's name and no reason on it is no better than an unresolved
 * one, and worse than leaving it open, because it looks handled.
 */
export async function resolveFlag(
  flagId: string,
  orgId: string,
  note: string,
): Promise<void> {
  const res = await post(`/api/admin/flags/${flagId}/resolve`, { org_id: orgId, note });
  if (!res.ok) throw new Error(await res.text());
}

/**
 * Adding a login returns a one-time invite link and the dashboard shows it once. No mail
 * is sent — there is no SMTP — so the admin copies the link and passes it on. Nothing
 * here ever sees or sets a password.
 */
export async function addOrgUser(
  orgId: string,
  email: string,
  role: "owner" | "staff",
): Promise<string | null> {
  const res = await post(`/api/admin/orgs/${orgId}/users`, { email, role });
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { invite_link: string | null }).invite_link;
}

export async function setUserRole(
  orgId: string,
  userId: string,
  role: "owner" | "staff",
): Promise<void> {
  const res = await patchJson(`/api/admin/orgs/${orgId}/users/${userId}`, { role });
  if (!res.ok) throw new Error(await res.text());
}

/** Removes the login itself, not just the membership: an account that can sign in and
 * reach nothing is the confusion this is meant to end. 409 means the org's last owner. */
export async function removeOrgUser(orgId: string, userId: string): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("signed out");

  const res = await fetch(`${BASE}/api/admin/orgs/${orgId}/users/${userId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function resetPassword(orgId: string, userId: string): Promise<string | null> {
  const res = await post(`/api/admin/orgs/${orgId}/users/${userId}/reset`);
  if (!res.ok) throw new Error(await res.text());
  return ((await res.json()) as { reset_link: string | null }).reset_link;
}

/**
 * Everything a client needs to exist, in one request (admin-panel.md §4). The token and
 * app secret are typed in here and sealed by the Worker; nothing sends them anywhere
 * else, and nothing reads them back — `wa_accounts` is unreadable from the browser under
 * any login.
 */
export interface Onboarding {
  name: string;
  sector: string;
  phone_number_id: string;
  waba_id: string;
  display_phone_number: string;
  token: string;
  app_secret: string;
  owner_email: string;
}

export interface Onboarded {
  org_id: string;
  /** Paste into Meta. The slug is this client's only per-client secret. */
  webhook_url: string;
  subscribed: boolean;
  invite_link: string | null;
  invite_error: string | null;
}

export async function onboard(input: Onboarding): Promise<Onboarded> {
  const res = await post("/api/admin/orgs", input);
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as Onboarded;
}

/** The end-to-end proof. Meta's own refusal comes back verbatim, because that is the
 * diagnosis. */
export async function testMessage(
  orgId: string,
  to: string,
): Promise<{ ok: boolean; meta: unknown }> {
  const res = await post(`/api/admin/orgs/${orgId}/test-message`, { to });
  return (await res.json()) as { ok: boolean; meta: unknown };
}

export async function exportOrg(orgId: string): Promise<unknown> {
  const res = await post(`/api/admin/orgs/${orgId}/export`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/**
 * Irreversible. The Worker refuses unless the client's data has been exported first and
 * the name is typed exactly — export, then erase, then delete, in that order.
 */
export async function offboardOrg(orgId: string, confirm: string): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("signed out");

  const res = await fetch(`${BASE}/api/admin/orgs/${orgId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ confirm }),
  });
  if (!res.ok) throw new Error(await res.text());
}

/** By email, because the target may belong to no org and so cannot be picked off a row. */
export async function setPlatformAdmin(email: string, grant: boolean): Promise<void> {
  const res = await post("/api/admin/platform-admins", { email, grant });
  if (!res.ok) throw new Error(await res.text());
}

/** One turn of browser-held console history. Never persisted anywhere. */
export interface ConsoleTurn {
  direction: "inbound" | "outbound";
  body: string;
}

export interface ConsoleRun {
  action: "none" | "safe" | "handoff" | "send";
  /** Which step settled the turn — the answer to "why did it say that". */
  stage: string;
  text: string | null;
  kind: string | null;
  hold: "paused" | "closed" | "capped" | null;
  overrodeHold: boolean;
  costMicros: number;
  usage: { promptTokens: number; completionTokens: number } | null;
  kbBytes: number;
  sector: string;
  voice: string | null;
  replyMaxWords: number | null;
  languages: string | null;
  systemPrompt: string | null;
}

/**
 * Runs the real reply path against a client without sending anything (admin-panel.md
 * §11). History travels with the request because it lives in the browser only — the
 * console never touches `messages`.
 */
export async function consoleRun(
  orgId: string,
  text: string,
  history: ConsoleTurn[],
  overrideHold: boolean,
): Promise<ConsoleRun> {
  const res = await post(`/api/admin/console/${orgId}`, { text, history, overrideHold });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as ConsoleRun;
}

export async function takeover(conversationId: string): Promise<void> {
  const res = await post(`/api/conversations/${conversationId}/takeover`);
  if (!res.ok) throw new Error(await res.text());
}

export async function release(conversationId: string): Promise<void> {
  const res = await post(`/api/conversations/${conversationId}/release`);
  if (!res.ok) throw new Error(await res.text());
}

export async function reply(conversationId: string, body: string): Promise<void> {
  const res = await post(`/api/conversations/${conversationId}/reply`, { body });
  // 409 means the bot still owns the conversation: take over first.
  if (!res.ok) throw new Error(await res.text());
}

/** DPDP erasure. Irreversible, owner-only, and audited on the Worker side. */
export async function erase(conversationId: string): Promise<void> {
  const res = await post(`/api/conversations/${conversationId}/erase`);
  if (!res.ok) throw new Error(await res.text());
}

/**
 * The whole conversation, past the 20-row page the thread reads: this is the DPDP
 * access right, and a partial answer to it is not an answer. Media comes back as keys
 * rather than bytes, so an export cannot pull the egress budget through the Worker.
 */
export async function exportConversation(conversationId: string): Promise<unknown> {
  const res = await post(`/api/conversations/${conversationId}/export`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
