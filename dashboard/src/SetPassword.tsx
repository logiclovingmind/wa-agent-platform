import { useState, type FormEvent } from "react";
import { supabase } from "./lib/supabase";
import { Button } from "./components/ui/button";

/**
 * The other end of the admin panel's "Reset password" button. Clicking a recovery link
 * signs the person in, which without this screen means they land on the inbox with the
 * old password still set and nothing telling them otherwise — the link looks like it
 * did nothing.
 *
 * There is no current-password field and there should not be: whoever holds the link has
 * already proven possession of the mailbox, and someone resetting a password by
 * definition does not know the old one.
 */
export default function SetPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    // Length and character rules are enforced by GoTrue, so its message is the accurate
    // one — restating them here would drift the day the project's policy changes.
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    // Drop the recovery tokens out of the address bar so the URL cannot be re-shared or
    // land in a browser history as something that still looks like a way in.
    window.history.replaceState(null, "", window.location.pathname);
    onDone();
  }

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <form onSubmit={submit} className="w-80 space-y-4">
        <h1 className="text-lg font-semibold">Choose a new password</h1>
        <input
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="New password"
          className="w-full rounded-md border border-border px-3 py-2 text-sm"
        />
        <input
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Repeat new password"
          className="w-full rounded-md border border-border px-3 py-2 text-sm"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Saving…" : "Save and continue"}
        </Button>
      </form>
    </div>
  );
}
