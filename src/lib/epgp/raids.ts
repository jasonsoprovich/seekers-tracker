import { and, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { bids, characters, epLedger, gpLedger, lootEvents, players, raids, users } from "@/db";
import { ATTENDANCE_GATED_ACTIVITIES } from "@/lib/epgp/attendance";
import { prepareDeleteAudit } from "@/lib/epgp/ledger-audit";
import { settleStandings } from "@/lib/epgp/standings";

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
        source: epLedger.source,
      })
      .from(epLedger)
      .where(or(eq(epLedger.source, "parse"), isNotNull(epLedger.raidDate))),
    db.select({ occurredAt: lootEvents.occurredAt }).from(lootEvents),
    db
      .select({ occurredAt: gpLedger.occurredAt, points: gpLedger.points, raidDate: gpLedger.raidDate, source: gpLedger.source, itemName: gpLedger.itemName })
      .from(gpLedger)
      .where(or(eq(gpLedger.source, "parse"), isNotNull(gpLedger.raidDate))),
    db.select().from(raids),
  ]);

  type Bucket = { members: Set<number>; ep: number; zones: Set<string>; leaderCandidate: LeaderCandidate | null };
  const attByDate = new Map<string, Bucket>();
  for (const r of attRows) {
    const d = r.raidDate ?? toGuildDateString(r.occurredAt);
    let b = attByDate.get(d);
    if (!b) {
      b = { members: new Set(), ep: 0, zones: new Set(), leaderCandidate: null };
      attByDate.set(d, b);
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

  const lootByDate = new Map<string, number>();
  for (const r of lootRows) {
    const d = toGuildDateString(r.occurredAt);
    lootByDate.set(d, (lootByDate.get(d) ?? 0) + 1);
  }

  const gpByDate = new Map<string, number>();
  for (const r of gpRows) {
    const d = r.raidDate ?? toGuildDateString(r.occurredAt);
    gpByDate.set(d, (gpByDate.get(d) ?? 0) + r.points);
    if (r.source === "manual" && r.raidDate && r.itemName) {
      lootByDate.set(d, (lootByDate.get(d) ?? 0) + 1);
    }
  }

  const namedByDate = new Map(named.map((r) => [r.raidDate, r]));
  const leaderNames = await resolveLeaderNames(db, [...attByDate.values()].map((bucket) => bucket.leaderCandidate));

  const dates = new Set<string>([...attByDate.keys(), ...lootByDate.keys(), ...gpByDate.keys()]);
  const rows: RaidListRow[] = [];
  for (const d of dates) {
    const a = attByDate.get(d);
    const meta = namedByDate.get(d);
    rows.push({
      raidDate: d,
      name: meta?.name ?? null,
      note: meta?.note ?? null,
      zones: a ? [...a.zones] : [],
      memberCount: a?.members.size ?? 0,
      itemCount: lootByDate.get(d) ?? 0,
      epAwarded: a?.ep ?? 0,
      gpSpent: gpByDate.get(d) ?? 0,
      leader: a?.leaderCandidate ? leaderNames.get(a.leaderCandidate.enteredBy) ?? null : null,
    });
  }
  rows.sort((x, y) => (x.raidDate < y.raidDate ? 1 : -1));
  return rows;
}

export type RaidCapture = {
  activity: string;
  occurredAt: Date;
  zone: string | null;
  manualLink: boolean;
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

export type RaidLoot = {
  lootEventId: number;
  itemName: string;
  occurredAt: Date;
  winnerName: string | null;
  tier: string | null;
  gp: number | null;
  note: string | null;
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
  captures: RaidCapture[];
  loot: RaidLoot[];
};

export async function getRaidDetail(db: ReturnType<typeof drizzle>, raidDate: string): Promise<RaidDetail | null> {
  const bounds = guildDayBounds(raidDate);
  if (!bounds) return null;
  const { start, end } = bounds;

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
        characterName: characters.name,
      })
      .from(epLedger)
      .leftJoin(characters, eq(characters.id, epLedger.characterId))
      .where(or(and(eq(epLedger.source, "parse"), gte(epLedger.occurredAt, start), lt(epLedger.occurredAt, end)), eq(epLedger.raidDate, raidDate))),
    db
      .select({
        id: lootEvents.id,
        itemName: lootEvents.itemName,
        occurredAt: lootEvents.occurredAt,
        winnerName: characters.name,
        tier: bids.tier,
        note: bids.note,
        winnerCharacterId: bids.characterId,
        winnerPlayerId: characters.playerId,
      })
      .from(lootEvents)
      .leftJoin(bids, eq(bids.id, lootEvents.winningBidId))
      .leftJoin(characters, eq(characters.id, bids.characterId))
      .where(and(gte(lootEvents.occurredAt, start), lt(lootEvents.occurredAt, end))),
    db
      .select({
        lootEventId: bids.lootEventId,
        characterName: characters.name,
        tier: bids.tier,
        prioritySnapshot: bids.prioritySnapshot,
        status: bids.status,
        bidId: bids.id,
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
        characterName: characters.name,
      })
      .from(gpLedger)
      .leftJoin(characters, eq(characters.id, gpLedger.characterId))
      .where(or(and(eq(gpLedger.source, "parse"), gte(gpLedger.occurredAt, start), lt(gpLedger.occurredAt, end)), eq(gpLedger.raidDate, raidDate))),
    db.select().from(raids).where(eq(raids.raidDate, raidDate)),
  ]);

  if (attRows.length === 0 && lootRows.length === 0 && gpRows.length === 0 && meta.length === 0) return null;

  // Attendance grouped into captures by (activity, occurredAt) — one /who.
  const captureMap = new Map<string, RaidCapture>();
  const playerIds = new Set<number>();
  let leaderCandidate: LeaderCandidate | null = null;
  let epAwarded = 0;
  for (const r of attRows) {
    if (r.points > 0) epAwarded += r.points;
    if (!ATTENDANCE_GATED_ACTIVITIES.has(r.activity)) continue;
    if (r.playerId != null) playerIds.add(r.playerId);
    if (r.source === "parse" && r.enteredBy) {
      const candidate = { enteredBy: r.enteredBy, createdAt: r.createdAt, id: r.id };
      if (isEarlierLeaderCandidate(candidate, leaderCandidate)) leaderCandidate = candidate;
    }
    const key = `${r.activity}@${r.occurredAt.getTime()}@${r.source}`;
    let cap = captureMap.get(key);
    if (!cap) {
      cap = {
        activity: r.activity,
        occurredAt: r.occurredAt,
        zone: r.zone,
        manualLink: r.source === "manual" && r.raidDate === raidDate,
        members: [],
      };
      captureMap.set(key, cap);
    }
    cap.members.push({ name: r.characterName ?? "(unknown)", ep: r.points });
  }
  const captures = [...captureMap.values()].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  for (const c of captures) c.members.sort((a, b) => a.name.localeCompare(b.name));

  // GP charge per (item, winner) — first match wins if an item dropped twice.
  // Keyed by the winner's ACCOUNT (player_id), not character: insertLedgerEntry
  // charges an alt's win to the account's main character, so matching on
  // bids.character_id left every alt winner's GP showing "—" (leader,
  // 2026-09-11: Korrek's and Blesko's wins on the 09-09 raid). Character id
  // is the fallback for rows written before player_id existed.
  const gpByPlayer = new Map<string, number>();
  const gpByCharacter = new Map<string, number>();
  for (const g of gpRows) {
    if (!g.itemName) continue;
    const item = g.itemName.toLowerCase();
    if (g.playerId != null && !gpByPlayer.has(`${item}@${g.playerId}`)) gpByPlayer.set(`${item}@${g.playerId}`, g.points);
    if (g.characterId != null && !gpByCharacter.has(`${item}@${g.characterId}`)) gpByCharacter.set(`${item}@${g.characterId}`, g.points);
  }
  const gpFor = (itemName: string, playerId: number | null, characterId: number | null): number | null => {
    const item = itemName.toLowerCase();
    if (playerId != null) {
      const byPlayer = gpByPlayer.get(`${item}@${playerId}`);
      if (byPlayer !== undefined) return byPlayer;
    }
    if (characterId != null) {
      const byCharacter = gpByCharacter.get(`${item}@${characterId}`);
      if (byCharacter !== undefined) return byCharacter;
    }
    return null;
  };
  const bidsByLootEvent = new Map<number, RaidLootBid[]>();
  for (const b of allBidRows) {
    const list = bidsByLootEvent.get(b.lootEventId) ?? [];
    list.push({
      characterName: b.characterName ?? "(unknown)",
      tier: b.tier,
      prioritySnapshot: b.prioritySnapshot,
      status: b.status,
    });
    bidsByLootEvent.set(b.lootEventId, list);
  }

  const loot: RaidLoot[] = lootRows
    .map((r) => ({
      lootEventId: r.id,
      itemName: r.itemName,
      occurredAt: r.occurredAt,
      winnerName: r.winnerName,
      tier: r.tier,
      note: r.note,
      gp: gpFor(r.itemName, r.winnerPlayerId ?? null, r.winnerCharacterId ?? null),
      bids: bidsByLootEvent.get(r.id) ?? [],
    }))
    .concat(
      gpRows
        .filter((g) => g.source === "manual" && g.raidDate === raidDate)
        .map((g) => ({
          // Manual rows do not have a loot_events record. A negative id keeps
          // their expandable-row key distinct from real positive event ids.
          lootEventId: -g.id,
          itemName: g.itemName ?? "(unnamed item)",
          occurredAt: g.occurredAt,
          winnerName: g.characterName,
          tier: g.tier,
          gp: g.points,
          note: [g.tier === "Rot (No-Drop)" ? "Rot loot" : "Manual entry", g.note].filter(Boolean).join(" - "),
          bids: [],
        })),
    )
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const gpSpent = gpRows.reduce((n, g) => n + g.points, 0);
  const leaderNames = await resolveLeaderNames(db, [leaderCandidate]);

  return {
    raidDate,
    name: meta[0]?.name ?? null,
    note: meta[0]?.note ?? null,
    memberCount: playerIds.size,
    epAwarded,
    gpSpent,
    leader: leaderCandidate ? leaderNames.get(leaderCandidate.enteredBy) ?? null : null,
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
  await db
    .insert(raids)
    .values({ raidDate, name, note, createdBy: userId, updatedAt: now })
    .onConflictDoUpdate({ target: raids.raidDate, set: { name, note, updatedAt: now } });
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
  await db
    .insert(raids)
    .values({ raidDate, name: trimmed, createdBy: userId, updatedAt: now })
    .onConflictDoUpdate({
      target: raids.raidDate,
      set: { name: trimmed, updatedAt: now },
      setWhere: isNull(raids.name),
    });
}
