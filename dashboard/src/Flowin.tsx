import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import { Stat } from "./components/screen";
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
 * That question now has one answer at the top instead of four equal boxes: the share of
 * replies that went out without anybody. Everything else on the screen supports it.
 *
 * Every number here is aggregated in Postgres (`pulse_*`). Counting a month of messages
 * in the browser would spend the shared 5GB egress budget on arithmetic.
 *
 * ⚠️ **No charting library.** recharts was 379kB raw for one line, one two-value donut
 * and a heatmap that was already hand-drawn divs. The line is now an SVG `polyline`, the
 * donut is a stacked bar, and the owner's phone parses none of it. Adding a chart
 * dependency back for a fourth chart is not worth it — draw the fourth one too.
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

    // Same reason as the desk: a failed read and a quiet month look identical
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
  const replies = aiReplies + byHuman;
  const share = replies === 0 ? null : Math.round((aiReplies / replies) * 100);

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="max-w-3xl px-6 py-8 sm:px-10 sm:py-10">
        <header>
          <h1 className="text-[28px] font-semibold leading-none tracking-tight">Flowin</h1>
          <p className="mt-3 text-[15px] text-muted-foreground">
            The last five weeks on WhatsApp.
          </p>
        </header>

        {loadError && (
          <p className="mt-6 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            Could not load activity: {loadError}
          </p>
        )}

        {/* The whole screen in one number. It used to be the second of four equal boxes,
            which is a strange place to keep the only figure that answers "is this thing
            worth paying for". */}
        <div className="mt-10">
          <div className="text-[48px] font-semibold leading-none tracking-tight tabular-nums">
            {share === null ? "—" : `${share}%`}
          </div>
          <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground">
            {replies === 0
              ? "No replies have gone out in the last five weeks."
              : `${aiReplies.toLocaleString("en-IN")} of ${replies.toLocaleString(
                  "en-IN",
                )} replies went out without anyone on your team touching them.`}
          </p>
        </div>

        <div className="mt-10 grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-3">
          <Stat n={total((d) => d.conversations).toLocaleString("en-IN")} label="conversations" />
          <Stat
            n={total((d) => d.afterHours).toLocaleString("en-IN")}
            label="answered while you were closed"
          />
          <Stat n={speed(replySeconds)} label="typical reply" />
        </div>

        <Block title="Conversations per day">
          <Trend grid={grid} />
        </Block>

        <Block title="Who answered">
          {replies === 0 ? (
            <p className="text-[13px] text-muted-foreground">Nothing has been answered yet.</p>
          ) : (
            <>
              <div className="flex h-2.5 overflow-hidden rounded-full">
                <div style={{ width: `${(aiReplies / replies) * 100}%`, background: AI }} />
                <div style={{ width: `${(byHuman / replies) * 100}%`, background: HUMAN }} />
              </div>
              <div className="mt-3 space-y-1.5 text-[13px]">
                <Legend color={AI} label="Answered by the assistant" n={aiReplies} />
                <Legend color={HUMAN} label="Answered by your team" n={byHuman} />
              </div>
            </>
          )}
        </Block>

        <Block title="When your customers message">
          <Hours hours={hours} />
        </Block>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10 border-t border-border pt-6">
      <h2 className="mb-4 text-[13px] text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Legend({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="flex-1 text-muted-foreground">{label}</span>
      <span className="tabular-nums">{n.toLocaleString("en-IN")}</span>
    </div>
  );
}

/**
 * Five weeks of daily volume.
 *
 * The axis labels are HTML beside the SVG rather than `<text>` inside it, which is what
 * lets the drawing stretch to any width without the type stretching with it — and it is
 * why the y-axis numbers are no longer clipped to one glyph, as they were when recharts
 * was given a negative left margin to claw back space.
 *
 * Hover uses one transparent `<rect>` per day carrying a `<title>`, so the browser draws
 * the tooltip and this screen ships no tooltip code.
 */
function Trend({ grid }: { grid: { day: string; conversations: number }[] }) {
  const W = 700;
  const H = 180;
  const peak = Math.max(...grid.map((d) => d.conversations), 1);
  const step = W / Math.max(grid.length - 1, 1);

  const points = grid.map((d, i) => {
    const x = i * step;
    const y = H - (d.conversations / peak) * H;
    return { x, y, d };
  });

  const line = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = [
    `M0,${H}`,
    ...points.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    `L${W},${H}`,
    "Z",
  ].join(" ");

  return (
    <div className="flex gap-3">
      {/* Its own column, so the numbers can never be clipped by the drawing. */}
      <div className="flex w-8 shrink-0 flex-col justify-between text-right text-[11px] tabular-nums text-muted-foreground">
        <span>{peak}</span>
        <span>{Math.round(peak / 2)}</span>
        <span>0</span>
      </div>

      <div className="min-w-0 flex-1">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-[180px] w-full overflow-visible"
          role="img"
          aria-label="Conversations per day over the last five weeks"
        >
          <defs>
            <linearGradient id="flowinFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={AI} stopOpacity={0.45} />
              <stop offset="100%" stopColor={AI} stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* `non-scaling-stroke` is what keeps a 2px line 2px after the viewBox has been
              stretched to the pane's width. Without it the line thickens with the window. */}
          <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="currentColor" strokeWidth="1"
            className="text-border" vectorEffect="non-scaling-stroke" />
          <path d={area} fill="url(#flowinFill)" />
          <polyline
            points={line}
            fill="none"
            stroke={AI}
            strokeWidth="2"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {points.map((p) => (
            <rect
              key={p.d.day}
              x={p.x - step / 2}
              y={0}
              width={step}
              height={H}
              fill="transparent"
            >
              <title>
                {dayLabel(p.d.day)} — {p.d.conversations}{" "}
                {p.d.conversations === 1 ? "conversation" : "conversations"}
              </title>
            </rect>
          ))}
        </svg>

        <div className="mt-2 flex justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>{dayLabel(grid[0]!.day)}</span>
          <span>{dayLabel(grid[Math.floor(grid.length / 2)]!.day)}</span>
          <span>Today</span>
        </div>
      </div>
    </div>
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
    <div className="overflow-x-auto">
      <div className="min-w-[20rem] space-y-1">
        {DOW.map((label, dow) => (
          <div key={label} className="flex items-center gap-2">
            <span className="w-7 shrink-0 text-[11px] text-muted-foreground">{label}</span>
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
      <div className="mt-2 flex justify-between pl-9 text-[11px] text-muted-foreground">
        <span>12am</span>
        <span>noon</span>
        <span>11pm</span>
      </div>
    </div>
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
