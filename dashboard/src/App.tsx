import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { Button } from "./components/ui/button";
import SignIn from "./SignIn";
import Inbox from "./Inbox";
import Usage from "./Usage";
import Admin from "./Admin";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<"inbox" | "usage" | "admin">("inbox");
  const [isOwner, setIsOwner] = useState(false);
  const [isMember, setIsMember] = useState(false);
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
    // Belonging to no org is the platform admin's normal state, not a failed read: they
    // are staff of nobody, so there is no inbox that could be shown to them.
    setIsMember((memberships ?? []).length > 0);

    const { data: me } = await supabase
      .from("users")
      .select("is_platform_admin")
      .eq("id", auth.user.id)
      .maybeSingle<{ is_platform_admin: boolean }>();
    setIsPlatformAdmin(me?.is_platform_admin ?? false);
  }

  if (!ready) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!session) return <SignIn />;

  /**
   * Two products behind one login screen, told apart by whether the account belongs to
   * an org. The admin account holds no membership, so RLS already returns it nothing on
   * every client table — dropping the tabs here just stops it landing on an inbox that
   * is empty for a reason no one could guess from looking at it.
   */
  const adminOnly = isPlatformAdmin && !isMember;
  if (adminOnly) {
    return (
      <div className="flex h-screen flex-col">
        <nav className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Platform admin</span>
          <span className="text-xs text-muted-foreground">
            {session.user.email} — no client inbox is readable from this account
          </span>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => supabase.auth.signOut()}>
            Sign out
          </Button>
        </nav>
        <div className="min-h-0 flex-1">
          <Admin />
        </div>
      </div>
    );
  }

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
        {/* Only reachable by an account that is both a platform admin and a member of
            some org, which the split above is meant to make unnecessary. Kept so that
            granting the flag to an existing client owner does not lock them out of it. */}
        {isPlatformAdmin && (
          <Button
            variant={view === "admin" ? "default" : "ghost"}
            size="sm"
            onClick={() => setView("admin")}
          >
            All clients
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => supabase.auth.signOut()}>
          Sign out
        </Button>
      </nav>

      <div className="min-h-0 flex-1">
        {view === "admin" && isPlatformAdmin ? (
          <Admin />
        ) : view === "usage" && isOwner ? (
          <Usage />
        ) : (
          <Inbox isOwner={isOwner} />
        )}
      </div>
    </div>
  );
}
