import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import { type HoursRow } from "./lib/api";
import { Count, Empty, Group, TabButton } from "./components/screen";
import { cn, dayOfWeek, istDay, istTime, istToday, shiftDay } from "./lib/utils";

/**
 * The owner's side of the booking calendar.
 *
 * Until this screen existed the assistant could take an appointment and the business had
 * nowhere to see it: the only list of bookings in the product was inside the platform
 * admin's training console, which no client can open. A bot that books into a diary
 * nobody can read is worse than one that does not book at all.
 *
 * Every query here goes straight to Supabase under RLS, like the desk and Flowin, and
 * unlike the admin console next door — which has to go through the Worker only because
 * the platform admin holds no `org_members` row and RLS would answer it with nothing.
 *
 * Shaped like the Desk on purpose: a left column that picks, a right pane that acts. It
 * used to be a month grid beside a rail of three permanently open forms, which put a
 * setting nobody edits twice a year at the same weight as this afternoon's appointments.
 */

/** Named columns, never `select *` — invariant 7's rule, applied past `messages`. */
const BOOKING_COLUMNS =
  "id,starts_at,duration_minutes,customer_name,service,status,kind,conversation_id";

/**
 * A month of a busy salon is a few hundred rows. The cap is here so that a runaway org
 * cannot pull an unbounded page into the browser on the shared 5GB egress budget; a range
 * that reaches it is a range that needs a different screen, not a bigger fetch.
 */
const RANGE_LIMIT = 500;

/** Shared by the small forms, so a redesign of one does not leave the other behind. */
const FIELD = "min-w-0 rounded-md border border-border bg-transparent px-2 py-1 text-[13px]";
const GO =
  "shrink-0 rounded-md bg-foreground px-2.5 py-1 text-[13px] font-medium text-background disabled:opacity-50";

export interface Booking {
  id: string;
  starts_at: string;
  duration_minutes: number;
  customer_name: string | null;
  service: string | null;
  status: string;
  /** `block` is time the owner marked unavailable, not a customer. */
  kind: string;
  /** Set only when the booking came from WhatsApp — the thread it was agreed in. */
  conversation_id: string | null;
}

/** One bookable slot on the open day, as `public.day_slots` returns it. */
interface Slot {
  starts_at: string;
  slot_minutes: number;
}

/** Which span of days the left column is listing. */
type Tab = "today" | "week" | "month";

/**
 * Midnight IST on a `YYYY-MM-DD`, as an instant.
 *
 * The offset is written into the string rather than computed, which is the whole trick:
 * `2026-08-01T00:00:00+05:30` is unambiguous to both `Date` and Postgres, so no arithmetic
 * happens in either and neither can be wrong about it. IST does not observe DST.
 */
const istMidnight = (day: string) => `${day}T00:00:00+05:30`;

/** `YYYY-MM` for the month a day belongs to. */
const monthOf = (day: string) => day.slice(0, 7);

/** First day of the month `delta` months from a `YYYY-MM-DD`. */
function shiftMonth(day: string, delta: number): string {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + delta, 1)).toISOString().slice(0, 10);
}

const MONTH_NAME = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAME[m! - 1]} ${y}`;
}

/** Monday first, because a working week does. `dayOfWeek` is Postgres `dow`, 0 = Sunday. */
const COLUMNS = [
  { dow: 1, label: "M" },
  { dow: 2, label: "T" },
  { dow: 3, label: "W" },
  { dow: 4, label: "T" },
  { dow: 5, label: "F" },
  { dow: 6, label: "S" },
  { dow: 0, label: "S" },
];

const columnOf = (day: string) => (dayOfWeek(day) + 6) % 7;

function who(b: Booking): string {
  // `service` carries the note on a block — the column already exists and a block has no
  // service, so the alternative was a column that only one `kind` would ever use.
  if (b.kind === "block") return b.service ? `Blocked out · ${b.service}` : "Blocked out";
  return [b.customer_name, b.service].filter(Boolean).join(" · ") || "No name given";
}

function dayHeading(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export default function Diary({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  const today = istToday();
  const [tab, setTab] = useState<Tab>("week");
  /** The first day of the listed span. Moving it moves the selection with it, which is
      what keeps the open day inside the rows that were fetched. */
  const [anchor, setAnchor] = useState(today);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hours, setHours] = useState<HoursRow[] | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which form the day pane is showing. Neither, until asked for. */
  const [action, setAction] = useState<"book" | "block" | null>(null);

  /** The open day. On a phone `selected` is also what covers the list with the day. */
  const day = selected ?? today;

  // Only the tab and its anchor decide what is fetched, so these are derived rather than
  // held: two pieces of state that must agree about a date range eventually will not.
  const from = tab === "today" ? today : tab === "week" ? anchor : shiftMonth(anchor, 0);
  const to =
    tab === "today" ? shiftDay(today, 1) : tab === "week" ? shiftDay(anchor, 7) : shiftMonth(anchor, 1);

  const days = Array.from(
    { length: tab === "today" ? 1 : 7 },
    (_, i) => shiftDay(from, i),
  );

  useEffect(() => {
    if (!orgId) return;
    setBookings(null);
    // Tapping Next twice quickly fires two reads, and the slower one can answer last. The
    // guard is what stops August's rows painting under September's heading.
    let live = true;
    void loadRange(() => live);
    return () => {
      live = false;
    };
  }, [orgId, from, to]);

  useEffect(() => {
    if (!orgId) return;
    void loadHours();
  }, [orgId]);

  // A form left open from the previous day would submit against this one.
  useEffect(() => setAction(null), [day]);

  /**
   * The bookable slots on the open day, asked of Postgres rather than derived from `hours`
   * here. Which instants are slots is one rule with three readers (see `app.slot_grid`),
   * and a fourth copy of it in the browser is how the assistant ends up offering a time
   * this form thinks is gone.
   *
   * Re-runs when `bookings` changes, so taking a slot removes it from the list underneath.
   */
  useEffect(() => {
    if (!orgId || bookings === null) return;
    let live = true;
    void supabase
      .rpc("day_slots", { p_org_id: orgId, p_day: day })
      .then(({ data }) => live && setSlots((data as Slot[] | null) ?? []));
    return () => {
      live = false;
    };
  }, [orgId, day, bookings]);

  async function loadRange(live: () => boolean = () => true) {
    const { data, error: readError } = await supabase
      .from("appointments")
      .select(BOOKING_COLUMNS)
      .eq("org_id", orgId)
      .gte("starts_at", istMidnight(from))
      // Exclusive, so a booking at 23:30 on the last day of the span is still inside it.
      .lt("starts_at", istMidnight(to))
      // Cancelled rows are kept forever — they are the proof a customer was once told
      // they had this time — but a cancelled booking is a free slot everywhere else, and
      // this is the one screen where showing it would read as still taken.
      .neq("status", "cancelled")
      .order("starts_at", { ascending: true })
      .limit(RANGE_LIMIT)
      .returns<Booking[]>();

    if (!live()) return;
    // A failed read and an empty span look identical otherwise, and "nothing booked" is
    // not a claim to make when we do not know.
    setError(readError?.message ?? null);
    setBookings(data ?? []);
  }

  async function loadHours() {
    const { data } = await supabase
      .from("business_hours")
      .select("weekday,opens_at,closes_at,slot_minutes")
      .eq("org_id", orgId)
      .order("weekday", { ascending: true })
      .returns<HoursRow[]>();
    setHours(data ?? []);
  }

  async function cancel(id: string) {
    setBusy(true);
    // Cancelled, never deleted: `free_slots` offers the time again either way, and the row
    // is the only record that this customer was promised it.
    const { error: writeError } = await supabase
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", id);
    setBusy(false);
    if (writeError) return setError(writeError.message);
    await loadRange();
  }

  /**
   * Deleted rather than cancelled, which is the one place this screen departs from the
   * rule above. A cancelled row is kept because it proves a customer was once promised
   * that time; a block was promised to nobody, so keeping it would only leave rows that
   * every reader has to filter out for the rest of the org's life.
   */
  async function unblock(ids: string[]) {
    setBusy(true);
    const { error: writeError } = await supabase
      .from("appointments")
      .delete()
      .in("id", ids)
      .eq("kind", "block");
    setBusy(false);
    if (writeError) return setError(writeError.message);
    await loadRange();
  }

  /**
   * A booking for someone the assistant never spoke to — a walk-in, a phone call, or a
   * conversation that was handed to a person before it got as far as a time.
   *
   * Returns false when the slot went in the seconds between the list being drawn and the
   * button being pressed, which the form reports rather than swallowing: the alternative is
   * a staff member believing they booked somebody who is not in the diary.
   */
  async function bookManual(startsAt: string, name: string, service: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    const { data, error: writeError } = await supabase.rpc("book_manual", {
      p_org_id: orgId,
      p_starts_at: startsAt,
      p_name: name.trim() || null,
      p_service: service.trim() || null,
    });
    setBusy(false);
    if (writeError) {
      setError(writeError.message);
      return false;
    }
    await loadRange();
    // Null is the "could not" answer, and it is not an error — the row already exists.
    return data !== null;
  }

  /** Returns how many slots were actually taken out, which is not always what was asked. */
  async function blockOut(fromTime: string, toTime: string, note: string): Promise<number> {
    setBusy(true);
    setError(null);
    const { data, error: writeError } = await supabase.rpc("block_time", {
      p_org_id: orgId,
      // The offset is in the string for the same reason as `istMidnight`: no arithmetic
      // happens on either side, so neither side can be wrong about it.
      p_from: `${day}T${fromTime}:00+05:30`,
      p_to: `${day}T${toTime}:00+05:30`,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (writeError) {
      setError(writeError.message);
      return 0;
    }
    await loadRange();
    return typeof data === "number" ? data : 0;
  }

  async function saveHours(next: HoursRow[]) {
    setBusy(true);
    setError(null);
    try {
      // Replace the week rather than diff it: a day the owner unticked has to disappear,
      // and "which rows went away" is state this form does not need to carry.
      const wipe = await supabase.from("business_hours").delete().eq("org_id", orgId);
      if (wipe.error) throw new Error(wipe.error.message);

      if (next.length > 0) {
        const written = await supabase
          .from("business_hours")
          .insert(next.map((h) => ({ ...h, org_id: orgId })));
        if (written.error) throw new Error(written.error.message);
      }
      await loadHours();
      // The hours decide which slots exist, so the calendar underneath them is now stale.
      await loadRange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save the hours");
    } finally {
      setBusy(false);
    }
  }

  /** Moves the span and the open day together, so the day pane never shows a date whose
      rows were not fetched. Every date change in this screen goes through one of these
      three, which is the only reason the single range fetch is safe. */
  function go(delta: number) {
    const next =
      tab === "month" ? shiftMonth(anchor, delta) : shiftDay(anchor, delta * 7);
    setAnchor(next);
    setSelected(next);
  }

  function reset() {
    setAnchor(today);
    setSelected(null);
  }

  /** Switching the span cannot keep the old selection: a day picked in September is not in
      the range "today", and the day pane would report it as empty rather than unfetched. */
  function pickTab(next: Tab) {
    setTab(next);
    setAnchor(today);
    setSelected(null);
  }

  /** The grid draws the days either side of the month, and picking one has to take the
      month with it — otherwise the 31st of last month is open and unfetched. */
  function pickCell(cell: string) {
    if (monthOf(cell) !== monthOf(anchor)) setAnchor(cell);
    setSelected(cell);
  }

  const byDay = new Map<string, Booking[]>();
  for (const b of bookings ?? []) {
    const on = istDay(b.starts_at);
    byDay.set(on, [...(byDay.get(on) ?? []), b]);
  }

  const monthFirst = shiftMonth(anchor, 0);
  const lead = columnOf(monthFirst);
  const cells = Array.from({ length: 42 }, (_, i) => shiftDay(monthFirst, i - lead));
  const weeks = Array.from({ length: 6 }, (_, w) => cells.slice(w * 7, w * 7 + 7));

  const onDay = byDay.get(day) ?? [];
  const blocksOnDay = onDay.filter((b) => b.kind === "block");
  const openDays = new Set((hours ?? []).map((h) => h.weekday));
  const closedOnDay = hours !== null && !openDays.has(dayOfWeek(day));

  const real = (bookings ?? []).filter((b) => b.kind !== "block");
  const auto = real.filter((b) => b.conversation_id !== null).length;
  // Not "this week": the span moves with Back and Next, and a heading that keeps saying
  // "this week" over next month's rows is the kind of wrong nobody notices.
  const span =
    tab === "today" ? "today" : tab === "week" ? "in these seven days" : `in ${monthLabel(monthOf(anchor))}`;

  const head =
    bookings === null
      ? "Loading…"
      : `${real.length} ${real.length === 1 ? "booking" : "bookings"} ${span}`;
  const sub =
    bookings === null || real.length === 0
      ? ""
      : auto === 0
        ? "None of them taken by the assistant."
        : `${auto} of them taken by the assistant.`;

  return (
    <div className="flex h-full">
      {/* One pane at a time on a phone, both side by side from `md`. */}
      <aside
        className={cn(
          "w-full shrink-0 overflow-y-auto overscroll-contain border-border px-3 pb-8 md:w-[21rem] md:border-r",
          selected && "hidden md:block",
        )}
      >
        <header className="px-3 pb-4 pt-8">
          <h1 className="text-[28px] font-semibold leading-none tracking-tight">Diary</h1>
          <p className={cn("mt-3 text-[15px] font-medium", error && "text-destructive")}>{head}</p>
          <p className="text-[15px] text-muted-foreground">{sub}</p>
        </header>

        {/* Week is the default because the assistant only offers times a week ahead, so
            three quarters of a month grid is cells it can never fill. */}
        <div className="mb-4 flex gap-1 overflow-x-auto px-2 pb-1">
          <TabButton on={tab === "today"} onClick={() => pickTab("today")}>
            Today
          </TabButton>
          <TabButton on={tab === "week"} onClick={() => pickTab("week")}>
            Week
          </TabButton>
          <TabButton on={tab === "month"} onClick={() => pickTab("month")}>
            Month
          </TabButton>
        </div>

        {error && (
          <p className="mx-3 mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}

        {hours !== null && openDays.size === 0 && (
          <p className="mx-3 mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-[13px]">
            No opening hours are set, so the assistant never offers a time and cannot book.
            {isOwner ? " Open a day and set them at the bottom." : " Ask the account owner to set them."}
          </p>
        )}

        {tab !== "today" && (
          <div className="mb-3 flex items-center gap-2 px-3">
            <span className="mr-auto text-[13px] text-muted-foreground">
              {tab === "month" ? monthLabel(monthOf(anchor)) : `${dayHeading(from)} — ${dayHeading(shiftDay(to, -1))}`}
            </span>
            <Step onClick={() => go(-1)}>Back</Step>
            <Step onClick={reset}>Today</Step>
            <Step onClick={() => go(1)}>Next</Step>
          </div>
        )}

        {tab === "month" ? (
          <div className="px-2">
            <div className="grid grid-cols-7 gap-1 pb-1 text-center text-[11px] text-muted-foreground">
              {COLUMNS.map((c) => (
                <div key={c.dow}>{c.label}</div>
              ))}
            </div>
            <div className="space-y-1">
              {weeks.map((week) => (
                <div key={week[0]} className="grid grid-cols-7 gap-1">
                  {week.map((cell) => {
                    const n = (byDay.get(cell) ?? []).length;
                    const outside = monthOf(cell) !== monthOf(anchor);
                    const closed = !openDays.has(dayOfWeek(cell));
                    return (
                      <button
                        key={cell}
                        type="button"
                        onClick={() => pickCell(cell)}
                        className={cn(
                          "flex h-11 flex-col items-center justify-center rounded-lg text-[13px] outline-none",
                          cell === day ? "bg-foreground text-background" : "hover:bg-black/[0.04]",
                          closed && cell !== day && "bg-black/[0.03]",
                          outside && "opacity-30",
                        )}
                      >
                        <span className={cn("tabular-nums", cell === today && "font-semibold")}>
                          {Number(cell.slice(8))}
                        </span>
                        {/* A count, not a stack of names. Thirty bookings on a Saturday
                            would otherwise make the cell taller than the week. */}
                        {n > 0 && (
                          <span
                            className={cn(
                              "mt-0.5 h-1 w-1 rounded-full",
                              cell === day ? "bg-background" : "bg-foreground",
                            )}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <p className="px-1 pt-3 text-[13px] text-muted-foreground">
              Shaded days are days you are closed. The assistant offers no times on those.
            </p>
          </div>
        ) : bookings === null ? (
          <Empty>Loading…</Empty>
        ) : (
          days.map((d) => {
            const list = byDay.get(d) ?? [];
            const closed = hours !== null && !openDays.has(dayOfWeek(d));
            return (
              <Group
                key={d}
                title={d === today ? "Today" : dayHeading(d)}
                right={
                  <button
                    type="button"
                    onClick={() => setSelected(d)}
                    className={cn("text-[13px]", d === day ? "text-muted-foreground" : "text-blue-600")}
                  >
                    {list.length > 0 && <Count>{list.length} · </Count>}
                    Open
                  </button>
                }
              >
                {list.length === 0 ? (
                  <Empty>{closed ? "Closed." : "Nothing booked."}</Empty>
                ) : (
                  list.map((b) => (
                    <BookingRow key={b.id} b={b} active={d === day} onPick={() => setSelected(d)} />
                  ))
                )}
              </Group>
            );
          })
        )}
      </aside>

      <div
        className={cn(
          "min-w-0 flex-1 overflow-y-auto overscroll-contain",
          !selected && "hidden md:block",
        )}
      >
        <div className="max-w-2xl px-6 py-8 sm:px-10 sm:py-10">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="mb-4 text-[13px] text-blue-600 md:hidden"
          >
            ← Back
          </button>

          <h2 className="text-[22px] font-semibold tracking-tight">
            {day === today ? "Today" : dayHeading(day)}
          </h2>
          <p className="mt-1 text-[15px] text-muted-foreground">
            {closedOnDay
              ? "You are closed. The assistant offers no times."
              : slots === null
                ? "\u00a0"
                : `${onDay.filter((b) => b.kind !== "block").length} booked · ${slots.length} still free`}
          </p>

          <div className="mt-7">
            {bookings === null ? (
              <Empty>Loading…</Empty>
            ) : onDay.length === 0 ? (
              <Empty>Nothing booked on this day.</Empty>
            ) : (
              onDay.map((b) => (
                <BookingRow
                  key={b.id}
                  b={b}
                  busy={busy}
                  onCancel={() => void (b.kind === "block" ? unblock([b.id]) : cancel(b.id))}
                />
              ))
            )}

            {/* One click for the common case. Blocking an afternoon makes eight rows, and
                clearing them one at a time is eight confirmations of the same decision. */}
            {blocksOnDay.length > 1 && (
              <button
                type="button"
                disabled={busy}
                className="mt-2 px-3 text-[13px] text-destructive disabled:opacity-50"
                onClick={() => void unblock(blocksOnDay.map((b) => b.id))}
              >
                Unblock all {blocksOnDay.length} on this day
              </button>
            )}
          </div>

          {/* Both forms were permanently open in the rail before this, which is why the
              settings below them read as part of the day's work. Asked for, then shown. */}
          <div className="mt-8 flex gap-1">
            <TabButton
              on={action === "book"}
              onClick={() => setAction((a) => (a === "book" ? null : "book"))}
            >
              Add a booking
            </TabButton>
            <TabButton
              on={action === "block"}
              onClick={() => setAction((a) => (a === "block" ? null : "block"))}
            >
              Block out time
            </TabButton>
          </div>

          {action === "book" && (
            <div className="mt-4">
              <BookingForm key={`book-${day}`} slots={slots} busy={busy} onBook={bookManual} />
            </div>
          )}

          {action === "block" && (
            <div className="mt-4">
              <BlockEditor
                key={day}
                hours={hours?.find((h) => h.weekday === dayOfWeek(day)) ?? null}
                busy={busy}
                onBlock={blockOut}
              />
            </div>
          )}

          {/* Collapsed, and last. It is edited when the business changes its hours and
              never again, so it has no business sitting level with this afternoon. */}
          {isOwner && (
            <details className="mt-10 border-t border-border pt-5">
              <summary className="cursor-pointer list-none text-[13px] text-muted-foreground marker:content-none">
                <span className="mr-1 inline-block text-[10px]">▸</span>
                Opening hours
              </summary>
              <div className="mt-4">
                <HoursEditor hours={hours} busy={busy} onSave={saveHours} />
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-2 py-0.5 text-[13px] text-muted-foreground outline-none hover:bg-black/[0.04]"
    >
      {children}
    </button>
  );
}

/**
 * One appointment, in the desk's row shape. A block is dimmed rather than boxed: it is
 * the absence of an appointment, and drawing it as loudly as a customer made a blocked
 * afternoon look like eight bookings.
 */
function BookingRow({
  b,
  active,
  busy,
  onPick,
  onCancel,
}: {
  b: Booking;
  active?: boolean;
  busy?: boolean;
  onPick?: () => void;
  onCancel?: () => void;
}) {
  const block = b.kind === "block";
  const line = (
    <div className="flex items-baseline justify-between gap-3">
      <span className={cn("truncate text-[15px]", block ? "text-muted-foreground" : "font-medium")}>
        {who(b)}
      </span>
      <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">
        {istTime(b.starts_at)}
      </span>
    </div>
  );

  return (
    <div
      className={cn(
        "rounded-lg px-3 py-2.5",
        active ? "bg-black/[0.03]" : onPick && "hover:bg-black/[0.03]",
      )}
    >
      {/* A plain div where the row is not a link: a disabled button greys its own text in
          Chrome, which made a booking read as cancelled. */}
      {onPick ? (
        <button type="button" onClick={onPick} className="block w-full text-left outline-none">
          {line}
        </button>
      ) : (
        line
      )}

      {onCancel && (
        <div className="mt-0.5 flex items-baseline gap-3 text-[13px] text-muted-foreground">
          <span className="tabular-nums">{b.duration_minutes} min</span>
          {b.conversation_id && !block && <span>booked on WhatsApp</span>}
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="ml-auto text-destructive disabled:opacity-50"
          >
            {block ? "Unblock" : "Cancel"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Entering a booking the assistant did not take.
 *
 * The times come from a list rather than a text box on purpose. `free_slots` decides
 * whether a time is available by comparing `starts_at` for equality, so a 09:15 booking
 * typed by hand would leave 09:00 and 09:30 both bookable and the assistant would put a
 * customer on top of the walk-in. `book_manual` refuses anything off the grid regardless —
 * this list is so that nobody has to find that out by being refused.
 */
function BookingForm({
  slots,
  busy,
  onBook,
}: {
  /** Null while loading. Empty means the day is full, or closed. */
  slots: Slot[] | null;
  busy: boolean;
  onBook: (startsAt: string, name: string, service: string) => Promise<boolean>;
}) {
  const [at, setAt] = useState("");
  const [name, setName] = useState("");
  const [service, setService] = useState("");
  const [lost, setLost] = useState(false);

  const chosen = at || slots?.[0]?.starts_at || "";

  if (slots === null) return <Empty>Loading…</Empty>;

  async function submit() {
    const ok = await onBook(chosen, name, service);
    setLost(!ok);
    if (ok) {
      setName("");
      setService("");
      setAt("");
    }
  }

  if (slots.length === 0) {
    return <Empty>No free times on this day — everything is booked, blocked, or you are closed.</Empty>;
  }

  return (
    <div className="space-y-2 px-3">
      <div className="flex items-center gap-2">
        <select
          value={chosen}
          onChange={(e) => {
            setAt(e.target.value);
            setLost(false);
          }}
          className={FIELD}
        >
          {slots.map((s) => (
            <option key={s.starts_at} value={s.starts_at}>
              {istTime(s.starts_at)}
            </option>
          ))}
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className={cn(FIELD, "flex-1")}
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          value={service}
          onChange={(e) => setService(e.target.value)}
          placeholder="What for (optional)"
          className={cn(FIELD, "flex-1")}
        />
        <button type="button" disabled={busy} onClick={() => void submit()} className={GO}>
          Book
        </button>
      </div>

      {lost ? (
        // Said plainly rather than as an error: nothing went wrong, somebody was just
        // quicker, and the staff member has to know not to expect this person.
        <p className="text-[13px] text-destructive">
          That time went while you were typing. Nothing was booked — pick another.
        </p>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          For someone who phoned or was handed over. The assistant stops offering the time
          immediately.
        </p>
      )}
    </div>
  );
}

/**
 * Marking a stretch of a day unavailable.
 *
 * Not owner-gated, unlike the opening hours below it. Hours are a standing fact about the
 * business; "the doctor left at three" is the same class of thing as marking a booking,
 * which `appointments`' own policy already lets any member do. Gating it here would only
 * mean the person answering the phone has to find the owner before they can stop the
 * assistant promising a slot that no longer exists.
 */
function BlockEditor({
  hours,
  busy,
  onBlock,
}: {
  /** This weekday's opening hours, or null when the business is closed that day. */
  hours: HoursRow | null;
  busy: boolean;
  onBlock: (from: string, to: string, note: string) => Promise<number>;
}) {
  const open = hours?.opens_at.slice(0, 5) ?? "09:00";
  const close = hours?.closes_at.slice(0, 5) ?? "18:00";
  const [from, setFrom] = useState(open);
  const [to, setTo] = useState(close);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<number | null>(null);

  if (!hours) {
    return (
      <Empty>
        You are closed on this day, so the assistant already offers no times. Nothing to
        block.
      </Empty>
    );
  }

  const backwards = to <= from;

  async function submit() {
    const n = await onBlock(from, to, note);
    setResult(n);
    setNote("");
  }

  return (
    <div className="space-y-2 px-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="time"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setResult(null);
          }}
          className={FIELD}
        />
        <span className="text-[13px] text-muted-foreground">–</span>
        <input
          type="time"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setResult(null);
          }}
          className={cn(FIELD, backwards && "border-destructive")}
        />
        <button
          type="button"
          onClick={() => {
            setFrom(open);
            setTo(close);
            setResult(null);
          }}
          className="rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-black/[0.04]"
        >
          Whole day
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reason (optional)"
          className={cn(FIELD, "flex-1")}
        />
        <button
          type="button"
          disabled={busy || backwards}
          onClick={() => void submit()}
          className={GO}
        >
          Block
        </button>
      </div>

      {backwards ? (
        <p className="text-[13px] text-destructive">The end has to be after the start.</p>
      ) : result === null ? (
        <p className="text-[13px] text-muted-foreground">
          The assistant stops offering these times and cannot book them.
        </p>
      ) : result === 0 ? (
        // Genuinely different from a failure, and the owner has to be able to tell: the
        // usual cause is every slot in the range already being taken.
        <p className="text-[13px] text-muted-foreground">
          Nothing was blocked — those times were already taken or outside your hours.
          Existing bookings are never removed by this.
        </p>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          Blocked {result} slot{result === 1 ? "" : "s"}. Any booking already in that range
          was left alone — cancel those yourself if you need to.
        </p>
      )}
    </div>
  );
}

/**
 * The week the assistant books inside, as a form.
 *
 * Shared with the training console rather than rewritten there: the console edits the same
 * seven rows through the Worker, and two copies of "which day is 0" would eventually
 * disagree about a Sunday.
 */
const WEEK = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

const DEFAULT_OPEN = "09:00";
const DEFAULT_CLOSE = "18:00";
const DEFAULT_SLOT = 30;

type Week = Record<number, { opens_at: string; closes_at: string } | undefined>;

export function HoursEditor({
  hours,
  busy,
  onSave,
}: {
  /** Null while loading. A new array is what tells this form to refill itself. */
  hours: HoursRow[] | null;
  busy: boolean;
  onSave: (hours: HoursRow[]) => Promise<void>;
}) {
  const [week, setWeek] = useState<Week>({});
  const [slot, setSlot] = useState(DEFAULT_SLOT);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!hours) return;
    const next: Week = {};
    for (const h of hours) {
      // `HH:MM:SS` off Postgres, and `<input type="time">` wants `HH:MM`.
      next[h.weekday] = { opens_at: h.opens_at.slice(0, 5), closes_at: h.closes_at.slice(0, 5) };
    }
    setWeek(next);
    // The table stores a slot length per day; this form writes one for the week, because
    // no client has yet wanted a different appointment length on a Tuesday.
    setSlot(hours[0]?.slot_minutes ?? DEFAULT_SLOT);
    setDirty(false);
  }, [hours]);

  function toggle(day: number) {
    setWeek((w) => ({
      ...w,
      [day]: w[day] ? undefined : { opens_at: DEFAULT_OPEN, closes_at: DEFAULT_CLOSE },
    }));
    setDirty(true);
  }

  function edit(day: number, field: "opens_at" | "closes_at", value: string) {
    setWeek((w) => {
      const row = w[day];
      return row ? { ...w, [day]: { ...row, [field]: value } } : w;
    });
    setDirty(true);
  }

  const open = WEEK.filter(({ day }) => week[day]);
  const broken = open.some(({ day }) => week[day]!.closes_at <= week[day]!.opens_at);

  return (
    <div className="space-y-2 text-[13px]">
      <div className="flex items-center gap-2">
        <select
          value={slot}
          onChange={(e) => {
            setSlot(Number(e.target.value));
            setDirty(true);
          }}
          className={FIELD}
        >
          {[15, 20, 30, 45, 60].map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <button
          type="button"
          disabled={busy || !dirty || broken}
          onClick={() =>
            void onSave(
              WEEK.flatMap(({ day }) => {
                const row = week[day];
                return row ? [{ weekday: day, ...row, slot_minutes: slot }] : [];
              }),
            )
          }
          className={GO}
        >
          Save
        </button>
      </div>

      <p className="text-muted-foreground">
        {open.length === 0
          ? "No hours set, so the assistant never offers a time and cannot book. It answers questions only."
          : `The assistant offers free ${slot}-minute slots inside these hours, up to a week ahead, and books the one the customer picks.`}
      </p>

      {WEEK.map(({ day, label }) => {
        const row = week[day];
        return (
          <div key={day} className="flex items-center gap-2">
            <label className="flex w-16 items-center gap-1.5">
              <input type="checkbox" checked={!!row} onChange={() => toggle(day)} />
              {label}
            </label>
            {row ? (
              <>
                <input
                  type="time"
                  value={row.opens_at}
                  onChange={(e) => edit(day, "opens_at", e.target.value)}
                  className={FIELD}
                />
                <span className="text-muted-foreground">–</span>
                <input
                  type="time"
                  value={row.closes_at}
                  onChange={(e) => edit(day, "closes_at", e.target.value)}
                  className={cn(FIELD, row.closes_at <= row.opens_at && "border-destructive")}
                />
              </>
            ) : (
              <span className="text-muted-foreground">closed</span>
            )}
          </div>
        );
      })}

      {broken && <p className="text-destructive">A day has to close after it opens.</p>}
    </div>
  );
}

