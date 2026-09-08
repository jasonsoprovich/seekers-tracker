import { GUILD_TIMEZONE } from "./guild-timezone";

// EPGP dates that come from the guild sheet (ep_ledger/gp_ledger.occurred_at,
// cycles.start_date/end_date, decay_events.effective_date) are stored at
// UTC midnight: scripts/import-epgp.ts reads the sheet's `m/d/yy` cells via
// exceljs, which returns them as UTC-midnight Date objects, and the cycle
// boundaries are stored the same way so computeEpgpTotals' pre/current-cycle
// split stays consistent.
//
// Rendered with a plain `Date.toLocaleDateString()`, a viewer west of UTC
// (the guild is US/Mountain) sees the day before -- a 9/2 loot drop shows as
// 9/1. These are date-only values, so format them in UTC.
//
// Use this only for those sheet-origin / date-bucketed values. Genuine
// event timestamps (audit changed_at, decay applied_at, import created_at)
// are real wall-clock moments -- leave those on the viewer's local zone.
//
// EXCEPTION (post-live-test-1 LT-10): ledger rows written by the officer
// parser (`source === "parse"`) carry the real bid/attendance *timestamp*,
// not a UTC-midnight bucket. A raid that runs past ~8pm Eastern is already
// "tomorrow" in UTC, so those must be formatted in the guild's zone or the
// ledger shows every late-night raid a day ahead. Pass the row's `source`
// and parse-origin rows render in GUILD_TIMEZONE; everything else stays UTC.
export function ledgerDate(
  value: Date | string | number | null | undefined,
  source?: "import" | "manual" | "parse",
): string {
  if (value === null || value === undefined) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", { timeZone: source === "parse" ? GUILD_TIMEZONE : "UTC" });
}
