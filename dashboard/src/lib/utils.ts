import { useEffect, useState } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's class merger: later Tailwind classes win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Under this, the window is close enough that the owner should act now, not later. */
export const WINDOW_URGENT_MS = 2 * 60 * 60 * 1000;

/**
 * Time left in Meta's 24h service window. Once it hits zero the only way to reach the
 * customer is a paid template, so this is a countdown and not a timestamp.
 */
export function windowLeft(
  expiresAt: string | null,
): { text: string; urgent: boolean; closed: boolean } | null {
  if (!expiresAt) return null;

  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return { text: "window closed", urgent: true, closed: true };

  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return {
    text: hours > 0 ? `${hours}h ${minutes % 60}m left` : `${minutes}m left`,
    urgent: ms <= WINDOW_URGENT_MS,
    closed: false,
  };
}

/** Re-renders on a timer so a countdown does not sit frozen on an open tab. */
export function useNow(everyMs = 30_000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
}

/** Invariant 12: everything is stored UTC and shown IST, whatever the browser's clock says. */
export function ist(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
