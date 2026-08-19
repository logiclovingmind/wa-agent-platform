import { useEffect, useRef, useState } from "react";
import {
  SAFETY_LABEL,
  customerLabel,
  supabase,
  type Conversation,
  type Lead,
  type Message,
  type SafetyFlag,
} from "./lib/supabase";
import Attachment, { useSignedUrls } from "./Attachment";
import {
  erase,
  exportConversation,
  release,
  reply,
  takeover,
  type ConversationExport,
} from "./lib/api";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { cn, ist, istDay, istTime, istToday, shiftDay, useNow, windowLeft } from "./lib/utils";

/** Invariant 7. Also the egress budget: a thousand-message thread is 5GB in a few opens. */
const PAGE = 20;
const COLUMNS = "id,direction,body,type,media_key,safety_screened,created_at,status";

/**
 * Keyed by id so the same row arriving twice collapses to one. StrictMode mounts the
 * effect twice in dev and Realtime can deliver a row the initial page also returns,
 * both of which rendered the thread duplicated before this existed.
 */
function merge(a: Message[], b: Message[]): Message[] {
  const byId = new Map(a.map((m) => [m.id, m]));
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.created_at.localeCompare(y.created_at));
}

/** Saves without a server round trip: the Worker already returned the whole export. */
function downloadJson(filename: string, payload: ConversationExport): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function Thread({
  conversation,
  flags,
  lead,
  isOwner,
  onBack,
  onChanged,
}: {
  conversation: Conversation;
  flags: SafetyFlag[];
  lead: Lead | null;
  isOwner: boolean;
  /** Closes the thread on a phone, where the list is not on screen beside it. */
  onBack: () => void;
  onChanged: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Conversation["handoff_state"] | null>(null);
  // Erasure is irreversible, so it takes two clicks. Cheaper than a dialog dependency.
  const [confirmErase, setConfirmErase] = useState(false);
  // Erasure rewrites the thread underneath us, and Realtime does not deliver deletes.
  const [reloadKey, setReloadKey] = useState(0);
  // Held as the payload itself, and both the screen and the downloaded file are rendered
  // from it, so what an owner reads and what they hand over cannot drift apart.
  const [exported, setExported] = useState<ConversationExport | null>(null);
  // The readable rendering is the one an owner shows a customer; the raw JSON is the
  // file they send. Both are needed, so the panel toggles rather than picking one.
  const [exportRaw, setExportRaw] = useState(false);
  // Everything that is not "call this person" lives behind one button. The header used
  // to carry four, which made the destructive one look like the others.
  const [menuOpen, setMenuOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useNow();
  const left = windowLeft(conversation.window_expires_at);
  const mediaUrls = useSignedUrls(messages);

  const id = conversation.id;
  // Takeover is a Worker round trip plus a list reload before the prop updates. Showing
  // the new state straight away is the difference between snappy and broken-feeling.
  const human = (optimistic ?? conversation.handoff_state) === "human";

  // The parent caught up, or a different conversation opened. Either way stop guessing.
  useEffect(() => setOptimistic(null), [conversation.handoff_state, id]);

  // An armed confirm must not survive switching customers, and neither must one
  // customer's export stay on screen above another customer's thread.
  useEffect(() => {
    setConfirmErase(false);
    setExported(null);
    setExportRaw(false);
    setMenuOpen(false);
  }, [id]);

  useEffect(() => {
    if (!menuOpen) return;
    function away(e: MouseEvent) {
      if (!menu.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [menuOpen]);

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setMore(false);

    void (async () => {
      const { rows, hasMore } = await fetchPage(null);
      // Without this, switching conversations while a fetch is in flight merges the
      // previous customer's messages into the thread that is now open.
      if (cancelled) return;
      setMessages((prev) => merge(prev, rows));
      setMore(hasMore);
    })();

    // Invariant 8: one subscription, for the conversation that is actually open.
    const channel = supabase
      .channel(`messages:${id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${id}`,
        },
        (payload) => {
          // A DELETE arrives with `new` set to `{}` — the row that no longer exists. It
          // used to be merged in anyway, and `merge` sorts on `created_at`, so the sort
          // read a property of undefined and threw inside the state updater. There is no
          // error boundary above this, so the whole dashboard went white and only a
          // reload brought it back. Erasing an unflagged conversation deletes its
          // messages, which is why it happened on every erase.
          const row = payload.new as Partial<Message>;
          if (!row.id || !row.created_at) return;
          setMessages((prev) => merge(prev, [row as Message]));
        },
      )
      .subscribe();

    const drop = () => void supabase.removeChannel(channel);
    // Closing the tab does not always run cleanup, and the free tier counts the socket.
    window.addEventListener("pagehide", drop);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", drop);
      drop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadKey]);

  useEffect(() => {
    bottom.current?.scrollIntoView();
  }, [messages.length]);

  async function fetchPage(before: string | null): Promise<{ rows: Message[]; hasMore: boolean }> {
    let q = supabase
      .from("messages")
      .select(COLUMNS)
      .eq("conversation_id", id)
      .order("created_at", { ascending: false })
      .limit(PAGE);
    if (before) q = q.lt("created_at", before);

    const { data } = await q.returns<Message[]>();
    return { rows: (data ?? []).slice().reverse(), hasMore: (data ?? []).length === PAGE };
  }

  async function loadOlder() {
    const { rows, hasMore } = await fetchPage(messages[0]?.created_at ?? null);
    setMessages((prev) => merge(prev, rows));
    setMore(hasMore);
  }

  async function act(fn: () => Promise<void>, expect?: Conversation["handoff_state"]) {
    setBusy(true);
    setError(null);
    if (expect) setOptimistic(expect);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setOptimistic(null);
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  /**
   * The one write the browser makes to `conversations`. It reaches Supabase directly
   * rather than the Worker because it touches neither Meta nor money — a column grant
   * on `followed_up_at` alone is what stops it being anything more (migration 0023).
   */
  async function followUp() {
    await act(async () => {
      const { error: err } = await supabase
        .from("conversations")
        .update({ followed_up_at: new Date().toISOString() })
        .eq("id", id);
      if (err) throw new Error(err.message);
    });
  }

  async function send() {
    const body = draft.trim();
    if (!body) return;
    await act(async () => {
      await reply(id, body);
      setDraft("");
    });
  }

  // What this customer wants, in the header, because that is what someone about to pick
  // up the phone needs in front of them. The number is the fallback, not the headline.
  const subtitle = [lead?.intent, lead?.timeframe, lead?.budget].filter(Boolean).join(" · ");
  const firstName = (conversation.customer_name ?? "").split(" ")[0] ?? "";

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-3 md:px-4">
        <div className="flex min-w-0 items-center gap-1">
          {/* Visible on desktop too. Once a conversation is open there was no way back to
              the day's numbers except a keystroke nobody had been told about. */}
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 px-2"
            onClick={onBack}
            aria-label="Back"
          >
            ←
          </Button>
          <div className="min-w-0">
            <div className="truncate text-[17px] font-semibold leading-tight">
              {customerLabel(conversation)}
            </div>
            <div className="mt-0.5 truncate text-[13px] text-muted-foreground">
              {subtitle || `+${conversation.customer_wa_id}`}
              {left?.urgent && (
                <span className="font-medium text-destructive"> · {left.text}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* The only action promoted out of the menu, because on a callback row it is
              the whole job. A real `tel:` link, not a button that reopens this screen. */}
          <a
            href={`tel:+${conversation.customer_wa_id}`}
            className="hidden rounded-md bg-emerald-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-emerald-700 sm:block"
          >
            Call +{conversation.customer_wa_id}
          </a>

          {/* Beside Call rather than inside the menu, because it is the second half of the
              same job: you ring them, you say you rang them. Buried under `···` it was two
              clicks behind a lid, and a callback nobody marks comes back tomorrow as work
              that looks undone. It disappears once marked — there is nothing to undo. */}
          {lead && !conversation.followed_up_at && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              className="hidden shrink-0 sm:block"
              onClick={() => void followUp()}
            >
              Mark called back
            </Button>
          )}

          <div ref={menu} className="relative">
            <Button
              variant="outline"
              size="sm"
              aria-label="More"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ···
            </Button>
            {menuOpen && (
              <div className="absolute right-0 top-9 z-20 w-72 overflow-hidden rounded-lg border border-border bg-background py-1 shadow-lg">
                <MenuItem
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    void act(
                      () => (human ? release(id) : takeover(id)),
                      human ? "bot" : "human",
                    );
                  }}
                >
                  {human ? "Hand back to the assistant" : "Take over this conversation"}
                </MenuItem>

                <MenuItem
                  onClick={() => {
                    void navigator.clipboard?.writeText(`+${conversation.customer_wa_id}`);
                    setMenuOpen(false);
                  }}
                >
                  Copy +{conversation.customer_wa_id}
                </MenuItem>

                {/* Owner-only here because they are owner-only at the Worker; staff would
                    get a 403 from a button that looked available. */}
                {isOwner && (
                  <>
                    <MenuItem
                      disabled={busy}
                      onClick={() => {
                        setMenuOpen(false);
                        // Shown rather than saved. This is the answer to a data-access
                        // request, and an owner is about to hand it to the customer who
                        // asked — being able to read it first is the point.
                        void act(async () => {
                          setExported(await exportConversation(id));
                        });
                      }}
                    >
                      Export everything held about this customer
                    </MenuItem>
                    <MenuItem
                      destructive
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirmErase(true);
                      }}
                    >
                      Erase permanently
                    </MenuItem>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {exported !== null && (
        <div className="border-b border-border bg-muted/40 px-4 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="mr-auto text-xs uppercase tracking-wide text-muted-foreground">
              Everything held about this customer: {exported.messages.length}{" "}
              {exported.messages.length === 1 ? "message" : "messages"}, taken{" "}
              {ist(exported.exported_at)}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setExportRaw(!exportRaw)}>
              {exportRaw ? "Readable" : "JSON"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadJson(`conversation-${conversation.customer_wa_id}.json`, exported)
              }
            >
              Download
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setExported(null);
                setExportRaw(false);
              }}
            >
              Close
            </Button>
          </div>

          {/* Attachments are keys, not bytes, so this stays small enough to read and the
              export cannot pull the egress budget through the Worker. */}
          {exportRaw ? (
            <pre className="max-h-72 overflow-auto rounded border border-border bg-background p-3 text-[11px] leading-relaxed">
              {JSON.stringify(exported, null, 2)}
            </pre>
          ) : (
            <div className="max-h-72 overflow-auto rounded border border-border bg-background text-[13px]">
              <dl className="grid gap-x-6 gap-y-1 border-b border-border p-3 sm:grid-cols-2">
                <Learned label="Phone" value={`+${exported.conversation.customer_wa_id}`} />
                <Learned label="Name" value={exported.conversation.customer_name} />
                <Learned label="First seen" value={ist(exported.conversation.created_at)} />
                <Learned
                  label="Last message"
                  value={ist(exported.conversation.last_message_at) || null}
                />
              </dl>
              <ol className="divide-y divide-border">
                {exported.messages.map((m, i) => (
                  <li key={m.wa_message_id ?? `${m.created_at}-${i}`} className="flex gap-3 p-3">
                    <span className="w-24 shrink-0 text-muted-foreground">
                      {ist(m.created_at)}
                    </span>
                    <span className="w-20 shrink-0 text-muted-foreground">
                      {m.direction === "inbound" ? "Customer" : "Business"}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                      {m.body || (
                        <span className="text-muted-foreground/70">
                          {m.media_key ? `${m.type}, ${m.media_key}` : m.type}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
              {exported.messages.length === 0 && (
                <p className="p-3 text-muted-foreground">No messages are held.</p>
              )}
            </div>
          )}
        </div>
      )}

      {confirmErase && (
        <div className="flex flex-wrap items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px]">
          <p className="min-w-0 flex-1">
            {flags.length > 0
              ? "This conversation is flagged. Message content goes; the flag, timestamps and message ids stay, because they are the proof the system responded correctly."
              : "Every message in this conversation is deleted, along with any stored attachments. This cannot be undone."}
          </p>
          <Button variant="ghost" size="sm" onClick={() => setConfirmErase(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() =>
              act(async () => {
                await erase(id);
                setConfirmErase(false);
                setReloadKey((n) => n + 1);
              })
            }
          >
            {flags.length > 0 ? "Erase content, keep the flag" : "Erase permanently"}
          </Button>
        </div>
      )}

      {flags.length > 0 && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {[...new Set(flags.map((f) => f.kind))].map((kind) => (
              <span
                key={kind}
                className="rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-destructive-foreground"
              >
                {SAFETY_LABEL[kind]}
              </span>
            ))}
            <span className="text-xs text-muted-foreground">
              flagged {ist(flags[0]!.detected_at)}
            </span>
          </div>
          <p className="mt-1.5 text-xs">
            {flags.some((f) => f.kind === "minor")
              ? "The AI has stopped. Involve a parent or guardian — do not ask the customer their age."
              : "The AI has stopped. This conversation needs a human reply."}{" "}
            Message content here is deleted within 24 hours.
          </p>
        </div>
      )}

      {/* What the assistant heard, next to the conversation it heard it in. There is no
          separate leads screen: this is the detail, the list is the worklist, and the
          CSV is the thing an owner actually files. */}
      {/* Collapsed by default. It is the same facts as the header subtitle, spelled out —
          worth one click when you need it, not worth a permanent panel between the name
          and the conversation. */}
      {lead && (
        <details className="border-b border-border px-4 py-2.5 text-[13px]">
          <summary className="cursor-pointer list-none text-muted-foreground marker:content-none">
            <span className="mr-1 inline-block text-[10px]">▸</span>
            {subtitle || "What they told the assistant"}
          </summary>
          <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <Learned label="Name given" value={lead.name} />
            <Learned label="Wants" value={lead.intent} />
            <Learned label="When" value={lead.timeframe} />
            <Learned label="Budget" value={lead.budget} />
            <Learned label="Notes" value={lead.notes} />
          </dl>
          <p className="mt-3 text-muted-foreground">
            {conversation.followed_up_at
              ? `Called back ${ist(conversation.followed_up_at)}.`
              : "Nobody has marked this one called back."}
          </p>
        </details>
      )}

      {/* The scroller is full width so the scrollbar sits at the window edge, but the
          reading measure is capped. On a wide desktop an uncapped thread stretches a
          chat bubble to a thousand pixels, which is unreadable in the literal sense —
          the eye loses the line it was on. */}
      <div className="flex-1 overflow-y-auto overscroll-contain bg-[#EFEAE2] px-4 py-4">
        <div className="mx-auto max-w-[680px] space-y-2">
        {more && (
          <div className="text-center">
            <Button variant="ghost" size="sm" onClick={loadOlder}>
              Load older
            </Button>
          </div>
        )}
        {messages.map((m, i) => {
          const inbound = m.direction === "inbound";
          // A day separator only where the day actually changes, so a thread that all
          // happened this morning gets one "Today" and not one per message.
          const prev = messages[i - 1];
          const newDay = !prev || istDay(prev.created_at) !== istDay(m.created_at);
          return (
            <div key={m.id}>
              {newDay && (
                <div className="py-3 text-center">
                  <span className="rounded-md bg-white/80 px-2 py-0.5 text-[12px] text-muted-foreground shadow-sm">
                    {dayLabel(m.created_at)}
                  </span>
                </div>
              )}
              <div className={cn("flex flex-col", inbound ? "items-start" : "items-end")}>
                {/* Timestamps sit outside the bubble. Inside, they were competing with the
                    message for the same block of colour. */}
                {/* WhatsApp's own colours, because this *is* WhatsApp — the customer is
                    reading these words in exactly those bubbles, and an owner comparing
                    the two screens should not have to work out which side is theirs. */}
                <div
                  className={cn(
                    "max-w-[78%] rounded-2xl px-3.5 py-2 text-[15px] leading-snug shadow-sm",
                    inbound ? "bg-white" : "bg-[#D9FDD3]",
                  )}
                >
                  {m.type !== "text" && (
                    <div className="mb-1">
                      <Attachment
                        message={m}
                        url={m.media_key ? mediaUrls.get(m.media_key) : undefined}
                      />
                      {/* Read off the row, never inferred from the type: an image whose
                          classification failed is as unscreened as a voice note, and a
                          badge that guessed would call it checked. Inbound only — an
                          outbound attachment is something we sent. */}
                      {inbound && !m.safety_screened && (
                        <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-amber-600">
                          Not screened, read it yourself
                        </div>
                      )}
                    </div>
                  )}
                  {m.body && <div className="whitespace-pre-wrap">{m.body}</div>}
                </div>
                <div className="mt-1 px-1 text-[11px] text-muted-foreground">
                  {istTime(m.created_at)}
                  {!inbound && m.status ? ` · ${m.status}` : ""}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
        </div>
      </div>

      {/* Who is holding the conversation is stated here rather than in the header,
          because this is where it changes what you can do. */}
      <div className="border-t border-border bg-muted/40 px-4 py-3">
        {error && <p className="mb-2 text-center text-[13px] text-destructive">{error}</p>}
        <p className="mb-2 text-center text-[13px] text-muted-foreground">
          {left?.closed
            ? "The 24-hour window has closed. Only an approved template can reach this customer now, and Meta charges for it."
            : human
              ? "You're replying. The assistant is paused."
              : "The assistant is replying."}
        </p>

        {human ? (
          <div className="mx-auto flex max-w-[680px] items-end gap-2">
            <Textarea
              rows={1}
              value={draft}
              disabled={busy || left?.closed === true}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={
                left?.closed ? "Window closed, this needs a template" : `Message ${firstName || "them"}`
              }
              className="min-h-10 resize-none rounded-xl bg-background"
            />
            <Button
              className="shrink-0 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={busy || draft.trim() === "" || left?.closed === true}
              onClick={send}
            >
              Send
            </Button>
          </div>
        ) : (
          <div className="flex justify-center">
            <Button
              disabled={busy || left?.closed === true}
              onClick={() => act(() => takeover(id), "human")}
            >
              Take over to reply
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function dayLabel(iso: string): string {
  const day = istDay(iso);
  const today = istToday();
  if (day === today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  return day;
}

function MenuItem({
  onClick,
  disabled,
  destructive,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "block w-full px-3 py-2 text-left text-[13px] hover:bg-muted disabled:opacity-50",
        destructive && "text-destructive",
      )}
    >
      {children}
    </button>
  );
}

/** Blank means the customer never said, which is worth showing as a gap rather than
 *  hiding as an absent row: the empty half of this list is what is still worth asking. */
function Learned({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={value ? "" : "text-muted-foreground/50"}>{value ?? "—"}</dd>
    </div>
  );
}
