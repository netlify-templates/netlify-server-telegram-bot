import { describe, expect, it } from "vitest";
import { localDay, localToUtc, nextLocalMidnight, nextRun, parseWeekdays, planOccurrence, ruleText } from "../src/time.ts";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("local time", () => {
  it("converts an ordinary wall time", () => {
    expect(iso(localToUtc(2026, 11, 9, 8, 0, "Asia/Jerusalem"))).toBe("2026-11-09T06:00:00.000Z");
    expect(iso(localToUtc(2026, 7, 1, 8, 0, "America/New_York"))).toBe("2026-07-01T12:00:00.000Z");
  });

  it("runs a time skipped by DST at the next valid minute", () => {
    // Berlin springs forward at 02:00 on Mar 29, 2026: 02:30 doesn't exist, 03:00 (01:00 UTC) is next.
    expect(iso(localToUtc(2026, 3, 29, 2, 30, "Europe/Berlin"))).toBe("2026-03-29T01:00:00.000Z");
    // New York, Mar 8, 2026.
    expect(iso(localToUtc(2026, 3, 8, 2, 15, "America/New_York"))).toBe("2026-03-08T07:00:00.000Z");
  });

  it("takes the first of a time that happens twice", () => {
    // New York falls back at 02:00 on Nov 1, 2026: 01:30 happens in EDT (05:30 UTC), then EST.
    expect(iso(localToUtc(2026, 11, 1, 1, 30, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
  });

  it("finds the next local midnight and day", () => {
    const now = new Date("2026-11-09T22:30:00Z"); // 00:30 on the 10th in Jerusalem
    expect(localDay(now, "Asia/Jerusalem")).toBe("2026-11-10");
    expect(iso(nextLocalMidnight(now, "Asia/Jerusalem"))).toBe("2026-11-10T22:00:00.000Z");
  });
});

describe("schedule rules", () => {
  const weekdays8 = { kind: "daily" as const, time: "08:00", weekdays: [1, 2, 3, 4, 5] };

  it("finds the next weekday morning", () => {
    // Fri Nov 13, 2026, 09:00 in Jerusalem: next is Mon Nov 16 at 08:00.
    expect(iso(nextRun(weekdays8, new Date("2026-11-13T07:00:00Z"), "Asia/Jerusalem"))).toBe("2026-11-16T06:00:00.000Z");
    // Mon at 07:59 local: today at 08:00.
    expect(iso(nextRun(weekdays8, new Date("2026-11-16T05:59:00Z"), "Asia/Jerusalem"))).toBe("2026-11-16T06:00:00.000Z");
  });

  it("runs a repeated time once", () => {
    const rule = { kind: "daily" as const, time: "01:30", weekdays: null };
    const first = nextRun(rule, new Date("2026-11-01T04:00:00Z"), "America/New_York")!;
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z");
    // Computed again from just after the first run, it goes to the next day, not to 06:30 UTC.
    expect(iso(nextRun(rule, new Date(first.getTime() + 20_000), "America/New_York"))).toBe("2026-11-02T06:30:00.000Z");
  });

  it("runs a skipped time at the end of the gap", () => {
    const rule = { kind: "daily" as const, time: "02:30", weekdays: null };
    expect(iso(nextRun(rule, new Date("2026-03-28T12:00:00Z"), "Europe/Berlin"))).toBe("2026-03-29T01:00:00.000Z");
  });

  it("repeats every N hours from its anchor", () => {
    const rule = { kind: "every" as const, hours: 3, anchor: "2026-11-09T10:00:00Z" };
    expect(iso(nextRun(rule, new Date("2026-11-09T10:00:00Z"), "UTC"))).toBe("2026-11-09T13:00:00.000Z");
    expect(iso(nextRun(rule, new Date("2026-11-09T14:20:00Z"), "UTC"))).toBe("2026-11-09T16:00:00.000Z");
    expect(iso(nextRun(rule, new Date("2026-11-09T09:00:00Z"), "UTC"))).toBe("2026-11-09T10:00:00.000Z");
  });

  it("runs a one-off once", () => {
    const rule = { kind: "at" as const, at: "2026-11-10T09:00:00Z" };
    expect(iso(nextRun(rule, new Date("2026-11-09T09:00:00Z"), "UTC"))).toBe("2026-11-10T09:00:00.000Z");
    expect(nextRun(rule, new Date("2026-11-10T09:00:00Z"), "UTC")).toBeNull();
  });

  it("runs a missed occurrence under 6 hours late, and skips it after", () => {
    const due = new Date("2026-11-16T06:00:00Z");
    expect(planOccurrence(weekdays8, due, new Date("2026-11-16T11:59:00Z"), "Asia/Jerusalem").run).toBe(true);
    const late = planOccurrence(weekdays8, due, new Date("2026-11-16T12:30:00Z"), "Asia/Jerusalem");
    expect(late.run).toBe(false);
    expect(iso(late.next)).toBe("2026-11-17T06:00:00.000Z");
  });

  it("describes rules and parses weekdays", () => {
    expect(ruleText(weekdays8, "UTC")).toBe("Weekdays at 08:00");
    expect(ruleText({ kind: "every", hours: 1, anchor: "" }, "UTC")).toBe("Every hour");
    expect(parseWeekdays(["Mon", "wednesday"])).toEqual([1, 3]);
    expect(parseWeekdays(["weekdays"])).toEqual([1, 2, 3, 4, 5]);
    expect(() => parseWeekdays(["someday"])).toThrow();
  });
});
