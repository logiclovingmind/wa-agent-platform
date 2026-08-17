import { supabase, customerLabel, type Conversation, type Lead } from "./supabase";

/** Export pages through the same table rather than reading it all at once. A client with
 *  three thousand leads should get three thousand rows, and should not fetch them to see
 *  the fifty conversations on screen. */
const CHUNK = 1000;
const MAX = 20000;

export interface LeadRow extends Lead {
  customer: string;
  phone: string;
}

/**
 * Two queries rather than one PostgREST embed. `leads` reaches `conversations` through a
 * composite foreign key, and naming the right one in an embed hint is a string that
 * breaks the day the constraint is renamed.
 */
async function page(from: number, size: number): Promise<{ rows: LeadRow[]; error: string | null }> {
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

/** What the assistant learned, for the conversations currently on screen. */
export async function leadsFor(conversationIds: string[]): Promise<Map<string, Lead>> {
  if (conversationIds.length === 0) return new Map();
  const { data } = await supabase
    .from("leads")
    .select("id, conversation_id, name, intent, timeframe, budget, notes, updated_at")
    .in("conversation_id", conversationIds)
    .returns<Lead[]>();
  return new Map((data ?? []).map((l) => [l.conversation_id, l]));
}

/**
 * `rows: 0` is a real answer and not a failure — the same distinction the inbox draws
 * between a read that broke and an inbox that is genuinely empty. Collapsing the two
 * into "null means fine" is what let a failed export hand the owner a file.
 */
export type ExportOutcome = { ok: true; rows: number } | { ok: false; error: string };

export async function downloadLeadsCsv(): Promise<ExportOutcome> {
  const all: LeadRow[] = [];
  for (let from = 0; from < MAX; from += CHUNK) {
    const chunk = await page(from, CHUNK);
    if (chunk.error) return { ok: false, error: chunk.error };
    all.push(...chunk.rows);
    if (chunk.rows.length < CHUNK) break;
  }

  // No download on an empty export. A file containing nothing but the header looks like
  // a successful export of a client who has no customers, and an owner who opens it
  // concludes the assistant has not been capturing anything.
  if (all.length > 0) {
    save(toCsv(all), `leads-${new Date().toISOString().slice(0, 10)}.csv`);
  }
  return { ok: true, rows: all.length };
}

const COLUMNS: Array<[string, (row: LeadRow) => string | null | undefined]> = [
  ["Customer", (r) => r.customer],
  ["Phone", (r) => r.phone],
  ["Name given", (r) => r.name],
  ["Wants", (r) => r.intent],
  ["When", (r) => r.timeframe],
  ["Budget", (r) => r.budget],
  ["Notes", (r) => r.notes],
  ["Last heard", (r) => r.updated_at],
];

function toCsv(rows: LeadRow[]): string {
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
 * `-` or `@`, which makes "=HYPERLINK(...)" in a WhatsApp message a working attack on
 * the person who opens the export. Prefixing a quote neutralises it — and does the same
 * job for the phone number, which Excel would otherwise render as 9.19E+11.
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
