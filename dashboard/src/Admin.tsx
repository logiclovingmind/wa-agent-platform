import { useEffect, useState } from "react";
import { supabase, SAFETY_LABEL, type AdminHealth, type AdminOrg } from "./lib/supabase";
import {
  clientHealth,
  platformStats,
  setControls,
  setTemplate,
  walletBalance,
  type NumberHealth,
  type PlatformStats,
} from "./lib/api";
import { health, type Verdict } from "./lib/health";
import { AuditLog, FlagQueue, OrgUsers, PlatformAdmins } from "./AdminGovernance";
import { Offboard, OnboardClient } from "./AdminOnboard";
import { inr, ist } from "./lib/utils";

/**
 * Every client on one screen. This is where "client #21 is an INSERT, not a deploy"
 * stops being a claim in CLAUDE.md and becomes something you can look at: onboarding
 * an org adds a row here and touches nothing else.
 *
 * The wallet lives here rather than on a client's own Usage tab, which is where it was
 * first built. One aicredits.in wallet funds every client, so it is the platform's
 * number: a client owner seeing it would be reading our books and, worse, watching it
 * move when a different client talks.
 *
 * Reads go through the `admin_orgs` RPC. It is the one query in the dashboard that
 * crosses orgs, it aggregates in Postgres rather than shipping rows to the browser,
 * and it checks `is_platform_admin` itself — this component gating the tab is a
 * courtesy, not the lock.
 */
export default function Admin() {
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [rows, setRows] = useState<Record<string, AdminHealth>>({});
  const [balance, setBalance] = useState<number | null>(null);
  const [platform, setPlatform] = useState<PlatformStats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Meta is only asked about a client whose row has been opened — see clientHealth().
  const [meta, setMeta] = useState<Record<string, NumberHealth[]>>({});
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const [list, rollup] = await Promise.all([
      supabase.rpc("admin_orgs"),
      supabase.rpc("admin_health"),
    ]);

    // Same reason as the inbox and the usage screen: a failed read and a quiet platform
    // render identically, and "no clients" is a claim not worth making by accident.
    setLoadError(list.error?.message ?? rollup.error?.message ?? null);
    setOrgs((list.data ?? []) as AdminOrg[]);
    setRows(
      Object.fromEntries(((rollup.data ?? []) as AdminHealth[]).map((h) => [h.org_id, h])),
    );

    setBalance(await walletBalance().catch(() => null));
    setPlatform(await platformStats().catch(() => null));
  }

  async function openRow(orgId: string) {
    if (open === orgId) return setOpen(null);
    setOpen(orgId);
    if (meta[orgId]) return;

    // A failure here is a finding, not an error state: the endpoint answers with nulls
    // when Meta rejects the token, and an empty list reads as "no numbers configured".
    const numbers = await clientHealth(orgId).catch(() => []);
    setMeta((m) => ({ ...m, [orgId]: numbers }));
  }

  const totalCost = orgs.reduce((n, o) => n + Number(o.month_cost_micros), 0);
  const totalWaiting = orgs.reduce((n, o) => n + Number(o.waiting), 0);
  const totalFlags = orgs.reduce((n, o) => n + Number(o.open_flags), 0);
  const demoCount = orgs.filter((o) => o.is_demo).length;
  const paying = orgs.length - demoCount;

  // Runway is the only form of the balance anyone acts on, and the month-to-date burn
  // is the honest rate to divide by — a fresh month would otherwise read as infinite.
  const dayOfMonth = Number(
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(8),
  );
  const burnPerDay = totalCost / 1_000_000 / dayOfMonth;
  const runwayDays = balance !== null && burnPerDay > 0 ? Math.floor(balance / burnPerDay) : null;

  return (
    <div className="h-full overflow-y-auto p-6">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">All clients</h1>
        <p className="text-sm text-muted-foreground">
          Every org on the platform. Onboarding a client is an INSERT here — no deploy, no
          branch, no per-client secret.
        </p>
      </header>

      {loadError && (
        <p className="mb-6 rounded border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          Could not load clients: {loadError}
        </p>
      )}

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card
          label="Clients"
          value={String(paying)}
          note={demoCount > 0 ? `paying, plus ${demoCount} demo` : "live orgs"}
        />
        <Card
          label="Spend this month"
          value={inr(totalCost)}
          note="model cost, every client"
        />
        <Card
          label="Waiting on a person"
          value={String(totalWaiting)}
          note={totalWaiting > 0 ? "conversations, across all clients" : "nobody is waiting"}
          alert={totalWaiting > 0}
        />
        <Card
          label="Open safety flags"
          value={String(totalFlags)}
          note={totalFlags > 0 ? "unresolved" : "none open"}
          alert={totalFlags > 0}
        />
      </div>

      <div className="mb-8 grid gap-3 lg:grid-cols-2">
        <div className="rounded border border-border p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            LLM wallet — platform-wide
          </div>
          <div className="mt-1 text-2xl font-semibold">
            {balance === null ? "unavailable" : `₹${balance.toFixed(2)}`}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {runwayDays !== null
              ? `About ${runwayDays} days left at this month's rate. One wallet funds every client — at zero, all of them stop replying at once.`
              : "One wallet funds every client. At zero, all of them stop replying at once."}
          </p>
        </div>

        {/* The other shared ceiling. Storage is 1GB for every client together, so one
            client's photo backlog is everyone's outage. */}
        <div className="rounded border border-border p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Media storage — platform-wide
          </div>
          <div className="mt-1 text-2xl font-semibold">
            {platform === null ? "unavailable" : `${mb(platform.media_bytes)} MB`}
          </div>
          {platform !== null && (
            <>
              <div className="mt-2 h-1.5 w-full rounded bg-muted">
                <div
                  className={`h-1.5 rounded ${
                    platform.media_bytes >= platform.media_alarm_bytes
                      ? "bg-destructive"
                      : "bg-foreground/40"
                  }`}
                  style={{
                    width: `${Math.min(100, (platform.media_bytes / platform.media_limit_bytes) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                of {mb(platform.media_limit_bytes)} MB, alarm at{" "}
                {mb(platform.media_alarm_bytes)} MB. Media is deleted after 30 days.
              </p>
            </>
          )}
        </div>
      </div>

      <OnboardClient onChanged={() => void load()} />

      {/* Above the table on purpose: an open distress flag outranks every number on this
          screen, and it is the one thing here that belongs to no single client's row. */}
      <FlagQueue onChanged={() => void load()} />

      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Client</th>
              <th className="px-4 py-2 font-medium">Working</th>
              <th className="px-4 py-2 font-medium">Sector</th>
              <th className="px-4 py-2 text-right font-medium">This month</th>
              <th className="px-4 py-2 text-right font-medium">Replies</th>
              <th className="px-4 py-2 text-right font-medium">Conversations</th>
              <th className="px-4 py-2 text-right font-medium">Waiting</th>
              <th className="px-4 py-2 text-right font-medium">Flags</th>
              <th className="px-4 py-2 font-medium">Last message</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => {
              const verdict = health({
                db: rows[o.org_id],
                meta: meta[o.org_id],
                walletEmpty: balance !== null && balance <= 0,
              });

              return (
                <RowGroup
                  key={o.org_id}
                  org={o}
                  db={rows[o.org_id]}
                  meta={meta[o.org_id]}
                  verdict={verdict}
                  expanded={open === o.org_id}
                  onToggle={() => void openRow(o.org_id)}
                  onChanged={() => void load()}
                />
              );
            })}

            {orgs.length === 0 && !loadError && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-muted-foreground">
                  No clients yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="my-6 text-xs text-muted-foreground">
        Spend is model cost only, snapshotted per call at the rate charged at the time.
        Meta's own per-conversation fees are billed separately by Meta and are not counted
        here.
      </p>

      <PlatformAdmins />
      <AuditLog orgs={orgs} />
    </div>
  );
}

/** One client's row, plus the panel that opens under it. */
function RowGroup({
  org: o,
  db,
  meta,
  verdict,
  expanded,
  onToggle,
  onChanged,
}: {
  org: AdminOrg;
  db: AdminHealth | undefined;
  meta: NumberHealth[] | undefined;
  verdict: Verdict;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40"
      >
        <td className="px-4 py-2 font-medium">
          {o.name}
          {/* Nobody pays for this one, so its spend is not revenue and its
              silence is not an incident. Unlabelled it reads as client #1. */}
          {o.is_demo && (
            <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
              Demo
            </span>
          )}
          {/* Visible without opening the row: a paused client looks like a quiet one
              on every other column, and forgetting a pause is how a client goes a
              week without replies. */}
          {db?.ai_paused && (
            <span className="ml-2 rounded border border-amber-500/50 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-amber-600">
              Paused
            </span>
          )}
        </td>
        <td className="px-4 py-2">
          <Light verdict={verdict} />
        </td>
        <td className="px-4 py-2 text-muted-foreground">{o.sector}</td>
        <td className="px-4 py-2 text-right tabular-nums">
          {inr(Number(o.month_cost_micros))}
        </td>
        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
          {Number(o.month_events)}
        </td>
        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
          {Number(o.conversations)}
        </td>
        <td className="px-4 py-2 text-right tabular-nums">
          <Count n={Number(o.waiting)} />
        </td>
        <td className="px-4 py-2 text-right tabular-nums">
          <Count n={Number(o.open_flags)} />
        </td>
        <td className="px-4 py-2 text-muted-foreground">
          {/* A client with no traffic at all is the one worth noticing — an
              onboarding that never got its webhook subscribed looks exactly
              like this. */}
          {o.last_message_at ? ist(o.last_message_at) : "never"}
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-border bg-muted/20 last:border-0">
          <td colSpan={9} className="px-4 py-4">
            <Detail
              orgId={o.org_id}
              name={o.name}
              isDemo={o.is_demo}
              db={db}
              meta={meta}
              verdict={verdict}
              onChanged={onChanged}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Everything known about one client, in the order it is acted on: what is wrong, what
 * Meta says, then the timeline that explains it.
 */
function Detail({
  orgId,
  name,
  isDemo,
  db,
  meta,
  verdict,
  onChanged,
}: {
  orgId: string;
  name: string;
  isDemo: boolean;
  db: AdminHealth | undefined;
  meta: NumberHealth[] | undefined;
  verdict: Verdict;
  onChanged: () => void;
}) {
  return (
    <div className="space-y-4">
      {verdict.reasons.length > 0 && (
        <ul className="space-y-1 text-xs">
          {verdict.reasons.map((r) => (
            <li key={r} className={verdict.level === "red" ? "text-destructive" : ""}>
              {r}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 text-xs lg:grid-cols-2">
        <div>
          <div className="mb-2 uppercase tracking-wide text-muted-foreground">Meta</div>
          {meta === undefined && <p className="text-muted-foreground">Checking…</p>}
          {meta?.length === 0 && (
            <p className="text-destructive">
              No WhatsApp number configured. This client cannot receive anything.
            </p>
          )}
          {meta?.map((n) => (
            <dl key={n.phone_number_id} className="space-y-1">
              <Field label="Number" value={n.display_phone_number} />
              <Field
                label="Token"
                value={
                  n.token.valid === false
                    ? "invalid"
                    : n.token.valid === null
                      ? "Meta did not answer"
                      : n.token.expires_at === null
                        ? "valid, permanent"
                        : `valid until ${ist(new Date(n.token.expires_at * 1000).toISOString())}`
                }
                bad={n.token.valid === false}
              />
              <Field
                label="App subscribed to WABA"
                value={n.subscribed === null ? "unknown" : n.subscribed ? "yes" : "no"}
                bad={n.subscribed === false}
              />
              <Field
                label="Quality rating"
                value={n.number?.quality_rating ?? "unknown"}
                bad={!!n.number?.quality_rating && n.number.quality_rating !== "GREEN"}
              />
              <Field label="Messaging limit" value={n.number?.messaging_limit_tier ?? "unknown"} />
              <Field
                label="Re-engagement template"
                value={
                  n.template === null
                    ? "none configured"
                    : `${n.template.name} — ${n.template.status ?? "not found in this WABA"}`
                }
                bad={n.template !== null && n.template.status !== "APPROVED"}
              />
            </dl>
          ))}
        </div>

        <div>
          <div className="mb-2 uppercase tracking-wide text-muted-foreground">Our data</div>
          {db === undefined ? (
            <p className="text-muted-foreground">No health row.</p>
          ) : (
            <dl className="space-y-1">
              <Field label="Last inbound" value={db.last_inbound_at ? ist(db.last_inbound_at) : "never"} />
              <Field
                label="Last reply sent"
                value={db.last_outbound_at ? ist(db.last_outbound_at) : "never"}
                bad={!!db.last_inbound_at && !db.last_outbound_at}
              />
              <Field
                label="Last rejected send"
                value={db.last_failed_at ? ist(db.last_failed_at) : "none"}
                bad={!!db.last_failed_at}
              />
              {/* Free-form replies are only possible inside this window; outside it the
                  only way to reach a customer is a paid template. */}
              <Field label="Open 24h windows" value={String(db.open_windows)} />
              <Field
                label="Waiting since"
                value={db.waiting_since ? ist(db.waiting_since) : "nobody waiting"}
              />
              <Field
                label="Open safety flags"
                value={
                  Object.entries(db.open_flags_by_kind)
                    .map(([k, n]) => `${n} ${SAFETY_LABEL[k as keyof typeof SAFETY_LABEL] ?? k}`)
                    .join(", ") || "none"
                }
                bad={Object.keys(db.open_flags_by_kind).length > 0}
              />
              <Field label="Media stored" value={`${mb(db.media_bytes)} MB`} />
            </dl>
          )}
        </div>
      </div>

      {db && <Controls orgId={orgId} db={db} onChanged={onChanged} />}

      {meta && meta.length > 0 && (
        <TemplateForm orgId={orgId} numbers={meta} onChanged={onChanged} />
      )}

      {isDemo && <ResetDemo onChanged={onChanged} />}

      <OrgUsers orgId={orgId} onChanged={onChanged} />

      <Offboard orgId={orgId} name={name} onChanged={onChanged} />

      {/* The limit that makes the rest of this panel trustworthy. Counts and kinds cross
          the boundary; words never do. */}
      <p className="text-xs text-muted-foreground">
        Safety flags are shown as counts and kinds only. Reading the messages behind them
        needs the client's own owner login — this account holds no membership in any org.
      </p>
    </div>
  );
}

/**
 * The undo for a walk-in demo, on the demo org's row only.
 *
 * A demo overlays a prospect's business on this org — their KB pasted into the console,
 * their voice, and whatever threads arrive from messaging the sandbox number. Left in
 * place, the next walk-in is answered with the last prospect's fees.
 *
 * The RPC deletes only what the demo added, so the seeded backdrop is never rebuilt and
 * this is instant rather than a two-minute re-seed. Called straight from the browser
 * because it is `security definer` guarded on `app.is_platform_admin()`: this account
 * holds no `org_members` row, so anything scoped by RLS would answer it with nothing.
 */
function ResetDemo({ onChanged }: { onChanged: () => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [setups, setSetups] = useState<DemoSetup[]>([]);
  const [label, setLabel] = useState("");

  useEffect(() => {
    void loadSetups();
  }, []);

  // `kb` is deliberately not selected. It holds every document the prospect pasted, and
  // this list only needs a name and a date — fetching the bodies to render ten rows is
  // the shape of query the 5GB egress budget dies to.
  async function loadSetups() {
    const { data, error: readError } = await supabase
      .from("demo_setups")
      .select("id,label,name,created_at")
      .order("created_at", { ascending: false })
      .limit(20)
      .returns<DemoSetup[]>();
    if (readError) return setError(readError.message);
    setSetups(data ?? []);
  }

  /**
   * Runs one RPC, reports whichever way it went, and refreshes the list.
   *
   * `PromiseLike`, not `Promise`: a Supabase query builder is a thenable that only
   * becomes a promise when awaited, so it does not satisfy `Promise`.
   */
  async function rpc(
    fn: () => PromiseLike<{ error: { message: string } | null }>,
    success: string,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    setDone(null);
    const { error: rpcError } = await fn();
    setBusy(false);
    if (rpcError) return setError(rpcError.message);
    setDone(success);
    await loadSetups();
    onChanged();
  }

  async function run() {
    setBusy(true);
    setError(null);
    setDone(null);

    const { data, error: rpcError } = await supabase.rpc("demo_reset");

    setBusy(false);
    setArmed(false);
    // Surfaced rather than swallowed: a reset that silently did nothing leaves the next
    // prospect's data on screen, which is the one failure this button exists to prevent.
    if (rpcError) return setError(rpcError.message);

    const counts = (data as ResetCounts[] | null)?.[0];
    setDone(
      counts
        ? `Removed ${counts.conversations_removed} conversations, ` +
            `${counts.kb_documents_removed} documents, ${counts.usage_events_removed} usage rows.` +
            // The reset is a delete, and an operator who does not know the overlay was
            // kept will retype it. Naming the row is the whole point of saying this.
            (counts.setup_saved ? ` Saved as “${counts.setup_saved}”.` : "")
        : "Nothing to remove — already at defaults.",
    );
    await loadSetups();
    onChanged();
  }

  return (
    <div className="rounded border border-border bg-background p-4 text-xs">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="uppercase tracking-wide text-muted-foreground">After a demo</div>
        <button
          type="button"
          disabled={busy}
          onClick={() => (armed ? void run() : setArmed(true))}
          className={`rounded px-3 py-1.5 font-medium disabled:opacity-50 ${
            armed ? "bg-destructive text-white" : "border border-destructive/50 text-destructive"
          }`}
        >
          {busy ? "Resetting…" : armed ? "Confirm reset" : "Reset demo"}
        </button>
      </div>

      <p className="text-muted-foreground">
        Deletes the knowledge base, conversations and spend from the last walk-in, and puts
        the name, sector and voice back. The seeded history is not touched — and the
        overlay is saved below first, so resetting is not the end of it.
      </p>

      {error && <p className="mt-2 text-destructive">{error}</p>}
      {done && <p className="mt-2 text-emerald-600">{done}</p>}

      <div className="mt-4 border-t border-border pt-3">
        <div className="mb-2 uppercase tracking-wide text-muted-foreground">Saved setups</div>

        {/* Saving mid-demo, before the reset does it automatically. The operator who wants
            "the version before I changed the fees" cannot get it from the reset, which
            only ever captures the last state. */}
        <div className="mb-3 flex gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Save the setup on screen as…"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"
          />
          <button
            type="button"
            disabled={busy || label.trim() === ""}
            onClick={() =>
              void rpc(
                () => supabase.rpc("demo_setup_save", { p_label: label.trim() }),
                `Saved “${label.trim()}”.`,
              ).then(() => setLabel(""))
            }
            className="shrink-0 rounded border border-border px-3 py-1 font-medium disabled:opacity-50"
          >
            Save
          </button>
        </div>

        {setups.length === 0 ? (
          <p className="text-muted-foreground">
            Nothing saved yet. The next reset files whatever the walk-in pasted in.
          </p>
        ) : (
          <ul className="space-y-1">
            {setups.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{s.label}</span>
                  <span className="block truncate text-muted-foreground">
                    {s.name} · {ist(s.created_at)}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void rpc(
                        () => supabase.rpc("demo_setup_load", { p_id: s.id }),
                        `Loaded “${s.label}”.`,
                      )
                    }
                    className="rounded border border-border px-2 py-1 disabled:opacity-50"
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void rpc(
                        async () => supabase.from("demo_setups").delete().eq("id", s.id),
                        `Deleted “${s.label}”.`,
                      )
                    }
                    className="rounded px-2 py-1 text-destructive disabled:opacity-50"
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type DemoSetup = {
  id: string;
  label: string;
  name: string;
  created_at: string;
};

type ResetCounts = {
  conversations_removed: number;
  kb_documents_removed: number;
  usage_events_removed: number;
  /** Null when the walk-in pasted no KB and the reset filed nothing. */
  setup_saved: string | null;
};

/**
 * The runtime controls of docs/admin-panel.md §3. Every one of them is a row edit and
 * none of them is a deploy — that is the test this panel exists to keep passing.
 *
 * Pause is its own button, deliberately apart from the form. It is the "the bot said
 * something wrong, stop it now" switch, and a kill switch behind a Save button is not a
 * kill switch.
 */
function Controls({
  orgId,
  db,
  onChanged,
}: {
  orgId: string;
  db: AdminHealth;
  onChanged: () => void;
}) {
  const [cap, setCap] = useState(db.cap_micros === null ? "" : String(db.cap_micros / 1_000_000));
  const [openAt, setOpenAt] = useState(db.hours_open_ist ?? "");
  const [closeAt, setCloseAt] = useState(db.hours_close_ist ?? "");
  const [outOfHours, setOutOfHours] = useState(db.out_of_hours);
  const [months, setMonths] = useState(db.retention_months === null ? "" : String(db.retention_months));
  const [mediaDays, setMediaDays] = useState(
    db.media_retention_days === null ? "" : String(db.media_retention_days),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: Parameters<typeof setControls>[1]) {
    setBusy(true);
    setError(null);
    try {
      await setControls(orgId, patch);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  const capMicros = cap.trim() === "" ? null : Math.round(Number(cap) * 1_000_000);
  const spent = db.month_spend_micros;

  return (
    <div className="rounded border border-border bg-background p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Controls</div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save({ ai_paused: !db.ai_paused })}
          className={`rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
            db.ai_paused
              ? "bg-emerald-600 text-white"
              : "border border-destructive/50 text-destructive"
          }`}
        >
          {db.ai_paused ? "Resume the AI" : "Pause the AI"}
        </button>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        {db.ai_paused
          ? "Paused. Every new message is answered with a holding line and handed to a person."
          : "The AI is answering. Pausing hands every new conversation to a person instead."}
      </p>

      <div className="grid gap-3 text-xs sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-muted-foreground">Monthly spend cap (₹)</span>
          <input
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            placeholder="no cap"
            inputMode="decimal"
            className="w-full rounded border border-border bg-transparent px-2 py-1"
          />
          <span className="block text-muted-foreground">
            {inr(spent)} spent this month.{" "}
            {db.cap_micros === null
              ? "Uncapped."
              : `At the cap the AI stops and hands off — it does not go quiet.`}
          </span>
        </label>

        <label className="space-y-1">
          <span className="text-muted-foreground">Outside business hours</span>
          <select
            value={outOfHours}
            onChange={(e) => setOutOfHours(e.target.value as "reply" | "handoff")}
            className="w-full rounded border border-border bg-transparent px-2 py-1"
          >
            <option value="reply">Reply as usual</option>
            <option value="handoff">Say we're closed and hand off</option>
          </select>
          <span className="block text-muted-foreground">
            Leave the hours empty for a client that is always open.
          </span>
        </label>

        <label className="space-y-1">
          <span className="text-muted-foreground">Opens (IST)</span>
          <input
            type="time"
            value={openAt}
            onChange={(e) => setOpenAt(e.target.value)}
            className="w-full rounded border border-border bg-transparent px-2 py-1"
          />
        </label>

        <label className="space-y-1">
          <span className="text-muted-foreground">Closes (IST)</span>
          <input
            type="time"
            value={closeAt}
            onChange={(e) => setCloseAt(e.target.value)}
            className="w-full rounded border border-border bg-transparent px-2 py-1"
          />
        </label>

        <label className="space-y-1">
          <span className="text-muted-foreground">Keep messages (months)</span>
          <input
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            placeholder="12 — platform default"
            inputMode="numeric"
            className="w-full rounded border border-border bg-transparent px-2 py-1"
          />
        </label>

        <label className="space-y-1">
          <span className="text-muted-foreground">Keep media (days)</span>
          <input
            value={mediaDays}
            onChange={(e) => setMediaDays(e.target.value)}
            placeholder="30 — platform default"
            inputMode="numeric"
            className="w-full rounded border border-border bg-transparent px-2 py-1"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void save({
              cap_micros: capMicros,
              hours_open_ist: openAt || null,
              hours_close_ist: closeAt || null,
              out_of_hours: outOfHours,
              retention_months: months.trim() === "" ? null : Number(months),
              media_retention_days: mediaDays.trim() === "" ? null : Number(mediaDays),
            })
          }
          className="rounded bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
        >
          Save controls
        </button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>

      {/* Said out loud rather than left as a gap in the panel: §3 lists a per-org rate
          limit, and the Cloudflare Rate Limiting binding takes its configuration from
          wrangler.jsonc at deploy time. A per-client value there would be a deploy per
          client, which is the one thing the whole design forbids. */}
      <p className="mt-3 text-xs text-muted-foreground">
        The per-org webhook rate limit is not settable here. Cloudflare's rate-limit
        binding is fixed at deploy time, so a per-client value would mean a deploy per
        client.
      </p>
    </div>
  );
}

/**
 * The re-engagement template, per number. Its columns have existed since migration 0005
 * and until now the only way to set them was an UPDATE by hand.
 */
function TemplateForm({
  orgId,
  numbers,
  onChanged,
}: {
  orgId: string;
  numbers: NumberHealth[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { name: string; language: string }>>(() =>
    Object.fromEntries(
      numbers.map((n) => [
        n.phone_number_id,
        { name: n.template?.name ?? "", language: n.template?.language ?? "en" },
      ]),
    ),
  );

  async function save(waAccountId: string, value: { name: string; language: string }) {
    setBusy(true);
    setError(null);
    try {
      await setTemplate(waAccountId, orgId, value.name.trim() === "" ? null : value);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-border bg-background p-4 text-xs">
      <div className="mb-3 uppercase tracking-wide text-muted-foreground">
        Re-engagement template
      </div>
      <p className="mb-3 text-muted-foreground">
        The only message that may legally go out after the 24-hour window has closed. Its
        name and language must match an approved template in this client's WABA; leave the
        name empty to switch it off.
      </p>

      {numbers.map((n) => {
        const value = draft[n.phone_number_id] ?? { name: "", language: "en" };
        return (
          <div key={n.phone_number_id} className="mb-2 flex flex-wrap items-center gap-2">
            <span className="w-36 text-muted-foreground">{n.display_phone_number}</span>
            <input
              value={value.name}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  [n.phone_number_id]: { ...value, name: e.target.value },
                }))
              }
              placeholder="template name"
              className="flex-1 rounded border border-border bg-transparent px-2 py-1"
            />
            <input
              value={value.language}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  [n.phone_number_id]: { ...value, language: e.target.value },
                }))
              }
              placeholder="en"
              className="w-20 rounded border border-border bg-transparent px-2 py-1"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(n.wa_account_id, value)}
              className="rounded border border-border px-3 py-1 font-medium disabled:opacity-50"
            >
              Save
            </button>
          </div>
        );
      })}
      {error && <span className="text-destructive">{error}</span>}
    </div>
  );
}

function Field({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={bad ? "font-medium text-destructive" : ""}>{value}</dd>
    </div>
  );
}

/**
 * Red is "this client is not replying right now"; amber is "it works but is degrading".
 * The dot is deliberately paired with a word — a colour alone is unreadable to some
 * people and ambiguous to everyone else.
 */
function Light({ verdict }: { verdict: Verdict }) {
  const colour = { red: "bg-destructive", amber: "bg-amber-500", green: "bg-emerald-500" }[
    verdict.level
  ];
  const label = { red: "Not replying", amber: "Degraded", green: "OK" }[verdict.level];

  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span className={`inline-block h-2 w-2 rounded-full ${colour}`} />
      <span className={verdict.level === "red" ? "font-medium text-destructive" : ""}>{label}</span>
      {/* Green from our own data alone is not the same claim as green from Meta too, and
          saying so is cheaper than being wrong about it. */}
      {verdict.partial && verdict.level === "green" && (
        <span className="text-xs text-muted-foreground">(Meta not checked)</span>
      )}
    </span>
  );
}

/** Bytes as whole megabytes. Anything finer is noise against a 1GB ceiling. */
function mb(bytes: number): string {
  return Math.round(bytes / (1024 * 1024)).toLocaleString("en-IN");
}

function Card({
  label,
  value,
  note,
  alert = false,
}: {
  label: string;
  value: string;
  note: string;
  alert?: boolean;
}) {
  return (
    <div className={`rounded border p-4 ${alert ? "border-destructive/40" : "border-border"}`}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${alert ? "text-destructive" : ""}`}>
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{note}</div>
    </div>
  );
}

/** Zero is the normal case and should recede; anything above it is someone's job. */
function Count({ n }: { n: number }) {
  if (n === 0) return <span className="text-muted-foreground">—</span>;
  return <span className="font-medium text-destructive">{n}</span>;
}
