import { useEffect, useState } from "react";
import {
  SAFETY_LABEL,
  customerLabel,
  supabase,
  type Conversation,
  type Lead,
  type SafetyFlag,
} from "./lib/supabase";
import { Button } from "./components/ui/button";
import { cn, ist, useNow, windowLeft } from "./lib/utils";
import { downloadLeadsCsv, leadsFor } from "./lib/leads";
import Thread from "./Thread";

const LIST_LIMIT = 50;

/**
 * Why a conversation is waiting on a person, or null if it is not. Ordered: a safety
 * flag outranks everything, then a customer who asked for a human, then one the owner
 * already took over and has not handed back.
 */
const ATTENTION = [
  { rank: 0, label: "flagged", match: (_c: Conversation, f: SafetyFlag[]) => f.length > 0 },
  { rank: 1, label: "asked for a human", match: (c: Conversation) => c.handoff_state === "requested" },
  { rank: 2, label: "you are replying", match: (c: Conversation) => c.handoff_state === "human" },
] as const;

function attention(c: Conversation, f: SafetyFlag[]) {
  return ATTENTION.find((a) => a.match(c, f)) ?? null;
}

type Filter = "waiting" | "callback" | "all";

/**
 * One list, not two. The Leads tab was the same rows with different columns, and keeping
 * it separate meant an owner had to check two screens to answer one question — who do I
 * deal with this morning. What the assistant learned rides on the row it came from, and
 * the spreadsheet an owner actually works from is the export, not a grid on screen.
 */
export default function Inbox({ isOwner, jumpTo }: { isOwner: boolean; jumpTo: string | null }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [flags, setFlags] = useState<Map<string, SafetyFlag[]>>(new Map());
  const [leads, setLeads] = useState<Map<string, Lead>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useNow();

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const { data, error } = await supabase
      .from("conversations")
      .select(
        "id,customer_wa_id,customer_name,handoff_state,last_message_at,window_expires_at,followed_up_at",
      )
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(LIST_LIMIT)
      .returns<Conversation[]>();

    // A failed read and a genuinely empty inbox used to look identical. They are not:
    // a column this build expects but the database does not have renders as "nothing
    // here", which reads as lost data.
    setLoadError(error ? error.message : null);
    setConversations(data ?? []);

    // Unresolved only. A flag is why the bot stopped talking, so the list has to show
    // it — otherwise a conversation waiting on a human looks like any other.
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

  const byRecency = (a: Conversation, b: Conversation) =>
    (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "");

  // Waiting conversations first, and within them the most urgent reason first.
  const ranked = [...conversations].sort((a, b) => {
    const ra = attention(a, flags.get(a.id) ?? [])?.rank ?? ATTENTION.length;
    const rb = attention(b, flags.get(b.id) ?? [])?.rank ?? ATTENTION.length;
    if (ra !== rb) return ra - rb;
    return byRecency(a, b);
  });

  // "All" is the tab you watch a live conversation in, so it sorts by recency alone.
  // Ranking it too meant every flagged thread outranked the message that just arrived —
  // during a demo the reply landed below nine older flags and looked like it never came.
  // The urgency ordering still exists; it belongs to the tab that promises it.
  const recent = [...conversations].sort(byRecency);

  const waitingCount = conversations.filter((c) => attention(c, flags.get(c.id) ?? [])).length;
  const callbackCount = conversations.filter(owed).length;
  const listed =
    filter === "waiting"
      ? ranked.filter((c) => attention(c, flags.get(c.id) ?? []))
      : filter === "callback"
        ? ranked.filter(owed)
        : recent;

  async function exportCsv() {
    setExporting(true);
    setLoadError(await downloadLeadsCsv());
    setExporting(false);
  }

  return (
    <div className="flex h-full">
      {/* One pane at a time on a phone, both side by side from `md`. A 320px list next
          to a thread is two columns fighting over a 390px screen; the list is the
          screen until a conversation is picked, and then the thread is. */}
      <aside
        className={cn(
          "w-full shrink-0 overflow-y-auto overscroll-contain border-border md:w-80 md:border-r",
          open && "hidden md:block",
        )}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold">Conversations</span>
          <Button variant="ghost" size="sm" disabled={exporting} onClick={() => void exportCsv()}>
            Export
          </Button>
        </header>

        <div className="flex gap-1 border-b border-border px-3 py-2">
          <Chip active={filter === "waiting"} onClick={() => setFilter("waiting")}>
            Needs you {waitingCount > 0 && `(${waitingCount})`}
          </Chip>
          <Chip active={filter === "callback"} onClick={() => setFilter("callback")}>
            To call {callbackCount > 0 && `(${callbackCount})`}
          </Chip>
          <Chip active={filter === "all"} onClick={() => setFilter("all")}>
            All
          </Chip>
        </div>

        {loadError && (
          <p className="border-b border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
            Could not load conversations: {loadError}
          </p>
        )}

        {listed.map((c) => (
          <button
            key={c.id}
            onClick={() => setOpenId(c.id)}
            className={cn(
              "block w-full border-b border-border px-4 py-4 text-left text-sm md:py-3",
              c.id === openId && "bg-muted",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{customerLabel(c)}</span>
              {attention(c, flags.get(c.id) ?? []) && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {attention(c, flags.get(c.id) ?? [])!.label}
                </span>
              )}
            </div>

            {/* What they asked for, on the row, because that is what the owner is
                scanning this list to find. Blank means the conversation never got as
                far as saying — not that nothing was recorded. */}
            {leads.get(c.id)?.intent && (
              <div className="mt-0.5 truncate text-xs text-foreground/80">
                {leads.get(c.id)!.intent}
              </div>
            )}

            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{ist(c.last_message_at)}</span>
              {(() => {
                const left = windowLeft(c.window_expires_at);
                return left?.urgent ? (
                  <span className="font-medium text-destructive">{left.text}</span>
                ) : null;
              })()}
              {owed(c) && <span className="font-medium text-amber-600">to call</span>}
            </div>

            {(flags.get(c.id)?.length ?? 0) > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {[...new Set(flags.get(c.id)!.map((f) => f.kind))].map((kind) => (
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
        ))}
        {listed.length === 0 && !loadError && (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {filter === "waiting"
              ? "Nothing waiting on you."
              : filter === "callback"
                ? "Everyone has been called back."
                : "Nothing yet."}
          </p>
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
        <div className="hidden flex-1 items-center justify-center text-sm text-muted-foreground md:flex">
          Pick a conversation.
        </div>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button variant={active ? "default" : "ghost"} size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}
