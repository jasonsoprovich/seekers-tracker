import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characters, epLedger, players } from "@/db";
import { getActivePointValue } from "@/lib/epgp/point-values";
import { DEFAULT_SETTINGS, getSettingAt } from "@/lib/epgp/settings";

// 2026-09-23: two officers both taking attendance for the same raid (LT-1
// post-live-test feedback batch). The existing dedupe was an exact
// occurredAt match — fine for a resubmit of the identical capture, useless
// against a second officer's own `/who` a few minutes later, which has its
// own timestamp. A window is the fix; ±60 min per the guild's own call
// (long enough to cover Start/Mid/End of one raid, short enough that two
// genuinely separate raids the same night don't collide).
export const ATTENDANCE_DEDUPE_WINDOW_MS = 60 * 60 * 1000;

export function attendanceDedupeWindow(occurredAt: Date): { start: Date; end: Date } {
  return {
    start: new Date(occurredAt.getTime() - ATTENDANCE_DEDUPE_WINDOW_MS),
    end: new Date(occurredAt.getTime() + ATTENDANCE_DEDUPE_WINDOW_MS),
  };
}

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

export type ExistingEventLead = { recipientName: string; enteredBy: string | null };

// Event Lead should go out once per raid moment, regardless of which
// officer's capture happens to submit it or who they name. The sourceKey
// unique index (attendance-event-lead:v2:...) already blocks the exact
// same (activity, occurredAt, recipient) triple; this catches the more
// likely real case — two officers' captures of the same raid land a few
// minutes apart, so their occurredAt values differ and the sourceKey never
// collides. Matches ANY recipient in the window, on purpose: the question
// is "has this raid's Event Lead already been awarded," not "did this
// exact player already get it."
export async function findExistingEventLead(db: ReturnType<typeof drizzle>, activity: string, occurredAt: Date): Promise<ExistingEventLead | null> {
  if (!ATTENDANCE_GATED_ACTIVITIES.has(activity)) return null;
  const { start, end } = attendanceDedupeWindow(occurredAt);
  const [row] = await db
    .select({ recipientName: characters.name, enteredBy: epLedger.enteredBy })
    .from(epLedger)
    .innerJoin(characters, eq(characters.id, epLedger.characterId))
    .where(and(eq(epLedger.activity, "Event Lead"), eq(epLedger.source, "parse"), gte(epLedger.occurredAt, start), lte(epLedger.occurredAt, end)))
    .orderBy(epLedger.occurredAt)
    .limit(1);
  return row ? { recipientName: row.recipientName, enteredBy: row.enteredBy } : null;
}

export type PreparedEventLeadAward = {
  characterId: number;
  // The recipient's canonical name, for the attendance route's response —
  // the officer chose a name that may differ from this (an alt of the
  // chosen character, or a typo'd casing), so the confirmation should show
  // who the EP actually landed on.
  characterName: string;
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
  // The officer taking attendance isn't always the actual raid leader (a
  // trainee learning the app, covering for someone) — the confirm dialog
  // lets them name who Event Lead actually goes to instead of only being
  // able to toggle the API-key owner's own award on/off, then having to
  // fix it with a separate Manual Entry afterward. This introduces no new
  // privilege: an officer can already award "Event Lead" EP to any
  // character today via /api/officer/manual-entry (insertLedgerEntry
  // takes an arbitrary characterId) — this just makes the common case
  // (attendance-taker != raid leader) a one-step submit. `overrideCharacterName`
  // is resolved the same way any other captured name is (case-insensitive
  // exact match against `characters`); undefined/blank keeps the original
  // behavior of awarding the API key owner's own current main.
  overrideCharacterName?: string,
): Promise<{ ok: true; award: PreparedEventLeadAward } | { ok: false; error: string }> {
  if (!ATTENDANCE_GATED_ACTIVITIES.has(activity)) {
    return { ok: false, error: "Event Lead can only be awarded with an attendance-gated activity." };
  }

  let player: { id: number; mainCharacterId: number | null };
  if (overrideCharacterName) {
    const [char] = await db
      .select({ id: characters.id, playerId: characters.playerId })
      .from(characters)
      .where(sql`${characters.name} COLLATE NOCASE = ${overrideCharacterName}`);
    if (!char) {
      return { ok: false, error: `Could not find a character named "${overrideCharacterName}" for the Event Lead award.` };
    }
    if (char.playerId == null) {
      return { ok: false, error: `"${overrideCharacterName}" isn't linked to a player account, so Event Lead can't be awarded to them.` };
    }
    const [p] = await db.select({ id: players.id, mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, char.playerId));
    if (!p) {
      return { ok: false, error: `"${overrideCharacterName}"'s player account could not be found.` };
    }
    player = p;
  } else {
    const ownedPlayers = await db
      .select({ id: players.id, mainCharacterId: players.mainCharacterId })
      .from(players)
      .where(eq(players.userId, userId));
    if (ownedPlayers.length !== 1) {
      return { ok: false, error: "The API key owner must resolve to exactly one player account with a current main." };
    }
    player = ownedPlayers[0];
  }
  if (player.mainCharacterId == null) {
    return {
      ok: false,
      error: overrideCharacterName
        ? `"${overrideCharacterName}" has no current main character set, so Event Lead can't be awarded to them.`
        : "The API key owner must resolve to exactly one player account with a current main.",
    };
  }

  const mainCharacterId = player.mainCharacterId;
  const [main] = await db
    .select({ id: characters.id, name: characters.name, playerId: characters.playerId })
    .from(characters)
    .where(eq(characters.id, mainCharacterId));
  if (!main || main.playerId !== player.id) {
    return {
      ok: false,
      error: overrideCharacterName
        ? `"${overrideCharacterName}"'s current main is missing or does not belong to their player account.`
        : "The API key owner's current main is missing or does not belong to their player account.",
    };
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
      characterName: main.name,
      playerId: player.id,
      points,
      capAtEntry: capRaw !== null ? Number(capRaw) : null,
      // Keyed by (activity, occurredAt, recipient player) rather than the
      // submitting officer's userId (v1's key) — the thing that must stay
      // unique per raid moment is "this player already got Event Lead for
      // this capture", regardless of which officer's key submitted it or
      // who they chose. v2 so an old v1 key from before this change never
      // collides with (or blocks) a v2 one for the same moment.
      sourceKey: `attendance-event-lead:v2:${activity}:${occurredAt.getTime()}:player:${player.id}`,
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
