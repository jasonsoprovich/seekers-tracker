import { inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { cycles, epLedger, gpLedger } from "@/db";
import { guildDayBounds } from "@/lib/guild-timezone";

export type Cycle = typeof cycles.$inferSelect;
type Db = ReturnType<typeof drizzle>;

// A cycle ends when the guild leader commits a global cycle decay: that
// commit closes the running cycle at the decay instant and opens the next
// one (rolloverCycle, called from decay.ts's commitRateDecay). The cycle
// running now is always the latest row and has no fixed end.
//
// History still holds the sheet's calendar cycles (whole Eastern days,
// start_date/end_date at UTC midnight of the first/last day). A cycle opened
// by a decay starts at its exact instant instead (started_by_decay_event_id
// set). cycleWindows turns both kinds into one half-open [start, end) range
// per cycle, which is what the EP cap (ep-cap.ts), the Your Characters meter
// and the Cycle Overview page all read — so they can't disagree about which
// cycle "now" is.

export type CycleWindow = {
  cycle: Cycle;
  start: Date;
  end: Date; // exclusive; FAR_FUTURE while the cycle is still running
  open: boolean;
};

export const FAR_FUTURE = new Date(8.64e15);
const HOUR = 3_600_000;

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayStart(day: string): Date {
  return guildDayBounds(day)?.start ?? new Date(`${day}T00:00:00Z`);
}

function dayEnd(day: string): Date {
  return guildDayBounds(day)?.end ?? new Date(new Date(`${day}T00:00:00Z`).getTime() + 24 * HOUR);
}

// Noon Eastern on a date — where a date-only ledger row is placed.
function dayNoon(day: string): Date {
  return new Date(dayStart(day).getTime() + 12 * HOUR);
}

function shiftDay(day: string, days: number): string {
  return utcDay(new Date(new Date(`${day}T00:00:00Z`).getTime() + days * 24 * HOUR));
}

// Ledger dates are of two kinds: sheet/manual-form rows sit at exactly UTC
// midnight of their date (a bucket), while officer-app rows carry the real
// timestamp. A bucket row counts as noon Eastern on its date, so on a
// rollover day it lands in whichever cycle was running at midday. For the
// whole-day calendar cycles this is the same as the old "bucket rows read
// their UTC date" rule.
export function isBucketTime(t: Date): boolean {
  return t.getTime() % 86_400_000 === 0;
}

export function effectiveInstant(t: Date): Date {
  return isBucketTime(t) ? dayNoon(utcDay(t)) : t;
}

export function cycleWindows(all: Cycle[]): CycleWindow[] {
  const sorted = [...all].sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  return sorted.map((cycle, i) => {
    const next = sorted[i + 1];
    const start = cycle.startedByDecayEventId != null ? cycle.startDate : dayStart(utcDay(cycle.startDate));
    if (!next) return { cycle, start, end: FAR_FUTURE, open: true };
    const end = next.startedByDecayEventId != null ? next.startDate : dayEnd(utcDay(cycle.endDate));
    return { cycle, start, end, open: false };
  });
}

// The cycle a ledger timestamp belongs to. A calendar gap (never seen in
// practice) falls back to the latest cycle started by then, open-ended.
export function windowAt(windows: CycleWindow[], t: Date): CycleWindow | null {
  const at = effectiveInstant(t);
  const containing = windows.find((w) => w.start <= at && at < w.end);
  if (containing) return containing;
  const started = windows.filter((w) => w.start <= at).at(-1);
  return started ? { ...started, end: FAR_FUTURE, open: true } : null;
}

// The UTC-midnight range of bucket rows that fall inside a window — the SQL
// side of effectiveInstant, for range queries over the ledger.
export function bucketRange(w: CycleWindow): { from: Date; to: Date } {
  const firstGuess = utcDay(new Date(w.start.getTime() - 24 * HOUR));
  let first = firstGuess;
  while (dayNoon(first) < w.start) first = shiftDay(first, 1);
  if (w.end >= FAR_FUTURE) return { from: new Date(`${first}T00:00:00Z`), to: FAR_FUTURE };
  let last = utcDay(new Date(w.end.getTime() + 24 * HOUR));
  while (dayNoon(last) >= w.end) last = shiftDay(last, -1);
  return { from: new Date(`${first}T00:00:00Z`), to: new Date(`${last}T00:00:00Z`) };
}

export async function loadCycleWindows(db: Db): Promise<CycleWindow[]> {
  return cycleWindows(await db.select().from(cycles));
}

export async function getCurrentCycleWindow(db: Db, asOf: Date = new Date()): Promise<CycleWindow | undefined> {
  return windowAt(await loadCycleWindows(db), asOf) ?? undefined;
}

// "Current cycle" as of a given instant. Returns undefined only when no
// cycle has started yet at all (fresh dev DB).
export async function getCurrentCycle(db: Db, asOf: Date = new Date()): Promise<Cycle | undefined> {
  return (await getCurrentCycleWindow(db, asOf))?.cycle;
}

export type RolloverPlan = {
  closing: CycleWindow;
  nextNumber: number;
  at: Date;
  // Pre-filled calendar rows that haven't started; removed by the rollover.
  staleIds: number[];
};

// Checks a cycle decay at `at` can end the running cycle, before any decay
// row is written. The decay must fall inside the cycle that is running now:
// a date before it started would end a cycle that's already over.
export async function planRollover(db: Db, at: Date): Promise<RolloverPlan | { error: string }> {
  const windows = await loadCycleWindows(db);
  const stale = windows.filter((w) => w.start > at && w.cycle.startedByDecayEventId == null);
  const live = windows.filter((w) => !stale.includes(w));
  const closing = live.at(-1);
  if (!closing) return { error: "There is no cycle to end — no cycle has started yet." };
  if (closing.start >= at) {
    return { error: `Cycle #${closing.cycle.cycleNumber} started after that date — pick a date after it started.` };
  }

  const staleIds = stale.map((w) => w.cycle.id);
  if (staleIds.length > 0) {
    const [[ep], [gp]] = await Promise.all([
      db.select({ id: epLedger.id }).from(epLedger).where(inArray(epLedger.cycleId, staleIds)).limit(1),
      db.select({ id: gpLedger.id }).from(gpLedger).where(inArray(gpLedger.cycleId, staleIds)).limit(1),
    ]);
    if (ep || gp) return { error: "Ledger rows reference a cycle that hasn't started yet — fix those before running cycle decay." };
  }

  const nextNumber = Math.max(...live.map((w) => w.cycle.cycleNumber)) + 1;
  return { closing, nextNumber, at, staleIds };
}

// The statements that end the running cycle at the decay instant and open
// the next, run as one D1 batch. The new cycle's end_date is a placeholder
// (the column is NOT NULL); a running cycle has no end until the next decay.
export function rolloverStatements(d1: D1Database, plan: RolloverPlan, decayEventId: number): D1PreparedStatement[] {
  const at = Math.floor(plan.at.getTime() / 1000);
  const statements: D1PreparedStatement[] = [];
  if (plan.staleIds.length > 0) {
    statements.push(d1.prepare(`DELETE FROM cycles WHERE id IN (${plan.staleIds.map(() => "?").join(", ")})`).bind(...plan.staleIds));
  }
  statements.push(
    d1.prepare("UPDATE cycles SET end_date = ? WHERE id = ?").bind(at, plan.closing.cycle.id),
    d1
      .prepare("INSERT INTO cycles (cycle_number, start_date, end_date, started_by_decay_event_id) VALUES (?, ?, ?, ?)")
      .bind(plan.nextNumber, at, at, decayEventId),
  );
  return statements;
}

export type UndoRolloverPlan = { opened: Cycle; previous: Cycle } | null;

// Reversing a cycle decay also undoes the cycle it started, reopening the
// previous one. Only the latest cycle can be undone; a later decay must be
// reversed first. Returns null for a decay that started no cycle (expansion
// decays, and cycle decays from before rollover existed).
export async function planUndoRollover(db: Db, decayEventId: number): Promise<UndoRolloverPlan | { error: string }> {
  const windows = await loadCycleWindows(db);
  const index = windows.findIndex((w) => w.cycle.startedByDecayEventId === decayEventId);
  if (index === -1) return null;
  if (index !== windows.length - 1) {
    return { error: `Cycle #${windows[index].cycle.cycleNumber} has already ended — reverse the later cycle decay first.` };
  }
  if (index === 0) return { error: "This decay started the only cycle on record, so it can't be reopened." };
  return { opened: windows[index].cycle, previous: windows[index - 1].cycle };
}

// Moves rows stamped with the removed cycle back to the reopened one, then
// deletes it. `guard` keeps the statements inert on a retry of an already
// reversed decay (see reverseDecayEvent).
export function undoRolloverStatements(d1: D1Database, plan: NonNullable<UndoRolloverPlan>, guard: { sql: string; params: unknown[] }): D1PreparedStatement[] {
  const { opened, previous } = plan;
  return [
    d1.prepare(`UPDATE ep_ledger SET cycle_id = ? WHERE cycle_id = ? AND ${guard.sql}`).bind(previous.id, opened.id, ...guard.params),
    d1.prepare(`UPDATE gp_ledger SET cycle_id = ? WHERE cycle_id = ? AND ${guard.sql}`).bind(previous.id, opened.id, ...guard.params),
    d1.prepare(`UPDATE cycles SET end_date = start_date WHERE id = ? AND ${guard.sql}`).bind(previous.id, ...guard.params),
    d1.prepare(`DELETE FROM cycles WHERE id = ? AND ${guard.sql}`).bind(opened.id, ...guard.params),
  ];
}
