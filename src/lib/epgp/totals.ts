import { and, gte, inArray, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { epLedger, gpLedger } from "@/db";

import { getCurrentCycle } from "./cycles";
import { DEFAULT_SETTINGS, getSettingAt, getSettingsAt } from "./settings";

export type EpgpTotal = {
  playerId: number;
  ep: number;
  gp: number;
  epDecay: number;
  gpDecay: number;
  priorityRating: number;
  // Undecayed ledger sums and the pre-current-cycle portion of each, as of
  // `asOf`. Carried so src/lib/epgp/standings.ts can persist them and let a
  // legacy-model read re-derive the §1a haircut against a later cycle
  // boundary without re-summing the ledger. Unused under decay_model=global.
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

// Computes live EP/GP/Priority Rating straight from the ledgers — this
// replaces the old character_epgp mirror table. Confirmed cell-for-cell
// against the guild's live sheet's Totals tab (columns F/G/I/J — Effort
// Points, Gear Points, EP Decay, GP Decay — verified 2026-08-19 against
// Osui's row): the sheet pre-applies the *upcoming* cycle's decay to
// everything earned before the current cycle started, while decay already
// applied in past cycles lives as explicit negative ep_ledger/gp_ledger rows
// (so those are just summed like any other row, no special-casing needed
// here). The sheet also skips decay entirely for a character whose raw
// lifetime total hasn't reached the base value yet (Totals!$L$26/$L$28) —
// without that guard a brand-new member's tiny pre-cycle balance still gets
// docked 20%, which the sheet doesn't do.
//
//   rawEp = sum of every EP ledger row, undecayed
//   epDecay = rawEp < base_ep ? 0 : (points before current cycle start) * ep_decay
//   ep = rawEp - epDecay        (same for gp/gpDecay)
//   priority = (ep + base_ep) / (gp + base_gp)
//
// PLAN.md §11 Phase 3 task 3.11: grouped by player_id, not character_id —
// EP/GP earned on any of a player's characters (main, alt, or a
// pre-Phase-3 row still keyed to an alt's own id) now rolls up under one
// account, so a leader-approved main swap (players.main_character_id) no
// longer needs the old "always redirect an alt's write to its main's
// character_id" trick to keep totals correct (insertLedgerEntry still does
// it — harmless now, not load-bearing). Every ep_ledger/gp_ledger row
// already carries its own player_id (backfilled from characters.player_id
// at import time, task 3.9), so this groups directly off the ledger rows
// with no join back through characters.
export async function computeEpgpTotals(
  db: ReturnType<typeof drizzle>,
  opts: { asOf?: Date; playerIds?: number[] } = {},
): Promise<Map<number, EpgpTotal>> {
  const asOf = opts.asOf ?? new Date();
  // A targeted recompute (src/lib/epgp/standings.ts's per-write refresh)
  // pushes `player_id IN (...)` into the 4 aggregate scans so a single
  // ledger insert costs a few hundred index-seeked rows, not a full-table
  // GROUP BY. An empty array would mean "nobody" — treat it as unfiltered
  // rather than returning an empty map, so `refreshStandings({ playerIds: []
  // })` from a NULL-player edge case is a harmless no-op-ish full pass.
  const playerFilter = opts.playerIds && opts.playerIds.length > 0 ? opts.playerIds : null;
  const settings = await getEpgpSettings(db, asOf);
  // PLAN.md §11 Phase 5 task 5.2 / §1c — which cycle-decay model is in
  // force right now. "legacy" derives the 20% pre-cycle haircut below
  // (§1a); "global" trusts the raw ledger sums as-is, because 10%
  // compounding cycle decay (kind: "global_cycle", src/lib/epgp/decay.ts)
  // is applied as real stored negative rows at commit time — deriving
  // anything on top of that would double-decay. Both models coexist by
  // construction: pre-cutover ledger rows never change, so switching this
  // setting only changes how *this function* reads them, never the rows
  // themselves.
  const decayModel = (await getSettingAt(db, "decay_model", asOf)) ?? DEFAULT_SETTINGS.decay_model;

  // See cycles.ts's getCurrentCycle for why "current" isn't simply "most
  // recent by start date" (the sheet's Cycles tab is pre-populated with
  // future cycles).
  const currentCycle = await getCurrentCycle(db, asOf);
  // No cycles seeded yet (fresh dev DB): treat everything as "current cycle"
  // rather than crashing — nothing to decay yet.
  const cycleStart = currentCycle?.startDate ?? new Date(0);

  const epScoped = playerFilter ? inArray(epLedger.playerId, playerFilter) : undefined;
  const gpScoped = playerFilter ? inArray(gpLedger.playerId, playerFilter) : undefined;
  const [prePointsEp, curPointsEp, prePointsGp, curPointsGp] = await Promise.all([
    db
      .select({ playerId: epLedger.playerId, sum: sql<number>`coalesce(sum(${epLedger.points}), 0)` })
      .from(epLedger)
      .where(and(lt(epLedger.occurredAt, cycleStart), epScoped))
      .groupBy(epLedger.playerId),
    db
      .select({ playerId: epLedger.playerId, sum: sql<number>`coalesce(sum(${epLedger.points}), 0)` })
      .from(epLedger)
      .where(and(gte(epLedger.occurredAt, cycleStart), epScoped))
      .groupBy(epLedger.playerId),
    db
      .select({ playerId: gpLedger.playerId, sum: sql<number>`coalesce(sum(${gpLedger.points}), 0)` })
      .from(gpLedger)
      .where(and(lt(gpLedger.occurredAt, cycleStart), gpScoped))
      .groupBy(gpLedger.playerId),
    db
      .select({ playerId: gpLedger.playerId, sum: sql<number>`coalesce(sum(${gpLedger.points}), 0)` })
      .from(gpLedger)
      .where(and(gte(gpLedger.occurredAt, cycleStart), gpScoped))
      .groupBy(gpLedger.playerId),
  ]);

  // An orphaned row (§1e/§4d), or any row whose character has no player_id
  // yet (shouldn't happen post-Phase-3-backfill, but a future creation path
  // that forgets to set it would otherwise silently vanish into a phantom
  // "null" player rather than surfacing) — excluded here, same as
  // decay.ts's balance queries.
  const hasPlayer = <T extends { playerId: number | null }>(r: T) => r.playerId !== null;
  const preEp = new Map(prePointsEp.filter(hasPlayer).map((r) => [r.playerId as number, r.sum]));
  const curEp = new Map(curPointsEp.filter(hasPlayer).map((r) => [r.playerId as number, r.sum]));
  const preGp = new Map(prePointsGp.filter(hasPlayer).map((r) => [r.playerId as number, r.sum]));
  const curGp = new Map(curPointsGp.filter(hasPlayer).map((r) => [r.playerId as number, r.sum]));

  const playerIds = new Set([...preEp.keys(), ...curEp.keys(), ...preGp.keys(), ...curGp.keys()]);

  const totals = new Map<number, EpgpTotal>();
  for (const playerId of playerIds) {
    const preEpAmt = preEp.get(playerId) ?? 0;
    const curEpAmt = curEp.get(playerId) ?? 0;
    const preGpAmt = preGp.get(playerId) ?? 0;
    const curGpAmt = curGp.get(playerId) ?? 0;
    const rawEp = preEpAmt + curEpAmt;
    const rawGp = preGpAmt + curGpAmt;

    // global: no derivation — rawEp/rawGp already reflect every
    // global_cycle decay_events commit as a stored ledger row (§1c).
    // legacy: derive the flat, non-compounding 20% pre-cycle haircut (§1a),
    // unchanged from before this branch existed.
    const epDecay = decayModel === "global" ? 0 : rawEp < settings.base_ep ? 0 : preEpAmt * settings.ep_decay;
    const gpDecay = decayModel === "global" ? 0 : rawGp < settings.base_gp ? 0 : preGpAmt * settings.gp_decay;
    const ep = rawEp - epDecay;
    const gp = rawGp - gpDecay;
    const priorityRating = (ep + settings.base_ep) / (gp + settings.base_gp);
    totals.set(playerId, { playerId, ep, gp, epDecay, gpDecay, priorityRating, rawEp, rawGp, preCycleEp: preEpAmt, preCycleGp: preGpAmt });
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
