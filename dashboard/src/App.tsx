import { Suspense, lazy, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { Button } from "./components/ui/button";
import ErrorBoundary from "./ErrorBoundary";
import SignIn from "./SignIn";
import SetPassword from "./SetPassword";
import Inbox from "./Inbox";
import Search from "./Search";
import { MfaChallenge, MfaSetup, mfaOwed } from "./Mfa";

/**
 * Split off rather than imported outright. Flowin carries recharts, which is most of
 * the bundle; Admin and Console are ours and no client account can ever open them. On a
 * phone that is the difference between the inbox arriving and the charts arriving first.
 */
const Flowin = lazy(() => import("./Flowin"));
const Admin = lazy(() => import("./Admin"));
const Console = lazy(() => import("./Console"));
const Diary = lazy(() => import("./Diary"));

type View = "inbox" | "pulse" | "diary" | "admin" | "console" | "security";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  // Flowin, not the inbox. The inbox is where you go when something needs you; landing
  // there makes an ordinary quiet day look like the product does nothing.
  const [view, setView] = useState<View>("pulse");
  /**
   * Which views have been opened at least once. Switching tabs used to unmount one and
   * mount the other, so every tap tore down a screenful of chart SVGs and then sat on a
   * blank pane for three round trips, refetching what it had already fetched a minute
   * earlier. On a phone that reads as the app hanging on the press.
   *
   * A view is mounted on first visit and stays mounted, hidden, afterwards. The cost is
   * one open Realtime channel when a conversation is left open on another tab — which is
   * that conversation still being open; it still closes on unmount and on tab close, as
   * invariant 8 requires.
   */
  const [mounted, setMounted] = useState<Record<View, boolean>>({
    pulse: true,
    inbox: false,
    diary: false,
    admin: false,
    console: false,
    security: false,
  });
  const [isOwner, setIsOwner] = useState(false);
  const [isMember, setIsMember] = useState(false);
  const [orgId, setOrgId] = useState("");
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  // Held because it carries `factors`, which is what says whether this account owes a
  // code. Kept from the lookup `loadRole` already makes rather than fetched again.
  const [user, setUser] = useState<User | null>(null);
  // Nothing renders until the account has been looked at once. Without this the admin
  // shell paints for a frame before the challenge replaces it, which reads as the panel
  // opening and then being taken away.
  const [identified, setIdentified] = useState(false);
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
    else setIdentified(false);
  }, [session]);

  useEffect(() => {
    setMounted((m) => (m[view] ? m : { ...m, [view]: true }));
  }, [view]);

  /**
   * Lives here rather than in the inbox because two screens need it now. It decides
   * what to render and nothing else: the balance endpoint checks admin itself and the
   * `pulse_*` functions re-check membership in the database, so a stale answer here
   * hides a control or shows one that comes back empty — never a way in.
   */
  async function loadRole() {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    setUser(auth.user);

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
    setIdentified(true);
  }

  if (!ready) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!session) return <SignIn />;
  // Ahead of every shell below, including the admin one: an account arriving on a
  // recovery link has nothing to do here until the password is actually changed.
  if (recovering) return <SetPassword onDone={() => setRecovering(false)} />;
  if (!identified) return <div className="p-8 text-muted-foreground">Loading…</div>;
  /**
   * A factor is enrolled and this session has not used it. The password already made a
   * session, so this cannot live in the sign-in form — App would be rendering the panel
   * behind it. This screen is the courtesy; `denyAdmin` in the Worker is the lock, and
   * it answers 403 to exactly the same condition.
   */
  if (mfaOwed(user, session.access_token)) return <MfaChallenge user={user} />;

  /**
   * Two products behind one login screen, told apart by whether the account belongs to
   * an org. The admin account holds no membership, so RLS already returns it nothing on
   * every client table — dropping the tabs here just stops it landing on an inbox that
   * is empty for a reason no one could guess from looking at it.
   */
  const adminOnly = isPlatformAdmin && !isMember;
  if (adminOnly) {
    // `view` starts on the client landing screen, which this shell does not have. The
    // client list is the equivalent here, and naming it keeps its tab lit on arrival.
    const adminView =
      view === "pulse" || view === "inbox" || view === "diary" ? "admin" : view;
    return (
      <div className="flex h-dvh flex-col">
        <nav className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <img src="/logo.svg" alt="Logic Loving Mind" className="h-6 w-6 shrink-0" />
          <span className="text-sm font-semibold">Platform admin</span>
          {/* Three named destinations rather than the old two-way toggle, which had no
              room for a third and would have sent "Security" back to the client list. */}
          <Button
            variant={adminView === "admin" ? "default" : "ghost"}
            size="sm"
            onClick={() => setView("admin")}
          >
            All clients
          </Button>
          <Button
            variant={adminView === "console" ? "default" : "ghost"}
            size="sm"
            onClick={() => setView("console")}
          >
            Training console
          </Button>
          <Button
            variant={adminView === "security" ? "default" : "ghost"}
            size="sm"
            onClick={() => setView("security")}
          >
            Security
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
          {/* Keyed on the view: this shell swaps screens in one slot rather than keeping
              them mounted, so without a key a boundary tripped on one screen would still
              be showing its message after the admin had navigated to another. */}
          <ErrorBoundary key={adminView} label="This screen">
            <Suspense fallback={<Loading />}>
              {adminView === "security" ? (
                <MfaSetup />
              ) : adminView === "console" ? (
                <Console />
              ) : (
                <Admin />
              )}
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
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
        <Button
          variant={view === "diary" ? "default" : "ghost"}
          size="sm"
          onClick={() => setView("diary")}
        >
          Diary
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
          {mounted.pulse && (
            <Pane show={view === "pulse"} label="Flowin">
              <Flowin orgId={orgId} onOpenDiary={() => setView("diary")} />
            </Pane>
          )}
          {mounted.inbox && (
            <Pane show={view === "inbox"} label="The inbox">
              <Inbox isOwner={isOwner} jumpTo={jumpTo} />
            </Pane>
          )}
          {mounted.diary && (
            <Pane show={view === "diary"} label="The diary">
              <Diary orgId={orgId} isOwner={isOwner} />
            </Pane>
          )}
          {mounted.admin && isPlatformAdmin && (
            <Pane show={view === "admin"} label="The client list">
              <Admin />
            </Pane>
          )}
          {mounted.console && isPlatformAdmin && (
            <Pane show={view === "console"} label="The training console">
              <Console />
            </Pane>
          )}
        </Suspense>
      </div>
    </div>
  );
}

/** `display: none` rather than unmounting, so a tab that has been opened stays ready. */
function Pane({
  show,
  label,
  children,
}: {
  show: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={show ? "h-full" : "hidden"}>
      <ErrorBoundary label={label}>{children}</ErrorBoundary>
    </div>
  );
}

function Loading() {
  return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
}
