import { gte, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { cycles, epLedger, epgpSettings, gpLedger } from "@/db";

export type EpgpTotal = {
  characterId: number;
  ep: number;
  gp: number;
  epDecay: number;
  gpDecay: number;
  priorityRating: number;
};

// Defaults match the sheet's own Point Values tab as observed on
// 2026-08-18 (Base EP 150 / Base GP 100, 20% decay both sides). Only used
// when epgp_settings has no row for a key yet (e.g. a fresh dev DB before
// the seed script runs) — the seed script writes real rows from the sheet.
const DEFAULT_SETTINGS: Record<string, number> = {
  ep_decay: 0.2,
  gp_decay: 0.2,
  base_ep: 150,
  base_gp: 100,
  ep_cap_per_cycle: 900,
};

export async function getEpgpSettings(db: ReturnType<typeof drizzle>): Promise<Record<string, number>> {
  const rows = await db.select().from(epgpSettings);
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    const num = Number(row.value);
    if (Number.isFinite(num)) settings[row.key] = num;
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
export async function computeEpgpTotals(db: ReturnType<typeof drizzle>): Promise<Map<number, EpgpTotal>> {
  const settings = await getEpgpSettings(db);

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
      .select({ characterId: epLedger.characterId, sum: sql<number>`coalesce(sum(${epLedger.points}), 0)` })
      .from(epLedger)
      .where(lt(epLedger.occurredAt, cycleStart))
      .groupBy(epLedger.characterId),
    db
      .select({ characterId: epLedger.characterId, sum: sql<number>`coalesce(sum(${epLedger.points}), 0)` })
      .from(epLedger)
      .where(gte(epLedger.occurredAt, cycleStart))
      .groupBy(epLedger.characterId),
    db
      .select({ characterId: gpLedger.characterId, sum: sql<number>`coalesce(sum(${gpLedger.points}), 0)` })
      .from(gpLedger)
      .where(lt(gpLedger.occurredAt, cycleStart))
      .groupBy(gpLedger.characterId),
    db
      .select({ characterId: gpLedger.characterId, sum: sql<number>`coalesce(sum(${gpLedger.points}), 0)` })
      .from(gpLedger)
      .where(gte(gpLedger.occurredAt, cycleStart))
      .groupBy(gpLedger.characterId),
  ]);

  const preEp = new Map(prePointsEp.map((r) => [r.characterId, r.sum]));
  const curEp = new Map(curPointsEp.map((r) => [r.characterId, r.sum]));
  const preGp = new Map(prePointsGp.map((r) => [r.characterId, r.sum]));
  const curGp = new Map(curPointsGp.map((r) => [r.characterId, r.sum]));

  const characterIds = new Set([...preEp.keys(), ...curEp.keys(), ...preGp.keys(), ...curGp.keys()]);

  const totals = new Map<number, EpgpTotal>();
  for (const characterId of characterIds) {
    const preEpAmt = preEp.get(characterId) ?? 0;
    const curEpAmt = curEp.get(characterId) ?? 0;
    const preGpAmt = preGp.get(characterId) ?? 0;
    const curGpAmt = curGp.get(characterId) ?? 0;
    const rawEp = preEpAmt + curEpAmt;
    const rawGp = preGpAmt + curGpAmt;

    const epDecay = rawEp < settings.base_ep ? 0 : preEpAmt * settings.ep_decay;
    const gpDecay = rawGp < settings.base_gp ? 0 : preGpAmt * settings.gp_decay;
    const ep = rawEp - epDecay;
    const gp = rawGp - gpDecay;
    const priorityRating = (ep + settings.base_ep) / (gp + settings.base_gp);
    totals.set(characterId, { characterId, ep, gp, epDecay, gpDecay, priorityRating });
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
