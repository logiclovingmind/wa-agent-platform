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

/** One IST calendar day of model spend, as returned by the `usage_daily` RPC. */
export interface DailyUsage {
  day: string;
  cost_micros: number;
  events: number;
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
