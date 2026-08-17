import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import { type HoursRow } from "./lib/api";
import { dayOfWeek, istDay, istTime, istToday, shiftDay } from "./lib/utils";

/**
 * The owner's side of the booking calendar.
 *
 * Until this screen existed the assistant could take an appointment and the business had
 * nowhere to see it: the only list of bookings in the product was inside the platform
 * admin's training console, which no client can open. A bot that books into a diary
 * nobody can read is worse than one that does not book at all.
 *
 * Every query here goes straight to Supabase under RLS, like the inbox and Flowin, and
 * unlike the admin console next door — which has to go through the Worker only because
 * the platform admin holds no `org_members` row and RLS would answer it with nothing.
 */

/** Named columns, never `select *` — invariant 7's rule, applied past `messages`. */
const BOOKING_COLUMNS =
  "id,starts_at,duration_minutes,customer_name,service,status,kind,conversation_id";

/**
 * A month of a busy salon is a few hundred rows. The cap is here so that a runaway org
 * cannot pull an unbounded page into the browser on the shared 5GB egress budget; a month
 * that reaches it is a month that needs a different screen, not a bigger fetch.
 */
const MONTH_LIMIT = 500;

/** How many bookings the "next up" list shows before it stops being a glance. */
const COMING_UP_LIMIT = 6;

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

/** First day of the month `delta` months from `YYYY-MM`. */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const at = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return at.toISOString().slice(0, 7);
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
  { dow: 1, label: "Mon" },
  { dow: 2, label: "Tue" },
  { dow: 3, label: "Wed" },
  { dow: 4, label: "Thu" },
  { dow: 5, label: "Fri" },
  { dow: 6, label: "Sat" },
  { dow: 0, label: "Sun" },
];

const columnOf = (day: string) => (dayOfWeek(day) + 6) % 7;

function who(b: Booking): string {
  // `service` carries the note on a block — the column already exists and a block has no
  // service, so the alternative was a column that only one `kind` would ever use.
  if (b.kind === "block") return b.service ? `Blocked out · ${b.service}` : "Blocked out";
  return [b.customer_name, b.service].filter(Boolean).join(" · ") || "No name given";
}

export default function Diary({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  const today = istToday();
  const [month, setMonth] = useState(() => monthOf(today));
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hours, setHours] = useState<HoursRow[] | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The open day. Declared here rather than beside the render, because the effects and
      the write helpers below all key off it. */
  const day = selected ?? today;

  useEffect(() => {
    if (!orgId) return;
    setBookings(null);
    // Tapping Next twice quickly fires two reads, and the slower one can answer last. The
    // guard is what stops August's rows painting under September's heading.
    let live = true;
    void loadMonth(() => live);
    return () => {
      live = false;
    };
  }, [orgId, month]);

  useEffect(() => {
    if (!orgId) return;
    void loadHours();
  }, [orgId]);

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

  async function loadMonth(live: () => boolean = () => true) {
    const from = `${month}-01`;
    // Exclusive, so a booking at 23:30 on the last of the month is still inside it.
    const to = `${shiftMonth(month, 1)}-01`;

    const { data, error: readError } = await supabase
      .from("appointments")
      .select(BOOKING_COLUMNS)
      .eq("org_id", orgId)
      .gte("starts_at", istMidnight(from))
      .lt("starts_at", istMidnight(to))
      // Cancelled rows are kept forever — they are the proof a customer was once told
      // they had this time — but a cancelled booking is a free slot everywhere else, and
      // this is the one screen where showing it would read as still taken.
      .neq("status", "cancelled")
      .order("starts_at", { ascending: true })
      .limit(MONTH_LIMIT)
      .returns<Booking[]>();

    if (!live()) return;
    // A failed read and an empty month look identical otherwise, and "no bookings" is not
    // a claim to make when we do not know.
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
    await loadMonth();
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
    await loadMonth();
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
    await loadMonth();
    // Null is the "could not" answer, and it is not an error — the row already exists.
    return data !== null;
  }

  /** Returns how many slots were actually taken out, which is not always what was asked. */
  async function blockOut(from: string, to: string, note: string): Promise<number> {
    setBusy(true);
    setError(null);
    const { data, error: writeError } = await supabase.rpc("block_time", {
      p_org_id: orgId,
      // The offset is in the string for the same reason as `istMidnight`: no arithmetic
      // happens on either side, so neither side can be wrong about it.
      p_from: `${day}T${from}:00+05:30`,
      p_to: `${day}T${to}:00+05:30`,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (writeError) {
      setError(writeError.message);
      return 0;
    }
    await loadMonth();
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
      await loadMonth();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save the hours");
    } finally {
      setBusy(false);
    }
  }

  const byDay = new Map<string, Booking[]>();
  for (const b of bookings ?? []) {
    const day = istDay(b.starts_at);
    byDay.set(day, [...(byDay.get(day) ?? []), b]);
  }

  const first = `${month}-01`;
  const lead = columnOf(first);
  const cells = Array.from({ length: 42 }, (_, i) => shiftDay(first, i - lead));
  const weeks = Array.from({ length: 6 }, (_, w) => cells.slice(w * 7, w * 7 + 7));

  const onDay = byDay.get(day) ?? [];
  const blocksOnDay = onDay.filter((b) => b.kind === "block");
  const openDays = new Set((hours ?? []).map((h) => h.weekday));

  return (
    <div className="h-full overflow-y-auto overscroll-contain p-4 sm:p-6">
      <header className="mb-5">
        <h1 className="text-lg font-semibold">Diary</h1>
        <p className="text-sm text-muted-foreground">
          Every appointment the assistant took, and every one your team entered. All times
          are IST.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          {error}
        </p>
      )}

      {hours !== null && openDays.size === 0 && (
        <p className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs">
          No opening hours are set, so the assistant never offers a time and cannot book.
          {isOwner ? " Set them below." : " Ask the account owner to set them."}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded border border-border p-4 lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {monthLabel(month)}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setMonth((m) => shiftMonth(m, -1))}
              className="rounded border border-border px-2 py-0.5 text-xs"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setMonth(monthOf(today))}
              className="rounded border border-border px-2 py-0.5 text-xs"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
              className="rounded border border-border px-2 py-0.5 text-xs"
            >
              Next
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-[10px] text-muted-foreground">
            {COLUMNS.map((c) => (
              <div key={c.dow} className="pb-1 text-center">
                {c.label}
              </div>
            ))}
          </div>

          <div className="space-y-1">
            {weeks.map((week) => (
              <div key={week[0]} className="grid grid-cols-7 gap-1">
                {week.map((cell) => {
                  const n = (byDay.get(cell) ?? []).length;
                  const outside = monthOf(cell) !== month;
                  const closed = !openDays.has(dayOfWeek(cell));
                  return (
                    <button
                      key={cell}
                      type="button"
                      onClick={() => setSelected(cell)}
                      className={`flex h-14 flex-col items-center justify-center rounded border text-xs ${
                        cell === day ? "border-foreground" : "border-border"
                      } ${outside ? "opacity-35" : ""} ${
                        closed && !outside ? "bg-muted/40" : ""
                      }`}
                    >
                      <span className={cell === today ? "font-semibold underline" : ""}>
                        {Number(cell.slice(8))}
                      </span>
                      {/* A count, not a stack of names. Thirty bookings on a Saturday
                          would otherwise make the cell taller than the week. */}
                      {n > 0 && (
                        <span className="mt-0.5 rounded bg-foreground px-1.5 text-[10px] text-background">
                          {n}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <p className="mt-2 text-[11px] text-muted-foreground">
            Shaded days are days you are closed. The assistant offers no times on those.
          </p>
        </section>

        <section className="rounded border border-border p-4">
          <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
            {day === today ? "Today" : dayHeading(day)}
          </div>

          {bookings === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : onDay.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing booked.</p>
          ) : (
            <ul className="space-y-2">
              {onDay.map((b) => (
                <li
                  key={b.id}
                  className={`rounded border p-2 text-xs ${
                    b.kind === "block" ? "border-dashed border-border bg-muted/40" : "border-border"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium tabular-nums">{istTime(b.starts_at)}</span>
                    <span className="text-muted-foreground">{b.duration_minutes} min</span>
                    <span className="flex-1" />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void (b.kind === "block" ? unblock([b.id]) : cancel(b.id))}
                      className="text-destructive disabled:opacity-50"
                    >
                      {b.kind === "block" ? "Unblock" : "Cancel"}
                    </button>
                  </div>
                  <div className="mt-0.5 truncate">{who(b)}</div>
                </li>
              ))}
            </ul>
          )}

          {/* One click for the common case. Blocking an afternoon makes eight rows, and
              clearing them one at a time is eight confirmations of the same decision. */}
          {blocksOnDay.length > 1 && (
            <button
              type="button"
              disabled={busy}
              className="mt-2 text-xs text-destructive disabled:opacity-50"
              onClick={() => void unblock(blocksOnDay.map((b) => b.id))}
            >
              Unblock all {blocksOnDay.length} on this day
            </button>
          )}

          <div className="mt-4 border-t border-border pt-3">
            <BookingForm key={`book-${day}`} slots={slots} busy={busy} onBook={bookManual} />
          </div>

          <div className="mt-4 border-t border-border pt-3">
            <BlockEditor
              key={day}
              hours={hours?.find((h) => h.weekday === dayOfWeek(day)) ?? null}
              busy={busy}
              onBlock={blockOut}
            />
          </div>

          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              Coming up
            </div>
            <ComingUp bookings={bookings} today={today} onPick={setSelected} />
          </div>
        </section>
      </div>

      {isOwner && (
        <section className="mt-4 rounded border border-border p-4">
          <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
            Opening hours
          </div>
          <HoursEditor hours={hours} busy={busy} onSave={saveHours} />
        </section>
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

  if (slots === null) return <p className="text-xs text-muted-foreground">Loading…</p>;

  async function submit() {
    const ok = await onBook(chosen, name, service);
    setLost(!ok);
    if (ok) {
      setName("");
      setService("");
      setAt("");
    }
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="uppercase tracking-wide text-muted-foreground">Add a booking</div>

      {slots.length === 0 ? (
        <p className="text-muted-foreground">
          No free times on this day — everything is booked, blocked, or you are closed.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            <select
              value={chosen}
              onChange={(e) => {
                setAt(e.target.value);
                setLost(false);
              }}
              className="rounded border border-border bg-transparent px-1 py-0.5"
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
              className="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <input
              value={service}
              onChange={(e) => setService(e.target.value)}
              placeholder="What for (optional)"
              className="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="rounded bg-foreground px-2 py-0.5 font-medium text-background disabled:opacity-50"
            >
              Book
            </button>
          </div>

          {lost ? (
            // Said plainly rather than as an error: nothing went wrong, somebody was just
            // quicker, and the staff member has to know not to expect this person.
            <p className="text-destructive">
              That time went while you were typing. Nothing was booked — pick another.
            </p>
          ) : (
            <p className="text-muted-foreground">
              For someone who phoned or was handed over. The assistant stops offering the
              time immediately.
            </p>
          )}
        </>
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
      <p className="text-xs text-muted-foreground">
        You are closed on this day, so the assistant already offers no times. Nothing to
        block.
      </p>
    );
  }

  const backwards = to <= from;

  async function submit() {
    const n = await onBlock(from, to, note);
    setResult(n);
    setNote("");
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="uppercase tracking-wide text-muted-foreground">Block out time</div>

      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="time"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setResult(null);
          }}
          className="rounded border border-border bg-transparent px-1 py-0.5"
        />
        <span className="text-muted-foreground">–</span>
        <input
          type="time"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setResult(null);
          }}
          className={`rounded border bg-transparent px-1 py-0.5 ${
            backwards ? "border-destructive" : "border-border"
          }`}
        />
        <button
          type="button"
          onClick={() => {
            setFrom(open);
            setTo(close);
            setResult(null);
          }}
          className="rounded border border-border px-2 py-0.5"
        >
          Whole day
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reason (optional)"
          className="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5"
        />
        <button
          type="button"
          disabled={busy || backwards}
          onClick={() => void submit()}
          className="rounded bg-foreground px-2 py-0.5 font-medium text-background disabled:opacity-50"
        >
          Block
        </button>
      </div>

      {backwards ? (
        <p className="text-destructive">The end has to be after the start.</p>
      ) : result === null ? (
        <p className="text-muted-foreground">
          The assistant stops offering these times and cannot book them.
        </p>
      ) : result === 0 ? (
        // Genuinely different from a failure, and the owner has to be able to tell: the
        // usual cause is every slot in the range already being taken.
        <p className="text-muted-foreground">
          Nothing was blocked — those times were already taken or outside your hours.
          Existing bookings are never removed by this.
        </p>
      ) : (
        <p className="text-muted-foreground">
          Blocked {result} slot{result === 1 ? "" : "s"}. Any booking already in that range
          was left alone — cancel those yourself if you need to.
        </p>
      )}
    </div>
  );
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

/**
 * The next few appointments, from a month already in memory.
 *
 * It takes rows rather than fetching them so that the calendar beside it and this list can
 * never disagree, and so that opening the tab is one query rather than two.
 */
function ComingUp({
  bookings,
  today,
  onPick,
}: {
  bookings: Booking[] | null;
  today: string;
  onPick: (day: string) => void;
}) {
  const now = Date.now();
  const next = (bookings ?? [])
    .filter((b) => new Date(b.starts_at).getTime() >= now)
    .slice(0, COMING_UP_LIMIT);

  if (bookings === null) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (next.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Nothing left this month. Use Next to look further ahead.
      </p>
    );
  }

  return (
    <ul className="space-y-1 text-xs">
      {next.map((b) => {
        const day = istDay(b.starts_at);
        return (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => onPick(day)}
              className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-muted/50"
            >
              <span className="w-20 shrink-0 text-muted-foreground">
                {day === today ? "Today" : dayHeading(day)}
              </span>
              <span className="w-16 shrink-0 tabular-nums">{istTime(b.starts_at)}</span>
              <span className="flex-1 truncate">{who(b)}</span>
            </button>
          </li>
        );
      })}
    </ul>
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
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <select
          value={slot}
          onChange={(e) => {
            setSlot(Number(e.target.value));
            setDirty(true);
          }}
          className="rounded border border-border bg-transparent px-1 py-0.5"
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
          className="rounded bg-foreground px-2 py-0.5 font-medium text-background disabled:opacity-50"
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
                  className="rounded border border-border bg-transparent px-1 py-0.5"
                />
                <span className="text-muted-foreground">–</span>
                <input
                  type="time"
                  value={row.closes_at}
                  onChange={(e) => edit(day, "closes_at", e.target.value)}
                  className={`rounded border bg-transparent px-1 py-0.5 ${
                    row.closes_at <= row.opens_at ? "border-destructive" : "border-border"
                  }`}
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

/**
 * The forward half of Flowin, which is otherwise entirely a retrospective.
 *
 * Its own small query rather than the Diary's month: this is the landing screen, it must
 * paint without waiting on a calendar, and "the next few" crosses a month boundary that a
 * month fetch by definition does not.
 */
export function UpcomingCard({ orgId, onOpen }: { orgId: string; onOpen: () => void }) {
  const [next, setNext] = useState<Booking[] | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let live = true;
    void supabase
      .from("appointments")
      .select(BOOKING_COLUMNS)
      .eq("org_id", orgId)
      .gte("starts_at", new Date().toISOString())
      .neq("status", "cancelled")
      .order("starts_at", { ascending: true })
      .limit(COMING_UP_LIMIT)
      .returns<Booking[]>()
      .then(({ data }) => live && setNext(data ?? []));
    return () => {
      live = false;
    };
  }, [orgId]);

  const today = istToday();

  return (
    <section className="rounded border border-border p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Coming up</span>
        <span className="flex-1" />
        <button type="button" onClick={onOpen} className="rounded border border-border px-2 py-0.5 text-xs">
          Open the diary
        </button>
      </div>

      {next === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : next.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing booked yet. The assistant offers times whenever your opening hours are
          set.
        </p>
      ) : (
        <ul className="space-y-1 text-xs">
          {next.map((b) => {
            const day = istDay(b.starts_at);
            return (
              <li key={b.id} className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-muted-foreground">
                  {day === today ? "Today" : dayHeading(day)}
                </span>
                <span className="w-16 shrink-0 tabular-nums">{istTime(b.starts_at)}</span>
                <span className="flex-1 truncate">{who(b)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
