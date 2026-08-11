import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { Button } from "./components/ui/button";
import SignIn from "./SignIn";
import Inbox from "./Inbox";
import Usage from "./Usage";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<"inbox" | "usage">("inbox");
  const [isOwner, setIsOwner] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) void loadRole();
  }, [session]);

  /**
   * Lives here rather than in the inbox because two screens need it now. It decides
   * what to render and nothing else: usage rows are owner-only under RLS and the
   * balance endpoint checks admin itself, so a stale answer here hides a control or
   * shows one that comes back empty — never a way in.
   */
  async function loadRole() {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;

    // Every row, not maybeSingle: a user in two orgs would make that error out and
    // silently downgrade an owner to staff.
    const { data: memberships } = await supabase
      .from("org_members")
      .select("role")
      .eq("user_id", auth.user.id)
      .returns<{ role: string }[]>();
    setIsOwner((memberships ?? []).some((m) => m.role === "owner"));

    const { data: me } = await supabase
      .from("users")
      .select("is_platform_admin")
      .eq("id", auth.user.id)
      .maybeSingle<{ is_platform_admin: boolean }>();
    setIsPlatformAdmin(me?.is_platform_admin ?? false);
  }

  if (!ready) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!session) return <SignIn />;

  return (
    <div className="flex h-screen flex-col">
      <nav className="flex items-center gap-1 border-b border-border px-3 py-2">
        <Button
          variant={view === "inbox" ? "default" : "ghost"}
          size="sm"
          onClick={() => setView("inbox")}
        >
          Inbox
        </Button>
        {/* Staff never see cost — the RLS policy says so, so the tab should not imply
            otherwise by rendering an empty screen. */}
        {isOwner && (
          <Button
            variant={view === "usage" ? "default" : "ghost"}
            size="sm"
            onClick={() => setView("usage")}
          >
            Usage
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => supabase.auth.signOut()}>
          Sign out
        </Button>
      </nav>

      <div className="min-h-0 flex-1">
        {view === "usage" && isOwner ? (
          <Usage isPlatformAdmin={isPlatformAdmin} />
        ) : (
          <Inbox isOwner={isOwner} />
        )}
      </div>
    </div>
  );
}
