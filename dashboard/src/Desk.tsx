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
import { Count, Empty, Group, Stat, TabButton } from "./components/screen";
import { cn, ist, istToday, shiftDay, useNow, windowLeft } from "./lib/utils";
import { downloadLeadsCsv, leadsFor } from "./lib/leads";
import { setAiPaused } from "./lib/api";
import Thread from "./Thread";

/** The "All" tab only. The queue is not built from this list — see `desk_queue`. */
const LIST_LIMIT = 50;

/** A callback nobody made in a week is not today's work. It stays reachable, but it
 *  stops competing with the person who messaged an hour ago. */
const COLD_MS = 7 * 24 * 60 * 60 * 1000;

/** One exchange moves a conversation row several times — inbound, handoff, reply, window —
 *  and each move is its own event. Waiting for the burst to settle turns a two-second
 *  conversation into one re-read of the queue instead of four. */
const DESK_SETTLE_MS = 400;

const istMidnight = (day: string) => `${day}T00:00:00+05:30`;

/**
 * A row of the queue as Postgres ranked it (migration 0036). The ranking used to be done
 * here, over the fifty most recent conversations, which meant a callback owed from last
 * week did not exist as far as this screen was concerned.
 */
interface QueueRow extends Conversation {
  /** "flagged" | "asked for a person" | "you are replying" | "never called back" */
  reason: string;
  /** 0–2 are waiting on a person, 3 is a callback owed. */
  rank: number;
  flag_kinds: SafetyFlag["kind"][];
  intent: string | null;
}

type Tab = "today" | "waiting" | "flagged" | "all";

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
 * Almost nothing here is boxed or ruled. Hierarchy comes from type size and white space,
 * because a border around every group is what made the old screen read as cluttered when
 * the number of things on it had not actually changed.
 */
export default function Desk({
  orgId,
  isOwner,
  jumpTo,
  homeSignal,
  onWaiting,
}: {
  orgId: string;
  isOwner: boolean;
  jumpTo: string | null;
  /** Bumped every time the Desk tab is clicked — see the effect that closes the thread. */
  homeSignal: number;
  onWaiting?: (n: number) => void;
}) {
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [flags, setFlags] = useState<Map<string, SafetyFlag[]>>(new Map());
  const [leads, setLeads] = useState<Map<string, Lead>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ bad: boolean; text: string } | null>(null);
  // One list, sorted four ways, rather than a red slab shouting over the top of it. The
  // flag used to be a full-bleed scarlet banner: impossible to miss on the first morning
  // and impossible to get rid of on the fifth, which is how an alert becomes wallpaper.
  // As a tab it keeps a red dot — present but not shouting — and the warning appears
  // when the owner goes to read it.
  const [tab, setTab] = useState<Tab>("today");
  const [showCold, setShowCold] = useState(false);
  const [day, setDay] = useState<DayStats>({
    conversations: 0,
    afterHours: 0,
    booked: 0,
    replySeconds: null,
    known: false,
  });
  const [cursor, setCursor] = useState(-1);
  // Null until the org row is read. Not `false`: an unknown state rendered as "the
  // assistant is answering" is the one wrong answer here, because it is the reassuring one.
  const [paused, setPaused] = useState<boolean | null>(null);
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);

  useNow();

  useEffect(() => {
    if (!orgId) return;
    void load();
    void loadDay(orgId);
    void loadPaused(orgId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function load() {
    // The queue itself, ranked and ordered in Postgres across every conversation the org
    // has. Doing this in the browser meant it was only ever true about the fifty rows
    // below, and on this screen a missing row reads as "nothing to do".
    const { data: queueData, error: queueError } = await supabase.rpc("desk_queue", {
      p_org_id: orgId,
    });
    const rows = (queueData ?? []) as QueueRow[];

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
    setLoadError(queueError?.message ?? error?.message ?? null);
    setQueue(rows);
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

    // Only for the rows that can be opened from here. The queue carries its own intent,
    // so this is for the thread panel — the detail, the "mark called back" action — and
    // not for the list.
    const ids = new Set([...rows.map((r) => r.id), ...(data ?? []).map((c) => c.id)]);
    setLeads(await leadsFor([...ids]));
  }

  /**
   * The desk, live. Every ranking on this screen — the queue order, who is waiting, how
   * long the window has left — is computed in Postgres by `desk_queue`, so an event is a
   * signal to re-read rather than a row to merge in. Merging the payload would leave the
   * list correct and the order wrong.
   *
   * Debounced because one customer message moves the row more than once: the inbound
   * write, then the reply, then the handoff state. Reloading three times for one exchange
   * is three times the egress for the same screen.
   */
  useEffect(() => {
    if (!orgId) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel(`desk:${orgId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations", filter: `org_id=eq.${orgId}` },
        () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            void load();
            void loadDay(orgId);
          }, DESK_SETTLE_MS);
        },
      )
      .subscribe();

    const drop = () => void supabase.removeChannel(channel);
    // Same as Thread: closing the tab does not reliably run cleanup, and this channel
    // shares the tab's one socket rather than opening a second.
    window.addEventListener("pagehide", drop);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", drop);
      drop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  /**
   * Read rather than written from here: `authenticated` may only update
   * `organizations.name`, so the switch goes through the Worker and this is the state it
   * reports back. Staff read it too — they need to know the assistant has stopped, even
   * though only an owner may stop it.
   */
  async function loadPaused(id: string) {
    const { data } = await supabase
      .from("organizations")
      .select("ai_paused")
      .eq("id", id)
      .maybeSingle<{ ai_paused: boolean }>();
    if (data) setPaused(data.ai_paused);
  }

  async function togglePause() {
    if (paused === null) return;
    setPausing(true);
    setPauseError(null);
    try {
      // The Worker's answer, not the value we hoped for: a failed write must not leave the
      // desk claiming the assistant is paused while it is still replying to customers.
      setPaused(await setAiPaused(!paused));
    } catch (e) {
      setPauseError(e instanceof Error ? e.message : "could not change it");
    } finally {
      setPausing(false);
    }
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
    if (conversations.some((c) => c.id === jumpTo) || queue.some((c) => c.id === jumpTo)) return;

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

  // Clicking Desk means "take me to the desk", but the screen stays mounted between tabs,
  // so a thread left open was still covering it and only Back or Escape got out. The tab
  // now closes it, which is what every other tab in this nav already does by being a
  // different screen.
  useEffect(() => {
    if (homeSignal) setOpenId(null);
  }, [homeSignal]);

  const open =
    queue.find((c) => c.id === openId) ?? conversations.find((c) => c.id === openId) ?? null;

  function cold(c: Conversation): boolean {
    const at = c.last_message_at ? Date.parse(c.last_message_at) : 0;
    return Date.now() - at > COLD_MS;
  }

  const byRecency = (a: Conversation, b: Conversation) =>
    (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "");

  // Already ordered by rank, then by how long is left to reply. Meta closes the free
  // window 24h after the customer's last message; after that the only way to answer is a
  // paid template the client has to have approved in advance. So the conversation about
  // to close outranks the one that arrived most recently, which is the opposite of what a
  // chat app does — and the reason this is not a chat app.
  const waiting = queue.filter((r) => r.rank < 3);
  const flagged = queue.filter((r) => r.flag_kinds.length > 0);
  const callable = queue.filter((r) => r.rank === 3);
  const callToday = callable.filter((c) => !cold(c));
  const callCold = callable.filter(cold);
  const everything = [...conversations].sort(byRecency);
  const queued = new Set(queue.map((r) => r.id));

  useEffect(() => {
    onWaiting?.(waiting.length);
  }, [waiting.length, onWaiting]);

  // What the arrow keys walk, in the order they are painted. Collapsed groups are not in
  // it, because arrowing into something invisible is how a keyboard shortcut loses trust.
  const visible: Conversation[] =
    tab === "all"
      ? everything
      : tab === "waiting"
        ? waiting
        : tab === "flagged"
          ? flagged
          : [...waiting, ...callToday, ...(showCold ? callCold : [])];
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      // Never steal a keystroke from the reply box.
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const rows = visibleRef.current;
      // Arrow keys, not j/k. j/k is a habit from one text editor, and half the people
      // who will ever use this are on Windows and have never met it.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (rows.length === 0) return;
        e.preventDefault();
        setCursor((i) =>
          Math.max(0, Math.min(rows.length - 1, e.key === "ArrowDown" ? i + 1 : i - 1)),
        );
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
    const row = c as Partial<QueueRow>;
    const left = windowLeft(c.window_expires_at);
    return (
      <Row
        key={c.id}
        c={c}
        // The intent is what the owner is scanning for; the reason the assistant stopped
        // is the fallback, not a second label competing with it on the same row.
        sub={leads.get(c.id)?.intent ?? row.intent ?? row.reason ?? null}
        right={opts.deadline && left ? left.text : ist(c.last_message_at)}
        urgent={Boolean(opts.deadline && left?.urgent)}
        kinds={row.flag_kinds ?? (flags.get(c.id) ?? []).map((f) => f.kind)}
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
        <header className="px-3 pb-4 pt-8">
          <h1 className="text-[28px] font-semibold leading-none tracking-tight">Today</h1>
          <p className={cn("mt-3 text-[15px] font-medium", loadError && "text-destructive")}>
            {head}
          </p>
          <p className="text-[15px] text-muted-foreground">{sub}</p>
        </header>

        {/* The sorts. "Today" is the day's work in the order to do it; the other three are
            one question each, which is what the owner asked for instead of being told. */}
        <div className="mb-4 flex gap-1 overflow-x-auto px-2 pb-1">
          <TabButton on={tab === "today"} onClick={() => setTab("today")}>
            Today
          </TabButton>
          <TabButton on={tab === "waiting"} onClick={() => setTab("waiting")}>
            Waiting {waiting.length > 0 && <Count>{waiting.length}</Count>}
          </TabButton>
          <TabButton on={tab === "flagged"} onClick={() => setTab("flagged")} dot={flagged.length > 0}>
            Flagged
          </TabButton>
          <TabButton on={tab === "all"} onClick={() => setTab("all")}>
            All
          </TabButton>
        </div>

        {loadError && (
          <p className="mx-3 mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {loadError}
          </p>
        )}

        {/* On every tab and on the phone too, not tucked into the day panel with the
            switch: a paused assistant is the reason the desk looks quiet, and an owner who
            cannot see that concludes the product is broken. */}
        {paused && (
          <div className="mx-1 mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[13px]">
            <p>
              <span className="font-semibold text-amber-600">The assistant is paused.</span>{" "}
              Every new message waits for a person. Nobody is told that — they simply get no
              reply until someone here sends one.
            </p>
          </div>
        )}

        {tab === "flagged" && (
          <div className="mx-1 mb-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-[13px]">
            {flagged.length === 0 ? (
              <p className="text-muted-foreground">
                Nothing flagged. The assistant is handling every conversation itself.
              </p>
            ) : (
              <p>
                <span className="font-semibold text-destructive">
                  The assistant has stopped replying{" "}
                  {flagged.length === 1 ? "here" : `in these ${flagged.length}`}.
                </span>{" "}
                It sent one acknowledgement and nothing since. Only a person can answer
                now, and the message content is deleted within 24 hours.
              </p>
            )}
          </div>
        )}

        {tab === "all" ? (
          everything.map((c) => rowFor(c, { dim: !queued.has(c.id) }))
        ) : tab === "waiting" ? (
          waiting.length > 0 ? (
            waiting.map((c) => rowFor(c, { deadline: true }))
          ) : (
            <Empty>Nobody is waiting on a person.</Empty>
          )
        ) : tab === "flagged" ? (
          flagged.map((c) => rowFor(c, { deadline: true }))
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
          <Empty>Nothing yet. The first message will land here.</Empty>
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

            <div className="mt-8">
              <Button
                variant="outline"
                size="sm"
                disabled={exporting}
                onClick={() => void exportCsv()}
              >
                {exporting ? "Exporting…" : "Export enquiries"}
              </Button>
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

            {/* Owner-only, matching the Worker: staff would get a 403 from a button that
                looked available. Below the day's numbers because it is the decision the
                numbers inform, and it is deliberately not a one-tap switch in the header —
                turning the assistant off for the whole business should take a moment. */}
            {isOwner && paused !== null && (
              <>
                <hr className="my-8 border-border" />
                <h3 className="text-[15px] font-medium">
                  {paused ? "You are answering everything" : "The assistant is answering"}
                </h3>
                <p className="mt-1 max-w-lg text-[15px] leading-relaxed text-muted-foreground">
                  {paused
                    ? "Every enquiry is waiting for a person, including the ones that arrive tonight. Nothing is lost — they queue on the left."
                    : "Pause it when you would rather reply yourself. It stops for the whole business, and everything that arrives waits on this desk until you send it."}
                </p>
                <div className="mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pausing}
                    onClick={() => void togglePause()}
                  >
                    {pausing
                      ? "Saving…"
                      : paused
                        ? "Let the assistant answer again"
                        : "Pause the assistant"}
                  </Button>
                </div>
                {pauseError && <p className="mt-3 text-[13px] text-destructive">{pauseError}</p>}
              </>
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

function Row({
  c,
  sub,
  right,
  urgent,
  kinds,
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
  kinds: SafetyFlag["kind"][];
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
      {/* `outline-none`: the browser's own focus ring drew a blue rectangle around the
          row that had just been clicked, which read as a second kind of selection beside
          the grey one and belonged to neither. The grey says which row is open. */}
      <button onClick={onPick} className="block w-full text-left outline-none">
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
        {kinds.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[...new Set(kinds)].map((kind) => (
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
