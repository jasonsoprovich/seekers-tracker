import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { bids, characters, epLedger, gpLedger, lootEvents, players, raids, users } from "@/db";
import { ATTENDANCE_GATED_ACTIVITIES } from "@/lib/epgp/attendance";
import { prepareDeleteAudit } from "@/lib/epgp/ledger-audit";
import { recordLedgerChange } from "@/lib/epgp/ledger-audit";
import { insertLedgerEntry } from "@/lib/epgp/ledger-entry";
import { getActivePointValue } from "@/lib/epgp/point-values";
import { settleStandings } from "@/lib/epgp/standings";
import { recordSystemEvent, webActor } from "@/lib/system-log";

import { guildDayBounds, toGuildDateString } from "../guild-timezone";

// A "raid" is not a stored row — it's every `source='parse'` attendance
// award plus manual attendance explicitly linked by `raid_date`, and every
// loot event that share a calendar date **in the guild's
// own timezone** (leader, 2026-09-05: raids are scheduled and run on
// Eastern time; grouping by UTC date split a single Eastern evening across
// two rows whenever it straddled UTC midnight — see guild-timezone.ts).
// This module derives that grouping and merges in the optional
// officer-set name/note from the `raids` table (keyed by the same date
// string).
//
// Bucketing happens in JS, not SQL — SQLite has no timezone-aware date
// functions, and correctness (DST) matters more than the small extra
// transfer here. Attendance reads are bounded to parser captures and the
// small set of explicitly linked manual corrections, never the full ledger.

export type RaidListRow = {
  raidDate: string; // YYYY-MM-DD, in GUILD_TIMEZONE
  // Null is the historical, date-only event identity. `name` remains its
  // display label when an older raids metadata row named that date.
  eventName: string | null;
  name: string | null;
  note: string | null;
  zones: string[];
  memberCount: number;
  itemCount: number;
  epAwarded: number;
  gpSpent: number;
  leader: string | null;
};

type LeaderCandidate = { enteredBy: string; createdAt: Date; id: number };

function isEarlierLeaderCandidate(next: LeaderCandidate, current: LeaderCandidate | null): boolean {
  return current === null || next.createdAt < current.createdAt || (next.createdAt.getTime() === current.createdAt.getTime() && next.id < current.id);
}

async function resolveLeaderNames(
  db: ReturnType<typeof drizzle>,
  candidates: Iterable<LeaderCandidate | null>,
): Promise<Map<string, string>> {
  const userIds = [...new Set([...candidates].flatMap((candidate) => (candidate ? [candidate.enteredBy] : [])))];
  if (userIds.length === 0) return new Map();

  const [userRows, playerRows] = await Promise.all([
    db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds)),
    db
      .select({ userId: players.userId, mainCharacterId: players.mainCharacterId })
      .from(players)
      .where(inArray(players.userId, userIds)),
  ]);
  const usernameByUser = new Map(userRows.map((row) => [row.id, row.username]));
  const accountsByUser = new Map<string, typeof playerRows>();
  for (const row of playerRows) {
    if (!row.userId) continue;
    const accountRows = accountsByUser.get(row.userId) ?? [];
    accountRows.push(row);
    accountsByUser.set(row.userId, accountRows);
  }

  const unambiguousMainIds = [...new Set(
    [...accountsByUser.values()].flatMap((rows) => (rows.length === 1 && rows[0].mainCharacterId != null ? [rows[0].mainCharacterId] : [])),
  )];
  const mainRows = unambiguousMainIds.length
    ? await db.select({ id: characters.id, name: characters.name }).from(characters).where(inArray(characters.id, unambiguousMainIds))
    : [];
  const mainById = new Map(mainRows.map((row) => [row.id, row.name]));

  return new Map(userIds.map((userId) => {
    const accountRows = accountsByUser.get(userId) ?? [];
    const mainName = accountRows.length === 1 && accountRows[0].mainCharacterId != null
      ? mainById.get(accountRows[0].mainCharacterId)
      : null;
    return [userId, mainName ?? usernameByUser.get(userId) ?? "Unknown"];
  }));
}

export async function listRaids(db: ReturnType<typeof drizzle>): Promise<RaidListRow[]> {
  const [attRows, lootRows, gpRows, named] = await Promise.all([
    db
      .select({
        id: epLedger.id,
        occurredAt: epLedger.occurredAt,
        createdAt: epLedger.createdAt,
        enteredBy: epLedger.enteredBy,
        activity: epLedger.activity,
        playerId: epLedger.playerId,
        points: epLedger.points,
        zone: epLedger.zone,
        raidDate: epLedger.raidDate,
        raidName: epLedger.raidName,
        source: epLedger.source,
      })
      .from(epLedger)
      .where(or(eq(epLedger.source, "parse"), isNotNull(epLedger.raidDate))),
    db.select({ occurredAt: lootEvents.occurredAt }).from(lootEvents),
    db
      .select({ occurredAt: gpLedger.occurredAt, points: gpLedger.points, raidDate: gpLedger.raidDate, raidName: gpLedger.raidName, source: gpLedger.source, itemName: gpLedger.itemName })
      .from(gpLedger)
      .where(or(eq(gpLedger.source, "parse"), isNotNull(gpLedger.raidDate))),
    db.select().from(raids),
  ]);

  type Bucket = { members: Set<number>; ep: number; zones: Set<string>; leaderCandidate: LeaderCandidate | null };
  const eventKey = (date: string, name: string | null) => `${date}\u0000${name ?? ""}`;
  const attByEvent = new Map<string, Bucket>();
  for (const r of attRows) {
    const d = r.raidDate ?? toGuildDateString(r.occurredAt);
    const key = eventKey(d, r.raidName);
    let b = attByEvent.get(key);
    if (!b) {
      b = { members: new Set(), ep: 0, zones: new Set(), leaderCandidate: null };
      attByEvent.set(key, b);
    }
    if (r.points > 0) b.ep += r.points;
    if (ATTENDANCE_GATED_ACTIVITIES.has(r.activity)) {
      if (r.playerId != null) b.members.add(r.playerId);
      if (r.zone) b.zones.add(r.zone);
      if (r.source === "parse" && r.enteredBy) {
        const candidate = { enteredBy: r.enteredBy, createdAt: r.createdAt, id: r.id };
        if (isEarlierLeaderCandidate(candidate, b.leaderCandidate)) b.leaderCandidate = candidate;
      }
    }
  }

  const lootByEvent = new Map<string, number>();
  for (const r of lootRows) {
    const d = toGuildDateString(r.occurredAt);
    const key = eventKey(d, null);
    lootByEvent.set(key, (lootByEvent.get(key) ?? 0) + 1);
  }

  const gpByEvent = new Map<string, number>();
  for (const r of gpRows) {
    const d = r.raidDate ?? toGuildDateString(r.occurredAt);
    const key = eventKey(d, r.raidName);
    gpByEvent.set(key, (gpByEvent.get(key) ?? 0) + r.points);
    if (r.source === "manual" && r.raidDate && r.itemName) {
      lootByEvent.set(key, (lootByEvent.get(key) ?? 0) + 1);
    }
  }

  // Live-bid loot has no raid_name. When a date contains one named event,
  // that unambiguous date-only activity belongs to it rather than a second
  // phantom event row. Do not guess when multiple named events share a date.
  const namedKeysByDate = new Map<string, string[]>();
  for (const key of [...attByEvent.keys(), ...named.map((raid) => eventKey(raid.raidDate, raid.name))]) {
    const [date, name] = key.split("\u0000");
    if (name) namedKeysByDate.set(date, [...new Set([...(namedKeysByDate.get(date) ?? []), key])]);
  }
  for (const [date, namedKeys] of namedKeysByDate) {
    if (namedKeys.length !== 1) continue;
    const legacyKey = eventKey(date, null);
    const namedKey = namedKeys[0];
    const loot = lootByEvent.get(legacyKey);
    if (loot !== undefined) {
      lootByEvent.set(namedKey, (lootByEvent.get(namedKey) ?? 0) + loot);
      lootByEvent.delete(legacyKey);
    }
    const gp = gpByEvent.get(legacyKey);
    if (gp !== undefined) {
      gpByEvent.set(namedKey, (gpByEvent.get(namedKey) ?? 0) + gp);
      gpByEvent.delete(legacyKey);
    }
  }

  const dataEvents = new Set<string>([...attByEvent.keys(), ...lootByEvent.keys(), ...gpByEvent.keys()]);
  const metaByEvent = new Map<string, (typeof named)[number]>();
  for (const meta of named) {
    const namedKey = eventKey(meta.raidDate, meta.name);
    const legacyKey = eventKey(meta.raidDate, null);
    // Before raid_name existed, a metadata name described the only event on
    // that date. Keep that label on its historical date-only ledger rows.
    metaByEvent.set(!dataEvents.has(namedKey) && dataEvents.has(legacyKey) ? legacyKey : namedKey, meta);
  }
  const leaderNames = await resolveLeaderNames(db, [...attByEvent.values()].map((bucket) => bucket.leaderCandidate));
  const overridePlayerIds = [...new Set(named.flatMap((raid) => (raid.leaderPlayerId != null ? [raid.leaderPlayerId] : [])))];
  const overrideLeaders = overridePlayerIds.length
    ? await db
      .select({ playerId: players.id, name: characters.name })
      .from(players)
      .innerJoin(characters, eq(characters.id, players.mainCharacterId))
      .where(inArray(players.id, overridePlayerIds))
    : [];
  const overrideLeaderNames = new Map(overrideLeaders.map((leader) => [leader.playerId, leader.name]));

  const events = new Set<string>([...attByEvent.keys(), ...lootByEvent.keys(), ...gpByEvent.keys(), ...metaByEvent.keys()]);
  const rows: RaidListRow[] = [];
  for (const key of events) {
    const [d, name] = key.split("\u0000");
    const eventName = name || null;
    const a = attByEvent.get(key);
    const meta = metaByEvent.get(key);
    rows.push({
      raidDate: d,
      eventName,
      name: meta?.name ?? eventName,
      note: meta?.note ?? null,
      zones: a ? [...a.zones] : [],
      memberCount: a?.members.size ?? 0,
      itemCount: lootByEvent.get(key) ?? 0,
      epAwarded: a?.ep ?? 0,
      gpSpent: gpByEvent.get(key) ?? 0,
      leader: meta?.leaderPlayerId != null
        ? overrideLeaderNames.get(meta.leaderPlayerId) ?? null
        : a?.leaderCandidate ? leaderNames.get(a.leaderCandidate.enteredBy) ?? null : null,
    });
  }
  rows.sort((x, y) => (x.raidDate === y.raidDate ? (x.name ?? "").localeCompare(y.name ?? "") : x.raidDate < y.raidDate ? 1 : -1));
  return rows;
}

export type RaidCapture = {
  activity: string;
  occurredAt: Date;
  zone: string | null;
  // `ep` is what this specific capture awarded that member (their own
  // ep_ledger row's points) — not their standing priority, which doesn't
  // say anything about tonight's attendance and used to be shown here by
  // mistake (leader, 2026-09-05).
  members: { name: string; ep: number }[];
};

export type RaidLootBid = {
  characterName: string;
  tier: string;
  prioritySnapshot: number | null;
  status: "active" | "retracted" | "won" | "lost";
};

export type RaidLootWinner = {
  characterName: string;
  tier: string;
  gp: number | null;
  note: string | null;
};

export type RaidLoot = {
  lootEventId: number;
  itemName: string;
  occurredAt: Date;
  winners: RaidLootWinner[];
  manual: boolean;
  // Every bid placed on this drop — for the detail page's expandable loot
  // rows (post-live-test-1 LT-18), so members can review the priorities
  // behind a past raid's loot without leaving the raid.
  bids: RaidLootBid[];
};

export type RaidDetail = {
  raidDate: string;
  name: string | null;
  note: string | null;
  memberCount: number;
  epAwarded: number;
  gpSpent: number;
  leader: string | null;
  leaderPlayerId: number | null;
  classAttendance: { classId: number; count: number }[];
  captures: RaidCapture[];
  loot: RaidLoot[];
};

export async function getRaidDetail(db: ReturnType<typeof drizzle>, raidDate: string, raidName: string | null = null): Promise<RaidDetail | null> {
  const bounds = guildDayBounds(raidDate);
  if (!bounds) return null;
  const { start, end } = bounds;

  const eventNameCondition = (column: typeof epLedger.raidName | typeof gpLedger.raidName | typeof raids.name) => raidName === null ? isNull(column) : eq(column, raidName);
  const [attRows, lootRows, allBidRows, gpRows, meta] = await Promise.all([
    db
      .select({
        activity: epLedger.activity,
        occurredAt: epLedger.occurredAt,
        zone: epLedger.zone,
        points: epLedger.points,
        playerId: epLedger.playerId,
        id: epLedger.id,
        createdAt: epLedger.createdAt,
        enteredBy: epLedger.enteredBy,
        source: epLedger.source,
        raidDate: epLedger.raidDate,
        raidName: epLedger.raidName,
        characterName: characters.name,
        characterClass: characters.class,
      })
      .from(epLedger)
      .leftJoin(characters, eq(characters.id, epLedger.characterId))
      .where(or(
        and(eq(epLedger.source, "parse"), gte(epLedger.occurredAt, start), lt(epLedger.occurredAt, end), eventNameCondition(epLedger.raidName)),
        and(eq(epLedger.raidDate, raidDate), eventNameCondition(epLedger.raidName)),
      )),
    db
      .select({
        id: lootEvents.id,
        itemName: lootEvents.itemName,
        occurredAt: lootEvents.occurredAt,
      })
      .from(lootEvents)
      .where(and(gte(lootEvents.occurredAt, start), lt(lootEvents.occurredAt, end))),
    db
      .select({
        lootEventId: bids.lootEventId,
        characterName: characters.name,
        tier: bids.tier,
        prioritySnapshot: bids.prioritySnapshot,
        status: bids.status,
        bidId: bids.id,
        note: bids.note,
        characterId: bids.characterId,
        playerId: bids.playerId,
        characterPlayerId: characters.playerId,
      })
      .from(bids)
      .innerJoin(lootEvents, eq(lootEvents.id, bids.lootEventId))
      .leftJoin(characters, eq(characters.id, bids.characterId))
      .where(and(gte(lootEvents.occurredAt, start), lt(lootEvents.occurredAt, end))),
    db
      .select({
        id: gpLedger.id,
        itemName: gpLedger.itemName,
        characterId: gpLedger.characterId,
        playerId: gpLedger.playerId,
        points: gpLedger.points,
        occurredAt: gpLedger.occurredAt,
        tier: gpLedger.tier,
        note: gpLedger.note,
        source: gpLedger.source,
        raidDate: gpLedger.raidDate,
        raidName: gpLedger.raidName,
        characterName: characters.name,
      })
      .from(gpLedger)
      .leftJoin(characters, eq(characters.id, gpLedger.characterId))
      .where(or(
        and(eq(gpLedger.source, "parse"), gte(gpLedger.occurredAt, start), lt(gpLedger.occurredAt, end)),
        eq(gpLedger.raidDate, raidDate),
      )),
    db.select().from(raids).where(eq(raids.raidDate, raidDate)),
  ]);

  const eventMeta = raidName === null ? meta[0] : meta.find((event) => event.name === raidName);
  const namedEventCount = new Set(meta.flatMap((event) => event.name ? [event.name] : [])).size;
  const includeDateOnlyLiveLoot = raidName === null || namedEventCount === 1;
  if (!includeDateOnlyLiveLoot) {
    lootRows.length = 0;
    allBidRows.length = 0;
  }
  gpRows.splice(0, gpRows.length, ...gpRows.filter((row) => {
    if (row.raidName === raidName) return true;
    return includeDateOnlyLiveLoot && row.raidName === null;
  }));

  if (attRows.length === 0 && lootRows.length === 0 && gpRows.length === 0 && meta.length === 0) return null;

  // The event detail is a member-facing rollup, not a correction audit. Group
  // missed/manual awards with the matching activity and zone so a member who
  // was added later appears alongside everyone else who attended.
  const captureMap = new Map<string, RaidCapture>();
  const playerIds = new Set<number>();
  const classAttendance = new Map<string, { classId: number; players: Set<number> }>();
  let leaderCandidate: LeaderCandidate | null = null;
  let epAwarded = 0;
  for (const r of attRows) {
    if (r.points > 0) epAwarded += r.points;
    if (!ATTENDANCE_GATED_ACTIVITIES.has(r.activity)) continue;
    if (r.playerId != null) {
      playerIds.add(r.playerId);
      const classId = r.characterClass ?? 99;
      const key = `${classId}@${r.playerId}`;
      if (!classAttendance.has(key)) classAttendance.set(key, { classId, players: new Set([r.playerId]) });
    }
    if (r.source === "parse" && r.enteredBy) {
      const candidate = { enteredBy: r.enteredBy, createdAt: r.createdAt, id: r.id };
      if (isEarlierLeaderCandidate(candidate, leaderCandidate)) leaderCandidate = candidate;
    }
    const key = `${r.activity}@${r.zone ?? ""}`;
    let cap = captureMap.get(key);
    if (!cap) {
      cap = {
        activity: r.activity,
        occurredAt: r.occurredAt,
        zone: r.zone,
        members: [],
      };
      captureMap.set(key, cap);
    }
    if (r.occurredAt < cap.occurredAt) cap.occurredAt = r.occurredAt;
    cap.members.push({ name: r.characterName ?? "(unknown)", ep: r.points });
  }
  const captures = [...captureMap.values()].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  for (const c of captures) c.members.sort((a, b) => a.name.localeCompare(b.name));

  // Current GP rows are the authoritative event winner record. A bid is
  // immutable history: after an officer corrects a winner or changes a drop
  // to NoLooter/rot, the event summary follows the surviving ledger row.
  const winnersByItem = new Map<string, RaidLootWinner[]>();
  for (const g of gpRows) {
    if (!g.itemName) continue;
    const item = g.itemName.toLowerCase();
    const winners = winnersByItem.get(item) ?? [];
    winners.push({ characterName: g.characterName ?? "(unknown)", tier: g.tier ?? "—", gp: g.points, note: g.note });
    winnersByItem.set(item, winners);
  }
  const bidsByLootEvent = new Map<number, RaidLootBid[]>();
  const winnersByLootEvent = new Map<number, RaidLootWinner[]>();
  const itemNameByLootEvent = new Map(lootRows.map((loot) => [loot.id, loot.itemName]));
  for (const b of allBidRows) {
    const list = bidsByLootEvent.get(b.lootEventId) ?? [];
    list.push({
      characterName: b.characterName ?? "(unknown)",
      tier: b.tier,
      prioritySnapshot: b.prioritySnapshot,
      status: b.status,
    });
    bidsByLootEvent.set(b.lootEventId, list);
    if (b.status === "won") winnersByLootEvent.set(b.lootEventId, winnersByItem.get(itemNameByLootEvent.get(b.lootEventId)?.toLowerCase() ?? "") ?? []);
  }

  const loot: RaidLoot[] = lootRows
    .map((r) => ({
      lootEventId: r.id,
      itemName: r.itemName,
      occurredAt: r.occurredAt,
      winners: winnersByLootEvent.get(r.id) ?? [],
      manual: false,
      bids: bidsByLootEvent.get(r.id) ?? [],
    }))
      .concat(
      gpRows
        .filter((g) => g.source === "manual" && g.raidDate === raidDate && g.raidName === raidName && !lootRows.some((loot) => loot.itemName.toLowerCase() === g.itemName?.toLowerCase()))
        .map((g) => ({
          // Manual rows do not have a loot_events record. A negative id keeps
          // their expandable-row key distinct from real positive event ids.
          lootEventId: -g.id,
          itemName: g.itemName ?? "(unnamed item)",
          occurredAt: g.occurredAt,
          winners: [{
            characterName: g.characterName ?? "(unknown)",
            tier: g.tier ?? "—",
            gp: g.points,
            note: [g.tier === "Rot (No-Drop)" ? "Rot loot" : "Manual entry", g.note].filter(Boolean).join(" - "),
          }],
          manual: true,
          bids: [],
        })),
    )
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  const gpSpent = gpRows.reduce((n, g) => n + g.points, 0);
  const leaderNames = await resolveLeaderNames(db, [leaderCandidate]);
  const leaderPlayerId = eventMeta?.leaderPlayerId ?? null;
  const [leaderOverride] = leaderPlayerId == null
    ? []
    : await db
      .select({ name: characters.name })
      .from(players)
      .innerJoin(characters, eq(characters.id, players.mainCharacterId))
      .where(eq(players.id, leaderPlayerId));

  return {
    raidDate,
    name: eventMeta?.name ?? raidName,
    note: eventMeta?.note ?? null,
    memberCount: playerIds.size,
    epAwarded,
    gpSpent,
    leader: leaderOverride?.name ?? (leaderCandidate ? leaderNames.get(leaderCandidate.enteredBy) ?? null : null),
    leaderPlayerId,
    classAttendance: Array.from(
      [...classAttendance.values()]
        .reduce<Map<number, number>>((counts, { classId, players }) => counts.set(classId, (counts.get(classId) ?? 0) + players.size), new Map())
        .entries(),
      ([classId, count]) => ({ classId, count }),
    ),
    captures,
    loot,
  };
}

export type ReverseRaidResult =
  | { ok: true; epRows: number; gpRows: number; lootEvents: number; bids: number }
  | { error: string };

// Undo an entire raid night as a unit: delete every `source='parse'`
// ep_ledger and gp_ledger row inside that guild-local calendar day, plus
// the loot_events and bids in the same window. Mirrors reverseDecayEvent
// (src/lib/epgp/decay.ts) — each deleted ledger row gets a ledger_audit_log
// "delete" entry (the audit table has no FK to the row, so it survives),
// and standings are rebuilt with { all: true } at the end the same way a
// decay reverse does. D1 executes the set-based batch as one transaction,
// including the audits and dirty marker, so a partial reversal is impossible.
//
// The optional `raids` meta row (officer-set name/note) is left in place,
// like a reversed decay_events row is kept: it's the record that the night
// happened. A re-parse or re-import of the same date repopulates the
// ledger rows under it. `getRaidDetail` returns non-null while that lone
// meta row exists, so the detail page still renders (empty) — harmless.
export async function reverseRaid(db: ReturnType<typeof drizzle>, raidDate: string, reversedBy: string): Promise<ReverseRaidResult> {
  const bounds = guildDayBounds(raidDate);
  if (!bounds) return { error: "Bad raid date." };
  const { start, end } = bounds;

  const startSeconds = Math.floor(start.getTime() / 1000);
  const endSeconds = Math.floor(end.getTime() / 1000);
  const ledgerPredicate = "source = 'parse' AND occurred_at >= ? AND occurred_at < ?";
  const lootPredicate = "occurred_at >= ? AND occurred_at < ?";
  const d1 = db.$client;
  const results = await d1.batch([
    d1.prepare(`SELECT count(*) AS count FROM ep_ledger WHERE ${ledgerPredicate}`).bind(startSeconds, endSeconds),
    d1.prepare(`SELECT count(*) AS count FROM gp_ledger WHERE ${ledgerPredicate}`).bind(startSeconds, endSeconds),
    d1.prepare(`SELECT count(*) AS count FROM loot_events WHERE ${lootPredicate}`).bind(startSeconds, endSeconds),
    d1.prepare(`SELECT count(*) AS count FROM bids WHERE loot_event_id IN (SELECT id FROM loot_events WHERE ${lootPredicate})`).bind(startSeconds, endSeconds),
    d1.prepare(`
      INSERT INTO standings_dirty (scope, marked_at)
      SELECT 'all', unixepoch()
      WHERE EXISTS (SELECT 1 FROM ep_ledger WHERE ${ledgerPredicate})
         OR EXISTS (SELECT 1 FROM gp_ledger WHERE ${ledgerPredicate})
      ON CONFLICT(scope) DO UPDATE SET marked_at = excluded.marked_at
    `).bind(startSeconds, endSeconds, startSeconds, endSeconds),
    prepareDeleteAudit(d1, "gp", ledgerPredicate, [startSeconds, endSeconds], reversedBy),
    prepareDeleteAudit(d1, "ep", ledgerPredicate, [startSeconds, endSeconds], reversedBy),
    d1.prepare(`UPDATE loot_events SET winning_bid_id = NULL WHERE ${lootPredicate}`).bind(startSeconds, endSeconds),
    d1.prepare(`DELETE FROM bids WHERE loot_event_id IN (SELECT id FROM loot_events WHERE ${lootPredicate})`).bind(startSeconds, endSeconds),
    d1.prepare(`DELETE FROM loot_events WHERE ${lootPredicate}`).bind(startSeconds, endSeconds),
    d1.prepare(`DELETE FROM gp_ledger WHERE ${ledgerPredicate}`).bind(startSeconds, endSeconds),
    d1.prepare(`DELETE FROM ep_ledger WHERE ${ledgerPredicate}`).bind(startSeconds, endSeconds),
  ]);

  const count = (result: D1Result | undefined) => Number((result?.results[0] as { count?: number } | undefined)?.count ?? 0);
  const epRows = count(results[0]);
  const gpRows = count(results[1]);
  const lootCount = count(results[2]);
  const bidCount = count(results[3]);
  if (epRows === 0 && gpRows === 0 && lootCount === 0) {
    return { error: "No parsed attendance, GP, or loot rows on that date — nothing to reverse." };
  }

  await settleStandings(db, { all: true });

  await recordSystemEvent(db, await webActor(db, reversedBy), {
    action: "epgp.raid.reverse",
    targetType: "raid",
    targetId: raidDate,
    summary: `Raid ${raidDate} reversed (${epRows} EP rows, ${gpRows} GP rows, ${lootCount} loot events, ${bidCount} bids)`,
    before: { epRows, gpRows, lootEvents: lootCount, bids: bidCount },
  });

  return { ok: true, epRows, gpRows, lootEvents: lootCount, bids: bidCount };
}

export async function setRaidMeta(
  db: ReturnType<typeof drizzle>,
  raidDate: string,
  name: string | null,
  note: string | null,
  userId: string,
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raidDate)) throw new Error("Bad raid date.");
  const now = new Date();
  const [existing] = await db
    .select({ id: raids.id })
    .from(raids)
    .where(and(eq(raids.raidDate, raidDate), name === null ? isNull(raids.name) : eq(raids.name, name)));
  if (existing) {
    await db.update(raids).set({ note, updatedAt: now }).where(eq(raids.id, existing.id));
  } else {
    await db.insert(raids).values({ raidDate, name, note, createdBy: userId, updatedAt: now });
  }
  await recordSystemEvent(db, await webActor(db, userId), {
    action: "epgp.raid.meta",
    targetType: "raid",
    targetId: raidDate,
    summary: `Raid ${raidDate} renamed to "${name ?? ""}"`,
    after: { name, note },
  });
}

// An attendance submitter is normally the event leader, but an officer can
// correct exceptional nights. Moving or adding Event Lead EP is explicit:
// officers sometimes already recorded the correct award manually.
export async function setRaidLeader(
  db: ReturnType<typeof drizzle>,
  raidDate: string,
  leaderPlayerId: number,
  changedBy: string,
  updateEventLead = false,
): Promise<void> {
  const bounds = guildDayBounds(raidDate);
  if (!bounds) throw new Error("Bad raid date.");
  const [leader] = await db
    .select({ playerId: players.id, characterId: characters.id, name: characters.name })
    .from(players)
    .innerJoin(characters, eq(characters.id, players.mainCharacterId))
    .where(eq(players.id, leaderPlayerId));
  if (!leader) throw new Error("The selected leader needs a current main character.");

  const [existingMeta] = await db.select().from(raids).where(eq(raids.raidDate, raidDate));
  const now = new Date();
  if (existingMeta) {
    await db.update(raids).set({ leaderPlayerId, updatedAt: now }).where(eq(raids.id, existingMeta.id));
  } else {
    await db.insert(raids).values({ raidDate, leaderPlayerId, createdBy: changedBy, updatedAt: now });
  }

  if (!updateEventLead) {
    await recordSystemEvent(db, await webActor(db, changedBy), {
      action: "epgp.raid.meta", targetType: "raid", targetId: raidDate,
      summary: `Event leader for ${raidDate} set to ${leader.name}`,
      before: { leaderPlayerId: existingMeta?.leaderPlayerId ?? null }, after: { leaderPlayerId },
    });
    return;
  }

  const eventLeadRows = await db
    .select()
    .from(epLedger)
    .where(and(eq(epLedger.activity, "Event Lead"), eq(epLedger.source, "parse"), gte(epLedger.occurredAt, bounds.start), lt(epLedger.occurredAt, bounds.end)));
  const affectedPlayerIds = new Set<number>([leader.playerId]);
  for (const row of eventLeadRows) {
    if (row.playerId != null) affectedPlayerIds.add(row.playerId);
    const after = { ...row, characterId: leader.characterId, playerId: leader.playerId };
    await db.update(epLedger).set({ characterId: leader.characterId, playerId: leader.playerId }).where(eq(epLedger.id, row.id));
    await recordLedgerChange(db, "ep", row.id, "update", row, after, changedBy);
  }

  if (eventLeadRows.length === 0) {
    const [capture] = await db
      .select({ occurredAt: epLedger.occurredAt })
      .from(epLedger)
      .where(and(eq(epLedger.source, "parse"), gte(epLedger.occurredAt, bounds.start), lt(epLedger.occurredAt, bounds.end), inArray(epLedger.activity, [...ATTENDANCE_GATED_ACTIVITIES])))
      .orderBy(epLedger.occurredAt)
      .limit(1);
    if (!capture) throw new Error("This event has no parsed attendance capture to attach an Event Lead award to.");
    const points = await getActivePointValue(db, "ep", "Event Lead");
    if (points === null) throw new Error('"Event Lead" is not a current EP activity.');
    const result = await insertLedgerEntry(
      db,
      { kind: "ep", characterId: leader.characterId, activity: "Event Lead", points, occurredAt: capture.occurredAt.toISOString(), note: `Event leader corrected for ${raidDate}.`, raidDate },
      changedBy,
    );
    if (!result.ok) throw new Error(result.error);
  }

  await settleStandings(db, { playerIds: [...affectedPlayerIds] });
  await recordSystemEvent(db, await webActor(db, changedBy), {
    action: "epgp.raid.meta",
    targetType: "raid",
    targetId: raidDate,
    summary: `Event leader for ${raidDate} set to ${leader.name}`,
    before: { leaderPlayerId: existingMeta?.leaderPlayerId ?? null },
    after: { leaderPlayerId, eventLeadRowsMoved: eventLeadRows.length },
  });
}

// Name a raid from an officer-app attendance submit. Unlike setRaidMeta
// (the site's own inline editor — a deliberate overwrite), this never
// clobbers a name that's already there: the first submit of the night
// names the raid, and a later Raid-Start/Mid/End submit carrying the same
// (or a since-changed) value leaves the existing name alone. `note` is
// never touched from this path. A blank name is a no-op — the field is
// optional in the app.
export async function nameRaidFromCapture(
  db: ReturnType<typeof drizzle>,
  raidDate: string,
  name: string,
  userId: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raidDate)) throw new Error("Bad raid date.");
  const now = new Date();
  const [existing] = await db.select({ id: raids.id }).from(raids).where(and(eq(raids.raidDate, raidDate), eq(raids.name, trimmed)));
  if (!existing) await db.insert(raids).values({ raidDate, name: trimmed, createdBy: userId, updatedAt: now });
}
