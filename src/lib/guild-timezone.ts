// The guild runs its raid schedule on Eastern time (leader, 2026-09-05: "a
// normal monday VT raid starts at 8:30 EST and ends at 11:30 EST" — i.e.
// wall-clock Eastern, DST included, not a fixed UTC offset). Any place that
// buckets activity into calendar days for guild-wide display (Raids &
// Events grouping today; likely the cycle/rules info page's cycle
// start/end later) should bucket by this zone, not UTC — a raid that starts
// before UTC midnight and runs past it is one Eastern evening, not two
// separate raid nights.
//
// A per-user profile timezone preference (leader's "perhaps... if we want
// to adjust things for their own viewing") is a separate, larger feature —
// not built yet. This module is the seam: every call site takes an
// optional `timeZone` override defaulting to GUILD_TIMEZONE, so a future
// per-viewer preference only has to thread a different IANA zone name
// through, not touch this bucketing logic.
export const GUILD_TIMEZONE = "America/New_York";

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dateFormatterCache.get(timeZone);
  if (!f) {
    // en-CA formats as YYYY-MM-DD, which is exactly the bucket key format
    // the rest of the app already uses (raids.raidDate, etc).
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatterCache.set(timeZone, f);
  }
  return f;
}

const hourFormatterCache = new Map<string, Intl.DateTimeFormat>();
function hourFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = hourFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hour12: false });
    hourFormatterCache.set(timeZone, f);
  }
  return f;
}

// The calendar-date string (YYYY-MM-DD) a given instant falls on in the
// target zone — the timezone-aware replacement for
// `strftime('%Y-%m-%d', col, 'unixepoch')`, which is UTC-only.
export function toGuildDateString(date: Date, timeZone: string = GUILD_TIMEZONE): string {
  return dateFormatter(timeZone).format(date);
}

function addDaysUtcDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

// The UTC instant that is local midnight for `dateStr` in `timeZone`. Works
// by scanning every UTC offset a real-world zone could plausibly hold
// (-12:00 to +14:00, 30-minute steps — covers every IANA zone including
// half-hour and 45-minute ones at this granularity for the whole-hour DST
// shifts this app cares about) and picking whichever candidate instant
// actually reads back as local midnight — rather than looking up
// transition rules or depending on Intl's newer 'shortOffset'
// timeZoneName support (uneven across JS engines, including some Workers
// runtimes).
function findMidnightUTC(dateStr: string, timeZone: string): Date | null {
  const base = Date.parse(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base)) return null;
  for (let offsetMinutes = -12 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 30) {
    // offsetMinutes is UTC-minus-local (e.g. +300 for America/New_York's
    // EST, UTC-5): local midnight is UTC midnight PLUS that many minutes.
    const candidate = new Date(base + offsetMinutes * 60_000);
    if (toGuildDateString(candidate, timeZone) !== dateStr) continue;
    const hh = hourFormatter(timeZone).format(candidate);
    if (hh === "00" || hh === "24") return candidate;
  }
  return null;
}

// [start, end) UTC instants spanning one full calendar day of `dateStr` in
// `timeZone`. Each boundary is found independently (not assumed to be
// exactly 86_400_000ms apart), so a DST transition day — 23 or 25 hours
// long in that zone — still gets its real boundaries rather than a
// silently-shifted end.
export function guildDayBounds(dateStr: string, timeZone: string = GUILD_TIMEZONE): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const start = findMidnightUTC(dateStr, timeZone);
  if (!start) return null;
  const end = findMidnightUTC(addDaysUtcDateString(dateStr, 1), timeZone);
  if (!end) return null;
  return { start, end };
}
