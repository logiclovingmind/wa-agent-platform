import { describe, expect, it } from "vitest";
import {
  IST_TIME_ZONE,
  WINDOW_MS,
  isWindowOpen,
  parseMetaTimestamp,
  windowExpiresAt,
} from "@wa/shared";

// Test 2. The 10 minute margin is the whole point: a 24h00m window produces sends
// Meta rejects at the boundary.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("window_expires_at", () => {
  const lastInbound = new Date("2026-03-01T04:20:00.000Z");
  const expires = windowExpiresAt(lastInbound);

  it("expires 10 minutes short of 24 hours", () => {
    expect(WINDOW_MS).toBe(24 * HOUR - 10 * MINUTE);
    expect(expires.toISOString()).toBe("2026-03-02T04:10:00.000Z");
  });

  it("is open just inside the margin and closed just outside it", () => {
    expect(isWindowOpen(new Date(lastInbound.getTime() + 23 * HOUR + 49 * MINUTE), expires)).toBe(
      true,
    );
    expect(isWindowOpen(new Date(lastInbound.getTime() + 23 * HOUR + 51 * MINUTE), expires)).toBe(
      false,
    );
  });

  it("is closed at the boundary itself, not open", () => {
    expect(isWindowOpen(expires, expires)).toBe(false);
  });

  it("is closed during the last 10 minutes Meta would still accept", () => {
    // Inside Meta's 24h but outside ours. Deliberately conservative.
    expect(isWindowOpen(new Date(lastInbound.getTime() + 24 * HOUR - MINUTE), expires)).toBe(false);
  });

  it("treats a conversation with no window as closed", () => {
    expect(isWindowOpen(new Date(), null)).toBe(false);
    expect(isWindowOpen(new Date(), undefined)).toBe(false);
  });
});

describe("IST", () => {
  it("crosses the IST date boundary without moving the instant", () => {
    // 23:00 IST on 1 March is 17:30 UTC. The window ends the next IST day; the
    // arithmetic must not care, because everything stored is UTC.
    const lastInbound = new Date("2026-03-01T17:30:00.000Z");
    const expires = windowExpiresAt(lastInbound);

    expect(expires.toISOString()).toBe("2026-03-02T17:20:00.000Z");

    const istDay = (d: Date) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: IST_TIME_ZONE, dateStyle: "short" }).format(d);
    expect(istDay(lastInbound)).toBe("2026-03-01");
    expect(istDay(expires)).toBe("2026-03-02");
  });

  it("does not shift across a UTC DST change elsewhere in the world", () => {
    // IST has no DST. A window opened before the US spring-forward must still be
    // exactly WINDOW_MS long.
    const before = new Date("2026-03-08T06:00:00.000Z");
    expect(windowExpiresAt(before).getTime() - before.getTime()).toBe(WINDOW_MS);
  });
});

describe("parseMetaTimestamp", () => {
  it("reads Meta's epoch seconds as a string", () => {
    expect(parseMetaTimestamp("1772000000").toISOString()).toBe("2026-02-25T06:13:20.000Z");
  });
});
