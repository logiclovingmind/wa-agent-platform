import { Suspense, lazy, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { arrivedBy, supabase } from "./lib/supabase";
import {
  ClientsIcon,
  ConsoleIcon,
  DeskIcon,
  DiaryIcon,
  FlowinIcon,
  type Icon,
} from "./components/icons";
import { cn } from "./lib/utils";
import { Button } from "./components/ui/button";
import ErrorBoundary from "./ErrorBoundary";
import SignIn from "./SignIn";
import SetPassword from "./SetPassword";
import Desk from "./Desk";
import Search from "./Search";
import { MfaChallenge, MfaSetup, mfaOwed } from "./Mfa";

/**
 * Split off rather than imported outright: Admin and Console are ours and no client
 * account can ever open them, and Flowin is a screen nobody lands on. On a phone that is
 * the difference between the desk arriving and everything arriving at once.
 */
const Flowin = lazy(() => import("./Flowin"));
const Admin = lazy(() => import("./Admin"));
const Console = lazy(() => import("./Console"));
const Diary = lazy(() => import("./Diary"));

type View = "desk" | "pulse" | "diary" | "admin" | "console" | "security";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  // The desk, not Flowin. This used to land on Flowin because the old inbox showed a
  // list of conversations, and on a quiet day a list of things nobody needs to do makes
  // the product look like it did nothing. The desk answers that itself: with nothing
  // waiting it shows the day's numbers where the queue would be. Landing here also keeps
  // it mounted, which is what lets the tab carry a dot from the other screens.
  const [view, setView] = useState<View>("desk");
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
    pulse: false,
    desk: true,
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
  const [waiting, setWaiting] = useState(0);
  // Counter rather than a boolean: the Desk tab has to be able to say "go home" twice in
  // a row, and a flag that is already true says nothing the second time.
  const [deskHome, setDeskHome] = useState(0);
  // An invite is known from the URL before any event fires; recovery announces itself
  // below. Both end in the same place — nobody gets past this with a password they have
  // never chosen.
  const [mustSetPassword, setMustSetPassword] = useState(arrivedBy === "invite");

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
      if (event === "PASSWORD_RECOVERY") setMustSetPassword(true);
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
  // recovery or invite link has nothing to do here until the password is actually set.
  if (mustSetPassword) return <SetPassword onDone={() => setMustSetPassword(false)} />;
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
      view === "pulse" || view === "desk" || view === "diary" ? "admin" : view;
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
    /* The app is a card on a desk, not a page. The grey inset only exists from `md`:
       on a phone the margin is screen you cannot spare, so the card goes full bleed and
       the sidebar lies down into a strip. */
    <div className="h-dvh bg-[#F2F2F5] md:p-4">
      <div className="flex h-full flex-col bg-background md:flex-row md:rounded-xl md:border md:border-black/5 md:shadow-sm">
        {/* Column from `md`, horizontal strip below it — one set of markup, because two
            would drift. Deliberately not `overflow-hidden`: the search panel has to be
            able to escape a 224px column and lie over the content beside it. */}
        <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-2 md:w-56 md:flex-col md:items-stretch md:gap-0.5 md:overflow-visible md:border-b-0 md:border-r md:bg-[#FAFAFA] md:px-3 md:py-4 md:rounded-l-xl">
          <div className="mr-2 flex shrink-0 items-center gap-2 md:mb-4 md:mr-0 md:px-2">
            <img src="/logo.svg" alt="" className="h-6 w-6 shrink-0" />
            {/* Ours, not the client's. The org name was here and it is the one thing on
                this screen the client already knows — while every person they show the
                dashboard to is looking at an unbranded tool. The name still heads the
                training console, where it identifies which org is being edited. */}
            <img src="/llm.svg" alt="LLM" className="hidden h-4 md:block" />
          </div>

          {orgId && (
            <div className="order-last w-full md:order-none md:mb-4 md:w-auto">
              <Search
                orgId={orgId}
                onOpen={(id) => {
                  setView("desk");
                  setJumpTo(id);
                }}
              />
            </div>
          )}

          <NavItem active={view === "pulse"} onClick={() => setView("pulse")} icon={FlowinIcon}>
            Flowin
          </NavItem>
          {/* The only state this shell carries. It answers "is anyone waiting" from the
              Diary, which is the question that otherwise makes someone tab back and
              forth all morning. A number would invite reading it; a dot does not. */}
          <NavItem
            active={view === "desk"}
            onClick={() => {
              setView("desk");
              setDeskHome((n) => n + 1);
            }}
            dot={waiting > 0 ? `${waiting} waiting` : null}
            icon={DeskIcon}
          >
            Desk
          </NavItem>
          <NavItem active={view === "diary"} onClick={() => setView("diary")} icon={DiaryIcon}>
            Diary
          </NavItem>
          {/* Only reachable by an account that is both a platform admin and a member of
              some org, which the split above is meant to make unnecessary. Kept so that
              granting the flag to an existing client owner does not lock them out of it. */}
          {isPlatformAdmin && (
            <NavItem active={view === "admin"} onClick={() => setView("admin")} icon={ClientsIcon}>
              All clients
            </NavItem>
          )}
          {isPlatformAdmin && (
            <NavItem active={view === "console"} onClick={() => setView("console")} icon={ConsoleIcon}>
              Training console
            </NavItem>
          )}

          <span className="flex-1" />

          {/* The one thing a worried owner wants confirmed, sitting where nothing else
              competes for it. It is also literally true: the DO hands a conversation back
              to the model when a human goes quiet. */}
          <p className="mb-2 hidden px-2 text-[11px] leading-relaxed text-muted-foreground md:block">
            The assistant is answering.
            <br />
            Paused only while you reply.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 md:justify-start"
            onClick={() => supabase.auth.signOut()}
          >
            Sign out
          </Button>
        </nav>

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden md:rounded-r-xl">
        <Suspense fallback={<Loading />}>
          {mounted.pulse && (
            <Pane show={view === "pulse"} label="Flowin">
              <Flowin orgId={orgId} />
            </Pane>
          )}
          {mounted.desk && (
            <Pane show={view === "desk"} label="The desk">
              <Desk
                orgId={orgId}
                isOwner={isOwner}
                jumpTo={jumpTo}
                homeSignal={deskHome}
                onWaiting={setWaiting}
              />
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
    </div>
  );
}

function NavItem({
  active,
  onClick,
  dot,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  dot?: string | null;
  icon?: Icon;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium md:w-full",
        active ? "bg-black/[0.06] text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {Icon && <Icon className="hidden h-4 w-4 shrink-0 opacity-60 md:block" />}
      {children}
      {dot && <span aria-label={dot} className="h-1.5 w-1.5 rounded-full bg-destructive" />}
    </button>
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
