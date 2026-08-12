import { useEffect, useState } from "react";
import { supabase, customerLabel, type Conversation, type Lead } from "./lib/supabase";
import { Button } from "./components/ui/button";

/** Same reason as the inbox's 20: this is the main lever on the egress budget. */
const PAGE = 50;

/** Export pages through the same table rather than reading it all at once. A client with
 *  three thousand leads should get three thousand rows, and should not fetch them to look
 *  at the first fifty. */
const EXPORT_CHUNK = 1000;
const EXPORT_MAX = 20000;

interface Row extends Lead {
  customer: string;
  phone: string;
}

/**
 * Everyone who asked, and what they asked for.
 *
 * The list is written by the assistant, from the same completion that produced the reply —
 * there is no separate extraction call and no form anyone fills in. So it is only ever as
 * complete as the conversation was, which is why every column can be blank and why a row
 * with nothing but a phone number still earns its place: it means somebody asked and
 * nobody has called them back.
 */
export default function Leads() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void load(0);
  }, []);

  async function load(from: number) {
    setBusy(true);
    const page = await fetchRows(from, PAGE);
    setBusy(false);

    if (page.error) {
      setLoadError(page.error);
      return;
    }
    setLoadError(null);
    setRows((prev) => (from === 0 ? page.rows : [...prev, ...page.rows]));
    setMore(page.rows.length === PAGE);
  }

  async function download() {
    setBusy(true);
    const all: Row[] = [];
    for (let from = 0; from < EXPORT_MAX; from += EXPORT_CHUNK) {
      const page = await fetchRows(from, EXPORT_CHUNK);
      if (page.error) {
        setLoadError(page.error);
        setBusy(false);
        return;
      }
      all.push(...page.rows);
      if (page.rows.length < EXPORT_CHUNK) break;
    }
    setBusy(false);
    save(toCsv(all), `leads-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <header className="mb-5 flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Leads</h1>
          <p className="text-sm text-muted-foreground">
            What the assistant learned from each conversation. Blank means they never said.
          </p>
        </div>
        <Button size="sm" onClick={() => void download()} disabled={busy || rows.length === 0}>
          Export for Excel
        </Button>
      </header>

      {loadError && (
        <p className="mb-6 rounded border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          Could not load leads: {loadError}
        </p>
      )}

      {!loadError && rows.length === 0 && !busy && (
        <p className="rounded border border-border px-4 py-8 text-center text-sm text-muted-foreground">
          Nobody has told the assistant anything yet.
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <Th>Customer</Th>
                <Th>Wants</Th>
                <Th>When</Th>
                <Th>Budget</Th>
                <Th>Notes</Th>
                <Th>Last heard</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border/60 last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.name ?? row.customer}</div>
                    <div className="text-xs tabular-nums text-muted-foreground">{row.phone}</div>
                  </td>
                  <Td>{row.intent}</Td>
                  <Td>{row.timeframe}</Td>
                  <Td>{row.budget}</Td>
                  <Td>{row.notes}</Td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {when(row.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {more && (
        <div className="mt-3 text-center">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load(rows.length)}>
            Load older
          </Button>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({ children }: { children: string | null | undefined }) {
  return (
    <td className="px-3 py-2 align-top">
      {children ?? <span className="text-muted-foreground/50">—</span>}
    </td>
  );
}

/**
 * Two queries rather than one PostgREST embed. `leads` reaches `conversations` through a
 * composite foreign key, and naming the right one in an embed hint is a string that breaks
 * the day the constraint is renamed — for a join of at most PAGE ids.
 */
async function fetchRows(
  from: number,
  size: number,
): Promise<{ rows: Row[]; error: string | null }> {
  const leads = await supabase
    .from("leads")
    .select("id, conversation_id, name, intent, timeframe, budget, notes, updated_at")
    .order("updated_at", { ascending: false })
    .range(from, from + size - 1)
    .returns<Lead[]>();

  if (leads.error) return { rows: [], error: leads.error.message };
  if (!leads.data || leads.data.length === 0) return { rows: [], error: null };

  const people = await supabase
    .from("conversations")
    .select("id, customer_wa_id, customer_name")
    .in("id", leads.data.map((l) => l.conversation_id))
    .returns<Pick<Conversation, "id" | "customer_wa_id" | "customer_name">[]>();

  if (people.error) return { rows: [], error: people.error.message };

  const byId = new Map((people.data ?? []).map((c) => [c.id, c]));
  return {
    error: null,
    rows: leads.data.map((lead) => {
      const person = byId.get(lead.conversation_id);
      return {
        ...lead,
        customer: person ? customerLabel(person as Conversation) : "Unknown",
        phone: person ? `+${person.customer_wa_id}` : "",
      };
    }),
  };
}

const COLUMNS: Array<[string, (row: Row) => string | null | undefined]> = [
  ["Customer", (r) => r.customer],
  ["Phone", (r) => r.phone],
  ["Name given", (r) => r.name],
  ["Wants", (r) => r.intent],
  ["When", (r) => r.timeframe],
  ["Budget", (r) => r.budget],
  ["Notes", (r) => r.notes],
  ["Last heard", (r) => r.updated_at],
];

function toCsv(rows: Row[]): string {
  const lines = [COLUMNS.map(([head]) => head).join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map(([, read]) => cell(read(row))).join(","));
  }
  // Excel reads a CSV as the machine's ANSI codepage unless a BOM says otherwise, which
  // turns every Hindi or Kannada name into mojibake on the customer's laptop.
  return `\ufeff${lines.join("\r\n")}`;
}

/**
 * Every cell here is customer text the model repeated back, so it is untrusted input on
 * its way into a spreadsheet. Excel and Sheets execute a cell that opens with `=`, `+`,
 * `-` or `@`, which makes "=HYPERLINK(...)" in a WhatsApp message a working attack on the
 * person who opens the export. Prefixing a quote neutralises it — and does the same job
 * for the phone number, which Excel would otherwise render as 9.19E+11.
 */
function cell(value: string | null | undefined): string {
  const text = (value ?? "").replace(/\r?\n/g, " ");
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function save(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
  });
}
