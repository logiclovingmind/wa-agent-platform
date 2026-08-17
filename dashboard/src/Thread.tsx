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
import { erase, exportConversation, release, reply, takeover } from "./lib/api";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { cn, ist, useNow, windowLeft } from "./lib/utils";

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
function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
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
  // Held as the pretty-printed text the file would contain, so what is read on screen
  // and what lands on disk cannot drift apart.
  const [exported, setExported] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

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
  }, [id]);

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

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 shrink-0 md:hidden"
            onClick={onBack}
            aria-label="Back to conversations"
          >
            ←
          </Button>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{customerLabel(conversation)}</div>
            <div className="text-xs text-muted-foreground">
              {/* The number as well as the name here, unlike the list: this is where an
                  owner goes to look a customer up in their own records. */}
              {conversation.customer_name && <>+{conversation.customer_wa_id}{" · "}</>}
              {human ? "You are replying" : "Bot is replying"}
              {left && (
                <>
                  {" · "}
                  <span className={cn(left.urgent && "font-medium text-destructive")}>
                    {left.text}
                  </span>
                  {!left.closed && ` · closes ${ist(conversation.window_expires_at)}`}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Owner-only here because they are owner-only at the Worker; staff would get
              a 403 from a button that looked available. */}
          {isOwner &&
            (confirmErase ? (
              <>
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
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      // Shown rather than saved. This is the answer to a data-access
                      // request, and an owner is about to hand it to the customer who
                      // asked — being able to read it first is the point.
                      setExported(JSON.stringify(await exportConversation(id), null, 2));
                    })
                  }
                >
                  Export
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmErase(true)}
                >
                  Erase
                </Button>
              </>
            ))}
          {human ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => act(() => release(id), "bot")}
            >
              Hand back to bot
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => act(() => takeover(id), "human")}>
              Take over
            </Button>
          )}
        </div>
      </header>

      {exported !== null && (
        <div className="border-b border-border bg-muted/40 px-4 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="mr-auto text-xs uppercase tracking-wide text-muted-foreground">
              Everything held about this customer
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadJson(`conversation-${conversation.customer_wa_id}.json`, exported)
              }
            >
              Download
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setExported(null)}>
              Close
            </Button>
          </div>
          {/* Attachments are keys, not bytes, so this stays small enough to read and the
              export cannot pull the egress budget through the Worker. */}
          <pre className="max-h-72 overflow-auto rounded border border-border bg-background p-3 text-[11px] leading-relaxed">
            {exported}
          </pre>
        </div>
      )}

      {confirmErase && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs">
          {flags.length > 0
            ? "This conversation is flagged. Message content goes; the flag, timestamps and message ids stay, because they are the proof the system responded correctly."
            : "Every message in this conversation is deleted, along with any stored attachments. This cannot be undone."}
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
      {lead && (
        <div className="border-b border-border px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              What they told the assistant
            </span>
            {conversation.followed_up_at ? (
              <span className="text-xs text-muted-foreground">
                called back {ist(conversation.followed_up_at)}
              </span>
            ) : (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void followUp()}>
                Mark called back
              </Button>
            )}
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Learned label="Name given" value={lead.name} />
            <Learned label="Wants" value={lead.intent} />
            <Learned label="When" value={lead.timeframe} />
            <Learned label="Budget" value={lead.budget} />
            <Learned label="Notes" value={lead.notes} />
          </dl>
        </div>
      )}

      {left?.closed && (
        <div className="border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground">
          The 24-hour window has closed. Meta rejects an ordinary reply now — only an
          approved template can reach this customer, and Meta charges for it.
        </div>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto overscroll-contain px-4 py-4">
        {more && (
          <div className="text-center">
            <Button variant="ghost" size="sm" onClick={loadOlder}>
              Load older
            </Button>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={cn(
              "max-w-[70%] rounded-md px-3 py-2 text-sm",
              m.direction === "inbound"
                ? "bg-muted"
                : "ml-auto bg-primary text-primary-foreground",
            )}
          >
            {m.type !== "text" && (
              <div className="mb-1">
                <Attachment
                  message={m}
                  url={m.media_key ? mediaUrls.get(m.media_key) : undefined}
                />
                {/* Read off the row, never inferred from the type: an image whose
                    classification failed is as unscreened as a voice note, and a badge
                    that guessed would call it checked. Inbound only — an outbound
                    attachment is something we sent. */}
                {m.direction === "inbound" && !m.safety_screened && (
                  <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-amber-600">
                    Not screened — read it yourself
                  </div>
                )}
              </div>
            )}
            {m.body && <div className="whitespace-pre-wrap">{m.body}</div>}
            <div className="mt-1 text-[10px] opacity-60">
              {ist(m.created_at)}
              {m.direction === "outbound" && m.status ? ` · ${m.status}` : ""}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div className="border-t border-border p-3">
        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Textarea
            rows={2}
            value={draft}
            disabled={!human || busy || left?.closed === true}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              left?.closed
                ? "Window closed — needs a template"
                : human
                  ? "Reply as yourself"
                  : "Take over to reply"
            }
          />
          <Button
            disabled={!human || busy || draft.trim() === "" || left?.closed === true}
            onClick={send}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
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
