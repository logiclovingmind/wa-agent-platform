import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { supabase } from "./lib/supabase";
import { istToday, shiftDay } from "./lib/utils";

/** Five weeks: a full calendar grid, and the window a month of activity fills. */
const DAYS = 35;

const AI = "#10b981";
const HUMAN = "#f59e0b";

interface PulseDay {
  day: string;
  inbound: number;
  outbound: number;
  ai_replies: number;
  conversations: number;
  after_hours: number;
}

interface PulseHour {
  dow: number;
  hour: number;
  messages: number;
}

/**
 * What the assistant did, for the person paying for it.
 *
 * Deliberately has no money on it. It used to show model spend to four decimal places,
 * which is our cost of goods on a screen we hand to the customer we invoice; 0019 took
 * the figures away from the browser entirely, and this is what stands in their place.
 * The question an owner was really asking the old screen — is this thing earning its
 * keep — is answered better by volume, hours covered and speed than by a rupee total
 * that was never their rupee total anyway.
 *
 * Every number here is aggregated in Postgres (`pulse_*`). Counting a month of messages
 * in the browser would spend the shared 5GB egress budget on arithmetic.
 */
export default function Flowin({ orgId }: { orgId: string }) {
  const [days, setDays] = useState<PulseDay[]>([]);
  const [hours, setHours] = useState<PulseHour[]>([]);
  const [replySeconds, setReplySeconds] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) return;
    void load(orgId);
  }, [orgId]);

  async function load(id: string) {
    const [daily, hourly, speed] = await Promise.all([
      supabase.rpc("pulse_daily", { p_org_id: id, p_days: DAYS }),
      supabase.rpc("pulse_hourly", { p_org_id: id, p_days: DAYS }),
      supabase.rpc("pulse_reply_seconds", { p_org_id: id, p_days: DAYS }),
    ]);

    // Same reason as the inbox: a failed read and a quiet month look identical
    // otherwise, and "0 replies" is a claim we should not make when we do not know.
    setLoadError(daily.error?.message ?? hourly.error?.message ?? null);
    setDays((daily.data ?? []) as PulseDay[]);
    setHours((hourly.data ?? []) as PulseHour[]);
    setReplySeconds(speed.data === null ? null : Number(speed.data));
  }

  const today = istToday();
  const byDay = new Map(days.map((d) => [d.day, d]));
  const grid = Array.from({ length: DAYS }, (_, i) => {
    const day = shiftDay(today, i - (DAYS - 1));
    const row = byDay.get(day);
    return {
      day,
      conversations: Number(row?.conversations ?? 0),
      ai: Number(row?.ai_replies ?? 0),
      outbound: Number(row?.outbound ?? 0),
      afterHours: Number(row?.after_hours ?? 0),
      inbound: Number(row?.inbound ?? 0),
    };
  });

  const total = (of: (d: (typeof grid)[number]) => number) => grid.reduce((n, d) => n + of(d), 0);
  const aiReplies = total((d) => d.ai);
  const outbound = total((d) => d.outbound);
  // Nothing on `messages` records who sent a reply, so the split is "every reply, minus
  // the ones that cost a model call". Clamped because the two are counted from
  // different tables and a half-written turn would otherwise show a negative person.
  const byHuman = Math.max(outbound - aiReplies, 0);

  const split = [
    { name: "Answered by the assistant", value: aiReplies, fill: AI },
    { name: "Answered by your team", value: byHuman, fill: HUMAN },
  ];

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <header className="mb-5">
        <h1 className="text-lg font-semibold">Flowin</h1>
        <p className="text-sm text-muted-foreground">
          The last five weeks on WhatsApp.
        </p>
      </header>

      {loadError && (
        <p className="mb-6 rounded border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          Could not load activity: {loadError}
        </p>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat value={total((d) => d.conversations).toLocaleString("en-IN")} label="Conversations" />
        <Stat value={aiReplies.toLocaleString("en-IN")} label="Answered automatically" />
        <Stat
          value={total((d) => d.afterHours).toLocaleString("en-IN")}
          label="Answered out of hours"
          hint="while you were closed"
        />
        <Stat value={speed(replySeconds)} label="Typical reply time" />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <section className="rounded border border-border p-4 lg:col-span-2">
          <Title>Conversations per day</Title>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={grid} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
              <defs>
                <linearGradient id="pulseFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={AI} stopOpacity={0.5} />
                  <stop offset="100%" stopColor={AI} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="day"
                tickFormatter={(d: string) => d.slice(8)}
                tick={{ fontSize: 10 }}
                interval={4}
                axisLine={false}
                tickLine={false}
              />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={36} />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 6 }}
                labelFormatter={(d) => (typeof d === "string" ? dayLabel(d) : d)}
              />
              <Area
                type="monotone"
                dataKey="conversations"
                name="Conversations"
                stroke={AI}
                fill="url(#pulseFill)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </section>

        <section className="rounded border border-border p-4">
          <Title>Who answered</Title>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={split}
                dataKey="value"
                nameKey="name"
                innerRadius="58%"
                outerRadius="82%"
                paddingAngle={2}
                strokeWidth={0}
              >
                {split.map((s) => (
                  <Cell key={s.name} fill={s.fill} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="mt-2 space-y-1 text-xs">
            {split.map((s) => (
              <div key={s.name} className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ background: s.fill }} />
                <span className="flex-1 text-muted-foreground">{s.name}</span>
                <span>{s.value.toLocaleString("en-IN")}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <Hours hours={hours} />
    </div>
  );
}

function Stat({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="rounded border border-border p-3 sm:p-4">
      <div className="text-2xl font-semibold tabular-nums sm:text-3xl">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
      {hint && <div className="text-[11px] text-muted-foreground/70">{hint}</div>}
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">{children}</div>
  );
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * When customers actually write. The one chart on this screen that changes a decision:
 * an owner who can see a block of messages at 10pm knows what the assistant is covering
 * for, and an owner who cannot see it thinks nothing happens after seven.
 */
function Hours({ hours }: { hours: PulseHour[] }) {
  const peak = Math.max(...hours.map((h) => Number(h.messages)), 1);
  const at = new Map(hours.map((h) => [`${h.dow}-${h.hour}`, Number(h.messages)]));

  return (
    <section className="overflow-x-auto rounded border border-border p-4">
      <Title>When your customers message</Title>
      <div className="min-w-[20rem] space-y-1">
        {DOW.map((label, dow) => (
          <div key={label} className="flex items-center gap-2">
            <span className="w-7 shrink-0 text-[10px] text-muted-foreground">{label}</span>
            <div className="flex flex-1 gap-[2px]">
              {Array.from({ length: 24 }, (_, hour) => {
                const n = at.get(`${dow}-${hour}`) ?? 0;
                return (
                  <div
                    key={hour}
                    className="h-4 flex-1 rounded-[2px] ring-1 ring-inset ring-border"
                    style={{
                      background:
                        n === 0
                          ? "transparent"
                          : `color-mix(in srgb, ${AI} ${15 + (n / peak) * 85}%, transparent)`,
                    }}
                    title={`${label} ${hour}:00 — ${n} messages`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between pl-9 text-[10px] text-muted-foreground">
        <span>12am</span>
        <span>noon</span>
        <span>11pm</span>
      </div>
    </section>
  );
}

/** Seconds are the honest unit here, and the one that lands. Minutes round it away. */
function speed(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} hrs`;
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
