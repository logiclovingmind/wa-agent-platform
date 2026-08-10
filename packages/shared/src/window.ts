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

/** Meta sends timestamps as epoch seconds in a string. */
export function parseMetaTimestamp(timestamp: string): Date {
  return new Date(Number(timestamp) * 1000);
}
