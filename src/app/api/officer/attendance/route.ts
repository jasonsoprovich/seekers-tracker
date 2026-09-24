import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { characters, epLedger } from "@/db";
import {
  attendanceDedupeWindow,
  checkMinAttendance,
  findExistingEventLead,
  insertPreparedEventLeadAward,
  prepareEventLeadAward,
} from "@/lib/epgp/attendance";
import { getDb } from "@/lib/db";
import { insertEpLedgerBatch } from "@/lib/epgp/ledger-entry";
import { nameRaidFromCapture } from "@/lib/epgp/raids";
import { getStandingsForPlayers, settleStandings, type StandingsRow } from "@/lib/epgp/standings";
import { getActivePointValue } from "@/lib/epgp/point-values";
import { toGuildDateString } from "@/lib/guild-timezone";
import { officerApiActor, recordSystemEvent } from "@/lib/system-log";
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
  raidName?: unknown;
  awardEventLead?: unknown;
  // Who the Event Lead EP goes to, when awardEventLead is true. Blank/
  // absent keeps the original behavior: the API key owner's own current
  // main. See prepareEventLeadAward's doc comment for why a client-chosen
  // recipient is safe here (no new privilege over Manual Entry).
  eventLeadCharacterName?: unknown;
};

// Pre-submit "is this capture already in the ledger?" check for the parser
// app's Attendance tab (2026-09-09 sim feedback: after Clear all + a
// re-capture of the same log lines, the app happily let a Raid-Start be
// re-submitted — the server deduped it to 0 rows, but nothing warned the
// officer up front). 2026-09-23: widened from an exact occurredAt match to
// a ±60 min window — the real failure mode this caught (two officers, same
// raid) has two different timestamps, one per officer's own `/who`. Any
// `source='parse'` ep_ledger row for this activity within the window means
// at least part of this capture would be a no-op; `enteredBy` names who
// already has it, so the app can say so instead of just a count.
export async function GET(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const activityCheck = boundedString(url.searchParams.get("activity"), { max: LIMITS.activity, min: 1, field: "activity" });
  if (!activityCheck.ok) {
    return Response.json({ error: activityCheck.error }, { status: 400 });
  }
  const dateCheck = isoDate(url.searchParams.get("occurredAt"), "occurredAt");
  if (!dateCheck.ok) {
    return Response.json({ error: dateCheck.error }, { status: 400 });
  }
  const occurredAt = dateCheck.value;
  const { start, end } = attendanceDedupeWindow(occurredAt);

  const db = await getDb();
  const windowClause = and(
    eq(epLedger.activity, activityCheck.value),
    gte(epLedger.occurredAt, start),
    lte(epLedger.occurredAt, end),
    eq(epLedger.source, "parse"),
  );
  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(epLedger).where(windowClause);
  const count = countRow?.count ?? 0;
  // Two queries rather than one — SQLite's "bare column beside an aggregate,
  // no GROUP BY" behavior doesn't reliably respect ORDER BY for which row's
  // columns come back, and this only runs once per pre-submit check, not in
  // a hot loop.
  const [earliest] = count > 0
    ? await db.select({ enteredBy: epLedger.enteredBy, occurredAt: epLedger.occurredAt }).from(epLedger).where(windowClause).orderBy(epLedger.occurredAt).limit(1)
    : [];

  let enteredByName: string | null = null;
  if (earliest?.enteredBy) {
    const actor = await officerApiActor(db, earliest.enteredBy);
    enteredByName = actor.label;
  }

  const eventLead = await findExistingEventLead(db, activityCheck.value, occurredAt);
  let eventLeadEnteredByName: string | null = null;
  if (eventLead?.enteredBy) {
    const actor = await officerApiActor(db, eventLead.enteredBy);
    eventLeadEnteredByName = actor.label;
  }

  return Response.json({
    exists: count > 0,
    count,
    enteredBy: enteredByName,
    occurredAt: earliest?.occurredAt ? earliest.occurredAt.toISOString() : null,
    eventLead: eventLead ? { recipientName: eventLead.recipientName, enteredByName: eventLeadEnteredByName } : null,
  });
}

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
  // Optional raid name from the app's Attendance tab — names the night on
  // /epgp/raids so a Start/Mid/End set reads as one entry. Only the first
  // submit that carries a name wins (nameRaidFromCapture never overwrites),
  // so a stale value on a later Mid/End submit is harmless.
  const raidName = typeof body.raidName === "string" && body.raidName.trim() ? body.raidName.trim().slice(0, LIMITS.raidName) : null;
  if (body.awardEventLead !== undefined && typeof body.awardEventLead !== "boolean") {
    return Response.json({ error: "`awardEventLead` must be a boolean." }, { status: 400 });
  }
  const awardEventLead = body.awardEventLead === true;
  if (body.eventLeadCharacterName !== undefined && typeof body.eventLeadCharacterName !== "string") {
    return Response.json({ error: "`eventLeadCharacterName` must be a string." }, { status: 400 });
  }
  const eventLeadCharacterNameCheck =
    typeof body.eventLeadCharacterName === "string" ? body.eventLeadCharacterName.trim() : "";
  if (eventLeadCharacterNameCheck.length > LIMITS.characterName) {
    return Response.json({ error: "Event Lead character name is too long." }, { status: 400 });
  }
  const eventLeadCharacterName = eventLeadCharacterNameCheck || undefined;
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

  // Resolve every Event Lead dependency before attendance writes begin.
  // Defaults to the API-key owner's own current main; eventLeadCharacterName
  // lets the submitting officer name a different raid leader instead (the
  // attendance-taker isn't always the actual leader — see
  // prepareEventLeadAward's doc comment for why this is safe to accept from
  // the client).
  //
  // 2026-09-23: checked against findExistingEventLead FIRST — if this raid
  // moment already has an Event Lead (any recipient, any officer, within
  // the ±60 min dedupe window), skip awarding a second one outright rather
  // than resolving a recipient and relying on the sourceKey to silently
  // no-op it. The attendance rows below still land regardless.
  const existingEventLead = awardEventLead ? await findExistingEventLead(db, activity, occurredAt) : null;
  const existingEventLeadEnteredByName = existingEventLead?.enteredBy ? (await officerApiActor(db, existingEventLead.enteredBy)).label : null;
  const eventLeadPreparation =
    awardEventLead && !existingEventLead ? await prepareEventLeadAward(db, auth.userId, activity, occurredAt, eventLeadCharacterName) : null;
  if (eventLeadPreparation && !eventLeadPreparation.ok) {
    return Response.json({ error: eventLeadPreparation.error }, { status: 422 });
  }

  // 2026-09-10 perf rewrite. This used to loop names one at a time — name
  // lookup, player lookup, dupe check, then insertLedgerEntry's own 4-5
  // queries — ~7 sequential D1 round trips per name, ~15-20ms each in
  // production, so a 50-name capture took 6-10s and a Start/Mid/End submit
  // 20-45s. Now: one name-resolution query, one dupe query, then
  // insertEpLedgerBatch (fixed round-trip count) and one standings refresh.
  //
  // Name resolution — COLLATE NOCASE to match characters' own unique index
  // (see findCharacterIdByName), for every captured name in one query.
  const byLowerName = new Map<string, { id: number; playerId: number | null }>();
  // Chunked under D1's 100-bound-parameter-per-statement cap.
  for (let i = 0; i < names.length; i += 90) {
    const chunk = names.slice(i, i + 90);
    const found = await db
      .select({ id: characters.id, name: characters.name, playerId: characters.playerId })
      .from(characters)
      .where(sql`${characters.name} COLLATE NOCASE IN (${sql.join(chunk.map((n) => sql`${n}`), sql`, `)})`);
    for (const c of found) byLowerName.set(c.name.toLowerCase(), { id: c.id, playerId: c.playerId });
  }

  const unmatched: string[] = [];
  const duplicates: string[] = [];
  // §4h-1: Project Quarm bans multiboxing, so one `/who` capture can't
  // legitimately contain two characters of the same player — but a player
  // swapping characters between two captures of the same activity (or a
  // duplicate paste of the same block) would otherwise award them twice.
  // Dedupe by resolved player id per (activity, occurredAt): once within
  // this request's own name list, and once against rows already on
  // ep_ledger (a resubmission of the same capture in a separate request).
  // A character with no player_id yet (PLAN.md §16) is keyed by its own
  // character id so it's still checked against itself.
  type Resolved = { name: string; characterId: number; playerKey: number; playerId: number | null };
  const resolved: Resolved[] = [];
  for (const name of names) {
    const c = byLowerName.get(name.toLowerCase());
    if (!c) {
      unmatched.push(name);
      continue;
    }
    resolved.push({ name, characterId: c.id, playerKey: c.playerId ?? c.id, playerId: c.playerId });
  }

  // Rows already on the ledger for this activity within the ±60 min dedupe
  // window (2026-09-23: was an exact occurredAt match — see
  // attendanceDedupeWindow's comment for why that missed a second officer's
  // own capture of the same raid), for any player / character in this
  // capture — one query. Scoped to source='parse' so a manual correction
  // entered for the same activity/night doesn't block a real capture.
  const existingPlayerIds = new Set<number>();
  const existingCharacterIds = new Set<number>();
  if (resolved.length > 0) {
    const { start: windowStart, end: windowEnd } = attendanceDedupeWindow(occurredAt);
    const pids = [...new Set(resolved.map((r) => r.playerId).filter((v): v is number => v != null))];
    const cids = [...new Set(resolved.filter((r) => r.playerId == null).map((r) => r.characterId))];
    const lookups: Promise<{ playerId: number | null; characterId: number | null }[]>[] = [];
    for (let i = 0; i < pids.length; i += 90) {
      lookups.push(
        db
          .select({ playerId: epLedger.playerId, characterId: epLedger.characterId })
          .from(epLedger)
          .where(
            and(
              eq(epLedger.activity, activity),
              gte(epLedger.occurredAt, windowStart),
              lte(epLedger.occurredAt, windowEnd),
              eq(epLedger.source, "parse"),
              inArray(epLedger.playerId, pids.slice(i, i + 90)),
            ),
          ),
      );
    }
    for (let i = 0; i < cids.length; i += 90) {
      lookups.push(
        db
          .select({ playerId: epLedger.playerId, characterId: epLedger.characterId })
          .from(epLedger)
          .where(
            and(
              eq(epLedger.activity, activity),
              gte(epLedger.occurredAt, windowStart),
              lte(epLedger.occurredAt, windowEnd),
              eq(epLedger.source, "parse"),
              inArray(epLedger.characterId, cids.slice(i, i + 90)),
            ),
          ),
      );
    }
    for (const existing of await Promise.all(lookups)) {
      for (const e of existing) {
        if (e.playerId != null) existingPlayerIds.add(e.playerId);
        if (e.characterId != null) existingCharacterIds.add(e.characterId);
      }
    }
  }

  const seenPlayerKeys = new Set<number>();
  const toInsert: { characterId: number; activity: string; points: number; occurredAt: string; note: string; zone: string | null; raidName: string | null }[] = [];
  for (const r of resolved) {
    if (seenPlayerKeys.has(r.playerKey)) {
      duplicates.push(r.name);
      console.warn(`attendance: skipped "${r.name}" — player ${r.playerKey} already awarded "${activity}" at ${occurredAtIso} in this submission`);
      continue;
    }
    const alreadyRecorded = r.playerId != null ? existingPlayerIds.has(r.playerId) : existingCharacterIds.has(r.characterId);
    if (alreadyRecorded) {
      duplicates.push(r.name);
      console.warn(`attendance: skipped "${r.name}" — player ${r.playerKey} already has an "${activity}" row within 60 min of ${occurredAtIso} (duplicate capture?)`);
      continue;
    }
    seenPlayerKeys.add(r.playerKey);
    toInsert.push({ characterId: r.characterId, activity, points, occurredAt: occurredAtIso, note, zone, raidName });
  }

  let inserted = 0;
  let eventLeadInserted = false;
  let standings: StandingsRow[] = [];
  const affectedPlayerIds = new Set<number>();
  if (toInsert.length > 0) {
    const result = await insertEpLedgerBatch(db, toInsert, auth.userId, "parse");
    inserted = result.inserted;
    for (const f of result.failed) {
      const row = toInsert.find((t) => t.characterId === f.characterId);
      const name = resolved.find((r) => r.characterId === f.characterId)?.name ?? String(f.characterId);
      console.warn(`attendance: could not store "${name}": ${f.error}`);
      if (row) unmatched.push(name);
    }
    for (const playerId of result.playerIds) affectedPlayerIds.add(playerId);
  }

  if (eventLeadPreparation?.ok) {
    eventLeadInserted = await insertPreparedEventLeadAward(
      db,
      eventLeadPreparation.award,
      occurredAt,
      auth.userId,
      note,
    );
    affectedPlayerIds.add(eventLeadPreparation.award.playerId);
  }

  // One recompute for attendance and Event Lead together. Both insert paths
  // commit their dirty markers transactionally, so a failed recompute only
  // delays repair; it cannot leave silent standings drift.
  if (affectedPlayerIds.size > 0) {
    const playerIds = [...affectedPlayerIds];
    const settled = await settleStandings(db, { playerIds });
    if (settled) standings = [...(await getStandingsForPlayers(db, playerIds)).values()];
  }

  // Best-effort: a name that couldn't be stored (bad date, race) must not
  // fail an otherwise-good attendance submit — the officer can still name
  // the raid on /epgp/raids.
  if (raidName && (inserted > 0 || duplicates.length > 0)) {
    try {
      await nameRaidFromCapture(db, toGuildDateString(occurredAt), raidName, auth.userId);
    } catch (err) {
      console.warn(`attendance: could not name raid for ${occurredAtIso}: ${String(err)}`);
    }
  }

  // One System Log summary row per capture — not per attendee (those live
  // on ep_ledger already) — so a submit that inserted nothing new is still
  // silent here, matching the same "nothing to report" logic as the raid
  // naming above.
  if (inserted > 0) {
    await recordSystemEvent(db, await officerApiActor(db, auth.userId), {
      action: "epgp.attendance.submit",
      targetType: "raid",
      targetLabel: raidName || null,
      summary: `Attendance capture submitted: ${inserted} row(s), ${activity}${zone ? `, ${zone}` : ""}${raidName ? ` — ${raidName}` : ""}`,
      after: { activity, occurredAt: occurredAtIso, zone, inserted, duplicates: duplicates.length, unmatched: unmatched.length, eventLeadInserted },
    });
  }

  return Response.json(
    {
      inserted,
      eventLeadInserted,
      eventLeadCharacterName: eventLeadInserted ? eventLeadPreparation?.award.characterName : undefined,
      // Set when awardEventLead was true but this raid moment already has
      // one (any recipient, within the ±60 min window) — the app can tell
      // the officer "Event Lead already went to X" instead of quietly
      // dropping the request.
      eventLeadSkipped: existingEventLead
        ? { recipientName: existingEventLead.recipientName, enteredByName: existingEventLeadEnteredByName }
        : undefined,
      unmatched,
      duplicates,
      standings,
    },
    { status: 201 },
  );
}
