import { and, inArray, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { epLedger, gpLedger, playerEpgpTotals } from "@/db";

import { computeEpgpTotals, type EpgpTotal } from "./totals";

// Maintains the `player_epgp_totals` materialized table (see its schema
// comment). `computeEpgpTotals` stays the single source of the math; this
// module only decides *when* to persist its output and how to read it back
// cheaply. Every place that used to call `invalidateEpgpTotalsCache()` now
// calls `refreshStandings()` instead — same call sites, opposite direction
// (push the new numbers in, rather than blow a cache away and hope the next
// reader recomputes).

export type StandingsRow = EpgpTotal & { lastActivityAt: Date | null };

// Most-recent EP/GP occurredAt per player — the roster's "Last Attended"
// column, folded in here so a standings read is one table scan instead of
// roster/page.tsx running its own two GROUP BY max() queries over the full
// ledgers on every request.
async function lastActivityByPlayer(
  db: ReturnType<typeof drizzle>,
  playerFilter: number[] | null,
): Promise<Map<number, Date>> {
  const epScoped = playerFilter ? inArray(epLedger.playerId, playerFilter) : undefined;
  const gpScoped = playerFilter ? inArray(gpLedger.playerId, playerFilter) : undefined;
  const [ep, gp] = await Promise.all([
    db
      .select({ playerId: epLedger.playerId, lastAt: sql<number | null>`max(${epLedger.occurredAt})` })
      .from(epLedger)
      .where(and(epScoped))
      .groupBy(epLedger.playerId),
    db
      .select({ playerId: gpLedger.playerId, lastAt: sql<number | null>`max(${gpLedger.occurredAt})` })
      .from(gpLedger)
      .where(and(gpScoped))
      .groupBy(gpLedger.playerId),
  ]);
  const out = new Map<number, Date>();
  for (const r of [...ep, ...gp]) {
    if (r.playerId == null || r.lastAt == null) continue;
    const prev = out.get(r.playerId);
    // occurred_at is stored in seconds.
    if (!prev || r.lastAt * 1000 > prev.getTime()) out.set(r.playerId, new Date(r.lastAt * 1000));
  }
  return out;
}

type RefreshOpts =
  // Recompute exactly these players (a ledger insert/edit/delete's own
  // player) — cheap, index-seeked. A player id whose ledger rows are now
  // all gone has its totals row deleted.
  | { playerIds: number[]; asOf?: Date }
  // Recompute every player — used after a settings change (base/decay
  // rates move everyone's priority), any decay commit/reverse (touches
  // many players at once), a cycle rollover under decay_model=legacy, and
  // the initial backfill. Rows for players with no ledger history are
  // pruned.
  | { all: true; asOf?: Date };

export async function refreshStandings(db: ReturnType<typeof drizzle>, opts: RefreshOpts): Promise<void> {
  const asOf = opts.asOf ?? new Date();
  const scoped = "playerIds" in opts;
  const playerFilter = scoped ? opts.playerIds.filter((id): id is number => Number.isFinite(id)) : null;

  // Nothing to do — e.g. a ledger row whose character has no player_id yet
  // (PLAN.md §16): it contributes to no total, same as computeEpgpTotals
  // excludes it.
  if (scoped && (playerFilter as number[]).length === 0) return;

  const [totals, lastActivity] = await Promise.all([
    computeEpgpTotals(db, { asOf, ...(playerFilter ? { playerIds: playerFilter } : {}) }),
    lastActivityByPlayer(db, playerFilter),
  ]);

  const now = new Date();
  for (const t of totals.values()) {
    const row = {
      playerId: t.playerId,
      ep: t.ep,
      gp: t.gp,
      epDecay: t.epDecay,
      gpDecay: t.gpDecay,
      priorityRating: t.priorityRating,
      rawEp: t.rawEp,
      rawGp: t.rawGp,
      preCycleEp: t.preCycleEp,
      preCycleGp: t.preCycleGp,
      lastActivityAt: lastActivity.get(t.playerId) ?? null,
      updatedAt: now,
    };
    await db
      .insert(playerEpgpTotals)
      .values(row)
      .onConflictDoUpdate({ target: playerEpgpTotals.playerId, set: row });
  }

  // Prune stale rows: a scoped refresh only revisits the ids it was asked
  // about that produced no total (all their rows deleted); a full refresh
  // drops anyone no longer in the ledger at all. Deletes are chunked —
  // Miniflare's D1 trips "too many SQL variables" well under SQLite's
  // nominal 999 (see scripts/import-sos-bot-dump.ts's note).
  let gone: number[];
  if (scoped) {
    gone = (playerFilter as number[]).filter((id) => !totals.has(id));
  } else {
    const existing = await db.select({ id: playerEpgpTotals.playerId }).from(playerEpgpTotals);
    gone = existing.map((r) => r.id).filter((id) => !totals.has(id));
  }
  for (let i = 0; i < gone.length; i += 100) {
    await db.delete(playerEpgpTotals).where(inArray(playerEpgpTotals.playerId, gone.slice(i, i + 100)));
  }
}

// The read path that replaces getCachedEpgpTotals — one scan of a
// ~one-row-per-player table, always current. Shape-compatible with what
// computeEpgpTotals returned (a Map keyed by playerId) so callers only
// change the import, plus `lastActivityAt` for the roster.
export async function getStandings(db: ReturnType<typeof drizzle>): Promise<Map<number, StandingsRow>> {
  const rows = await db.select().from(playerEpgpTotals);
  const out = new Map<number, StandingsRow>();
  for (const r of rows) {
    out.set(r.playerId, {
      playerId: r.playerId,
      ep: r.ep,
      gp: r.gp,
      epDecay: r.epDecay,
      gpDecay: r.gpDecay,
      priorityRating: r.priorityRating,
      rawEp: r.rawEp,
      rawGp: r.rawGp,
      preCycleEp: r.preCycleEp,
      preCycleGp: r.preCycleGp,
      lastActivityAt: r.lastActivityAt ?? null,
    });
  }
  return out;
}
