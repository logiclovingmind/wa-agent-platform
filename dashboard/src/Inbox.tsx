import { useEffect, useState } from "react";
import {
  SAFETY_LABEL,
  customerLabel,
  supabase,
  type Conversation,
  type SafetyFlag,
} from "./lib/supabase";
import { Button } from "./components/ui/button";
import { cn, ist, useNow, windowLeft } from "./lib/utils";
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

export default function Inbox() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [flags, setFlags] = useState<Map<string, SafetyFlag[]>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useNow();

  useEffect(() => {
    void load();
    void loadRole();
  }, []);

  /**
   * Erase and export are 403 for staff at the Worker, which is the actual lock. This
   * only decides whether to render the buttons, so a stale answer hides a control or
   * shows one that fails — never a way in.
   */
  async function loadRole() {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    // Every row, not maybeSingle: a user in two orgs would make that error out and
    // silently downgrade an owner to staff.
    const { data } = await supabase
      .from("org_members")
      .select("role")
      .eq("user_id", auth.user.id)
      .returns<{ role: string }[]>();
    setIsOwner((data ?? []).some((m) => m.role === "owner"));
  }

  async function load() {
    const { data, error } = await supabase
      .from("conversations")
      .select("id,customer_wa_id,handoff_state,last_message_at,window_expires_at")
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
  }

  const open = conversations.find((c) => c.id === openId) ?? null;

  // Waiting conversations first, and within them the most urgent reason first. Sorting
  // rather than only filtering, so the default view is already useful.
  const ranked = [...conversations].sort((a, b) => {
    const ra = attention(a, flags.get(a.id) ?? [])?.rank ?? ATTENTION.length;
    const rb = attention(b, flags.get(b.id) ?? [])?.rank ?? ATTENTION.length;
    if (ra !== rb) return ra - rb;
    return (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "");
  });

  const waitingCount = conversations.filter((c) => attention(c, flags.get(c.id) ?? [])).length;
  const listed = onlyWaiting ? ranked.filter((c) => attention(c, flags.get(c.id) ?? [])) : ranked;

  return (
    <div className="flex h-screen">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-border">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold">Conversations</span>
          <Button variant="ghost" size="sm" onClick={() => supabase.auth.signOut()}>
            Sign out
          </Button>
        </header>

        <div className="flex gap-1 border-b border-border px-3 py-2">
          <Button
            variant={onlyWaiting ? "default" : "ghost"}
            size="sm"
            onClick={() => setOnlyWaiting(true)}
          >
            Needs you {waitingCount > 0 && `(${waitingCount})`}
          </Button>
          <Button
            variant={onlyWaiting ? "ghost" : "default"}
            size="sm"
            onClick={() => setOnlyWaiting(false)}
          >
            All
          </Button>
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
              "block w-full border-b border-border px-4 py-3 text-left text-sm",
              c.id === openId && "bg-muted",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{customerLabel(c)}</span>
              {attention(c, flags.get(c.id) ?? []) && (
                <span className="text-xs text-muted-foreground">
                  {attention(c, flags.get(c.id) ?? [])!.label}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{ist(c.last_message_at)}</span>
              {(() => {
                const left = windowLeft(c.window_expires_at);
                return left?.urgent ? (
                  <span className="font-medium text-destructive">{left.text}</span>
                ) : null;
              })()}
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
            {onlyWaiting ? "Nothing waiting on you." : "Nothing yet."}
          </p>
        )}
      </aside>

      {open ? (
        <Thread
          conversation={open}
          flags={flags.get(open.id) ?? []}
          isOwner={isOwner}
          onChanged={load}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Pick a conversation.
        </div>
      )}
    </div>
  );
}
