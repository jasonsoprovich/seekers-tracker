import { gte, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { cycles, epLedger, gpLedger } from "@/db";

import { DEFAULT_SETTINGS, getSettingAt, getSettingsAt } from "./settings";

export type EpgpTotal = {
  playerId: number;
  ep: number;
  gp: number;
  epDecay: number;
  gpDecay: number;
  priorityRating: number;
};

// Totals are always computed "as of now" — this predates the effective-
// dated settings table (PLAN.md §4i, Phase 1) and stays that way until a
// later phase actually needs a rate to apply differently to old vs new
// ledger rows (the mutable cap in §2, the decay-model cutover in §1c).
// Until then, "now" is the only date any caller needs.
export async function getEpgpSettings(db: ReturnType<typeof drizzle>): Promise<Record<string, number>> {
  const raw = await getSettingsAt(db, new Date());
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
export async function computeEpgpTotals(db: ReturnType<typeof drizzle>): Promise<Map<number, EpgpTotal>> {
  const settings = await getEpgpSettings(db);
  // PLAN.md §11 Phase 5 task 5.2 / §1c — which cycle-decay model is in
  // force right now. "legacy" derives the 20% pre-cycle haircut below
  // (§1a); "global" trusts the raw ledger sums as-is, because 10%
  // compounding cycle decay (kind: "global_cycle", src/lib/epgp/decay.ts)
  // is applied as real stored negative rows at commit time — deriving
  // anything on top of that would double-decay. Both models coexist by
  // construction: pre-cutover ledger rows never change, so switching this
  // setting only changes how *this function* reads them, never the rows
  // themselves.
  const decayModel = (await getSettingAt(db, "decay_model", new Date())) ?? DEFAULT_SETTINGS.decay_model;

  // The sheet's Cycles tab is pre-populated with future cycles (observed
  // 2026-08-18: rows exist through cycle 72 / mid-November), so "most
  // recent by start date" is NOT "current" — it has to be the cycle whose
  // [start, end] actually contains now. Falls back to the most recent
  // *started* cycle if the calendar ever has a gap (a raid week not yet
  // added), so points earned after the last known cycle still count as
  // "current" rather than vanishing into a mismatch.
  const now = new Date();
  const allCycles = await db.select().from(cycles).orderBy(sql`${cycles.startDate} asc`);
  const containingCycle = allCycles.find((c) => c.startDate <= now && now <= c.endDate);
  const startedCycles = allCycles.filter((c) => c.startDate <= now);
  const currentCycle = containingCycle ?? startedCycles.at(-1);
  // No cycles seeded yet (fresh dev DB): treat everything as "current cycle"
  // rather than crashing — nothing to decay yet.
  const cycleStart = currentCycle?.startDate ?? new Date(0);

  const [prePointsEp, curPointsEp, prePointsGp, curPointsGp] = await Promise.all([
    db
      .select({ playerId: epLedger.playerId, sum: sql<number>`coalesce(sum(${epLedger.points}), 0)` })
      .from(epLedger)
      .where(lt(epLedger.occurredAt, cycleStart))
      .groupBy(epLedger.playerId),
    db
      .select({ playerId: epLedger.playerId, sum: sql<number>`coalesce(sum(${epLedger.points}), 0)` })
      .from(epLedger)
      .where(gte(epLedger.occurredAt, cycleStart))
      .groupBy(epLedger.playerId),
    db
      .select({ playerId: gpLedger.playerId, sum: sql<number>`coalesce(sum(${gpLedger.points}), 0)` })
      .from(gpLedger)
      .where(lt(gpLedger.occurredAt, cycleStart))
      .groupBy(gpLedger.playerId),
    db
      .select({ playerId: gpLedger.playerId, sum: sql<number>`coalesce(sum(${gpLedger.points}), 0)` })
      .from(gpLedger)
      .where(gte(gpLedger.occurredAt, cycleStart))
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
    totals.set(playerId, { playerId, ep, gp, epDecay, gpDecay, priorityRating });
  }

  return totals;
}

// computeEpgpTotals runs 4 unfiltered GROUP BY SUM() queries over the full
// ep_ledger/gp_ledger — D1 scans every row on every call, and it was being
// called uncached from a server component (roster/page.tsx, re-runs per
// request) plus three officer API routes. That's what burns the 5M/day
// free-tier row-read budget (PLAN.md §6). Cache the result in Cloudflare's
// edge Cache API under a synthetic key — there's no real inbound request
// this response corresponds to, so `cache.put` needs a made-up GET Request
// to key off. TTL is short (not correctness-critical data — EPGP standings
// tolerate a ~1min-stale read) but long enough to collapse a burst of page
// loads into one D1 hit.
const TOTALS_CACHE_TTL_SECONDS = 45;
const TOTALS_CACHE_KEY = new Request("https://seekers-tracker.internal/cache/epgp-totals");

// cloudflare-env.d.ts's CacheStorage/Cache (the Workers runtime's single
// `.default` cache) get shadowed by the "dom" lib's same-named types (the
// browser Cache Storage API — named caches only, no `.default`) once both
// are in `tsconfig.json`'s `lib`, which this Next.js app needs for its
// client-side code. `caches` resolves to the DOM interface at the type
// level even though the Workers runtime object underneath is the
// Cloudflare one, so reach `.default` through a narrow local cast instead
// of fighting the lib conflict.
interface CloudflareCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}
function defaultCache(): CloudflareCache {
  return (caches as unknown as { default: CloudflareCache }).default;
}

export async function getCachedEpgpTotals(db: ReturnType<typeof drizzle>): Promise<Map<number, EpgpTotal>> {
  const cache = defaultCache();
  const cached = await cache.match(TOTALS_CACHE_KEY);
  if (cached) {
    const rows = (await cached.json()) as [number, EpgpTotal][];
    return new Map(rows);
  }

  // Only the miss path hits D1 — this line is what makes the TTL window
  // visible in `wrangler tail` (PLAN.md §6 task 0.4). A quiet stretch of
  // cache hits between misses is the caching working, not a gap in logging.
  console.log("[epgp-totals] cache miss, querying D1");
  const totals = await computeEpgpTotals(db);
  const response = new Response(JSON.stringify([...totals]), {
    headers: { "content-type": "application/json", "cache-control": `max-age=${TOTALS_CACHE_TTL_SECONDS}` },
  });
  await cache.put(TOTALS_CACHE_KEY, response);
  return totals;
}

// Called by every EPGP-ledger write path (insertLedgerEntry covers manual
// entry, attendance, and bids' GP charges — see that file) so a fresh totals
// read never has to wait out the TTL after an officer just changed the
// numbers.
export async function invalidateEpgpTotalsCache(): Promise<void> {
  await defaultCache().delete(TOTALS_CACHE_KEY);
}
