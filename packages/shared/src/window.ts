/**
 * Meta's 24-hour customer service window, minus a 10 minute safety margin.
 *
 * The margin is not decoration. Between the customer's message and our send sit a
 * 4s debounce, LLM latency, and clock skew between Meta and Cloudflare. Treating
 * the window as 24h00m produces sends that Meta rejects right at the boundary,
 * which is the single most common cause of "why didn't the bot reply?".
 */
export const WINDOW_MS = 23 * 60 * 60 * 1000 + 50 * 60 * 1000;

/** Everything is stored UTC. This is for display only. */
export const IST_TIME_ZONE = "Asia/Kolkata";

/** Computed from the customer's last inbound message, never from our own sends. */
export function windowExpiresAt(lastInboundAt: Date): Date {
  return new Date(lastInboundAt.getTime() + WINDOW_MS);
}

export function isWindowOpen(now: Date, expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  return now.getTime() < expiresAt.getTime();
}

/** IST is a fixed +5:30 with no daylight saving, so the offset is arithmetic. */
const IST_OFFSET_MINUTES = 330;

/**
 * Whether a client's business hours are open right now, from `HH:MM` strings in IST.
 *
 * Either bound missing means always open, which is every client until one asks for
 * hours. Open later than close is not a mistake — it is a window that crosses
 * midnight, which is what a restaurant open until 1am has.
 *
 * Arithmetic rather than `Intl.DateTimeFormat`: this runs on every inbound burst,
 * formatting a date costs real CPU against the 10ms budget, and IST never shifts.
 */
export function isWithinHours(now: Date, open: string | null, close: string | null): boolean {
  if (!open || !close) return true;

  const from = hhmm(open);
  const to = hhmm(close);
  if (from === null || to === null) return true;

  const minutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + IST_OFFSET_MINUTES) % 1440;
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

function hhmm(value: string): number | null {
  const [h, m] = value.split(":");
  const hours = Number(h);
  const mins = Number(m);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null;
  return hours * 60 + mins;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * An appointment slot as the customer should read it: "Mon 18 Aug, 10:30 am".
 *
 * This label is also the identifier. The model is offered a list of these, may only echo
 * one back, and the caller resolves it through the same list — so the format has to be
 * stable, and a change here is a change to the matching key, not just to presentation.
 *
 * Arithmetic rather than `Intl.DateTimeFormat`, for the same reason as `isWithinHours`
 * above: this runs on the reply path against a 10ms budget, and IST never shifts.
 */
export function istSlotLabel(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);

  const hours24 = ist.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(ist.getUTCMinutes()).padStart(2, "0");

  return (
    `${DAY_NAMES[ist.getUTCDay()]} ${ist.getUTCDate()} ${MONTH_NAMES[ist.getUTCMonth()]}, ` +
    `${hours12}:${minutes} ${hours24 < 12 ? "am" : "pm"}`
  );
}

/** Meta sends timestamps as epoch seconds in a string. */
export function parseMetaTimestamp(timestamp: string): Date {
  return new Date(Number(timestamp) * 1000);
}
