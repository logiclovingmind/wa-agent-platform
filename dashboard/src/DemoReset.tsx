import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import { ist } from "./lib/utils";

/**
 * The undo for a walk-in demo, on the demo org's row only.
 *
 * A demo overlays a prospect's business on this org — their KB pasted into the console,
 * their voice, and whatever threads arrive from messaging the sandbox number. Left in
 * place, the next walk-in is answered with the last prospect's fees.
 *
 * The RPC deletes only what the demo added, so the seeded backdrop is never rebuilt and
 * this is instant rather than a two-minute re-seed. Called straight from the browser
 * because it is `security definer` guarded on `app.is_platform_admin()`: this account
 * holds no `org_members` row, so anything scoped by RLS would answer it with nothing.
 *
 * Its own module because both All clients and the training console render it, and those
 * two are separate Vite chunks — importing one from the other would merge them.
 */
export function ResetDemo({ onChanged }: { onChanged: () => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [setups, setSetups] = useState<DemoSetup[]>([]);
  const [label, setLabel] = useState("");

  useEffect(() => {
    void loadSetups();
  }, []);

  // `kb` is deliberately not selected. It holds every document the prospect pasted, and
  // this list only needs a name and a date — fetching the bodies to render ten rows is
  // the shape of query the 5GB egress budget dies to.
  async function loadSetups() {
    const { data, error: readError } = await supabase
      .from("demo_setups")
      .select("id,label,name,created_at")
      .order("created_at", { ascending: false })
      .limit(20)
      .returns<DemoSetup[]>();
    if (readError) return setError(readError.message);
    setSetups(data ?? []);
  }

  /**
   * Runs one RPC, reports whichever way it went, and refreshes the list.
   *
   * `PromiseLike`, not `Promise`: a Supabase query builder is a thenable that only
   * becomes a promise when awaited, so it does not satisfy `Promise`.
   */
  async function rpc(
    fn: () => PromiseLike<{ error: { message: string } | null }>,
    success: string,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    setDone(null);
    const { error: rpcError } = await fn();
    setBusy(false);
    if (rpcError) return setError(rpcError.message);
    setDone(success);
    await loadSetups();
    onChanged();
  }

  async function run() {
    setBusy(true);
    setError(null);
    setDone(null);

    const { data, error: rpcError } = await supabase.rpc("demo_reset");

    setBusy(false);
    setArmed(false);
    // Surfaced rather than swallowed: a reset that silently did nothing leaves the next
    // prospect's data on screen, which is the one failure this button exists to prevent.
    if (rpcError) return setError(rpcError.message);

    const counts = (data as ResetCounts[] | null)?.[0];
    setDone(
      counts
        ? `Removed ${counts.conversations_removed} conversations, ` +
            `${counts.kb_documents_removed} documents, ${counts.usage_events_removed} usage rows.` +
            // The reset is a delete, and an operator who does not know the overlay was
            // kept will retype it. Naming the row is the whole point of saying this.
            (counts.setup_saved ? ` Saved as “${counts.setup_saved}”.` : "")
        : "Nothing to remove — already at defaults.",
    );
    await loadSetups();
    onChanged();
  }

  return (
    <div className="rounded border border-border bg-background p-4 text-xs">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="uppercase tracking-wide text-muted-foreground">After a demo</div>
        <button
          type="button"
          disabled={busy}
          onClick={() => (armed ? void run() : setArmed(true))}
          className={`rounded px-3 py-1.5 font-medium disabled:opacity-50 ${
            armed ? "bg-destructive text-white" : "border border-destructive/50 text-destructive"
          }`}
        >
          {busy ? "Resetting…" : armed ? "Confirm reset" : "Reset demo"}
        </button>
      </div>

      <p className="text-muted-foreground">
        Deletes the knowledge base, conversations, diary and spend from the last walk-in,
        and puts the name, sector, voice and seeded opening hours back. The seeded history
        is not touched — and the overlay is saved below first, so resetting is not the end
        of it.
      </p>

      {error && <p className="mt-2 text-destructive">{error}</p>}
      {done && <p className="mt-2 text-emerald-600">{done}</p>}

      <div className="mt-4 border-t border-border pt-3">
        <div className="mb-2 uppercase tracking-wide text-muted-foreground">Saved setups</div>

        {/* Saving mid-demo, before the reset does it automatically. The operator who wants
            "the version before I changed the fees" cannot get it from the reset, which
            only ever captures the last state. */}
        <div className="mb-3 flex gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Save the setup on screen as…"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"
          />
          <button
            type="button"
            disabled={busy || label.trim() === ""}
            onClick={() =>
              void rpc(
                () => supabase.rpc("demo_setup_save", { p_label: label.trim() }),
                `Saved “${label.trim()}”.`,
              ).then(() => setLabel(""))
            }
            className="shrink-0 rounded border border-border px-3 py-1 font-medium disabled:opacity-50"
          >
            Save
          </button>
        </div>

        {setups.length === 0 ? (
          <p className="text-muted-foreground">
            Nothing saved yet. The next reset files whatever the walk-in pasted in.
          </p>
        ) : (
          <ul className="space-y-1">
            {setups.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{s.label}</span>
                  <span className="block truncate text-muted-foreground">
                    {s.name} · {ist(s.created_at)}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void rpc(
                        () => supabase.rpc("demo_setup_load", { p_id: s.id }),
                        `Loaded “${s.label}”.`,
                      )
                    }
                    className="rounded border border-border px-2 py-1 disabled:opacity-50"
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void rpc(
                        async () => supabase.from("demo_setups").delete().eq("id", s.id),
                        `Deleted “${s.label}”.`,
                      )
                    }
                    className="rounded px-2 py-1 text-destructive disabled:opacity-50"
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type DemoSetup = {
  id: string;
  label: string;
  name: string;
  created_at: string;
};

type ResetCounts = {
  conversations_removed: number;
  kb_documents_removed: number;
  usage_events_removed: number;
  /** Null when the walk-in pasted no KB and the reset filed nothing. */
  setup_saved: string | null;
};
