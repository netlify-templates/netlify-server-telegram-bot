// Local time for schedules, with no date library: Intl knows the time zones.
//
// The rules:
// - a local time that doesn't exist (02:30 on a spring-forward day) runs at the
//   next valid minute;
// - a local time that happens twice runs once, the first time;
// - an occurrence missed while nothing could run is run once if it's less than
//   6 hours late, and skipped with a note otherwise.

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 = Monday ... 7 = Sunday */
  weekday: number;
}

export type Rule =
  | { kind: "at"; at: string }
  | { kind: "daily"; time: string; weekdays: number[] | null }
  | { kind: "every"; hours: number; anchor: string };

export const MAX_LATE_MS = 6 * 3600_000;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(date: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)) + 1,
  };
}

/** How far the zone's wall clock is ahead of UTC at this instant, in ms. */
function offsetMs(t: number, tz: string): number {
  const at = Math.floor(t / 1000) * 1000;
  const p = localParts(new Date(at), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
}

const shows = (t: number, tz: string, y: number, m: number, d: number, h: number, min: number) => {
  const p = localParts(new Date(t), tz);
  return p.year === y && p.month === m && p.day === d && p.hour === h && p.minute === min;
};

/**
 * The first instant the zone's clock shows this wall time. A wall time that
 * doesn't exist gives the end of the gap (the next valid minute).
 */
export function localToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const wall = Date.UTC(y, m - 1, d, h, min);
  const offsets = [...new Set([offsetMs(wall - 12 * 3600_000, tz), offsetMs(wall + 12 * 3600_000, tz)])];
  const matches = offsets
    .map((o) => wall - o)
    .filter((t) => shows(t, tz, y, m, d, h, min))
    .sort((a, b) => a - b);
  if (matches.length > 0) return new Date(matches[0]);

  // In a gap: find the transition between the instant read with the larger
  // offset (still before it) and the one read with the smaller (already after).
  let before = wall - Math.max(...offsets);
  let after = wall - Math.min(...offsets);
  const afterOffset = offsetMs(after, tz);
  while (after - before > 60_000) {
    const mid = before + Math.floor((after - before) / 120_000) * 60_000;
    if (offsetMs(mid, tz) === afterOffset) after = mid;
    else before = mid;
  }
  return new Date(after);
}

/** "YYYY-MM-DD" in the zone. */
export function localDay(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function nextLocalMidnight(after: Date, tz: string): Date {
  const p = localParts(after, tz);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz);
}

/** Parses a local "YYYY-MM-DDTHH:MM" in the zone. */
export function parseLocalDateTime(text: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return localToUtc(y, mo, d, h, mi, tz);
}

export function parseWeekdays(list: string[] | null | undefined): number[] | null {
  if (!list || list.length === 0) return null;
  const days = new Set<number>();
  for (const item of list) {
    const key = item.trim().toLowerCase();
    if (key === "weekdays") [1, 2, 3, 4, 5].forEach((d) => days.add(d));
    else if (key === "weekends") [6, 7].forEach((d) => days.add(d));
    else {
      const i = WEEKDAYS.indexOf(key.slice(0, 3));
      if (i < 0) throw new Error(`Unknown weekday "${item}"`);
      days.add(i + 1);
    }
  }
  return [...days].sort();
}

/** The rule's first time strictly after `after`, or null when it won't run again. */
export function nextRun(rule: Rule, after: Date, tz: string): Date | null {
  if (rule.kind === "at") {
    const at = new Date(rule.at);
    return at.getTime() > after.getTime() ? at : null;
  }
  if (rule.kind === "every") {
    const step = rule.hours * 3600_000;
    const anchor = new Date(rule.anchor).getTime();
    const k = Math.max(0, Math.floor((after.getTime() - anchor) / step) + 1);
    return new Date(anchor + k * step);
  }
  const [hh, mm] = rule.time.split(":").map(Number);
  const p = localParts(after, tz);
  for (let i = 0; i < 9; i++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const weekday = ((day.getUTCDay() + 6) % 7) + 1;
    if (rule.weekdays && !rule.weekdays.includes(weekday)) continue;
    const t = localToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
    if (t.getTime() > after.getTime()) return t;
  }
  return null;
}

/** What to do with an occurrence that came due at `due`, seen at `now`. */
export function planOccurrence(rule: Rule, due: Date, now: Date, tz: string): { run: boolean; lateMs: number; next: Date | null } {
  const lateMs = Math.max(0, now.getTime() - due.getTime());
  return { run: lateMs < MAX_LATE_MS, lateMs, next: nextRun(rule, now, tz) };
}

export function formatLocal(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function ruleText(rule: Rule, tz: string): string {
  if (rule.kind === "at") return `Once, ${formatLocal(new Date(rule.at), tz)}`;
  if (rule.kind === "every") return rule.hours === 1 ? "Every hour" : `Every ${rule.hours} hours`;
  const days = rule.weekdays;
  const when =
    !days || days.length === 7
      ? "Every day"
      : days.join() === "1,2,3,4,5"
        ? "Weekdays"
        : days.join() === "6,7"
          ? "Weekends"
          : days.map((d) => WEEKDAYS[d - 1][0].toUpperCase() + WEEKDAYS[d - 1].slice(1)).join(", ");
  return `${when} at ${rule.time}`;
}
