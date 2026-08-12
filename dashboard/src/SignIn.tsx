import { useState, type FormEvent } from "react";
import { supabase } from "./lib/supabase";
import { Button } from "./components/ui/button";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setBusy(false);
  }

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <form onSubmit={submit} className="w-80 max-w-full space-y-4 px-4">
        {/* The one screen the full lockup fits on. The wordmark is twenty times wider
            than it is tall, so everywhere else in the app it is the mark alone. */}
        <div className="mb-8 flex flex-col items-center gap-4">
          <img src="/logo.svg" alt="" className="h-12 w-12" />
          <img src="/wordmark.svg" alt="Logic Loving Mind" className="w-56" />
        </div>
        <input
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@business.com"
          className="h-11 w-full rounded-md border border-border px-3 text-base md:h-10 md:text-sm"
        />
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="h-11 w-full rounded-md border border-border px-3 text-base md:h-10 md:text-sm"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
