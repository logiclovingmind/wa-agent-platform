import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Lead } from "./llm.js";

// Invariant 2: the Worker holds service_role and therefore bypasses RLS. Every
// query must carry org_id in code. Nothing in the Worker should ever touch a raw
// SupabaseClient — go through OrgDb so the filter cannot be forgotten.

export const ORG_SCOPED_TABLES = [
  "users",
  "org_members",
  "wa_accounts",
  "conversations",
  "messages",
  "inbound_dedupe",
  "kb_documents",
  "kb_chunks",
  "usage_events",
  "audit_log",
  "safety_flags",
  "leads",
  "business_hours",
  "appointments",
] as const;

export type OrgScopedTable = (typeof ORG_SCOPED_TABLES)[number];

/** Invariant 7. Also the main lever on the 5GB/mo egress budget. */
export const MAX_PAGE = 20;

export interface DbEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export class OrgDb {
  constructor(
    private readonly sb: SupabaseClient,
    readonly orgId: string,
  ) {
    if (!orgId) throw new Error("OrgDb requires an org_id");
  }

  select(table: OrgScopedTable, columns: string, opts: { limit?: number } = {}) {
    if (columns.includes("*")) {
      throw new Error(`select("${table}") must name its columns, not "*"`);
    }
    const limit = Math.min(opts.limit ?? MAX_PAGE, MAX_PAGE);
    return this.sb.from(table).select(columns).eq("org_id", this.orgId).limit(limit);
  }

  /**
   * `organizations` is keyed by `id`, not `org_id`, so it cannot go through select().
   * It gets its own accessor rather than an exception inside select(), so there is
   * still no code path where the filter can be left off.
   */
  organization(columns: string) {
    if (columns.includes("*")) {
      throw new Error('organization() must name its columns, not "*"');
    }
    return this.sb.from("organizations").select(columns).eq("id", this.orgId).limit(1);
  }

  /**
   * Month-to-date spend in micros of INR, for the per-org cap (admin-panel.md §3).
   *
   * A named accessor rather than a bare `sb.rpc(...)` for the same reason
   * organization() exists: it is a query that must carry this org's id, and there
   * should be no code path where that id can be left off or be somebody else's.
   */
  monthSpendMicros() {
    return this.sb.rpc("org_month_spend", { p_org_id: this.orgId });
  }

  /**
   * Merge what the model learned into this conversation's lead. An accessor for the same
   * reason as the two above — the org id is half the key, and an upsert through
   * `insert()` would replace the row rather than merge it, silently erasing a name the
   * customer gave ten turns ago.
   */
  recordLead(conversationId: string, lead: Lead) {
    return this.sb.rpc("record_lead", {
      p_org_id: this.orgId,
      p_conversation_id: conversationId,
      p_name: lead.name ?? null,
      p_intent: lead.intent ?? null,
      p_timeframe: lead.timeframe ?? null,
      p_budget: lead.budget ?? null,
      p_notes: lead.notes ?? null,
    });
  }

  insert<T extends Record<string, unknown>>(table: OrgScopedTable, rows: T | T[]) {
    const list = Array.isArray(rows) ? rows : [rows];
    return this.sb.from(table).insert(list.map((row) => this.#stamp(table, row)));
  }

  #stamp(table: OrgScopedTable, row: Record<string, unknown>) {
    const given = row["org_id"];
    if (given !== undefined && given !== this.orgId) {
      throw new Error(`write to "${table}" carries org_id ${String(given)}, scoped to ${this.orgId}`);
    }
    return { ...row, org_id: this.orgId };
  }

  upsert<T extends Record<string, unknown>>(
    table: OrgScopedTable,
    rows: T | T[],
    opts: { onConflict: string },
  ) {
    const list = Array.isArray(rows) ? rows : [rows];
    return this.sb
      .from(table)
      .upsert(list.map((row) => this.#stamp(table, row)), { onConflict: opts.onConflict });
  }

  update(table: OrgScopedTable, patch: Record<string, unknown>) {
    if ("org_id" in patch) {
      throw new Error(`update("${table}") may not move a row between orgs`);
    }
    return this.sb.from(table).update(patch).eq("org_id", this.orgId);
  }

  delete(table: OrgScopedTable) {
    return this.sb.from(table).delete().eq("org_id", this.orgId);
  }
}

/**
 * An unscoped service_role client. This is the deliberate hole in invariant 2, and it
 * has exactly two callers, both of which have no org to scope to:
 *
 *   1. Resolving which org a webhook slug belongs to — that query *determines* the org.
 *   2. The maintenance crons, which sweep and count across every client at once.
 *
 * Every other query must go through OrgDb. If you reach for this anywhere else, the
 * org filter has to be somewhere else in that code path — check that it is.
 */
export function createServiceClient(env: DbEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    // No session storage and no refresh timer: neither survives a Worker
    // invocation and both cost CPU against the 10ms budget.
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function createOrgDb(env: DbEnv, orgId: string): OrgDb {
  return new OrgDb(createServiceClient(env), orgId);
}
