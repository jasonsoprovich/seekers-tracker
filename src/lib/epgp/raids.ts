import { and, eq, gte, lt } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { bids, characters, epLedger, gpLedger, lootEvents, raids } from "@/db";

import { guildDayBounds, toGuildDateString } from "../guild-timezone";

// A "raid" is not a stored row — it's every `source='parse'` attendance
// award plus every loot event that share a calendar date **in the guild's
// own timezone** (leader, 2026-09-05: raids are scheduled and run on
// Eastern time; grouping by UTC date split a single Eastern evening across
// two rows whenever it straddled UTC midnight — see guild-timezone.ts).
// This module derives that grouping and merges in the optional
// officer-set name/note from the `raids` table (keyed by the same date
// string).
//
// Bucketing happens in JS, not SQL — SQLite has no timezone-aware date
// functions, and correctness (DST) matters more than the small extra
// transfer here. Still bounded to `source='parse'` rows only (real
// attendance/loot captures), never the full ledger — same read-budget
// discipline as everywhere else (PLAN.md §6).

export type RaidListRow = {
  raidDate: string; // YYYY-MM-DD, in GUILD_TIMEZONE
  name: string | null;
  note: string | null;
  zones: string[];
  memberCount: number;
  itemCount: number;
  epAwarded: number;
  gpSpent: number;
};

export async function listRaids(db: ReturnType<typeof drizzle>): Promise<RaidListRow[]> {
  const [attRows, lootRows, gpRows, named] = await Promise.all([
    db
      .select({ occurredAt: epLedger.occurredAt, playerId: epLedger.playerId, points: epLedger.points, zone: epLedger.zone })
      .from(epLedger)
      .where(eq(epLedger.source, "parse")),
    db.select({ occurredAt: lootEvents.occurredAt }).from(lootEvents),
    db.select({ occurredAt: gpLedger.occurredAt, points: gpLedger.points }).from(gpLedger).where(eq(gpLedger.source, "parse")),
    db.select().from(raids),
  ]);

  type Bucket = { members: Set<number>; ep: number; zones: Set<string> };
  const attByDate = new Map<string, Bucket>();
  for (const r of attRows) {
    const d = toGuildDateString(r.occurredAt);
    let b = attByDate.get(d);
    if (!b) {
      b = { members: new Set(), ep: 0, zones: new Set() };
      attByDate.set(d, b);
    }
    if (r.playerId != null) b.members.add(r.playerId);
    if (r.points > 0) b.ep += r.points;
    if (r.zone) b.zones.add(r.zone);
  }

  const lootByDate = new Map<string, number>();
  for (const r of lootRows) {
    const d = toGuildDateString(r.occurredAt);
    lootByDate.set(d, (lootByDate.get(d) ?? 0) + 1);
  }

  const gpByDate = new Map<string, number>();
  for (const r of gpRows) {
    const d = toGuildDateString(r.occurredAt);
    gpByDate.set(d, (gpByDate.get(d) ?? 0) + r.points);
  }

  const namedByDate = new Map(named.map((r) => [r.raidDate, r]));

  const dates = new Set<string>([...attByDate.keys(), ...lootByDate.keys()]);
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
    });
  }
  rows.sort((x, y) => (x.raidDate < y.raidDate ? 1 : -1));
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

export async function getRaidDetail(db: ReturnType<typeof drizzle>, raidDate: string): Promise<RaidDetail | null> {
  const bounds = guildDayBounds(raidDate);
  if (!bounds) return null;
  const { start, end } = bounds;

  const [attRows, lootRows, gpRows, meta] = await Promise.all([
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
    cap.members.push({ name: r.characterName ?? "(unknown)", ep: r.points });
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
