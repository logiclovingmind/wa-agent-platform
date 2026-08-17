import { cn } from "../lib/utils";

/**
 * The pieces every client screen is built from. They started inside `Desk.tsx`; the
 * Diary and Flowin redesigns needed the same five, and a copy-paste of them is how the
 * three screens drift apart again. Nothing here knows what it is listing.
 *
 * `Row` deliberately stayed in `Desk.tsx` — it takes a `Conversation` and safety flags,
 * so it is a desk row, not a primitive.
 */

export function TabButton({
  on,
  dot,
  onClick,
  children,
}: {
  on: boolean;
  dot?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] outline-none",
        on ? "bg-foreground text-background" : "text-muted-foreground hover:bg-black/[0.04]",
      )}
    >
      {children}
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-destructive" />}
    </button>
  );
}

export function Count({ children }: { children: React.ReactNode }) {
  return <span className="tabular-nums opacity-60">{children}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pt-2 text-[13px] text-muted-foreground">{children}</p>;
}

export function Group({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="flex items-baseline justify-between gap-3 px-3 pb-1.5 text-[13px] text-muted-foreground">
        {title}
        {right}
      </h2>
      {children}
    </section>
  );
}

export function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div>
      <div className="text-[38px] font-semibold leading-none tracking-tight tabular-nums">{n}</div>
      <div className="mt-2 text-[13px] text-muted-foreground">{label}</div>
    </div>
  );
}
