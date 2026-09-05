import { and, gte, isNotNull, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { epLedger, gpLedger } from "@/db";

// Per-CHARACTER last-activity, for "recently active" filters/widgets
// (roster's Recently-active dropdown, dashboard's Active-by-Class board).
//
// Deliberately distinct from player_epgp_totals.lastActivityAt, which is
// per-PLAYER by design (EP/GP truly is a player-level concept — PLAN.md
// §4a). Using that player-level value for a "who's recently active"
// character list means every alt/mule silently inherits its main's most
// recent ledger row, inflating "98 characters active in 24h" when maybe
// 20 real people actually did anything (leader, 2026-09-05) — the fix is
// to ask each ledger row which CHARACTER it actually happened to.
//
// Bounded by `since` (always the widest UI window, 1 year today) rather
// than an unfiltered scan of the full ledger — index-assisted via each
// table's existing occurred_at index, not the kind of full-table
// aggregate PLAN.md §6 eliminated for totals (which had no filter at
// all). Still two full aggregation passes over up to a year of rows, so
// don't call this from a hot per-request path without caching if it ever
// shows up in D1 read-budget monitoring.
export async function getCharacterLastActivitySince(
  db: ReturnType<typeof drizzle>,
  since: Date,
): Promise<Map<number, Date>> {
  const [epRows, gpRows] = await Promise.all([
    db
      .select({ characterId: epLedger.characterId, lastMs: sql<number>`max(${epLedger.occurredAt})` })
      .from(epLedger)
      .where(and(isNotNull(epLedger.characterId), gte(epLedger.occurredAt, since)))
      .groupBy(epLedger.characterId),
    db
      .select({ characterId: gpLedger.characterId, lastMs: sql<number>`max(${gpLedger.occurredAt})` })
      .from(gpLedger)
      .where(and(isNotNull(gpLedger.characterId), gte(gpLedger.occurredAt, since)))
      .groupBy(gpLedger.characterId),
  ]);

  const result = new Map<number, Date>();
  for (const row of [...epRows, ...gpRows]) {
    if (row.characterId == null || row.lastMs == null) continue;
    // sql<>`max(...)` returns the raw stored integer (unix seconds), not a
    // Date — drizzle's timestamp-mode conversion only applies to plain
    // column selects.
    const d = new Date(row.lastMs * 1000);
    const existing = result.get(row.characterId);
    if (!existing || d > existing) result.set(row.characterId, d);
  }
  return result;
}
