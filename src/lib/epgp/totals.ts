import { and, eq, inArray, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { decayEvents, epLedger, gpLedger } from "@/db";

import { getSettingsAt } from "./settings";

// The "EP Decay" / "GP Decay" columns on /roster and the ledger Totals tab
// mean *cumulative cycle decay* — the same thing the sheet's Totals!I/J
// show. Expansion decay (§1b) and departure wipes (§1e) are folded into the
// balance and not surfaced separately, exactly as the sheet does it.
const CYCLE_DECAY_KINDS = ["legacy_cycle", "global_cycle"] as const;

export type EpgpTotal = {
  playerId: number;
  ep: number;
  gp: number;
  epDecay: number;
  gpDecay: number;
  priorityRating: number;
  // `rawEp`/`rawGp` are the undecayed sums (ep + epDecay) — a display-only
  // column on /roster. `preCycleEp`/`preCycleGp` are vestigial (they backed
  // the old legacy read-time re-derivation, removed with the decay_model
  // branch — see docs/decay-refactor-plan.md); always 0 now, kept so
  // src/lib/epgp/standings.ts and player_epgp_totals don't need a migration.
  rawEp: number;
  rawGp: number;
  preCycleEp: number;
  preCycleGp: number;
};

// Settings and the "current cycle" are resolved as of `asOf` (default: real
// now). Every production caller uses the default — the parameter exists so
// the verification harness (scripts/verify-harness.ts) can pin a fixed date
// and test the decay *math* deterministically, instead of the veteran-decay
// fixtures drifting every time the wall clock crosses a cycle boundary and
// more pre-cycle EP falls under the legacy §1a haircut.
export async function getEpgpSettings(
  db: ReturnType<typeof drizzle>,
  asOf: Date = new Date(),
): Promise<Record<string, number>> {
  const raw = await getSettingsAt(db, asOf);
  const settings: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const num = Number(value);
    if (Number.isFinite(num)) settings[key] = num;
  }
  return settings;
}

// Live EP/GP/Priority Rating straight off the ledgers. A total is a plain
// SUM(): every decay — the sheet's historical §1a haircut (materialised
// once by scripts/bake-legacy-decay.ts, kind "legacy_cycle"), an expansion
// decay, a global cycle decay — is a real negative ep_ledger/gp_ledger row,
// so there is nothing to derive here.
//
//   ep       = SUM(every EP ledger row for the player)     -- the balance
//   epDecay  = -SUM(rows linked to a decay_event)          -- display only
//   rawEp    = ep + epDecay                                -- undecayed, display only
//   priority = (ep + base_ep) / (gp + base_gp)             -- same for gp
//
// `decay_model` no longer changes anything in this function (that
// retroactive read-time switch was the bug — docs/decay-refactor-plan.md);
// it is only the /epgp/decay form's default rate/label now.
//
// PLAN.md §11 Phase 3 task 3.11: grouped by player_id, not character_id —
// EP/GP earned on any of a player's characters (main, alt, or a
// pre-Phase-3 row still keyed to an alt's own id) rolls up under one
// account. Every ep_ledger/gp_ledger row already carries its own player_id
// (backfilled from characters.player_id at import time, task 3.9), so this
// groups directly off the ledger rows with no join back through characters.
export async function computeEpgpTotals(
  db: ReturnType<typeof drizzle>,
  opts: { asOf?: Date; playerIds?: number[] } = {},
): Promise<Map<number, EpgpTotal>> {
  const asOf = opts.asOf ?? new Date();
  // A targeted recompute (src/lib/epgp/standings.ts's per-write refresh)
  // pushes `player_id IN (...)` into the aggregate scans so a single ledger
  // insert costs a few hundred index-seeked rows, not a full-table GROUP
  // BY. An empty array would mean "nobody" — treat it as unfiltered rather
  // than returning an empty map, so `refreshStandings({ playerIds: [] })`
  // from a NULL-player edge case is a harmless no-op-ish full pass.
  const playerFilter = opts.playerIds && opts.playerIds.length > 0 ? opts.playerIds : null;
  const settings = await getEpgpSettings(db, asOf);

  const epScoped = playerFilter ? inArray(epLedger.playerId, playerFilter) : undefined;
  const gpScoped = playerFilter ? inArray(gpLedger.playerId, playerFilter) : undefined;
  const sumPoints = (col: typeof epLedger.points | typeof gpLedger.points) => sql<number>`coalesce(sum(${col}), 0)`;
  const [epAllRows, epDecayRows, gpAllRows, gpDecayRows] = await Promise.all([
    // ep — every row for the player (the balance)
    db.select({ playerId: epLedger.playerId, sum: sumPoints(epLedger.points) }).from(epLedger).where(epScoped).groupBy(epLedger.playerId),
    // epDecay — only the rows from a cycle-decay event (display; see CYCLE_DECAY_KINDS)
    db
      .select({ playerId: epLedger.playerId, sum: sumPoints(epLedger.points) })
      .from(epLedger)
      .innerJoin(decayEvents, eq(epLedger.decayEventId, decayEvents.id))
      .where(and(inArray(decayEvents.kind, [...CYCLE_DECAY_KINDS]), epScoped))
      .groupBy(epLedger.playerId),
    db.select({ playerId: gpLedger.playerId, sum: sumPoints(gpLedger.points) }).from(gpLedger).where(gpScoped).groupBy(gpLedger.playerId),
    db
      .select({ playerId: gpLedger.playerId, sum: sumPoints(gpLedger.points) })
      .from(gpLedger)
      .innerJoin(decayEvents, eq(gpLedger.decayEventId, decayEvents.id))
      .where(and(inArray(decayEvents.kind, [...CYCLE_DECAY_KINDS]), gpScoped))
      .groupBy(gpLedger.playerId),
  ]);

  // An orphaned row (§1e/§4d), or any row whose character has no player_id
  // yet (shouldn't happen post-Phase-3-backfill, but a future creation path
  // that forgets to set it would otherwise silently vanish into a phantom
  // "null" player rather than surfacing) — excluded here, same as
  // decay.ts's balance queries.
  const hasPlayer = <T extends { playerId: number | null }>(r: T) => r.playerId !== null;
  const epAll = new Map(epAllRows.filter(hasPlayer).map((r) => [r.playerId as number, r.sum]));
  const epDec = new Map(epDecayRows.filter(hasPlayer).map((r) => [r.playerId as number, r.sum]));
  const gpAll = new Map(gpAllRows.filter(hasPlayer).map((r) => [r.playerId as number, r.sum]));
  const gpDec = new Map(gpDecayRows.filter(hasPlayer).map((r) => [r.playerId as number, r.sum]));

  const playerIds = new Set([...epAll.keys(), ...gpAll.keys()]);

  const totals = new Map<number, EpgpTotal>();
  for (const playerId of playerIds) {
    const ep = epAll.get(playerId) ?? 0;
    const gp = gpAll.get(playerId) ?? 0;
    // decay rows are stored negative; report the haircut as a positive number.
    const epDecay = -(epDec.get(playerId) ?? 0);
    const gpDecay = -(gpDec.get(playerId) ?? 0);
    const rawEp = ep + epDecay;
    const rawGp = gp + gpDecay;
    const priorityRating = (ep + settings.base_ep) / (gp + settings.base_gp);
    totals.set(playerId, { playerId, ep, gp, epDecay, gpDecay, priorityRating, rawEp, rawGp, preCycleEp: 0, preCycleGp: 0 });
  }

  return totals;
}

// computeEpgpTotals runs 4 GROUP BY SUM() queries over the full
// ep_ledger/gp_ledger — every unfiltered call (the default) scans every
// row. It used to be fronted by a 45s Cloudflare edge cache
// (getCachedEpgpTotals / invalidateEpgpTotalsCache, PLAN.md §6 tasks
// 0.1-0.4) so a burst of /roster loads collapsed to one D1 hit. That
// cache is gone as of the standings-table work: reads now go through
// `getStandings` (src/lib/epgp/standings.ts) against the materialized
// `player_epgp_totals`, and writes call `refreshStandings` where they used
// to invalidate. This function stays as the reference implementation
// (scripts/verify-harness.ts) and the thing `refreshStandings` recomputes
// from — production reads no longer call it directly.
