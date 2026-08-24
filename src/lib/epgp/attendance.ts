import type { drizzle } from "drizzle-orm/d1";

import { DEFAULT_SETTINGS, getSettingAt } from "@/lib/epgp/settings";

// PLAN.md §4h: the minimum-attendance rule applies to the attendance-capture
// path only — a "/who guild" snapshot producing one of these four
// activities. Everything else (Bank Donation, Hitting lvl 40-60, Epic
// Completion, Event Lead, Guild Meeting — §4h's "single-line activities")
// is exempt by construction: it's simply not in this set, rather than
// requiring an ever-growing exemption list to keep in sync with
// epgp_point_values.
export const ATTENDANCE_GATED_ACTIVITIES = new Set(["Raid - Start", "Raid - Mid", "Raid - End", "Event Attend"]);

export type AttendanceCheckResult = { ok: true } | { ok: false; count: number; required: number; shortfall: number };

// Resolves min_attendance as of `occurredAt` (not "now") — same
// effective-dated pattern as the EP cap (§4i): a leader raising or lowering
// the threshold later shouldn't retroactively change whether a past capture
// qualified. Exported so scripts/verify-attendance-minimum.ts (task 4.5)
// exercises this exact function against historical data instead of a
// reimplementation that could drift from it.
export async function checkMinAttendance(
  db: ReturnType<typeof drizzle>,
  activity: string,
  occurredAt: Date,
  attendeeCount: number,
): Promise<AttendanceCheckResult> {
  if (!ATTENDANCE_GATED_ACTIVITIES.has(activity)) return { ok: true };

  const raw = await getSettingAt(db, "min_attendance", occurredAt);
  const required = Number(raw ?? DEFAULT_SETTINGS.min_attendance);

  if (attendeeCount >= required) return { ok: true };
  return { ok: false, count: attendeeCount, required, shortfall: required - attendeeCount };
}
