import { useEffect, useRef, useState } from "react";
import { supabase, type Conversation, type Message } from "./lib/supabase";
import { release, reply, takeover } from "./lib/api";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { cn, ist } from "./lib/utils";

/** Invariant 7. Also the egress budget: a thousand-message thread is 5GB in a few opens. */
const PAGE = 20;
const COLUMNS = "id,direction,body,created_at,status";

export default function Thread({
  conversation,
  onChanged,
}: {
  conversation: Conversation;
  onChanged: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [more, setMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const id = conversation.id;
  const human = conversation.handoff_state === "human";

  useEffect(() => {
    setMessages([]);
    setMore(false);
    void page(null);

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
          setMessages((prev) => {
            const i = prev.findIndex((m) => m.id === row.id);
            if (i === -1) return [...prev, row];
            const next = [...prev];
            next[i] = row;
            return next;
          });
        },
      )
      .subscribe();

    const drop = () => void supabase.removeChannel(channel);
    // Closing the tab does not always run cleanup, and the free tier counts the socket.
    window.addEventListener("pagehide", drop);
    return () => {
      window.removeEventListener("pagehide", drop);
      drop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    bottom.current?.scrollIntoView();
  }, [messages.length]);

  async function page(before: string | null) {
    let q = supabase
      .from("messages")
      .select(COLUMNS)
      .eq("conversation_id", id)
      .order("created_at", { ascending: false })
      .limit(PAGE);
    if (before) q = q.lt("created_at", before);

    const { data } = await q.returns<Message[]>();
    const rows = (data ?? []).reverse();
    setMore((data ?? []).length === PAGE);
    setMessages((prev) => [...rows, ...prev]);
  }

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
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
            {conversation.window_expires_at &&
              ` · window closes ${ist(conversation.window_expires_at)}`}
          </div>
        </div>
        {human ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => act(() => release(id))}>
            Hand back to bot
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => act(() => takeover(id))}>
            Take over
          </Button>
        )}
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {more && (
          <div className="text-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => page(messages[0]?.created_at ?? null)}
            >
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
            <div className="whitespace-pre-wrap">{m.body}</div>
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
            disabled={!human || busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={human ? "Reply as yourself" : "Take over to reply"}
          />
          <Button disabled={!human || busy || draft.trim() === ""} onClick={send}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
