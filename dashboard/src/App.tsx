import { Suspense, lazy, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { Button } from "./components/ui/button";
import SignIn from "./SignIn";
import SetPassword from "./SetPassword";
import Inbox from "./Inbox";
import Search from "./Search";

/**
 * Split off rather than imported outright. Flowin carries recharts, which is most of
 * the bundle; Admin and Console are ours and no client account can ever open them. On a
 * phone that is the difference between the inbox arriving and the charts arriving first.
 */
const Flowin = lazy(() => import("./Flowin"));
const Admin = lazy(() => import("./Admin"));
const Console = lazy(() => import("./Console"));

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  // Flowin, not the inbox. The inbox is where you go when something needs you; landing
  // there makes an ordinary quiet day look like the product does nothing.
  const [view, setView] = useState<"inbox" | "pulse" | "admin" | "console">("pulse");
  const [isOwner, setIsOwner] = useState(false);
  const [isMember, setIsMember] = useState(false);
  const [orgId, setOrgId] = useState("");
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  // Set by the search box, consumed by the inbox. A hit is a conversation to open, and
  // it may well be older than the fifty rows the list holds.
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      // A recovery link signs the user in before they have chosen anything, so the
      // session alone cannot tell this apart from an ordinary login. This event can
      // arrive before or after getSession resolves, hence a flag rather than a branch.
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) void loadRole();
  }, [session]);

  /**
   * Lives here rather than in the inbox because two screens need it now. It decides
   * what to render and nothing else: the balance endpoint checks admin itself and the
   * `pulse_*` functions re-check membership in the database, so a stale answer here
   * hides a control or shows one that comes back empty — never a way in.
   */
  async function loadRole() {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;

    // Every row, not maybeSingle: a user in two orgs would make that error out and
    // silently downgrade an owner to staff.
    const { data: memberships } = await supabase
      .from("org_members")
      .select("role, org_id")
      .eq("user_id", auth.user.id)
      .returns<{ role: string; org_id: string }[]>();
    setIsOwner((memberships ?? []).some((m) => m.role === "owner"));
    setOrgId(memberships?.[0]?.org_id ?? "");
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
  // Ahead of every shell below, including the admin one: an account arriving on a
  // recovery link has nothing to do here until the password is actually changed.
  if (recovering) return <SetPassword onDone={() => setRecovering(false)} />;

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
        <nav className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <img src="/logo.svg" alt="Logic Loving Mind" className="h-6 w-6 shrink-0" />
          <span className="text-sm font-semibold">Platform admin</span>
          <Button
            variant={view === "console" ? "default" : "ghost"}
            size="sm"
            onClick={() => setView(view === "console" ? "admin" : "console")}
          >
            Training console
          </Button>
          <span className="text-xs text-muted-foreground">
            {session.user.email} — no client inbox is readable from this account
          </span>
          <span className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => supabase.auth.signOut()}>
            Sign out
          </Button>
        </nav>
        <div className="min-h-0 flex-1">
          <Suspense fallback={<Loading />}>
            {view === "console" ? <Console /> : <Admin />}
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Wraps rather than scrolls: on a phone the search box takes a line of its own
          below the tabs, which is where a thumb expects it anyway. */}
      <nav className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        <img src="/logo.svg" alt="Logic Loving Mind" className="mr-2 h-6 w-6 shrink-0" />
        <Button
          variant={view === "pulse" ? "default" : "ghost"}
          size="sm"
          onClick={() => setView("pulse")}
        >
          Flowin
        </Button>
        <Button
          variant={view === "inbox" ? "default" : "ghost"}
          size="sm"
          onClick={() => setView("inbox")}
        >
          WhatsApp
        </Button>
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
        {isPlatformAdmin && (
          <Button
            variant={view === "console" ? "default" : "ghost"}
            size="sm"
            onClick={() => setView("console")}
          >
            Training console
          </Button>
        )}
        <span className="flex-1" />
        {orgId && (
          <div className="order-last w-full md:order-none md:w-auto">
            <Search
              orgId={orgId}
              onOpen={(id) => {
                setView("inbox");
                setJumpTo(id);
              }}
            />
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={() => supabase.auth.signOut()}>
          Sign out
        </Button>
      </nav>

      <div className="min-h-0 flex-1">
        <Suspense fallback={<Loading />}>
          {view === "admin" && isPlatformAdmin ? (
            <Admin />
          ) : view === "console" && isPlatformAdmin ? (
            <Console />
          ) : view === "pulse" ? (
            <Flowin orgId={orgId} />
          ) : (
            <Inbox isOwner={isOwner} jumpTo={jumpTo} />
          )}
        </Suspense>
      </div>
    </div>
  );
}

function Loading() {
  return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
}
