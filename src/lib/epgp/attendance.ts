import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characters, players } from "@/db";
import { getActivePointValue } from "@/lib/epgp/point-values";
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

export type PreparedEventLeadAward = {
  characterId: number;
  playerId: number;
  points: number;
  capAtEntry: number | null;
  sourceKey: string;
};

export async function prepareEventLeadAward(
  db: ReturnType<typeof drizzle>,
  userId: string,
  activity: string,
  occurredAt: Date,
): Promise<{ ok: true; award: PreparedEventLeadAward } | { ok: false; error: string }> {
  if (!ATTENDANCE_GATED_ACTIVITIES.has(activity)) {
    return { ok: false, error: "Event Lead can only be awarded with an attendance-gated activity." };
  }

  const ownedPlayers = await db
    .select({ id: players.id, mainCharacterId: players.mainCharacterId })
    .from(players)
    .where(eq(players.userId, userId));
  if (ownedPlayers.length !== 1 || ownedPlayers[0].mainCharacterId == null) {
    return { ok: false, error: "The API key owner must resolve to exactly one player account with a current main." };
  }

  const player = ownedPlayers[0];
  const mainCharacterId = player.mainCharacterId!;
  const [main] = await db
    .select({ id: characters.id, playerId: characters.playerId })
    .from(characters)
    .where(eq(characters.id, mainCharacterId));
  if (!main || main.playerId !== player.id) {
    return { ok: false, error: "The API key owner's current main is missing or does not belong to their player account." };
  }

  const [points, capRaw] = await Promise.all([
    getActivePointValue(db, "ep", "Event Lead"),
    getSettingAt(db, "ep_cap_per_cycle", occurredAt),
  ]);
  if (points === null) return { ok: false, error: '"Event Lead" is not a current EP activity.' };

  return {
    ok: true,
    award: {
      characterId: main.id,
      playerId: player.id,
      points,
      capAtEntry: capRaw !== null ? Number(capRaw) : null,
      sourceKey: `attendance-event-lead:v1:${userId}:${activity}:${occurredAt.getTime()}`,
    },
  };
}

export async function insertPreparedEventLeadAward(
  db: ReturnType<typeof drizzle>,
  award: PreparedEventLeadAward,
  occurredAt: Date,
  enteredBy: string,
  note: string,
): Promise<boolean> {
  const d1 = db.$client;
  const occurredAtSeconds = Math.floor(occurredAt.getTime() / 1000);
  const markerToken = crypto.randomUUID();
  const results = await d1.batch([
    d1
      .prepare(`
        INSERT INTO ep_ledger (
          character_id, player_id, occurred_at, activity, points,
          points_nominal, points_awarded, cap_applied, cap_at_entry,
          note, entered_by, source, source_key
        ) VALUES (?, ?, ?, 'Event Lead', ?, ?, ?, 0, ?, ?, ?, 'parse', ?)
        ON CONFLICT(source_key) DO NOTHING
        RETURNING id
      `)
      .bind(
        award.characterId,
        award.playerId,
        occurredAtSeconds,
        award.points,
        award.points,
        award.points,
        award.capAtEntry,
        note.trim() || null,
        enteredBy,
        award.sourceKey,
      ),
    d1
      .prepare(`
        INSERT INTO standings_dirty (scope, marker_token, marked_at)
        VALUES (?, ?, unixepoch())
        ON CONFLICT(scope) DO UPDATE SET marker_token = excluded.marker_token, marked_at = excluded.marked_at
      `)
      .bind(`player:${award.playerId}`, markerToken),
    d1
      .prepare(`
        UPDATE characters
        SET last_activity_at = ?
        WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)
      `)
      .bind(occurredAtSeconds, award.characterId, occurredAtSeconds),
  ]);

  return results[0]?.results.length === 1;
}
