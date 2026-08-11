import { useEffect, useState } from "react";
import {
  supabase,
  SAFETY_LABEL,
  type AdminFlag,
  type AuditEntry,
  type OrgUser,
} from "./lib/supabase";
import {
  addOrgUser,
  removeOrgUser,
  resetPassword,
  resolveFlag,
  setPlatformAdmin,
  setUserRole,
} from "./lib/api";
import { ist } from "./lib/utils";

/**
 * The §5 and §6 half of the admin panel: the safety-flag queue, the audit log, and who
 * can sign in to what. Kept out of Admin.tsx because that file is the all-clients table
 * and this is the paperwork around it — different screens, different reads.
 *
 * The reads split three ways, for the reason in admin-panel.md §1:
 *
 *   flags   → `admin_flags()`, a definer RPC. `safety_flags` has no platform-admin
 *             read policy and is not getting one.
 *   audit   → straight PostgREST. `audit_log`'s policy has been `is_platform_admin()`
 *             since 0001 — this table exists to be read by us.
 *   users   → straight PostgREST. Both `users` and `org_members` already carry
 *             `or app.is_platform_admin()` on their select policies.
 *
 * Every write goes through the Worker and lands in `audit_log`, including the ones made
 * from this screen. The log shows our own actions back to us; that is the point.
 */

/** How many audit rows to pull. Cross-org and unbounded is how you spend 5GB of egress. */
const AUDIT_PAGE = 50;

export function FlagQueue({ onChanged }: { onChanged: () => void }) {
  const [flags, setFlags] = useState<AdminFlag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const { data, error: err } = await supabase.rpc("admin_flags");
    setError(err?.message ?? null);
    setFlags((data ?? []) as AdminFlag[]);
  }

  async function resolve(f: AdminFlag) {
    setBusy(f.id);
    setError(null);
    try {
      await resolveFlag(f.id, f.org_id, notes[f.id] ?? "");
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not resolve");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-8 rounded border border-border">
      <header className="border-b border-border bg-muted/40 px-4 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Open safety flags — every client
        </h2>
      </header>

      {error && <p className="px-4 py-3 text-xs text-destructive">{error}</p>}

      {flags.length === 0 && !error && (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing open. A distress or minor flag anywhere on the platform appears here.
        </p>
      )}

      <ul className="divide-y divide-border">
        {flags.map((f) => (
          <li key={f.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                {SAFETY_LABEL[f.kind] ?? f.kind}
              </span>
              <span className="font-medium">{f.org_name}</span>
              <span className="text-xs text-muted-foreground">{ist(f.detected_at)}</span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={notes[f.id] ?? ""}
                onChange={(e) => setNotes((n) => ({ ...n, [f.id]: e.target.value }))}
                placeholder="What was done about it"
                className="min-w-64 flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs"
              />
              <button
                type="button"
                disabled={busy === f.id || !(notes[f.id] ?? "").trim()}
                onClick={() => void resolve(f)}
                className="rounded bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
              >
                Resolve
              </button>
            </div>

            {/* The conversation id, not the conversation. It is here so the client's own
                owner can find the thread under their own login. */}
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              conversation {f.conversation_id}
            </p>
          </li>
        ))}
      </ul>

      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        Kind, client and time only. The messages behind a flag are readable with the
        client's own owner login and nowhere else — see the note under any client row.
      </p>
    </section>
  );
}

/**
 * Who can sign in to one client, and as what. Rendered inside a client's open row, so
 * the org is never ambiguous — every write here carries that org's id.
 */
export function OrgUsers({ orgId, onChanged }: { orgId: string; onChanged: () => void }) {
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"owner" | "staff">("staff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Shown once, never stored. Copy it out of here or issue another. */
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [orgId]);

  async function load() {
    const { data, error: err } = await supabase
      .from("org_members")
      .select("user_id,role,created_at,users(email)")
      .eq("org_id", orgId);

    setError(err?.message ?? null);
    setUsers(
      ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        user_id: String(r["user_id"]),
        role: r["role"] as "owner" | "staff",
        created_at: String(r["created_at"]),
        email: (r["users"] as { email?: string } | null)?.email ?? "unknown",
      })),
    );
  }

  async function act(fn: () => Promise<string | null | void>) {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (typeof result === "string") setLink(result);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-border bg-background p-4">
      <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
        Who can sign in
      </div>

      <ul className="mb-3 space-y-2 text-xs">
        {users.map((u) => (
          <li key={u.user_id} className="flex flex-wrap items-center gap-2">
            <span className="flex-1 truncate">{u.email}</span>
            <select
              value={u.role}
              disabled={busy}
              onChange={(e) =>
                void act(() => setUserRole(orgId, u.user_id, e.target.value as "owner" | "staff"))
              }
              className="rounded border border-border bg-transparent px-2 py-1"
            >
              <option value="owner">Owner</option>
              <option value="staff">Staff</option>
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => resetPassword(orgId, u.user_id))}
              className="rounded border border-border px-2 py-1 disabled:opacity-50"
            >
              Reset password
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => removeOrgUser(orgId, u.user_id))}
              className="rounded border border-destructive/50 px-2 py-1 text-destructive disabled:opacity-50"
            >
              Remove
            </button>
          </li>
        ))}
        {users.length === 0 && (
          <li className="text-destructive">
            Nobody can sign in to this client. Add an owner below.
          </li>
        )}
      </ul>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@client.com"
          className="min-w-56 flex-1 rounded border border-border bg-transparent px-2 py-1"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "owner" | "staff")}
          className="rounded border border-border bg-transparent px-2 py-1"
        >
          <option value="staff">Staff</option>
          <option value="owner">Owner</option>
        </select>
        <button
          type="button"
          disabled={busy || !email.includes("@")}
          onClick={() =>
            void act(async () => {
              const invite = await addOrgUser(orgId, email, role);
              setEmail("");
              return invite;
            })
          }
          className="rounded bg-foreground px-3 py-1.5 font-medium text-background disabled:opacity-50"
        >
          Add
        </button>
        {error && <span className="text-destructive">{error}</span>}
      </div>

      {link && (
        <div className="mt-3 rounded border border-border bg-muted/40 p-2 text-xs">
          <p className="mb-1 text-muted-foreground">
            One-time link. No email was sent — pass it on yourself. It is shown here once
            and is not stored anywhere.
          </p>
          <p className="break-all font-mono">{link}</p>
          <button
            type="button"
            onClick={() => setLink(null)}
            className="mt-1 rounded border border-border px-2 py-1"
          >
            Done
          </button>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Staff read the inbox and reply. Owners also see billing and edit the knowledge
        base. Neither is platform admin — that is a separate flag, below the table.
      </p>
    </div>
  );
}

/**
 * Every admin action, ours included. Filterable by client and by actor, because the
 * question this screen answers is always one of those two: "what was done to this
 * client" or "what did this person do".
 */
export function AuditLog({ orgs }: { orgs: Array<{ org_id: string; name: string }> }) {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [org, setOrg] = useState("");
  const [actor, setActor] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [org, actor]);

  async function load() {
    let query = supabase
      .from("audit_log")
      .select("id,org_id,actor_user_id,action,detail,created_at")
      .order("created_at", { ascending: false })
      .limit(AUDIT_PAGE);

    if (org) query = query.eq("org_id", org);
    if (actor) query = query.eq("actor_user_id", actor);

    const { data, error: err } = await query;
    setError(err?.message ?? null);
    const entries = (data ?? []) as AuditEntry[];
    setRows(entries);

    // Ids are what the table stores; an email is what a person can read. One extra
    // query over the ids actually present, rather than an embed on every row.
    const ids = [...new Set(entries.map((r) => r.actor_user_id).filter(Boolean))] as string[];
    if (ids.length === 0) return;
    const { data: people } = await supabase.from("users").select("id,email").in("id", ids);
    setEmails(
      Object.fromEntries(
        ((people ?? []) as Array<{ id: string; email: string }>).map((p) => [p.id, p.email]),
      ),
    );
  }

  const actors = [...new Set(rows.map((r) => r.actor_user_id).filter(Boolean))] as string[];
  const orgName = (id: string | null) =>
    id === null ? "platform" : (orgs.find((o) => o.org_id === id)?.name ?? "unknown");

  return (
    <section className="mb-8 rounded border border-border">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Audit log
        </h2>
        <div className="flex gap-2 text-xs">
          <select
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            className="rounded border border-border bg-transparent px-2 py-1"
          >
            <option value="">Every client</option>
            {orgs.map((o) => (
              <option key={o.org_id} value={o.org_id}>
                {o.name}
              </option>
            ))}
          </select>
          <select
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="rounded border border-border bg-transparent px-2 py-1"
          >
            <option value="">Anyone</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {emails[a] ?? a}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && <p className="px-4 py-3 text-xs text-destructive">{error}</p>}

      {rows.length === 0 && !error && (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing logged yet.
        </p>
      )}

      <ul className="divide-y divide-border text-xs">
        {rows.map((r) => (
          <li key={r.id} className="px-4 py-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{r.action}</span>
              <span className="text-muted-foreground">{orgName(r.org_id)}</span>
              <span className="text-muted-foreground">
                {r.actor_user_id ? (emails[r.actor_user_id] ?? r.actor_user_id) : "system"}
              </span>
              <span className="ml-auto text-muted-foreground">{ist(r.created_at)}</span>
            </div>
            {Object.keys(r.detail ?? {}).length > 0 && (
              <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
                {JSON.stringify(r.detail)}
              </p>
            )}
          </li>
        ))}
      </ul>

      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        The last {AUDIT_PAGE}. Rows with no client are platform actions — granting admin
        access belongs to no org.
      </p>
    </section>
  );
}

/**
 * Grant or revoke platform admin, by email.
 *
 * By email and never seeded: every script in this repo picks its org by "oldest
 * wa_account", so a seeded grant would hand this flag to client 1's owner the day they
 * onboard. The account must already exist — this promotes a login, it does not make one.
 */
export function PlatformAdmins() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function act(grant: boolean) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await setPlatformAdmin(email, grant);
      setDone(`${email} is ${grant ? "now" : "no longer"} a platform admin.`);
      setEmail("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-8 rounded border border-border p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        Platform admins
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="someone@ourcompany.com"
          className="min-w-56 flex-1 rounded border border-border bg-transparent px-2 py-1"
        />
        <button
          type="button"
          disabled={busy || !email.includes("@")}
          onClick={() => void act(true)}
          className="rounded bg-foreground px-3 py-1.5 font-medium text-background disabled:opacity-50"
        >
          Grant
        </button>
        <button
          type="button"
          disabled={busy || !email.includes("@")}
          onClick={() => void act(false)}
          className="rounded border border-destructive/50 px-3 py-1.5 font-medium text-destructive disabled:opacity-50"
        >
          Revoke
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {done && <p className="mt-2 text-xs text-muted-foreground">{done}</p>}
      <p className="mt-2 text-xs text-muted-foreground">
        A platform admin belongs to no client and therefore reads no client's messages —
        that limit is enforced by Postgres, not by this screen. You cannot revoke your own
        access here; there would be nobody left to undo it.
      </p>
    </section>
  );
}
