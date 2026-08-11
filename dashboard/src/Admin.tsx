import { useEffect, useState } from "react";
import { supabase, type AdminOrg } from "./lib/supabase";
import { walletBalance } from "./lib/api";
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
  const [balance, setBalance] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const { data, error } = await supabase.rpc("admin_orgs");
    // Same reason as the inbox and the usage screen: a failed read and a quiet platform
    // render identically, and "no clients" is a claim not worth making by accident.
    setLoadError(error ? error.message : null);
    setOrgs((data ?? []) as AdminOrg[]);
    setBalance(await walletBalance().catch(() => null));
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

      <div className="mb-8 rounded border border-border p-4">
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

      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Client</th>
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
            {orgs.map((o) => (
              <tr key={o.org_id} className="border-b border-border last:border-0">
                <td className="px-4 py-2 font-medium">
                  {o.name}
                  {/* Nobody pays for this one, so its spend is not revenue and its
                      silence is not an incident. Unlabelled it reads as client #1. */}
                  {o.is_demo && (
                    <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                      Demo
                    </span>
                  )}
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
            ))}

            {orgs.length === 0 && !loadError && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">
                  No clients yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Spend is model cost only, snapshotted per call at the rate charged at the time.
        Meta's own per-conversation fees are billed separately by Meta and are not counted
        here.
      </p>
    </div>
  );
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
