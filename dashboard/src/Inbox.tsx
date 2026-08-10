import { useEffect, useState } from "react";
import { supabase, type Conversation } from "./lib/supabase";
import { Button } from "./components/ui/button";
import { cn, ist } from "./lib/utils";
import Thread from "./Thread";

const LIST_LIMIT = 50;

export default function Inbox() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const { data } = await supabase
      .from("conversations")
      .select("id,customer_wa_id,handoff_state,last_message_at,window_expires_at")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(LIST_LIMIT)
      .returns<Conversation[]>();
    setConversations(data ?? []);
  }

  const open = conversations.find((c) => c.id === openId) ?? null;

  return (
    <div className="flex h-screen">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-border">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold">Conversations</span>
          <Button variant="ghost" size="sm" onClick={() => supabase.auth.signOut()}>
            Sign out
          </Button>
        </header>
        {conversations.map((c) => (
          <button
            key={c.id}
            onClick={() => setOpenId(c.id)}
            className={cn(
              "block w-full border-b border-border px-4 py-3 text-left text-sm",
              c.id === openId && "bg-muted",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{c.customer_wa_id}</span>
              {c.handoff_state !== "bot" && (
                <span className="text-xs text-muted-foreground">{c.handoff_state}</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">{ist(c.last_message_at)}</div>
          </button>
        ))}
        {conversations.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">Nothing yet.</p>
        )}
      </aside>

      {open ? (
        <Thread conversation={open} onChanged={load} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Pick a conversation.
        </div>
      )}
    </div>
  );
}
