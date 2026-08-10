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
  handoff_state: "bot" | "requested" | "human" | "returned";
  last_message_at: string | null;
  window_expires_at: string | null;
}

export interface Message {
  id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  created_at: string;
  status: string | null;
}
