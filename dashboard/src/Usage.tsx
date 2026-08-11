import { useEffect, useState } from "react";
import { supabase, type DailyUsage } from "./lib/supabase";
import { walletBalance } from "./lib/api";
import { inr, istToday, shiftDay } from "./lib/utils";

/** Two months, so "last month" is always complete however late in the month it is. */
const DAYS = 62;
const CHART_DAYS = 30;

/**
 * What the AI costs, for the one person who pays for it. Reads the `usage_daily` RPC
 * rather than the rows: a month of replies is thousands of rows to render thirty
 * numbers, and Supabase egress is the shared budget that takes every client down at
 * once when it runs out.
 */
export default function Usage({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const [rows, setRows] = useState<DailyUsage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const { data, error } = await supabase.rpc("usage_daily", { p_days: DAYS });

    // Same reason as the inbox: a failed read and a quiet month look identical
    // otherwise, and "₹0.00" is a claim we should not make when we do not know.
    setLoadError(error ? error.message : null);
    setRows((data ?? []) as DailyUsage[]);

    if (isPlatformAdmin) setBalance(await walletBalance().catch(() => null));
  }

  const today = istToday();
  const thisMonth = today.slice(0, 7);
  const lastMonth = shiftDay(`${thisMonth}-01`, -1).slice(0, 7);

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const sum = (of: (r: DailyUsage) => number, where: (r: DailyUsage) => boolean) =>
    rows.filter(where).reduce((n, r) => n + Number(of(r)), 0);

  const monthCost = sum((r) => r.cost_micros, (r) => r.day.startsWith(thisMonth));
  const monthReplies = sum((r) => r.events, (r) => r.day.startsWith(thisMonth));
  const lastMonthCost = sum((r) => r.cost_micros, (r) => r.day.startsWith(lastMonth));

  // A week is the shortest window that survives one quiet Sunday, and runway in days is
  // the only form of this number anyone acts on.
  const weekStart = shiftDay(today, -6);
  const weekCost = sum((r) => r.cost_micros, (r) => r.day >= weekStart);
  const burnPerDay = weekCost / 7 / 1_000_000;
  const runwayDays = balance !== null && burnPerDay > 0 ? Math.floor(balance / burnPerDay) : null;

  const chart = Array.from({ length: CHART_DAYS }, (_, i) => {
    const day = shiftDay(today, i - (CHART_DAYS - 1));
    const row = byDay.get(day);
    return { day, cost: Number(row?.cost_micros ?? 0), events: Number(row?.events ?? 0) };
  });
  const peak = Math.max(...chart.map((d) => d.cost), 1);

  return (
    <div className="h-full overflow-y-auto p-6">
      <header className="mb-6">
        <h1 className="text-lg font-semibold">Usage</h1>
        <p className="text-sm text-muted-foreground">
          What the AI has cost this org. Model spend only — WhatsApp's own per-conversation
          fees are billed by Meta and are not counted here.
        </p>
      </header>

      {loadError && (
        <p className="mb-6 rounded border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          Could not load usage: {loadError}
        </p>
      )}

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card label="This month" value={inr(monthCost)} note={`${monthReplies} AI replies`} />
        <Card label="Last month" value={inr(lastMonthCost)} note={lastMonth} />
        <Card
          label="Per reply"
          value={monthReplies > 0 ? inr(monthCost / monthReplies) : "—"}
          note="this month's average"
        />
        <Card
          label="Last 7 days"
          value={inr(weekCost)}
          note={burnPerDay > 0 ? `≈ ₹${(burnPerDay * 30).toFixed(2)} / month at this rate` : "quiet week"}
        />
      </div>

      {isPlatformAdmin && (
        <div className="mb-8 rounded border border-border p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            LLM wallet — platform-wide
          </div>
          <div className="mt-1 text-2xl font-semibold">
            {balance === null ? "unavailable" : `₹${balance.toFixed(2)}`}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {runwayDays !== null
              ? `About ${runwayDays} days left at the last 7 days' rate. Funds every client, not just this one.`
              : "Funds every client, not just this one. Top it up before it reaches zero — every org stops replying at once."}
          </p>
        </div>
      )}

      <div className="rounded border border-border p-4">
        <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
          Last {CHART_DAYS} days
        </div>
        <div className="flex h-32 items-end gap-1">
          {chart.map((d) => (
            <div
              key={d.day}
              className="flex-1 rounded-t bg-primary/70 hover:bg-primary"
              // Bars are a share of the busiest day, so the shape is the signal; a
              // silent day still gets a sliver, otherwise it reads as missing data.
              style={{ height: `${Math.max((d.cost / peak) * 100, 2)}%` }}
              title={`${d.day} — ${inr(d.cost)}, ${d.events} replies`}
            />
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
          <span>{chart[0]!.day}</span>
          <span>today</span>
        </div>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Prices are snapshotted per reply at ₹14 / ₹57 per million input / output tokens.
        The provider re-prices with the live USD/INR rate, so old rows keep the rate they
        were charged at.
      </p>
    </div>
  );
}

function Card({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded border border-border p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{note}</div>
    </div>
  );
}
