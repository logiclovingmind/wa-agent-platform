import type { NumberHealth } from "./api";
import { SAFETY_LABEL, type AdminHealth } from "./supabase";

/**
 * The traffic light, written down once.
 *
 * docs/admin-panel.md §2 fixes the rule: **red = not replying** (token dead,
 * unsubscribed, wallet empty, never answered anyone), **amber = degraded** (Meta
 * throttling, a rejected send, an open safety flag, someone waiting too long), green
 * otherwise. It lives in one function rather than in the table's JSX because a colour
 * that means slightly different things in two places is worse than no colour.
 *
 * Every input is optional on purpose. The Meta half costs a round trip per client and is
 * fetched only when a row is opened, so this has to give a useful answer from our own
 * data alone and sharpen when the rest arrives — and it must never call something green
 * that it simply has not checked.
 */
export type Level = "red" | "amber" | "green";

/** Amber past this. Half an hour is the auto-return window in the DO, so it is the point where a wait stops being a handover and starts being a lapse. */
const WAITING_LIMIT_MS = 30 * 60 * 1000;

/** Meta expiry worth acting on. Two weeks is enough to reach a client who replies slowly. */
const TOKEN_WARN_MS = 14 * 24 * 60 * 60 * 1000;

export interface HealthInput {
  db: AdminHealth | undefined;
  /** Undefined means Meta has not been checked, which is not the same as healthy. */
  meta: NumberHealth[] | undefined;
  /** Platform-wide: one empty wallet stops every client at once. */
  walletEmpty: boolean;
}

export interface Verdict {
  level: Level;
  /** Plain sentences, worst first. An indicator nobody can act on is decoration. */
  reasons: string[];
  /** True until the Meta half has been fetched, so the UI can say "not fully checked". */
  partial: boolean;
}

/** Micros of INR are the storage unit; ₹ is the unit the reader thinks in. */
function rupees(micros: number): string {
  return `₹${(micros / 1_000_000).toFixed(2)}`;
}

/** A wait of two days reported in minutes is a number nobody reads. */
function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

export function health({ db, meta, walletEmpty }: HealthInput): Verdict {
  const red: string[] = [];
  const amber: string[] = [];

  if (walletEmpty) red.push("LLM wallet is empty — no client can reply");

  for (const n of meta ?? []) {
    const where = n.display_phone_number;

    if (n.token.valid === false) red.push(`${where}: Meta token is no longer valid`);
    // Explicitly false, not falsy: null means Meta did not answer, and "we could not
    // check" must never be reported as "it is broken".
    if (n.subscribed === false) {
      red.push(`${where}: the app is not subscribed to the WABA — no webhooks arrive`);
    }

    if (n.token.expires_at !== null) {
      const days = Math.round((n.token.expires_at * 1000 - Date.now()) / 86_400_000);
      if (n.token.expires_at * 1000 - Date.now() < TOKEN_WARN_MS) {
        amber.push(`${where}: token expires in ${days} day${days === 1 ? "" : "s"}`);
      }
    }

    const quality = n.number?.quality_rating;
    if (quality && quality !== "GREEN" && quality !== "UNKNOWN") {
      // Meta throttles quietly, and the client reports it as "the bot stopped replying
      // to new people" — a bug in our software, as far as they can tell.
      amber.push(`${where}: Meta quality rating is ${quality.toLowerCase()}`);
    }

    if (n.template && n.template.status !== "APPROVED") {
      amber.push(
        `${where}: re-engagement template is ${n.template.status?.toLowerCase() ?? "missing from this WABA"}`,
      );
    }
  }

  if (db) {
    // §2 puts a hit cap under red: the client is not replying. Paused is amber, not
    // red, because somebody chose it — the panel has to distinguish "broken" from
    // "switched off on purpose" or the light stops meaning anything.
    if (db.cap_micros !== null && db.month_spend_micros >= db.cap_micros) {
      red.push(`monthly spend cap reached (${rupees(db.cap_micros)}) — the AI is not replying`);
    }
    if (db.ai_paused) amber.push("the AI is paused — every conversation goes to a person");

    // Inbound with nothing ever sent back is the shape of a broken onboarding, and it
    // reads as a healthy quiet client on every other column of the table. Not a fault
    // while the AI is deliberately off, which is the same silence for a good reason.
    if (db.last_inbound_at && !db.last_outbound_at && !db.ai_paused) {
      red.push("messages are arriving and none has ever been answered");
    }

    if (db.waiting_since) {
      const waited = Date.now() - Date.parse(db.waiting_since);
      if (waited > WAITING_LIMIT_MS) amber.push(`someone has been waiting ${duration(waited)}`);
    }

    if (db.last_failed_at && Date.now() - Date.parse(db.last_failed_at) < 86_400_000) {
      amber.push("Meta rejected a send in the last 24 hours");
    }

    const flags = Object.entries(db.open_flags_by_kind);
    if (flags.length > 0) {
      amber.push(
        `open safety flags: ${flags
          .map(([kind, n]) => `${n} ${SAFETY_LABEL[kind as keyof typeof SAFETY_LABEL] ?? kind}`)
          .join(", ")}`,
      );
    }
  }

  return {
    level: red.length > 0 ? "red" : amber.length > 0 ? "amber" : "green",
    reasons: [...red, ...amber],
    partial: meta === undefined,
  };
}
