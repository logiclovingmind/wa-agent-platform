import { useEffect, useState, type FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { Button } from "./components/ui/button";

/**
 * Time-based one-time passwords, using Supabase's own factor API.
 *
 * Nothing here is our cryptography and nothing here is a new dependency: GoTrue holds
 * the shared secret, generates the QR itself, and checks the code. What this file
 * contributes is the two screens around it.
 *
 * The account this exists for is the platform admin — the one login that can onboard a
 * client, read every org's health, and move the platform's own money. A client owner's
 * password only reaches their own org's rows; ours reaches the panel that administers
 * all of them.
 */

/** GoTrue returns half-finished enrolments too. Only a verified factor is a factor. */
type Factor = { id: string; status?: string; friendly_name?: string };

export function verifiedFactors(user: User | null): Factor[] {
  return (user?.factors ?? []).filter((f) => f.status === "verified");
}

/**
 * The session's assurance level, taken from the token it is already holding.
 *
 * Same reasoning as `sessionAal` in the Worker, and deliberately the same inputs: the
 * browser and the Worker should never disagree about whether this session has cleared a
 * second factor. Unreadable counts as not cleared.
 */
export function sessionAal(accessToken: string): string | null {
  const segment = accessToken.split(".")[1];
  if (!segment) return null;
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    return (JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as { aal?: string })
      .aal ?? null;
  } catch {
    return null;
  }
}

/** A factor is enrolled but this session has not used it yet. */
export function mfaOwed(user: User | null, accessToken: string): boolean {
  return verifiedFactors(user).length > 0 && sessionAal(accessToken) !== "aal2";
}

const codeInput =
  "h-11 w-full rounded-md border border-border px-3 text-center text-lg tracking-[0.4em] md:h-10";

/**
 * Shown instead of the app when a factor is enrolled and the session is one step short.
 *
 * It renders ahead of every shell rather than inside the sign-in form because the
 * password already produced a session by this point: `onAuthStateChange` has fired and
 * App would otherwise be rendering the admin panel behind this. The browser lock is
 * cosmetic on its own — `denyAdmin` in the Worker is the one that holds — but a screen
 * you can dismiss to reach dead buttons is not a lock at all.
 */
export function MfaChallenge({ user }: { user: User | null }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const factor = verifiedFactors(user)[0];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!factor) return;
    setBusy(true);
    setError(null);
    // One call rather than challenge() then verify(): a separate challenge id would be
    // one more thing to hold across a re-render and expire underneath us.
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code: code.trim(),
    });
    // On success the session is replaced at aal2, which re-renders App past this screen.
    if (error) setError(error.message);
    setBusy(false);
  }

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <form onSubmit={submit} className="w-80 max-w-full space-y-4 px-4">
        <div className="mb-8 flex flex-col items-center gap-4">
          <img src="/logo.svg" alt="" className="h-12 w-12" />
          <p className="text-center text-sm text-muted-foreground">
            Enter the six-digit code from your authenticator app.
          </p>
        </div>
        <input
          // Not type="number": it strips a leading zero and offers a spinner for a value
          // that is a string of six digits, not a quantity.
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          placeholder="000000"
          className={codeInput}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
          {busy ? "Checking…" : "Continue"}
        </Button>
        {/* The way out of a lost phone is a new sign-in, not a bypass. Removing the
            factor needs the database, and that is the point of it. */}
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => supabase.auth.signOut()}
        >
          Sign out
        </Button>
      </form>
    </div>
  );
}

/**
 * Enrolment, and the only place a factor can be removed.
 *
 * Reachable from an ordinary session on purpose: the Worker demands a second factor
 * only once one exists, so this screen has to be usable before there is anything to
 * demand. That is what stops the guard being a lockout.
 */
export function MfaSetup() {
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [pending, setPending] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    const { data } = await supabase.auth.getUser();
    setFactors(verifiedFactors(data.user));
  }

  async function begin() {
    setBusy(true);
    setError(null);

    // `cancel()` clears a pending factor, but a reload or a closed tab does not, and
    // enrolment writes the factor before any code is typed. GoTrue then refuses the
    // next attempt outright — the friendly name is already taken — and the screen
    // becomes unusable with no way out of it from the UI.
    const { data: current } = await supabase.auth.getUser();
    for (const stale of current.user?.factors ?? []) {
      if (stale.status !== "verified") {
        await supabase.auth.mfa.unenroll({ factorId: stale.id });
      }
    }

    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      // Shown inside the authenticator app beside the code, where "Supabase" or a
      // project ref would tell the owner of the phone nothing.
      issuer: "Logic Loving Mind",
      friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
    });
    if (error) setError(error.message);
    else if (data)
      setPending({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    setBusy(false);
  }

  /**
   * Enrolling creates the factor immediately, unverified. Abandoning the screen would
   * leave it behind, and a stack of dead factors is how someone ends up unable to tell
   * which entry in their authenticator app is the live one.
   */
  async function cancel() {
    if (pending) await supabase.auth.mfa.unenroll({ factorId: pending.id });
    setPending(null);
    setCode("");
    setError(null);
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId: pending.id,
      code: code.trim(),
    });
    if (error) {
      // Left pending rather than torn down: the usual cause is a phone clock a few
      // seconds out, and deleting the factor would mean scanning the QR again.
      setError(error.message);
    } else {
      setPending(null);
      setCode("");
      await refresh();
    }
    setBusy(false);
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.mfa.unenroll({ factorId: id });
    if (error) setError(error.message);
    else await refresh();
    setBusy(false);
  }

  if (factors === null) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="max-w-xl space-y-4 p-4">
      <div>
        <h2 className="text-base font-semibold">Two-factor authentication</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A code from your phone, on top of the password, for the account that administers
          every client.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {factors.length > 0 ? (
        <div className="space-y-3 rounded-md border border-border p-4">
          <p className="text-sm">
            <span className="font-medium text-green-700">On.</span> This account asks for a
            code at sign-in, and the admin API refuses a session that has not given one.
          </p>
          {factors.map((f) => (
            <div key={f.id} className="flex items-center gap-3">
              <span className="flex-1 truncate text-sm text-muted-foreground">
                {f.friendly_name ?? f.id}
              </span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(f.id)}>
                Remove
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Removing the last factor puts the account back to a password alone. Do it from a
            session that still works, never from a phone you are about to replace.
          </p>
        </div>
      ) : pending ? (
        <form onSubmit={confirm} className="space-y-4 rounded-md border border-border p-4">
          <p className="text-sm">Scan this in Google Authenticator, 1Password, or Aegis.</p>
          {/* GoTrue hands back the SVG itself, so the QR is never generated here and no
              image library is needed. Used raw because `enroll()` in auth-js has already
              prepended `data:image/svg+xml;utf-8,` — encoding it here once more, which is
              what this line used to do, percent-encoded that whole URI into the body of a
              second one and rendered a broken image. Nothing needs escaping: goqrsvg
              writes `fill:black`, so the only character that would end a data URI early —
              a `#` in a hex colour — never appears. */}
          <img
            src={pending.qr}
            alt=""
            className="h-44 w-44 bg-white"
          />
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Can't scan it?</summary>
            <code className="mt-2 block break-all font-mono">{pending.secret}</code>
          </details>
          <p className="text-sm">Then type the code it shows, to prove it works.</p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="000000"
            className={codeInput}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Turn on"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancel()}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3 rounded-md border border-border p-4">
          <p className="text-sm">
            <span className="font-medium">Off.</span> The password is the only thing between
            this panel and anyone holding it.
          </p>
          <Button disabled={busy} onClick={() => void begin()}>
            {busy ? "Starting…" : "Set up"}
          </Button>
        </div>
      )}
    </div>
  );
}
