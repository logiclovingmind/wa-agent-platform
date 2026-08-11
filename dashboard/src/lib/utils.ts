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

/**
 * Micro-rupees to something an owner can read. One reply costs about ₹0.003 and a busy
 * month costs a few rupees, so a fixed number of decimals is either noise or a row of
 * zeros: under ₹1 keeps three decimals, above it rounds to paise.
 */
export function inr(micros: number): string {
  const rupees = micros / 1_000_000;
  if (rupees > 0 && rupees < 1) return `₹${rupees.toFixed(3)}`;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Today on the IST calendar as `YYYY-MM-DD` — `en-CA` is the locale that formats that
 * way. Month boundaries are computed by offsetting from now, never by trusting the
 * browser's own timezone (data-model.md, "Time").
 */
export function istToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Calendar arithmetic on a `YYYY-MM-DD` day. No timezone involved, so none to get wrong. */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10);
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
