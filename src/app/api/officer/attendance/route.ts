import { and, eq } from "drizzle-orm";

import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { characters, epLedger } from "@/db";
import { checkMinAttendance } from "@/lib/epgp/attendance";
import { findCharacterIdByName } from "@/lib/epgp/character-lookup";
import { getDb } from "@/lib/db";
import { insertLedgerEntry } from "@/lib/epgp/ledger-entry";
import { refreshStandings } from "@/lib/epgp/standings";
import { getActivePointValue } from "@/lib/epgp/point-values";
import { boundedString, isoDate, LIMITS } from "@/lib/validate";

// One `/who guild` snapshot is at most the raid cap plus stragglers; well
// above that is a malformed or duplicated paste, not a real capture.
const MAX_ATTENDEES = 200;

type AttendanceRequestBody = {
  activity?: unknown;
  occurredAt?: unknown;
  characterNames?: unknown;
  note?: unknown;
  zone?: unknown;
};

// Bulk EP award from the officer app's Attendance capture (one "/who
// guild" snapshot -> everyone in it gets the same activity/points). Points
// are resolved server-side from epgp_point_values, not trusted from the
// caller — see src/lib/epgp/point-values.ts. Names that don't match a
// characters row are reported back rather than silently dropped, so the
// officer can fix a typo'd name and resubmit just that name (e.g. via
// manual-entry) instead of wondering who's missing.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: AttendanceRequestBody;
  try {
    body = (await request.json()) as AttendanceRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const activityCheck = boundedString(body.activity, { max: LIMITS.activity, min: 1, field: "activity" });
  if (!activityCheck.ok) {
    return Response.json({ error: activityCheck.error }, { status: 400 });
  }
  const dateCheck = isoDate(body.occurredAt, "occurredAt");
  if (!dateCheck.ok) {
    return Response.json({ error: dateCheck.error }, { status: 400 });
  }
  const occurredAt = dateCheck.value;
  const occurredAtIso = occurredAt.toISOString();
  if (!Array.isArray(body.characterNames) || body.characterNames.some((n) => typeof n !== "string")) {
    return Response.json({ error: "`characterNames` must be an array of strings." }, { status: 400 });
  }
  if (body.characterNames.length > MAX_ATTENDEES) {
    return Response.json({ error: `Too many names in one capture (limit ${MAX_ATTENDEES}).` }, { status: 400 });
  }
  const longName = body.characterNames.find((n) => (n as string).length > LIMITS.characterName);
  if (longName !== undefined) {
    return Response.json({ error: `"${(longName as string).slice(0, 20)}…" isn't a valid character name.` }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.slice(0, LIMITS.note) : "";
  // The zone the `/who` was run in, straight off the capture's own "There
  // are N players in <Zone>" line — says what this Raid-Start/Mid/End award
  // was actually for. Optional: an older client, or a manual resubmit,
  // won't send it.
  const zone = typeof body.zone === "string" && body.zone.trim() ? body.zone.trim().slice(0, LIMITS.zone) : null;
  const activity = activityCheck.value;

  const db = await getDb();
  const points = await getActivePointValue(db, "ep", activity);
  if (points === null) {
    return Response.json({ error: `"${activity}" isn't a current EP activity.` }, { status: 422 });
  }

  const names = [...new Set(body.characterNames.map((n) => n.trim()).filter(Boolean))];

  // §4h: server-side is authoritative — the app pre-checks locally too
  // (task 4.4), but a bypassed/older client must still be blocked here.
  // Headcount is the raw distinct-name count from this capture, not the
  // post-resolution count below: attendance is about who was actually in
  // the zone, not whether their character row already exists.
  const attendanceCheck = await checkMinAttendance(db, activity, occurredAt, names.length);
  if (!attendanceCheck.ok) {
    return Response.json(
      {
        error: `Only ${attendanceCheck.count} of ${attendanceCheck.required} required guild members attended.`,
        count: attendanceCheck.count,
        required: attendanceCheck.required,
        shortfall: attendanceCheck.shortfall,
      },
      { status: 422 },
    );
  }

  const unmatched: string[] = [];
  const duplicates: string[] = [];
  // §4h-1: Project Quarm bans multiboxing, so one `/who` capture can't
  // legitimately contain two characters of the same player — but a player
  // swapping characters between two captures of the same activity (or a
  // duplicate paste of the same block) would otherwise award them twice.
  // Dedupe by resolved player id per (activity, occurredAt): once in this
  // request's own name list, and once against rows already on ep_ledger
  // (catches a resubmission of the same capture in a separate request).
  const seenPlayerKeys = new Set<number>();
  const awardedPlayerIds = new Set<number>();
  let inserted = 0;

  for (const name of names) {
    const characterId = await findCharacterIdByName(db, name);
    if (characterId === null) {
      unmatched.push(name);
      continue;
    }

    const [character] = await db.select({ playerId: characters.playerId }).from(characters).where(eq(characters.id, characterId));
    // A character with no player_id yet (PLAN.md §16 — created through the
    // site's own claim/new-character flow) has no group to dedupe against;
    // fall back to its own character id so it's still checked against
    // itself rather than skipped or crashing.
    const playerKey = character?.playerId ?? characterId;

    if (seenPlayerKeys.has(playerKey)) {
      duplicates.push(name);
      console.warn(`attendance: skipped "${name}" — player ${playerKey} already awarded "${activity}" at ${occurredAtIso} in this submission`);
      continue;
    }

    const [existing] = await db
      .select({ id: epLedger.id })
      .from(epLedger)
      .where(and(eq(epLedger.playerId, playerKey), eq(epLedger.activity, activity), eq(epLedger.occurredAt, occurredAt)));
    if (existing) {
      duplicates.push(name);
      console.warn(`attendance: skipped "${name}" — player ${playerKey} already has an "${activity}" row at ${occurredAtIso} (duplicate capture?)`);
      continue;
    }

    seenPlayerKeys.add(playerKey);
    // Defer the per-row standings refresh — a `/who` capture awards 20-40
    // players at once, so one `refreshStandings({ playerIds })` for the
    // whole batch below beats one recompute per name.
    const result = await insertLedgerEntry(
      db,
      { kind: "ep", characterId, activity, points, occurredAt: occurredAtIso, note, zone },
      auth.userId,
      "parse",
      { deferStandingsRefresh: true },
    );
    if (result.ok) {
      inserted++;
      if (result.playerId != null) awardedPlayerIds.add(result.playerId);
    } else unmatched.push(name);
  }

  if (awardedPlayerIds.size > 0) await refreshStandings(db, { playerIds: [...awardedPlayerIds] });

  return Response.json({ inserted, unmatched, duplicates }, { status: 201 });
}
