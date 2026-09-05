import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { cycles } from "@/db";

export type Cycle = typeof cycles.$inferSelect;

// "Current cycle" as of a given instant — shared by totals.ts (where the
// legacy 1a decay boundary is this cycle's start date) and the member-
// facing cycle/rules info page. Single source of truth so the two never
// disagree about which cycle is "now".
//
// The sheet's Cycles tab is pre-populated with future cycles (observed
// 2026-08-18: rows exist through cycle 72 / mid-November), so "most recent
// by start date" is NOT "current" — it has to be the cycle whose
// [start, end] actually contains `asOf`. Falls back to the most recently
// *started* cycle if the calendar ever has a gap (a raid week not yet
// added), so activity after the last known cycle still counts as
// "current" rather than falling into a mismatch. Returns undefined only
// when no cycle has started yet at all (fresh dev DB, or before the
// guild's first seeded cycle).
export async function getCurrentCycle(db: ReturnType<typeof drizzle>, asOf: Date = new Date()): Promise<Cycle | undefined> {
  const allCycles = await db.select().from(cycles).orderBy(sql`${cycles.startDate} asc`);
  const containingCycle = allCycles.find((c) => c.startDate <= asOf && asOf <= c.endDate);
  if (containingCycle) return containingCycle;
  const startedCycles = allCycles.filter((c) => c.startDate <= asOf);
  return startedCycles.at(-1);
}
