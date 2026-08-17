import { useEffect, useRef, useState } from "react";
import {
  SAFETY_LABEL,
  customerLabel,
  supabase,
  type Conversation,
  type Lead,
  type SafetyFlag,
} from "./lib/supabase";
import { Button } from "./components/ui/button";
import { cn, ist, istToday, shiftDay, useNow, windowLeft } from "./lib/utils";
import { downloadLeadsCsv, leadsFor } from "./lib/leads";
import Thread from "./Thread";

const LIST_LIMIT = 50;

/** A callback nobody made in a week is not today's work. It stays reachable, but it
 *  stops competing with the person who messaged an hour ago. */
const COLD_MS = 7 * 24 * 60 * 60 * 1000;

const istMidnight = (day: string) => `${day}T00:00:00+05:30`;

/**
 * Why a conversation is waiting on a person, or null if it is not. Ordered: a safety
 * flag outranks everything, then a customer who asked for a human, then one the owner
 * already took over and has not handed back.
 */
const ATTENTION = [
  { rank: 0, label: "flagged", match: (_c: Conversation, f: SafetyFlag[]) => f.length > 0 },
  { rank: 1, label: "asked for a person", match: (c: Conversation) => c.handoff_state === "requested" },
  { rank: 2, label: "you are replying", match: (c: Conversation) => c.handoff_state === "human" },
] as const;

function attention(c: Conversation, f: SafetyFlag[]) {
  return ATTENTION.find((a) => a.match(c, f)) ?? null;
}

interface DayStats {
  conversations: number;
  afterHours: number;
  booked: number;
  replySeconds: number | null;
  known: boolean;
}

/**
 * The screen an owner opens in the morning.
 *
 * It is not an inbox. An inbox implies every conversation is yours to read, and the
 * whole point of the assistant is that most of them are not. This lists the exceptions —
 * who is waiting, who is owed a call — and when there are none it gets out of the way
 * and shows what the assistant did instead.
 *
 * The filter chips this replaced ("Needs you / To call / All") asked the owner to
 * choose a view before the screen would answer anything. The groups below answer it
 * without being asked, in the order the day should be worked.
 *
 * Almost nothing here is boxed or ruled. Hierarchy comes from type size and white space,
 * because a border around every group is what made the old screen read as cluttered when
 * the number of things on it had not actually changed.
 */
export default function Desk({
  orgId,
  isOwner,
  jumpTo,
  onWaiting,
}: {
  orgId: string;
  isOwner: boolean;
  jumpTo: string | null;
  onWaiting?: (n: number) => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [flags, setFlags] = useState<Map<string, SafetyFlag[]>>(new Map());
  const [leads, setLeads] = useState<Map<string, Lead>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ bad: boolean; text: string } | null>(null);
  // "today" is the exception queue; "all" is every conversation, newest first. A mode
  // rather than a filter chip: the chips were three views none of which was the answer
  // to "what do I do this morning", and this way the default screen never has to be
  // chosen at all.
  const [mode, setMode] = useState<"today" | "all">("today");
  const [showCold, setShowCold] = useState(false);
  const [day, setDay] = useState<DayStats>({
    conversations: 0,
    afterHours: 0,
    booked: 0,
    replySeconds: null,
    known: false,
  });
  const [cursor, setCursor] = useState(-1);

  useNow();

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!orgId) return;
    void loadDay(orgId);
  }, [orgId]);

  async function load() {
    const { data, error } = await supabase
      .from("conversations")
      .select(
        "id,customer_wa_id,customer_name,handoff_state,last_message_at,window_expires_at,followed_up_at",
      )
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(LIST_LIMIT)
      .returns<Conversation[]>();

    // A failed read and a genuinely empty desk used to look identical. They are not:
    // a column this build expects but the database does not have renders as "nothing
    // here", which on this screen reads as "you're clear" — a worse lie than a blank
    // list, because it is an instruction to stop looking.
    setLoadError(error ? error.message : null);
    setConversations(data ?? []);

    const { data: open } = await supabase
      .from("safety_flags")
      .select("conversation_id,kind,detected_at")
      .is("resolved_at", null)
      .order("detected_at", { ascending: false })
      .returns<SafetyFlag[]>();

    const byConversation = new Map<string, SafetyFlag[]>();
    for (const f of open ?? []) {
      byConversation.set(f.conversation_id, [...(byConversation.get(f.conversation_id) ?? []), f]);
    }
    setFlags(byConversation);

    // Only for the rows on screen. Reading every lead to label fifty conversations is
    // the kind of query the egress budget dies to.
    setLeads(await leadsFor((data ?? []).map((c) => c.id)));
  }

  /** Today only. Counted in Postgres for the same reason Flowin's numbers are. */
  async function loadDay(id: string) {
    const today = istToday();
    const [daily, speed, booked] = await Promise.all([
      supabase.rpc("pulse_daily", { p_org_id: id, p_days: 1 }),
      supabase.rpc("pulse_reply_seconds", { p_org_id: id, p_days: 1 }),
      // head + exact: the count comes back in a header and not one appointment row is
      // sent over the wire.
      supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("org_id", id)
        .eq("kind", "appointment")
        .neq("status", "cancelled")
        .gte("starts_at", istMidnight(today))
        .lt("starts_at", istMidnight(shiftDay(today, 1))),
    ]);
    if (daily.error) return;
    const row = (daily.data ?? [])[0];
    setDay({
      conversations: Number(row?.conversations ?? 0),
      afterHours: Number(row?.after_hours ?? 0),
      booked: booked.count ?? 0,
      replySeconds: speed.data === null ? null : Number(speed.data),
      known: true,
    });
  }

  // Search can land on a conversation older than the fifty this list holds, so a hit
  // that is not already loaded is fetched on its own and put at the top. Without this
  // the box finds a six-month-old customer and then opens nothing.
  useEffect(() => {
    if (!jumpTo) return;
    setOpenId(jumpTo);
    if (conversations.some((c) => c.id === jumpTo)) return;

    void (async () => {
      const { data } = await supabase
        .from("conversations")
        .select(
          "id,customer_wa_id,customer_name,handoff_state,last_message_at,window_expires_at,followed_up_at",
        )
        .eq("id", jumpTo)
        .returns<Conversation[]>();
      if (!data?.[0]) return;
      const lead = await leadsFor([jumpTo]);
      setConversations((prev) => [data[0]!, ...prev.filter((c) => c.id !== jumpTo)]);
      setLeads((prev) => new Map([...prev, ...lead]));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  const open = conversations.find((c) => c.id === openId) ?? null;

  /** Somebody asked for something and nobody has called them back. */
  function owed(c: Conversation): boolean {
    return leads.has(c.id) && c.followed_up_at === null;
  }

  function cold(c: Conversation): boolean {
    const at = c.last_message_at ? Date.parse(c.last_message_at) : 0;
    return Date.now() - at > COLD_MS;
  }

  const byRecency = (a: Conversation, b: Conversation) =>
    (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "");

  // Sorted by how long is left to reply, not by who spoke last. Meta closes the free
  // window 24h after the customer's last message; after that the only way to answer is
  // a paid template the client has to have approved in advance. So the conversation
  // about to close outranks the one that arrived most recently, which is the opposite
  // of what a chat app does — and the reason this is not a chat app.
  const waiting = conversations
    .filter((c) => attention(c, flags.get(c.id) ?? []))
    .sort((a, b) => {
      const ra = attention(a, flags.get(a.id) ?? [])!.rank;
      const rb = attention(b, flags.get(b.id) ?? [])!.rank;
      if (ra !== rb) return ra - rb;
      return (a.window_expires_at ?? "9999").localeCompare(b.window_expires_at ?? "9999");
    });

  const waitingIds = new Set(waiting.map((c) => c.id));
  const callable = conversations.filter((c) => owed(c) && !waitingIds.has(c.id));
  const callToday = callable.filter((c) => !cold(c)).sort(byRecency);
  const callCold = callable.filter(cold).sort(byRecency);

  const queued = new Set([...waitingIds, ...callable.map((c) => c.id)]);

  useEffect(() => {
    onWaiting?.(waiting.length);
  }, [waiting.length, onWaiting]);

  // What j/k walk, in the order they are painted. Collapsed groups are not in it,
  // because arrowing into something invisible is how a keyboard shortcut loses trust.
  const everything = [...conversations].sort(byRecency);
  const visible =
    mode === "all"
      ? everything
      : [...waiting, ...callToday, ...(showCold ? callCold : [])];
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      // Never steal a keystroke from the reply box. "j" is a letter before it is a
      // shortcut.
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const rows = visibleRef.current;
      if (e.key === "j" || e.key === "k") {
        if (rows.length === 0) return;
        e.preventDefault();
        setCursor((i) => Math.max(0, Math.min(rows.length - 1, e.key === "j" ? i + 1 : i - 1)));
      } else if (e.key === "Enter") {
        const row = rows[cursor];
        if (row) {
          e.preventDefault();
          setOpenId(row.id);
        }
      } else if (e.key === "Escape") {
        setOpenId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor]);

  async function exportCsv() {
    setExporting(true);
    setExportNote(null);
    const result = await downloadLeadsCsv();
    setExportNote(
      result.ok
        ? result.rows === 0
          ? {
              bad: false,
              text: "Nothing to export yet — the assistant has not recorded any enquiries.",
            }
          : { bad: false, text: `Saved ${result.rows} ${result.rows === 1 ? "enquiry" : "enquiries"}.` }
        : { bad: true, text: `Export failed: ${result.error}` },
    );
    setExporting(false);
  }

  const flagged = waiting.filter((c) => (flags.get(c.id)?.length ?? 0) > 0);

  // Two lines, not one: the first says what state the day is in, the second says what
  // that means for the person reading. "All clear." on its own invites a second look to
  // check it really means nothing.
  const [head, sub] = loadError
    ? (["Something is wrong.", "The desk could not be loaded."] as const)
    : waiting.length > 0
      ? ([
          `${waiting.length} ${waiting.length === 1 ? "person is" : "people are"} waiting.`,
          callToday.length > 0
            ? `And ${callToday.length} ${callToday.length === 1 ? "call" : "calls"} to make.`
            : "Nothing else needs you.",
        ] as const)
      : callToday.length > 0
        ? ([
            "All clear.",
            `Nobody is waiting. ${callToday.length} ${callToday.length === 1 ? "call" : "calls"} to make.`,
          ] as const)
        : (["All clear.", "Nothing needs you."] as const);

  function pick(c: Conversation) {
    setOpenId(c.id);
    setCursor(visible.findIndex((v) => v.id === c.id));
  }

  function rowFor(c: Conversation, opts: { callable?: boolean; deadline?: boolean; dim?: boolean }) {
    const reason = attention(c, flags.get(c.id) ?? [])?.label;
    const left = windowLeft(c.window_expires_at);
    return (
      <Row
        key={c.id}
        c={c}
        // The intent is what the owner is scanning for; the reason the assistant stopped
        // is the fallback, not a second label competing with it on the same row.
        sub={leads.get(c.id)?.intent ?? reason ?? null}
        right={opts.deadline && left ? left.text : ist(c.last_message_at)}
        urgent={Boolean(opts.deadline && left?.urgent)}
        flags={flags.get(c.id) ?? []}
        callable={opts.callable ?? false}
        dim={opts.dim ?? false}
        active={c.id === openId}
        cued={visible[cursor]?.id === c.id}
        onPick={() => pick(c)}
      />
    );
  }

  return (
    <div className="flex h-full">
      {/* One pane at a time on a phone, both side by side from `md`. */}
      <aside
        className={cn(
          "w-full shrink-0 overflow-y-auto overscroll-contain border-border px-3 pb-8 md:w-[21rem] md:border-r",
          open && "hidden md:block",
        )}
      >
        <header className="px-3 pb-5 pt-8">
          {mode === "all" ? (
            <>
              <button
                onClick={() => setMode("today")}
                className="mb-2 text-[13px] text-blue-600"
              >
                ← Today
              </button>
              <h1 className="text-[28px] font-semibold leading-none tracking-tight">
                All conversations
              </h1>
              <p className="mt-3 text-[15px] text-muted-foreground">
                The {conversations.length} most recent, newest first.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-[28px] font-semibold leading-none tracking-tight">Today</h1>
              <p className={cn("mt-3 text-[15px] font-medium", loadError && "text-destructive")}>
                {head}
              </p>
              <p className="text-[15px] text-muted-foreground">{sub}</p>
            </>
          )}
        </header>

        {loadError && (
          <p className="mx-3 mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {loadError}
          </p>
        )}

        {/* Inset and rounded rather than a full-bleed band. A flag has to be impossible
            to miss, but a scarlet slab across the whole app makes the app look broken
            rather than making one conversation look urgent. */}
        {flagged.length > 0 && (
          <button
            onClick={() => pick(flagged[0]!)}
            className="mb-5 block w-full rounded-xl bg-destructive px-4 py-3.5 text-left text-destructive-foreground"
          >
            <div className="text-[15px] font-semibold">
              {flagged.length === 1
                ? `${customerLabel(flagged[0]!)} needs a person.`
                : `${flagged.length} conversations need a person.`}
            </div>
            <div className="mt-0.5 text-[13px] opacity-90">
              The assistant has stopped replying. Open →
            </div>
          </button>
        )}

        {mode === "all" ? (
          everything.map((c) => rowFor(c, { dim: !queued.has(c.id) }))
        ) : (
          <>
            {waiting.length > 0 && (
              <Group title="Waiting on you">
                {waiting.map((c) => rowFor(c, { deadline: true }))}
              </Group>
            )}

            {callToday.length > 0 && (
              <Group title="Call today">
                {callToday.map((c) => rowFor(c, { callable: true }))}
              </Group>
            )}

            {/* Aged out rather than deleted. Thirty cold callbacks at the top of a list is
                why people stop reading the list. */}
            {callCold.length > 0 && (
              <div className="px-3 pt-1 text-[13px] leading-relaxed text-muted-foreground">
                {callCold.length} {callCold.length === 1 ? "callback has" : "callbacks have"} gone
                quiet for over a week.{" "}
                <button onClick={() => setShowCold((v) => !v)} className="text-blue-600">
                  {showCold ? "Hide" : "Review"}
                </button>
                {showCold && (
                  <div className="-mx-3 mt-2">
                    {callCold.map((c) => rowFor(c, { callable: true, dim: true }))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {!loadError && conversations.length === 0 && (
          <p className="px-3 pt-4 text-[13px] text-muted-foreground">
            Nothing yet. The first message will land here.
          </p>
        )}

        {/* The way out of the exception queue. It is a link and not a tab because it is
            the answer to an occasional question — "what did it say to everyone else" —
            and not one of the day's jobs. */}
        {mode === "today" && conversations.length > 0 && (
          <button
            onClick={() => setMode("all")}
            className="mt-5 block px-3 text-[13px] text-blue-600"
          >
            See all {conversations.length} conversations →
          </button>
        )}
      </aside>

      {open ? (
        <Thread
          conversation={open}
          flags={flags.get(open.id) ?? []}
          lead={leads.get(open.id) ?? null}
          isOwner={isOwner}
          onBack={() => setOpenId(null)}
          onChanged={load}
        />
      ) : (
        <div className="hidden min-w-0 flex-1 overflow-y-auto md:block">
          <div className="max-w-2xl px-10 py-10">
            <h2 className="text-[22px] font-semibold tracking-tight">The assistant&apos;s day</h2>
            <p className="mt-1 text-[15px] text-muted-foreground">Today so far, without you.</p>

            <div className="mt-9 grid grid-cols-2 gap-x-8 gap-y-8">
              <Stat n={day.known ? String(day.conversations) : "—"} label="enquiries answered" />
              <Stat n={day.known ? String(day.booked) : "—"} label="appointments booked" />
              <Stat n={day.known ? String(day.afterHours) : "—"} label="answered after hours" />
              <Stat n={replyText(day.replySeconds)} label="typical reply" />
            </div>

            {day.known && (
              <>
                <hr className="my-8 border-border" />
                <p className="max-w-lg text-[15px] leading-relaxed text-muted-foreground">
                  {sentence(day)}
                </p>
              </>
            )}

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={exporting}
                onClick={() => void exportCsv()}
              >
                {exporting ? "Exporting…" : "Export enquiries"}
              </Button>
              <span className="text-[12px] text-muted-foreground">
                <Kbd>J</Kbd> <Kbd>K</Kbd> to move · <Kbd>↩</Kbd> open · <Kbd>esc</Kbd> back
              </span>
            </div>

            {exportNote && (
              <p
                className={cn(
                  "mt-3 text-[13px]",
                  exportNote.bad ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {exportNote.text}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function replyText(seconds: number | null): string {
  if (seconds === null) return "—";
  return seconds < 60 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)}m`;
}

/** The numbers again, in the sentence the owner would say to someone else. */
function sentence(day: DayStats): string {
  const speed =
    day.replySeconds === null
      ? "The assistant answered every enquiry"
      : day.replySeconds < 60
        ? `A typical reply took ${Math.round(day.replySeconds)} seconds`
        : `A typical reply took ${Math.round(day.replySeconds / 60)} minutes`;

  if (day.afterHours === 0) return `${speed}, all of it inside your opening hours.`;
  return `${speed}, and ${day.afterHours} ${
    day.afterHours === 1 ? "answer went out" : "answers went out"
  } after you had closed for the day.`;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="px-3 pb-1.5 text-[13px] text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div>
      <div className="text-[38px] font-semibold leading-none tracking-tight tabular-nums">{n}</div>
      <div className="mt-2 text-[13px] text-muted-foreground">{label}</div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1 font-sans text-[11px]">
      {children}
    </kbd>
  );
}

function Row({
  c,
  sub,
  right,
  urgent,
  flags,
  callable,
  dim,
  active,
  cued,
  onPick,
}: {
  c: Conversation;
  sub: string | null;
  right: string;
  urgent: boolean;
  flags: SafetyFlag[];
  callable: boolean;
  dim: boolean;
  active: boolean;
  cued: boolean;
  onPick: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-lg px-3 py-2.5",
        active ? "bg-black/[0.06]" : cued ? "bg-black/[0.03]" : "hover:bg-black/[0.03]",
      )}
    >
      <button onClick={onPick} className="block w-full text-left">
        <div className="flex items-baseline justify-between gap-3">
          <span className={cn("truncate text-[15px] font-medium", dim && "text-muted-foreground")}>
            {customerLabel(c)}
          </span>
          <span
            className={cn(
              "shrink-0 text-[13px] tabular-nums",
              urgent ? "font-medium text-destructive" : "text-muted-foreground",
            )}
          >
            {right}
          </span>
        </div>
        {sub && <div className="mt-0.5 truncate text-[13px] text-muted-foreground">{sub}</div>}
        {flags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[...new Set(flags.map((f) => f.kind))].map((kind) => (
              <span
                key={kind}
                className="rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground"
              >
                {SAFETY_LABEL[kind]}
              </span>
            ))}
          </div>
        )}
      </button>

      {/* A phone number is the whole point of a callback row, so it is a real link and
          not a decoration that opens the chat you were already looking at. */}
      {callable && (
        <a
          href={`tel:+${c.customer_wa_id}`}
          className="mt-1.5 inline-block rounded-md border border-border px-2 py-0.5 text-[12px] font-medium hover:bg-background"
        >
          Call
        </a>
      )}
    </div>
  );
}
