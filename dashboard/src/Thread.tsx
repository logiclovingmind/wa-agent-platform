import { useEffect, useRef, useState } from "react";
import {
  SAFETY_LABEL,
  supabase,
  type Conversation,
  type Message,
  type SafetyFlag,
} from "./lib/supabase";
import Attachment, { useSignedUrls } from "./Attachment";
import { release, reply, takeover } from "./lib/api";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { cn, ist, useNow, windowLeft } from "./lib/utils";

/** Invariant 7. Also the egress budget: a thousand-message thread is 5GB in a few opens. */
const PAGE = 20;
const COLUMNS = "id,direction,body,type,media_key,created_at,status";

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

export default function Thread({
  conversation,
  flags,
  onChanged,
}: {
  conversation: Conversation;
  flags: SafetyFlag[];
  onChanged: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Conversation["handoff_state"] | null>(null);
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
          const row = payload.new as Message;
          setMessages((prev) => merge(prev, [row]));
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
  }, [id]);

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

  async function send() {
    const body = draft.trim();
    if (!body) return;
    await act(async () => {
      await reply(id, body);
      setDraft("");
    });
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-medium">{conversation.customer_wa_id}</div>
          <div className="text-xs text-muted-foreground">
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
      </header>

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

      {left?.closed && (
        <div className="border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground">
          The 24-hour window has closed. Meta rejects an ordinary reply now — only an
          approved template can reach this customer, and Meta charges for it.
        </div>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
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
