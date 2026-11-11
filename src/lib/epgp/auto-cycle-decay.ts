import { and, desc, eq, isNull } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { decayEvents } from "@/db";
import { decayReminder, type DecayReminder, getCurrentCycleWindow, scheduledCycleEnd, type ScheduledCycleEnd } from "@/lib/epgp/cycles";
import { commitRateDecay } from "@/lib/epgp/decay";
import { getSettingAt, setSetting } from "@/lib/epgp/settings";
import { CRON_ACTOR, type SystemActor } from "@/lib/system-log";

type Db = ReturnType<typeof drizzle>;

// The automatic cycle decay. An hourly cron (custom-worker.ts) calls
// runScheduledCycleDecay; once the running cycle's scheduled end
// (cycles.ts scheduledCycleEnd: midnight Eastern after its last Saturday)
// has passed, it commits the same global_cycle decay the leader used to run
// by hand on /epgp/decay — same rate, same commitRateDecay, same rollover
// into the next cycle. It is idempotent: once committed, the new cycle's
// end is two weeks out, so later runs find nothing due.

// Stored in epgp_settings like the other leader settings, but toggled from
// /epgp/decay rather than /epgp/settings (it's on/off, not a number).
export const AUTO_CYCLE_DECAY_KEY = "auto_cycle_decay";
const DEFAULT_RATE = 0.1;
// Only catch up on a decay this late. Past that (the cron was broken for a
// day, or automation was just switched back on mid-cycle) the leader runs
// it by hand, rather than the cron silently applying one or more old
// decays.
const MAX_LATE_MS = 24 * 3_600_000;

export async function isAutoCycleDecayOn(db: Db, now: Date = new Date()): Promise<boolean> {
  return ((await getSettingAt(db, AUTO_CYCLE_DECAY_KEY, now)) ?? "on") !== "off";
}

export async function setAutoCycleDecay(db: Db, on: boolean, userId: string, actor: SystemActor): Promise<void> {
  await setSetting(db, AUTO_CYCLE_DECAY_KEY, on ? "on" : "off", userId, actor, {
    note: on ? "Automatic cycle decay turned on" : "Automatic cycle decay turned off",
  });
}

// The rate the leader last used for a cycle decay, so automation keeps
// applying exactly what they did by hand. 10% (the guild's §1c vote and the
// form default) if none has been run yet.
export async function autoCycleDecayRate(db: Db): Promise<number> {
  const [last] = await db
    .select({ rate: decayEvents.epRate })
    .from(decayEvents)
    .where(and(eq(decayEvents.kind, "global_cycle"), isNull(decayEvents.reversedAt)))
    .orderBy(desc(decayEvents.effectiveDate), desc(decayEvents.id))
    .limit(1);
  const rate = last?.rate;
  return rate != null && rate > 0 && rate <= 1 ? rate : DEFAULT_RATE;
}

export type ScheduledDecayResult =
  | { status: "off" | "no-cycle" }
  | { status: "not-due"; end: ScheduledCycleEnd }
  | { status: "too-late"; end: ScheduledCycleEnd }
  | { status: "committed"; end: ScheduledCycleEnd; rate: number; decayEventId: number; cycleStarted?: number; epRows: number; gpRows: number }
  | { status: "error"; end: ScheduledCycleEnd; error: string };

export async function runScheduledCycleDecay(db: Db, now: Date = new Date()): Promise<ScheduledDecayResult> {
  if (!(await isAutoCycleDecayOn(db, now))) return { status: "off" };
  const w = await getCurrentCycleWindow(db, now);
  const end = w ? scheduledCycleEnd(w) : null;
  if (!w || !end) return { status: "no-cycle" };
  if (now < end.decayAt) return { status: "not-due", end };
  if (now.getTime() - end.decayAt.getTime() > MAX_LATE_MS) return { status: "too-late", end };

  const rate = await autoCycleDecayRate(db);
  // Dated the cycle's last day, counting everything before midnight — the
  // same thing the leader got by picking that Saturday on the form.
  const result = await commitRateDecay(db, {
    kind: "global_cycle",
    rate,
    effectiveDate: new Date(`${end.lastDay}T00:00:00Z`),
    cutoff: end.decayAt,
    label: `Automatic cycle decay — end of cycle #${w.cycle.cycleNumber}`,
    appliedBy: null,
    actor: CRON_ACTOR,
  });
  if ("error" in result) return { status: "error", end, error: result.error };
  return { status: "committed", end, rate, ...result };
}

// The leader's cycle decay reminder (Admin nav dot, /admin card), aware of
// whether automation is on.
export async function getDecayReminder(db: Db, now: Date = new Date()): Promise<DecayReminder | null> {
  const [w, auto] = await Promise.all([getCurrentCycleWindow(db, now), isAutoCycleDecayOn(db, now)]);
  return w ? decayReminder(w, auto, now) : null;
}
