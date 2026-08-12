import { createClient } from "@supabase/supabase-js";

/**
 * The browser gets the anon key and nothing else. Invariant 6: Meta tokens, the LLM key
 * and anything that costs money live in the Worker.
 *
 * Every read from here is under RLS as the logged-in user, which is the only lock on
 * this path — see tests/db/org-isolation-anon.test.ts.
 */
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    realtime: {
      // The free tier allows 200 concurrent connections and 2M messages a month. One
      // event per message is fine; a firehose per open tab is not.
      params: { eventsPerSecond: 5 },
    },
  },
);

export interface Conversation {
  id: string;
  customer_wa_id: string;
  /** WhatsApp profile name. Null until the customer sends a message, or if they set none. */
  customer_name: string | null;
  handoff_state: "bot" | "requested" | "human" | "returned";
  last_message_at: string | null;
  window_expires_at: string | null;
}

/**
 * What to call this customer. The WhatsApp profile name is what an owner recognises;
 * the number is the fallback, in full and with its country code, because a truncated
 * one is useless for looking someone up.
 *
 * Meta stores wa_id as digits with no `+`, and the digits are not ours to reformat —
 * spacing rules differ per country and a wrong grouping reads as a wrong number.
 */
export function customerLabel(c: Conversation): string {
  return c.customer_name ?? `+${c.customer_wa_id}`;
}

/**
 * One client, as the all-clients screen sees it. From the `admin_orgs` RPC — the only
 * read in the dashboard that deliberately crosses orgs. Every other query here is
 * scoped by RLS to the org the caller belongs to.
 */
export interface AdminOrg {
  org_id: string;
  name: string;
  sector: string;
  is_demo: boolean;
  month_cost_micros: number;
  month_events: number;
  open_flags: number;
  waiting: number;
  conversations: number;
  last_message_at: string | null;
}

/**
 * The half of a client's health that our own database can answer, from `admin_health`.
 * The other half — token, subscription, quality rating — only Meta knows and arrives
 * separately from the Worker, because reaching it needs a decrypted token.
 */
export interface AdminHealth {
  org_id: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  /** Meta rejected a send. Nothing else on this screen would show it. */
  last_failed_at: string | null;
  open_windows: number;
  /** When the longest wait started, not how many are waiting. Null means nobody is. */
  waiting_since: string | null;
  open_flags_by_kind: Partial<Record<SafetyKind, number>>;
  media_bytes: number;

  // The runtime controls (admin-panel.md §3), on the same row as the health because
  // half of them explain the other half: a client that is not replying because someone
  // paused it is not a client that is broken.
  ai_paused: boolean;
  /** Null means uncapped, which is every client until one is given a ceiling. */
  cap_micros: number | null;
  month_spend_micros: number;
  /** Null means the platform default: 12 months of text, 30 days of media. */
  retention_months: number | null;
  media_retention_days: number | null;
  /** `HH:MM` in IST. Either one null means always open. */
  hours_open_ist: string | null;
  hours_close_ist: string | null;
  out_of_hours: "reply" | "handoff";
}

/**
 * One open flag in the cross-org queue, from the `admin_flags` RPC.
 *
 * Six fields, and the seventh is missing on purpose (admin-panel.md §5): there is no
 * body here, no snippet, no customer name. `conversation_id` is an identifier so the
 * client's own owner can find the thread under their own login — not a way in.
 */
export interface AdminFlag {
  id: string;
  org_id: string;
  org_name: string;
  conversation_id: string;
  kind: SafetyKind;
  detected_at: string;
}

/**
 * An `audit_log` row. Read straight from PostgREST rather than through an RPC: this is
 * the one client-scoped table whose policy has been `app.is_platform_admin()` since 0001,
 * because the log exists to be read by us and by nobody else.
 *
 * `org_id` is nullable since 0015 — a granted admin flag belongs to no client.
 */
export interface AuditEntry {
  id: string;
  org_id: string | null;
  actor_user_id: string | null;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
}

/** A login and its role in one org, joined from `users` and `org_members`. */
export interface OrgUser {
  user_id: string;
  email: string;
  role: "owner" | "staff";
  created_at: string;
}

export type SafetyKind = "distress" | "self_harm" | "abuse" | "minor";

export interface SafetyFlag {
  conversation_id: string;
  kind: SafetyKind;
  detected_at: string;
}

export const SAFETY_LABEL: Record<SafetyKind, string> = {
  minor: "Minor",
  distress: "Distress",
  self_harm: "Self-harm",
  abuse: "Abuse",
};

export interface Message {
  id: string;
  direction: "inbound" | "outbound";
  /** For an attachment this is the caption, which is often null. */
  body: string | null;
  /** Meta's message type: `text`, `image`, `audio`, `video`, `document`, `sticker`. */
  type: string;
  /**
   * Path in the private `media` bucket, or null. Null on an attachment is normal and
   * not an error: video is never stored, and retention drops the bytes at 30 days.
   */
  media_key: string | null;
  /**
   * Whether a detector actually examined this message — the regex prefilter for text,
   * the vision classifier for images. Never infer it from `type`: an image whose
   * classification failed is exactly as unscreened as a voice note.
   */
  safety_screened: boolean;
  created_at: string;
  status: string | null;
}
