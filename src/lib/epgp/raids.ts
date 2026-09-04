import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { bids, characters, epLedger, gpLedger, lootEvents, raids } from "@/db";

import { getStandings } from "./standings";

// A "raid" is not a stored row — it's every `source='parse'` attendance
// award plus every loot event that share a UTC calendar date. This module
// derives that grouping and merges in the optional officer-set name/note
// from the `raids` table (keyed by the same date string).

export type RaidListRow = {
  raidDate: string; // YYYY-MM-DD (UTC)
  name: string | null;
  note: string | null;
  zones: string[];
  memberCount: number;
  itemCount: number;
  epAwarded: number;
  gpSpent: number;
};

const DATE = (col: typeof epLedger.occurredAt | typeof gpLedger.occurredAt | typeof lootEvents.occurredAt) =>
  sql<string>`strftime('%Y-%m-%d', ${col}, 'unixepoch')`;

export async function listRaids(db: ReturnType<typeof drizzle>): Promise<RaidListRow[]> {
  const [att, loot, gp, named] = await Promise.all([
    db
      .select({
        d: DATE(epLedger.occurredAt),
        members: sql<number>`count(distinct ${epLedger.playerId})`,
        ep: sql<number>`coalesce(sum(case when ${epLedger.points} > 0 then ${epLedger.points} else 0 end), 0)`,
        zones: sql<string | null>`group_concat(distinct ${epLedger.zone})`,
      })
      .from(epLedger)
      .where(eq(epLedger.source, "parse"))
      .groupBy(DATE(epLedger.occurredAt)),
    db
      .select({ d: DATE(lootEvents.occurredAt), items: sql<number>`count(*)` })
      .from(lootEvents)
      .groupBy(DATE(lootEvents.occurredAt)),
    db
      .select({ d: DATE(gpLedger.occurredAt), gp: sql<number>`coalesce(sum(${gpLedger.points}), 0)` })
      .from(gpLedger)
      .where(eq(gpLedger.source, "parse"))
      .groupBy(DATE(gpLedger.occurredAt)),
    db.select().from(raids),
  ]);

  const lootByDate = new Map(loot.map((r) => [r.d, r.items]));
  const gpByDate = new Map(gp.map((r) => [r.d, r.gp]));
  const namedByDate = new Map(named.map((r) => [r.raidDate, r]));

  const dates = new Set<string>([...att.map((r) => r.d), ...loot.map((r) => r.d)]);
  const rows: RaidListRow[] = [];
  for (const d of dates) {
    const a = att.find((r) => r.d === d);
    const meta = namedByDate.get(d);
    rows.push({
      raidDate: d,
      name: meta?.name ?? null,
      note: meta?.note ?? null,
      zones: a?.zones ? [...new Set(a.zones.split(",").map((z) => z.trim()).filter(Boolean))] : [],
      memberCount: a?.members ?? 0,
      itemCount: lootByDate.get(d) ?? 0,
      epAwarded: a?.ep ?? 0,
      gpSpent: gpByDate.get(d) ?? 0,
    });
  }
  rows.sort((x, y) => (x.raidDate < y.raidDate ? 1 : -1));
  return rows;
}

export type RaidCapture = {
  activity: string;
  occurredAt: Date;
  zone: string | null;
  members: { name: string; priority: number | null }[];
};

export type RaidLoot = {
  itemName: string;
  occurredAt: Date;
  winnerName: string | null;
  tier: string | null;
  gp: number | null;
  note: string | null;
};

export type RaidDetail = {
  raidDate: string;
  name: string | null;
  note: string | null;
  memberCount: number;
  epAwarded: number;
  gpSpent: number;
  captures: RaidCapture[];
  loot: RaidLoot[];
};

// Bounds for a UTC calendar date, as Date objects drizzle maps to unix
// seconds for the timestamp columns.
function dayBounds(raidDate: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raidDate)) return null;
  const start = new Date(`${raidDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

export async function getRaidDetail(db: ReturnType<typeof drizzle>, raidDate: string): Promise<RaidDetail | null> {
  const bounds = dayBounds(raidDate);
  if (!bounds) return null;
  const { start, end } = bounds;

  const [attRows, lootRows, gpRows, meta, standings] = await Promise.all([
    db
      .select({
        activity: epLedger.activity,
        occurredAt: epLedger.occurredAt,
        zone: epLedger.zone,
        points: epLedger.points,
        playerId: epLedger.playerId,
        characterName: characters.name,
      })
      .from(epLedger)
      .leftJoin(characters, eq(characters.id, epLedger.characterId))
      .where(and(eq(epLedger.source, "parse"), gte(epLedger.occurredAt, start), lt(epLedger.occurredAt, end))),
    db
      .select({
        id: lootEvents.id,
        itemName: lootEvents.itemName,
        occurredAt: lootEvents.occurredAt,
        winnerName: characters.name,
        tier: bids.tier,
        note: bids.note,
        winnerCharacterId: bids.characterId,
      })
      .from(lootEvents)
      .leftJoin(bids, eq(bids.id, lootEvents.winningBidId))
      .leftJoin(characters, eq(characters.id, bids.characterId))
      .where(and(gte(lootEvents.occurredAt, start), lt(lootEvents.occurredAt, end))),
    db
      .select({ itemName: gpLedger.itemName, characterId: gpLedger.characterId, points: gpLedger.points })
      .from(gpLedger)
      .where(and(eq(gpLedger.source, "parse"), gte(gpLedger.occurredAt, start), lt(gpLedger.occurredAt, end))),
    db.select().from(raids).where(eq(raids.raidDate, raidDate)),
    getStandings(db),
  ]);

  if (attRows.length === 0 && lootRows.length === 0 && meta.length === 0) return null;

  // Attendance grouped into captures by (activity, occurredAt) — one /who.
  const captureMap = new Map<string, RaidCapture>();
  const playerIds = new Set<number>();
  let epAwarded = 0;
  for (const r of attRows) {
    if (r.points > 0) epAwarded += r.points;
    if (r.playerId != null) playerIds.add(r.playerId);
    const key = `${r.activity}@${r.occurredAt.getTime()}`;
    let cap = captureMap.get(key);
    if (!cap) {
      cap = { activity: r.activity, occurredAt: r.occurredAt, zone: r.zone, members: [] };
      captureMap.set(key, cap);
    }
    cap.members.push({
      name: r.characterName ?? "(unknown)",
      priority: r.playerId != null ? (standings.get(r.playerId)?.priorityRating ?? null) : null,
    });
  }
  const captures = [...captureMap.values()].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  for (const c of captures) c.members.sort((a, b) => a.name.localeCompare(b.name));

  // GP charge per (item, winner) — first match wins if an item dropped twice.
  const gpByKey = new Map<string, number>();
  for (const g of gpRows) {
    if (!g.itemName || g.characterId == null) continue;
    const k = `${g.itemName.toLowerCase()}@${g.characterId}`;
    if (!gpByKey.has(k)) gpByKey.set(k, g.points);
  }
  const loot: RaidLoot[] = lootRows
    .map((r) => ({
      itemName: r.itemName,
      occurredAt: r.occurredAt,
      winnerName: r.winnerName,
      tier: r.tier,
      note: r.note,
      gp: r.winnerCharacterId != null ? (gpByKey.get(`${r.itemName.toLowerCase()}@${r.winnerCharacterId}`) ?? null) : null,
    }))
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const gpSpent = gpRows.reduce((n, g) => n + g.points, 0);

  return {
    raidDate,
    name: meta[0]?.name ?? null,
    note: meta[0]?.note ?? null,
    memberCount: playerIds.size,
    epAwarded,
    gpSpent,
    captures,
    loot,
  };
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
