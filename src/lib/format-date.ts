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
export function ledgerDate(value: Date | string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", { timeZone: "UTC" });
}
