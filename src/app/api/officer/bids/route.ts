import { and, eq, gte, lte, sql } from "drizzle-orm";

import { bids as bidsTable, characters, epgpPointValues, lootEvents } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { insertLedgerEntry } from "@/lib/epgp/ledger-entry";
import { getStandings, refreshStandings } from "@/lib/epgp/standings";
import { boundedString, isoDate, LIMITS } from "@/lib/validate";
import { guildDateTime } from "@/lib/guild-timezone";

// One item's bid round — every character who tell-bid, winner or not.
// Anything past this is a malformed or duplicated payload.
const MAX_BID_ENTRIES = 200;

type BidEntryBody = { characterName?: unknown; tier?: unknown; occurredAt?: unknown; isWinner?: unknown };
type BidsRequestBody = { itemName?: unknown; entries?: unknown; note?: unknown; confirmDuplicate?: unknown };

// A bid round with the same item name and a winning-entry time within this
// of an existing loot_events row is flagged as a likely double-submit —
// the finalize button double-clicked, or a "Missed Bid" manual entry for
// something already recorded. Soft: the officer resends with
// `confirmDuplicate: true` to record it anyway (a genuine second drop of
// the same item the same night is normal).
const DUPLICATE_WINDOW_MS = 12 * 60 * 60 * 1000;

type BidEntry = { characterName: string; tier: string; occurredAt: string; isWinner: boolean };

function isBidEntry(e: unknown): e is BidEntry {
  const entry = e as BidEntryBody;
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

// Records a full bid round — not just the winner's GP charge. Every
// remaining row from the officer app's Bids capture becomes a `bids` row
// (won/lost) against a new `loot_events` row, so there's a real record of
// who bid what and lost, not just who won — the guild's old sheet never
// had this. At least one entry must be marked a winner (the app's
// "Determine Winner" — tier first, then priority — is a client-side
// suggestion the officer can override; this route just trusts whichever
// rows came back flagged) — more than one covers a duplicate drop (same
// item, multiple copies), each winner getting its own gp_ledger charge.
// loot_events.winningBidId is a single FK, so it points at the first
// winner only; every winning row is still marked status='won' in `bids`,
// which is the authoritative multi-winner record.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: BidsRequestBody;
  try {
    body = (await request.json()) as BidsRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const itemCheck = boundedString(body.itemName, { max: LIMITS.itemName, min: 1, field: "itemName" });
  if (!itemCheck.ok) {
    return Response.json({ error: itemCheck.error }, { status: 400 });
  }
  if (!Array.isArray(body.entries) || body.entries.length === 0 || !body.entries.every(isBidEntry)) {
    return Response.json(
      { error: "`entries` must be a non-empty array of { characterName, tier, occurredAt, isWinner }." },
      { status: 400 },
    );
  }
  if (body.entries.length > MAX_BID_ENTRIES) {
    return Response.json({ error: `Too many bid entries (limit ${MAX_BID_ENTRIES}).` }, { status: 400 });
  }
  const entries = body.entries;
  const badField = entries.find(
    (e) => e.characterName.length > LIMITS.characterName || e.tier.length > LIMITS.activity || !isoDate(e.occurredAt).ok,
  );
  if (badField) {
    return Response.json({ error: `Invalid name, tier, or time on ${badField.characterName || "an entry"}.` }, { status: 400 });
  }
  const itemName = itemCheck.value;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, LIMITS.note) || null : null;

  const winners = entries.filter((e) => e.isWinner);
  if (winners.length === 0) {
    return Response.json({ error: "At least one entry must be marked as a winner." }, { status: 400 });
  }
  for (const w of winners) {
    if (!parseOccurredAt(w.occurredAt)) {
      return Response.json({ error: `Invalid \`occurredAt\` on ${w.characterName}'s winning entry.` }, { status: 400 });
    }
  }

  const db = await getDb();

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
      return Response.json(
        {
          error: `"${itemName}" was already recorded around ${guildDateTime(existing.occurredAt)}. Resubmit with confirmDuplicate to record it anyway.`,
          duplicate: { lootEventId: existing.id, itemName, occurredAt: existing.occurredAt.toISOString() },
        },
        { status: 409 },
      );
    }
  }

  const [allCharacters, totals] = await Promise.all([
    db.select({ id: characters.id, name: characters.name, playerId: characters.playerId }).from(characters),
    getStandings(db),
  ]);
  const byLowerName = new Map(allCharacters.map((c) => [c.name.toLowerCase(), c]));

  // computeEpgpTotals groups by player_id (PLAN.md §11 Phase 3 task 3.11).
  function priorityFor(c: (typeof allCharacters)[number]): number | null {
    return c.playerId !== null ? (totals.get(c.playerId)?.priorityRating ?? null) : null;
  }

  // Every winner must resolve (name + tier) before anything is written —
  // a doomed request shouldn't leave a half-recorded loot event behind.
  // Every active GP tier's point value in one query (2026-09-10 perf fix:
  // this used to be one lookup per entry, plus one per winner).
  const tierPoints = new Map<string, number>();
  for (const pv of await db
    .select({ activity: epgpPointValues.activity, points: epgpPointValues.points })
    .from(epgpPointValues)
    .where(and(eq(epgpPointValues.kind, "gp"), eq(epgpPointValues.retired, false)))) {
    tierPoints.set(pv.activity, pv.points);
  }

  for (const w of winners) {
    if (!byLowerName.get(w.characterName.trim().toLowerCase())) {
      return Response.json({ error: `No character found named "${w.characterName}" — fix the name and resubmit.` }, { status: 422 });
    }
    if (!tierPoints.has(w.tier)) {
      return Response.json({ error: `"${w.tier}" isn't a current GP tier.` }, { status: 422 });
    }
  }

  const [lootEvent] = await db
    .insert(lootEvents)
    .values({ itemName, occurredAt: parseOccurredAt(winners[0].occurredAt) as Date, status: "awarded", openedBy: auth.userId })
    .returning();

  const unmatched: string[] = [];
  const invalidTiers: string[] = [];
  let winningBidId: number | null = null;
  let inserted = 0;

  // All bid rows in one multi-row insert (one round trip) instead of one
  // insert per entry. `returning()` keeps the ids so winningBidId can point
  // at the first winner's row exactly as before.
  const bidValues: (typeof bidsTable.$inferInsert & { _isWinner: boolean })[] = [];
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
      lootEventId: lootEvent.id,
      characterId: character.id,
      tier: entry.tier,
      status: entry.isWinner ? "won" : "lost",
      prioritySnapshot: priorityFor(character),
      note,
      _isWinner: entry.isWinner,
    });
  }
  if (bidValues.length > 0) {
    // db.batch() of one-row inserts (D1 caps a statement at 100 bound
    // parameters, so a multi-row VALUES insert can't carry a whole round);
    // one round trip + one transaction per 40 rows, results in order.
    const ids: number[] = [];
    for (let i = 0; i < bidValues.length; i += 40) {
      const chunk = bidValues.slice(i, i + 40).map(({ _isWinner: _unused, ...v }) => db.insert(bidsTable).values(v).returning({ id: bidsTable.id }));
      const results = await db.batch(chunk as unknown as [(typeof chunk)[number], ...(typeof chunk)[number][]]);
      for (const r of results) ids.push(r[0].id);
    }
    inserted = ids.length;
    const firstWinnerIdx = bidValues.findIndex((v) => v._isWinner);
    if (firstWinnerIdx >= 0 && ids[firstWinnerIdx] !== undefined) winningBidId = ids[firstWinnerIdx];
  }

  if (winningBidId !== null) {
    await db.update(lootEvents).set({ winningBidId }).where(eq(lootEvents.id, lootEvent.id));
  }

  // This route does NOT touch the LiveAuctionSession DO. The parser app
  // clears its own live round the moment the officer clicks "End Round &
  // Review" (and on app quit) via POST /api/officer/live-bids/clear, which
  // is served from custom-worker.ts — so by the time a finalize lands here,
  // the live view has already dropped this round. The DO clear used to run
  // here too, as belt-and-suspenders, but a DO RPC from a Next Route
  // Handler crosses the OpenNext Node loopback (workerd → Node → workerd)
  // and that hop crashes `wrangler dev` under load — the exact failure
  // documented in CLAUDE.md's "Hard-won gotchas". It was the last such hop
  // left; removing it is what keeps local dev up during a live round.
  // (If a stale round ever does linger, the DO's own 5-min idle expiry
  // sweeps it — no signal from a finalized round's poller means it ages
  // out regardless.)
  const chargedPlayerIds = new Set<number>();
  for (const w of winners) {
    const character = byLowerName.get(w.characterName.trim().toLowerCase());
    if (!character) continue;
    const points = tierPoints.get(w.tier);
    if (points === undefined) continue;
    const gpResult = await insertLedgerEntry(
      db,
      { kind: "gp", characterId: character.id, tier: w.tier, itemName, points, occurredAt: w.occurredAt, note: note ?? "" },
      auth.userId,
      "parse",
      { deferStandingsRefresh: true },
    );
    if (!gpResult.ok) {
      return Response.json({ error: `Recorded the bids, but couldn't charge GP for ${w.characterName}: ${gpResult.error}` }, { status: 422 });
    }
    if (gpResult.playerId != null) chargedPlayerIds.add(gpResult.playerId);
  }
  // One standings refresh for every winner charged (a duplicate drop can
  // have several) rather than one per winner.
  if (chargedPlayerIds.size > 0) await refreshStandings(db, { playerIds: [...chargedPlayerIds] });

  return Response.json({ lootEventId: lootEvent.id, inserted, unmatched, invalidTiers }, { status: 201 });
}
