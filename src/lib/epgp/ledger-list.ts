import { desc, eq, isNotNull, like, or } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { bids, characters, epLedger, gpLedger, lootEvents, players, users } from "@/db";
import { getStandings } from "./standings";

export type EpLedgerRow = {
  id: number;
  characterName: string;
  occurredAt: Date;
  activity: string;
  points: number;
  note: string | null;
  zone: string | null;
  source: "import" | "manual" | "parse";
  enteredByName: string | null;
};

export type GpLedgerRow = {
  id: number;
  characterName: string;
  occurredAt: Date;
  itemName: string | null;
  tier: string;
  points: number;
  note: string | null;
  source: "import" | "manual" | "parse";
  enteredByName: string | null;
};

export type ListResult<T> = { rows: T[]; hasNext: boolean };

// Shared by the website's /epgp/ledger page and the officer app's GET
// /api/officer/ledger route — previously two verbatim copies of this exact
// query (same selects, same LIKE predicates, same PAGE_SIZE=50 peek-ahead
// pagination via limit(pageSize + 1)). Extracted 2026-08-25 while
// consolidating the Ledger page into tabs.
export async function listLedgerRows(
  db: ReturnType<typeof drizzle>,
  opts: { kind: "ep"; q?: string; page?: number; pageSize?: number },
): Promise<ListResult<EpLedgerRow>>;
export async function listLedgerRows(
  db: ReturnType<typeof drizzle>,
  opts: { kind: "gp"; q?: string; page?: number; pageSize?: number },
): Promise<ListResult<GpLedgerRow>>;
export async function listLedgerRows(
  db: ReturnType<typeof drizzle>,
  opts: { kind: "ep" | "gp"; q?: string; page?: number; pageSize?: number },
): Promise<ListResult<EpLedgerRow | GpLedgerRow>> {
  const pageSize = opts.pageSize ?? 50;
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * pageSize;
  const term = (opts.q ?? "").trim();

  if (opts.kind === "ep") {
    const rows = await db
      .select({
        id: epLedger.id,
        characterName: characters.name,
        occurredAt: epLedger.occurredAt,
        activity: epLedger.activity,
        points: epLedger.points,
        note: epLedger.note,
        zone: epLedger.zone,
        source: epLedger.source,
        enteredByName: users.username,
      })
      .from(epLedger)
      .innerJoin(characters, eq(epLedger.characterId, characters.id))
      .leftJoin(users, eq(epLedger.enteredBy, users.id))
      .where(term ? or(like(characters.name, `%${term}%`), like(epLedger.activity, `%${term}%`)) : undefined)
      .orderBy(desc(epLedger.occurredAt))
      .limit(pageSize + 1)
      .offset(offset);
    return { rows: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
  }

  const rows = await db
    .select({
      id: gpLedger.id,
      characterName: characters.name,
      occurredAt: gpLedger.occurredAt,
      itemName: gpLedger.itemName,
      tier: gpLedger.tier,
      points: gpLedger.points,
      note: gpLedger.note,
      source: gpLedger.source,
      enteredByName: users.username,
    })
    .from(gpLedger)
    .innerJoin(characters, eq(gpLedger.characterId, characters.id))
    .leftJoin(users, eq(gpLedger.enteredBy, users.id))
    .where(term ? or(like(characters.name, `%${term}%`), like(gpLedger.itemName, `%${term}%`), like(gpLedger.tier, `%${term}%`)) : undefined)
    .orderBy(desc(gpLedger.occurredAt))
    .limit(pageSize + 1)
    .offset(offset);
  return { rows: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
}

export type BidHistoryRow = {
  id: number;
  lootEventId: number;
  occurredAt: Date;
  itemName: string;
  characterName: string;
  tier: string;
  status: "active" | "retracted" | "won" | "lost";
  prioritySnapshot: number | null;
  note: string | null;
};

// `bids` has been write-only since it was created (PLAN.md's Phase 12
// writeup notes this explicitly) — every officer /api/officer/bids
// submission has been recording won *and* lost bids, but nothing has ever
// read them back. This is that first read path, added for the Ledger
// page's Bids History tab: every bid ever placed, winner and loser alike,
// joined back to the item it was on and the character who placed it.
export async function listBidHistory(
  db: ReturnType<typeof drizzle>,
  opts: { q?: string; page?: number; pageSize?: number },
): Promise<ListResult<BidHistoryRow>> {
  const pageSize = opts.pageSize ?? 50;
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * pageSize;
  const term = (opts.q ?? "").trim();

  const rows = await db
    .select({
      id: bids.id,
      lootEventId: bids.lootEventId,
      occurredAt: lootEvents.occurredAt,
      itemName: lootEvents.itemName,
      characterName: characters.name,
      tier: bids.tier,
      status: bids.status,
      prioritySnapshot: bids.prioritySnapshot,
      note: bids.note,
    })
    .from(bids)
    .innerJoin(lootEvents, eq(bids.lootEventId, lootEvents.id))
    .innerJoin(characters, eq(bids.characterId, characters.id))
    .where(term ? or(like(lootEvents.itemName, `%${term}%`), like(characters.name, `%${term}%`)) : undefined)
    .orderBy(desc(lootEvents.occurredAt), desc(bids.id))
    .limit(pageSize + 1)
    .offset(offset);
  return { rows: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
}

export type TotalsRow = {
  playerId: number;
  mainCharacterName: string;
  playerStatus: "active" | "inactive" | "departed";
  lastActivityAt: Date | null;
  ep: number;
  gp: number;
  // Amount already subtracted out of raw EP/GP to get the `ep`/`gp` above
  // (totals.ts) — always 0 under decay_model=global (today's default),
  // since global cycle decay is applied as real stored negative rows
  // rather than derived here; only legacy-model pre-cutover history shows
  // a nonzero value. Shown anyway (leader, 2026-09-05) since it's the real
  // field, not a placeholder.
  epDecay: number;
  gpDecay: number;
  priorityRating: number;
};

// EPGP Ledger's "Totals" tab (leader request, 2026-09-05) — one row per
// PLAYER, mirroring the guild sheet's own Totals tab (main character name,
// last activity, EP, GP, priority). Alt/mule activity is already rolled
// into these numbers by construction — player_epgp_totals is computed
// per-player, not per-character (PLAN.md §4a) — so there's no separate
// roll-up step here, unlike character-activity.ts's per-character concern.
// Only players with a resolved main character are listed (Phase 3's
// ambiguous-main group has none yet — see players.note for those).
export async function getTotalsRows(db: ReturnType<typeof drizzle>): Promise<TotalsRow[]> {
  const [rows, standings] = await Promise.all([
    db
      .select({ playerId: players.id, mainCharacterName: characters.name, playerStatus: players.status })
      .from(players)
      .innerJoin(characters, eq(characters.id, players.mainCharacterId))
      .where(isNotNull(players.mainCharacterId)),
    getStandings(db),
  ]);

  return rows
    .map((r) => {
      const s = standings.get(r.playerId);
      return {
        playerId: r.playerId,
        mainCharacterName: r.mainCharacterName,
        playerStatus: r.playerStatus,
        lastActivityAt: s?.lastActivityAt ?? null,
        ep: s?.ep ?? 0,
        gp: s?.gp ?? 0,
        epDecay: s?.epDecay ?? 0,
        gpDecay: s?.gpDecay ?? 0,
        priorityRating: s?.priorityRating ?? 0,
      };
    })
    .sort((a, b) => a.mainCharacterName.localeCompare(b.mainCharacterName));
}
