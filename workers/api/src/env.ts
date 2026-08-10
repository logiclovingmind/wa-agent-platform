import type { ConversationDO } from "./do/conversation.js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Public by design. Used only to ask Supabase who a dashboard token belongs to. */
  SUPABASE_ANON_KEY: string;

  /** One token for all clients. Per-client secrecy comes from the random slug. */
  META_VERIFY_TOKEN: string;

  /** Exact origin of the dashboard. One origin, never a wildcard. */
  DASHBOARD_ORIGIN: string;

  /** Graph API base including the version, e.g. https://graph.facebook.com/v21.0 */
  META_GRAPH_URL: string;

  /** The provider is not settled, so the base URL is configuration, not a constant. */
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL?: string | undefined;

  CONVERSATION: DurableObjectNamespace<ConversationDO>;

  /** Per-org burst cap on inbound messages. Counts per colo, so it is approximate. */
  ORG_LIMITER: RateLimit;

  /** Unset in dev and in tests, which turns error reporting off rather than failing. */
  SENTRY_DSN?: string | undefined;

  /**
   * healthchecks.io ping key, e.g. https://hc-ping.com/<key>. Jobs append their own
   * slug. Unset means the dead-man's-switch is off — acceptable locally, not in prod.
   */
  HEALTHCHECK_BASE?: string | undefined;

  /**
   * AES-GCM master keys, base64. One secret per *version*, never one per client —
   * a secret per client would mean a redeploy to onboard one, and client #21 is an
   * INSERT. wa_accounts.token_key_version selects the key for a given row.
   */
  [key: `MASTER_KEY_V${number}`]: string | undefined;
}
