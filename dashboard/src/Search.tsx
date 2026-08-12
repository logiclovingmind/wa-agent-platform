import { useEffect, useRef, useState } from "react";
import { supabase, type SearchHit } from "./lib/supabase";
import { Input } from "./components/ui/input";
import { ist } from "./lib/utils";

/**
 * A keystroke is a query, so the gap between them is the whole cost model. 250ms is long
 * enough that typing a name is one round trip rather than eight, and short enough that
 * it still feels like it is keeping up.
 */
const DEBOUNCE = 250;

/** Below this the RPC returns nothing on purpose: two characters match half the inbox. */
const MIN = 3;

const KIND_LABEL: Record<SearchHit["kind"], string> = {
  person: "Person",
  lead: "Asked for",
  message: "Message",
};

/**
 * One box over people, what they wanted, and what was said. It does not filter the
 * screen behind it — it jumps. An owner searching a customer's name wants that
 * conversation open, not the list narrowed and the thread left where it was.
 */
export default function Search({
  orgId,
  onOpen,
}: {
  orgId: string;
  onOpen: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN) {
      setHits([]);
      setError(null);
      return;
    }

    // The timer is the debounce; `stale` is what stops a slow early query overwriting
    // the results of a faster later one.
    let stale = false;
    setBusy(true);
    const timer = setTimeout(() => {
      void (async () => {
        const { data, error: err } = await supabase.rpc("search_everything", {
          p_org_id: orgId,
          p_query: q,
        });
        if (stale) return;
        setError(err ? err.message : null);
        setHits((data ?? []) as SearchHit[]);
        setBusy(false);
      })();
    }, DEBOUNCE);

    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, orgId]);

  // Clicking anywhere else closes the results. Without this the panel sits over the
  // thread the user just opened from it.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!box.current?.contains(e.target as Node)) setHits([]);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const short = query.trim().length > 0 && query.trim().length < MIN;

  return (
    <div ref={box} className="relative w-72">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setQuery("")}
        placeholder="Search people, leads, messages"
        className="h-8 text-sm"
      />

      {(hits.length > 0 || short || error) && (
        <div className="absolute left-0 right-0 top-9 z-20 max-h-96 overflow-y-auto rounded border border-border bg-background shadow-lg">
          {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
          {short && !error && (
            <p className="px-3 py-2 text-xs text-muted-foreground">Keep typing — {MIN} letters.</p>
          )}
          {hits.map((hit) => (
            <button
              key={`${hit.kind}-${hit.conversation_id}-${hit.at ?? ""}`}
              onClick={() => {
                onOpen(hit.conversation_id);
                setQuery("");
                setHits([]);
              }}
              className="block w-full border-b border-border/60 px-3 py-2 text-left last:border-0 hover:bg-muted"
            >
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate font-medium">
                  {hit.customer_name ?? `+${hit.customer_wa_id}`}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {KIND_LABEL[hit.kind]}
                </span>
              </div>
              {hit.snippet && (
                <div className="truncate text-xs text-muted-foreground">{hit.snippet}</div>
              )}
              {hit.at && <div className="text-[10px] text-muted-foreground/70">{ist(hit.at)}</div>}
            </button>
          ))}
        </div>
      )}

      {busy && query.trim().length >= MIN && hits.length === 0 && (
        <div className="absolute left-0 right-0 top-9 z-20 rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground shadow-lg">
          Searching…
        </div>
      )}
    </div>
  );
}
