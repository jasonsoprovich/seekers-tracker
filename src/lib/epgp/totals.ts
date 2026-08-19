import { gte, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { cycles, epLedger, epgpSettings, gpLedger } from "@/db";

export type EpgpTotal = {
  characterId: number;
  ep: number;
  gp: number;
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
// replaces the old character_epgp mirror table. Confirmed against the
// guild's sheet (docs/../EPGP plan "Findings" §2): the sheet pre-applies
// the *upcoming* cycle's decay to everything earned before the current
// cycle started, while decay already applied in past cycles lives as
// explicit negative ep_ledger/gp_ledger rows (so those are just summed like
// any other row, no special-casing needed here).
//
//   ep = (points before current cycle start) * (1 - ep_decay) + (points this cycle)
//   gp = (points before current cycle start) * (1 - gp_decay) + (points this cycle)
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
    const ep = (preEp.get(characterId) ?? 0) * (1 - settings.ep_decay) + (curEp.get(characterId) ?? 0);
    const gp = (preGp.get(characterId) ?? 0) * (1 - settings.gp_decay) + (curGp.get(characterId) ?? 0);
    const priorityRating = (ep + settings.base_ep) / (gp + settings.base_gp);
    totals.set(characterId, { characterId, ep, gp, priorityRating });
  }

  return totals;
}
