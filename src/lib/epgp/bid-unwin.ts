import { and, asc, eq, gte, lte, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { drizzle } from "drizzle-orm/d1";

import { bids, gpLedger, lootEvents } from "@/db";

type Db = ReturnType<typeof drizzle>;
type GpRow = typeof gpLedger.$inferSelect;

// A winning bid's outcome lives on `bids.status`, separately from the GP
// charge in `gp_ledger` — nothing tied the two together, so deleting a
// winner's GP row (an officer correcting a mis-recorded win) left Bids
// History and the raid page's bid list still saying "Won" (found 2026-09-28,
// Hawthor / Soul Essence of Aten Ha Ra).
//
// Given the GP row about to be deleted, plans the statements that put the
// bid outcome back in step: the winner's bid flips to `lost`, and the loot
// event's winning_bid_id is repointed at another remaining winner (or
// cleared). Returned as batch items so the caller commits them atomically
// with the delete itself; empty when the row isn't a bid win at all (a
// manual adjustment, a decay row, a sheet import).
//
// New rows carry gp_ledger.loot_event_id. Rows written before migration
// 0054 don't, so those fall back to the same item name within 12h of the
// charge (the same window bid-finalization's duplicate guard uses), closest
// loot event first.
const LEGACY_WINDOW_MS = 12 * 60 * 60 * 1000;

export async function planUnwinBidForGpRow(db: Db, gp: GpRow): Promise<BatchItem<"sqlite">[]> {
  if (gp.points <= 0) return [];
  // The bidder is identified by player (an alt's charge lands on its main's
  // character row) or, failing that, the character itself.
  const bidder = [gp.playerId != null ? eq(bids.playerId, gp.playerId) : undefined, gp.characterId != null ? eq(bids.characterId, gp.characterId) : undefined].filter(
    (c) => c !== undefined,
  );
  if (bidder.length === 0) return [];

  let lootEventIds: number[];
  if (gp.lootEventId != null) {
    lootEventIds = [gp.lootEventId];
  } else {
    if (!gp.itemName) return [];
    const at = gp.occurredAt.getTime();
    const candidates = await db
      .select({ id: lootEvents.id, occurredAt: lootEvents.occurredAt })
      .from(lootEvents)
      .where(
        and(
          sql`lower(${lootEvents.itemName}) = ${gp.itemName.toLowerCase()}`,
          gte(lootEvents.occurredAt, new Date(at - LEGACY_WINDOW_MS)),
          lte(lootEvents.occurredAt, new Date(at + LEGACY_WINDOW_MS)),
        ),
      );
    lootEventIds = candidates.sort((a, b) => Math.abs(a.occurredAt.getTime() - at) - Math.abs(b.occurredAt.getTime() - at)).map((c) => c.id);
  }

  for (const lootEventId of lootEventIds) {
    const [won] = await db
      .select({ id: bids.id })
      .from(bids)
      .where(and(eq(bids.lootEventId, lootEventId), eq(bids.status, "won"), or(...bidder)))
      .orderBy(asc(bids.id))
      .limit(1);
    if (!won) continue;

    return [
      db.update(bids).set({ status: "lost" }).where(eq(bids.id, won.id)),
      // Repoint (or clear) the winner pointer only if it was this bid.
      db
        .update(lootEvents)
        .set({
          winningBidId: sql`(SELECT ${bids.id} FROM ${bids} WHERE ${bids.lootEventId} = ${lootEventId} AND ${bids.status} = 'won' AND ${bids.id} <> ${won.id} ORDER BY ${bids.id} ASC LIMIT 1)`,
        })
        .where(and(eq(lootEvents.id, lootEventId), eq(lootEvents.winningBidId, won.id))),
    ];
  }
  return [];
}

