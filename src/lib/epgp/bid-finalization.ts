import { and, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { drizzle } from "drizzle-orm/d1";

import { bids as bidsTable, characters, epgpPointValues, gpLedger, lootEvents } from "@/db";
import { guildDateTime } from "@/lib/guild-timezone";
import { dirtyMarkerStatements, getStandings, getStandingsForPlayers, settleStandings, type StandingsRow } from "@/lib/epgp/standings";
import { boundedString, isoDate, LIMITS } from "@/lib/validate";

// PLAN.md §11 Phase 3 (atomic and idempotent bid finalization). Pulled out
// of the POST /api/officer/bids route handler so the core logic can be
// exercised directly against local D1 (scripts/verify-bid-finalization.ts)
// without needing a live Cloudflare Worker request context — the same
// separation insertLedgerEntry/refreshStandings/decay.ts already use.
//
// Records a full bid round — not just the winner's GP charge. Every
// remaining row from the officer app's Bids capture becomes a `bids` row
// (won/lost) against a new `loot_events` row, so there's a real record of
// who bid what and lost, not just who won. At least one entry must be
// marked a winner; more than one covers a duplicate drop (same item,
// multiple copies), each winner getting its own gp_ledger charge.
// loot_events.winningBidId is a single FK, so it points at the first
// winner only; every winning row is still marked status='won' in `bids`,
// which is the authoritative multi-winner record.
//
// Every entry is resolved and validated (character, tier, winner, GP
// amount) before anything is written (task 3.3), and the loot event,
// every bid row, the winner pointer, and every winner's GP charge commit
// in ONE db.batch() call (task 3.4) — a timeout or a D1 error partway
// through leaves NOTHING, not a half-recorded round. A retry carrying the
// same client-generated submissionId (the parser's BidRound.roundId —
// task 3.1) is recognized before any of that and simply returns the
// original result, GP untouched (task 3.5). The coarser item/time
// heuristic (task 3.6) is retained as a distinct, secondary check — an
// officer-facing warning for a genuinely distinct possible duplicate drop,
// not the mechanism that protects against a mechanical retry anymore.

// A bid round with the same item name and a winning-entry time within this
// of an existing loot_events row is flagged as a likely double-submit.
// Soft: the caller resends with `confirmDuplicate: true` to record it
// anyway (a genuine second drop of the same item the same night is
// normal).
const DUPLICATE_WINDOW_MS = 12 * 60 * 60 * 1000;

// Anything past this is a malformed or duplicated payload, not a real
// round — one item's bid round is every character who tell-bid, winner or
// not.
const MAX_BID_ENTRIES = 200;

export type BidRoundEntryInput = { characterName?: unknown; tier?: unknown; occurredAt?: unknown; isWinner?: unknown };

export type FinalizeBidRoundInput = {
  itemName?: unknown;
  entries?: unknown;
  note?: unknown;
  confirmDuplicate?: unknown;
  submissionId?: unknown;
};

export type FinalizeBidRoundResult =
  | {
      ok: true;
      status: 200 | 201;
      lootEventId: number;
      inserted: number;
      unmatched: string[];
      invalidTiers: string[];
      replay: boolean;
      // Task 4.3 — the winner(s)' current standings right after this round's
      // GP charge landed, so a caller (the officer app, a future UI) can
      // show the post-charge number immediately instead of waiting on its
      // own separate fetch. Always read fresh (getStandingsForPlayers,
      // never the 10s roster-wide cache) — see standings.ts.
      standings: StandingsRow[];
    }
  | {
      ok: false;
      status: number;
      error: string;
      duplicate?: { lootEventId: number; itemName: string; occurredAt: string };
      unmatched?: string[];
      invalidTiers?: string[];
    };

type BidRoundEntry = { characterName: string; tier: string; occurredAt: string; isWinner: boolean };

function isBidEntry(e: unknown): e is BidRoundEntry {
  const entry = e as BidRoundEntryInput;
  return (
    typeof entry?.characterName === "string" &&
    typeof entry?.tier === "string" &&
    typeof entry?.occurredAt === "string" &&
    typeof entry?.isWinner === "boolean"
  );
}

function parseOccurredAt(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function replayResult(db: ReturnType<typeof drizzle>, submissionId: string): Promise<FinalizeBidRoundResult | null> {
  const [existing] = await db
    .select({ id: lootEvents.id })
    .from(lootEvents)
    .where(eq(lootEvents.submissionId, submissionId))
    .limit(1);
  if (!existing) return null;

  const [[countRow], winnerRows] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(bidsTable).where(eq(bidsTable.lootEventId, existing.id)),
    db
      .select({ playerId: characters.playerId })
      .from(bidsTable)
      .innerJoin(characters, eq(characters.id, bidsTable.characterId))
      .where(and(eq(bidsTable.lootEventId, existing.id), eq(bidsTable.status, "won"))),
  ]);
  const winnerPlayerIds = [...new Set(winnerRows.map((r) => r.playerId).filter((id): id is number => id !== null))];
  const settled = winnerPlayerIds.length === 0 || (await settleStandings(db, { playerIds: winnerPlayerIds }));
  const replayStandings = settled ? await getStandingsForPlayers(db, winnerPlayerIds) : new Map<number, StandingsRow>();
  return {
    ok: true,
    status: 200,
    lootEventId: existing.id,
    inserted: Number(countRow?.n ?? 0),
    unmatched: [],
    invalidTiers: [],
    replay: true,
    standings: [...replayStandings.values()],
  };
}

export async function finalizeBidRound(
  db: ReturnType<typeof drizzle>,
  body: FinalizeBidRoundInput,
  enteredBy: string,
): Promise<FinalizeBidRoundResult> {
  const itemCheck = boundedString(body.itemName, { max: LIMITS.itemName, min: 1, field: "itemName" });
  if (!itemCheck.ok) return { ok: false, status: 400, error: itemCheck.error };

  if (!Array.isArray(body.entries) || body.entries.length === 0 || !body.entries.every(isBidEntry)) {
    return {
      ok: false,
      status: 400,
      error: "`entries` must be a non-empty array of { characterName, tier, occurredAt, isWinner }.",
    };
  }
  if (body.entries.length > MAX_BID_ENTRIES) {
    return { ok: false, status: 400, error: `Too many bid entries (limit ${MAX_BID_ENTRIES}).` };
  }
  const entries = body.entries;
  const badField = entries.find(
    (e) => e.characterName.length > LIMITS.characterName || e.tier.length > LIMITS.activity || !isoDate(e.occurredAt).ok,
  );
  if (badField) {
    return { ok: false, status: 400, error: `Invalid name, tier, or time on ${badField.characterName || "an entry"}.` };
  }
  const itemName = itemCheck.value;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, LIMITS.note) || null : null;

  let submissionId: string | null = null;
  if (body.submissionId !== undefined && body.submissionId !== null) {
    const idCheck = boundedString(body.submissionId, { max: LIMITS.submissionId, min: 1, field: "submissionId" });
    if (!idCheck.ok) return { ok: false, status: 400, error: idCheck.error };
    submissionId = idCheck.value;
  }

  const winners = entries.filter((e) => e.isWinner);
  if (winners.length === 0) {
    return { ok: false, status: 400, error: "At least one entry must be marked as a winner." };
  }
  for (const w of winners) {
    if (!parseOccurredAt(w.occurredAt)) {
      return { ok: false, status: 400, error: `Invalid \`occurredAt\` on ${w.characterName}'s winning entry.` };
    }
  }

  // Idempotent replay (task 3.5) — checked before the item/time heuristic
  // below so a legitimate retry of THIS submission (the parser's HTTP
  // client already retries once on a transport error or a 502/503/504,
  // resending the identical body) never has to clear a "possible
  // duplicate" confirm for its own successful first attempt. Only ever
  // matches a submissionId that was actually written by a prior successful
  // call — nothing is written on the way to a 409 below, so a resend after
  // THAT never finds a match here and falls through normally.
  if (submissionId !== null) {
    const replay = await replayResult(db, submissionId);
    if (replay) return replay;
  }

  // Soft duplicate guard — skipped when the caller has already confirmed.
  if (body.confirmDuplicate !== true) {
    const at = parseOccurredAt(winners[0].occurredAt) as Date;
    const lo = new Date(at.getTime() - DUPLICATE_WINDOW_MS);
    const hi = new Date(at.getTime() + DUPLICATE_WINDOW_MS);
    const [existing] = await db
      .select({ id: lootEvents.id, occurredAt: lootEvents.occurredAt })
      .from(lootEvents)
      .where(
        and(
          sql`lower(${lootEvents.itemName}) = ${itemName.toLowerCase()}`,
          gte(lootEvents.occurredAt, lo),
          lte(lootEvents.occurredAt, hi),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        ok: false,
        status: 409,
        error: `"${itemName}" was already recorded around ${guildDateTime(existing.occurredAt)}. Resubmit with confirmDuplicate to record it anyway.`,
        duplicate: { lootEventId: existing.id, itemName, occurredAt: existing.occurredAt.toISOString() },
      };
    }
  }

  const [allCharacters, totals] = await Promise.all([
    db
      .select({ id: characters.id, name: characters.name, playerId: characters.playerId, charType: characters.charType, mainCharacterId: characters.mainCharacterId })
      .from(characters),
    getStandings(db),
  ]);
  const byLowerName = new Map(allCharacters.map((c) => [c.name.toLowerCase(), c]));

  // computeEpgpTotals groups by player_id (PLAN.md §11 Phase 3 task 3.11).
  function priorityFor(c: (typeof allCharacters)[number]): number | null {
    return c.playerId !== null ? (totals.get(c.playerId)?.priorityRating ?? null) : null;
  }

  // Same alt->main redirect as insertLedgerEntry (src/lib/epgp/ledger-entry.ts)
  // — EPGP is tracked per main, never an alt's own row.
  function targetCharacterIdFor(c: (typeof allCharacters)[number]): number {
    return c.charType === "alt" && c.mainCharacterId !== null ? c.mainCharacterId : c.id;
  }

  // Every active GP tier's point value in one query.
  const tierPoints = new Map<string, number>();
  for (const pv of await db
    .select({ activity: epgpPointValues.activity, points: epgpPointValues.points })
    .from(epgpPointValues)
    .where(and(eq(epgpPointValues.kind, "gp"), eq(epgpPointValues.retired, false)))) {
    tierPoints.set(pv.activity, pv.points);
  }

  // Task 3.3: every winner must resolve (character + tier) before anything
  // is written at all — a doomed request can't leave a half-recorded loot
  // event behind, because nothing gets written until this function decides
  // to build the batch below.
  for (const w of winners) {
    if (!byLowerName.get(w.characterName.trim().toLowerCase())) {
      return { ok: false, status: 422, error: `No character found named "${w.characterName}" — fix the name and resubmit.` };
    }
    if (!tierPoints.has(w.tier)) {
      return { ok: false, status: 422, error: `"${w.tier}" isn't a current GP tier.` };
    }
  }

  // Resolve every entry (winner or not) — an entry that doesn't resolve is
  // reported and excluded from the write, but the resolution itself now
  // happens fully before any statement is built.
  const unmatched: string[] = [];
  const invalidTiers: string[] = [];
  const bidValues: { characterId: number; playerId: number | null; tier: string; status: "won" | "lost"; prioritySnapshot: number | null }[] = [];
  for (const entry of entries) {
    const character = byLowerName.get(entry.characterName.trim().toLowerCase());
    if (!character) {
      unmatched.push(entry.characterName);
      continue;
    }
    if (!tierPoints.has(entry.tier)) {
      invalidTiers.push(`${entry.characterName}: "${entry.tier}"`);
      continue;
    }
    bidValues.push({
      characterId: character.id,
      // Phase 7 task 7.3 — captured now so BidHistoryTable's "Current PR"
      // keeps tracking the same real person even if this character is
      // reassigned to a different account later. See schema.ts's own
      // comment on bids.playerId.
      playerId: character.playerId,
      tier: entry.tier,
      status: entry.isWinner ? "won" : "lost",
      prioritySnapshot: priorityFor(character),
    });
  }
  if (bidValues.length === 0) {
    // Every entry failed to resolve — every winner already passed the
    // check above, so this can only happen on a malformed/empty payload;
    // guard it anyway rather than writing an orphaned loot event.
    return { ok: false, status: 422, error: "None of the submitted entries resolved to a character and a valid tier.", unmatched, invalidTiers };
  }

  // A stable key every statement below can resolve "the row this batch is
  // writing" against, without needing a JS-side id from an earlier
  // statement in the SAME db.batch() call (batch() sends the whole array
  // as one request — a later statement can't be built from an id an
  // earlier one will only return once the request completes). Always set,
  // even for a caller that sent no submissionId of its own, purely so this
  // resolution trick always has something to key on; only a client-
  // supplied id gets task 3.5's retry-idempotency benefit on a future call.
  const submissionKey = submissionId ?? crypto.randomUUID();
  const lootEventOccurredAt = parseOccurredAt(winners[0].occurredAt) as Date;

  const statements: BatchItem<"sqlite">[] = [
    db.insert(lootEvents).values({
      itemName,
      occurredAt: lootEventOccurredAt,
      status: "awarded",
      openedBy: enteredBy,
      submissionId: submissionKey,
    }),
  ];
  for (const v of bidValues) {
    statements.push(
      db.insert(bidsTable).values({
        lootEventId: sql`(SELECT id FROM loot_events WHERE submission_id = ${submissionKey})`,
        characterId: v.characterId,
        playerId: v.playerId,
        tier: v.tier,
        status: v.status,
        prioritySnapshot: v.prioritySnapshot,
        note,
      }),
    );
  }
  // Points at the first-inserted 'won' bid row for this round — bidValues
  // preserves `entries` order, so "first" here matches the array-index-
  // based winningBidId this replaced.
  statements.push(
    db
      .update(lootEvents)
      .set({
        winningBidId: sql`(SELECT ${bidsTable.id} FROM ${bidsTable} WHERE ${bidsTable.lootEventId} = (SELECT id FROM loot_events WHERE submission_id = ${submissionKey}) AND ${bidsTable.status} = 'won' ORDER BY ${bidsTable.id} ASC LIMIT 1)`,
      })
      .where(eq(lootEvents.submissionId, submissionKey)),
  );

  const chargedPlayerIds = new Set<number>();
  const bumpTargets = new Map<number, Date>();
  for (const w of winners) {
    const character = byLowerName.get(w.characterName.trim().toLowerCase());
    if (!character) continue; // already validated to exist above
    const points = tierPoints.get(w.tier);
    if (points === undefined) continue; // already validated above
    const targetCharacterId = targetCharacterIdFor(character);
    const at = parseOccurredAt(w.occurredAt) as Date;
    statements.push(
      db.insert(gpLedger).values({
        characterId: targetCharacterId,
        playerId: character.playerId,
        occurredAt: at,
        itemName,
        tier: w.tier,
        points,
        pointsNominal: points,
        pointsAwarded: points,
        capApplied: false,
        capAtEntry: null,
        note,
        enteredBy,
        source: "parse",
      }),
    );
    if (character.playerId != null) chargedPlayerIds.add(character.playerId);
    const prevBump = bumpTargets.get(targetCharacterId);
    if (!prevBump || prevBump < at) bumpTargets.set(targetCharacterId, at);
  }

  // Task 4.4: a durable dirty marker for every winner charged rides in the
  // SAME batch as the loot event/bids/GP charge — so even if the
  // settleStandings recompute below never runs (a crash, an evicted
  // request), there's a durable record that these players' totals need a
  // refresh, picked up by the 2-minute repair pass or the nightly rebuild.
  statements.push(...dirtyMarkerStatements(db, { playerIds: [...chargedPlayerIds] }));

  // Task 3.4: the loot event, every bid row, the winner pointer, every
  // winner's GP charge, and now their dirty marker(s) all commit as ONE D1
  // batch — a transaction, so a mid-write failure rolls every one of these
  // statements back together instead of leaving, say, bids recorded with
  // no GP charged.
  try {
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (error) {
    // Two identical requests can both miss the preflight lookup. The unique
    // submission_id constraint lets only one batch commit; turn the loser
    // into the same replay response instead of leaking a constraint error.
    if (submissionId !== null) {
      const replay = await replayResult(db, submissionId);
      if (replay) return replay;
    }
    throw error;
  }

  // last_activity_at bumps are deliberately OUTSIDE the atomic batch above
  // — derived/display state, not the authoritative ledger rows task 3.4 is
  // about. A failure here after a successful commit means a stale "last
  // active" until the next write touches the same character, never lost or
  // double-counted GP.
  for (const [targetCharacterId, at] of bumpTargets) {
    await db
      .update(characters)
      .set({ lastActivityAt: at })
      .where(and(eq(characters.id, targetCharacterId), or(isNull(characters.lastActivityAt), lt(characters.lastActivityAt, at))));
  }
  // One standings refresh for every winner charged (a duplicate drop can
  // have several) rather than one per winner. Best-effort (task 4.6) — the
  // dirty marker above already guarantees this gets finished even if this
  // particular attempt fails.
  let standings: StandingsRow[] = [];
  if (chargedPlayerIds.size > 0) {
    const settled = await settleStandings(db, { playerIds: [...chargedPlayerIds] });
    if (settled) standings = [...(await getStandingsForPlayers(db, [...chargedPlayerIds])).values()];
  }

  const [lootEventRow] = await db.select({ id: lootEvents.id }).from(lootEvents).where(eq(lootEvents.submissionId, submissionKey)).limit(1);

  return { ok: true, status: 201, lootEventId: lootEventRow.id, inserted: bidValues.length, unmatched, invalidTiers, replay: false, standings };
}
