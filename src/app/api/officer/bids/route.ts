import { eq } from "drizzle-orm";

import { bids as bidsTable, characters, lootEvents } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { insertLedgerEntry } from "@/lib/epgp/ledger-entry";
import { getActivePointValue } from "@/lib/epgp/point-values";
import { getCachedEpgpTotals } from "@/lib/epgp/totals";

type BidEntryBody = { characterName?: unknown; tier?: unknown; occurredAt?: unknown; isWinner?: unknown };
type BidsRequestBody = { itemName?: unknown; entries?: unknown; note?: unknown };

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

  if (typeof body.itemName !== "string" || !body.itemName.trim()) {
    return Response.json({ error: "`itemName` is required." }, { status: 400 });
  }
  if (!Array.isArray(body.entries) || body.entries.length === 0 || !body.entries.every(isBidEntry)) {
    return Response.json(
      { error: "`entries` must be a non-empty array of { characterName, tier, occurredAt, isWinner }." },
      { status: 400 },
    );
  }
  const entries = body.entries;
  const itemName = body.itemName.trim();
  const note = typeof body.note === "string" ? body.note.trim() || null : null;

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

  const [allCharacters, totals] = await Promise.all([
    db.select({ id: characters.id, name: characters.name, playerId: characters.playerId }).from(characters),
    getCachedEpgpTotals(db),
  ]);
  const byLowerName = new Map(allCharacters.map((c) => [c.name.toLowerCase(), c]));

  // computeEpgpTotals groups by player_id (PLAN.md §11 Phase 3 task 3.11).
  function priorityFor(c: (typeof allCharacters)[number]): number | null {
    return c.playerId !== null ? (totals.get(c.playerId)?.priorityRating ?? null) : null;
  }

  // Every winner must resolve (name + tier) before anything is written —
  // a doomed request shouldn't leave a half-recorded loot event behind.
  for (const w of winners) {
    if (!byLowerName.get(w.characterName.trim().toLowerCase())) {
      return Response.json({ error: `No character found named "${w.characterName}" — fix the name and resubmit.` }, { status: 422 });
    }
    if ((await getActivePointValue(db, "gp", w.tier)) === null) {
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

  for (const entry of entries) {
    const character = byLowerName.get(entry.characterName.trim().toLowerCase());
    if (!character) {
      unmatched.push(entry.characterName);
      continue;
    }
    const points = await getActivePointValue(db, "gp", entry.tier);
    if (points === null) {
      invalidTiers.push(`${entry.characterName}: "${entry.tier}"`);
      continue;
    }
    const [row] = await db
      .insert(bidsTable)
      .values({
        lootEventId: lootEvent.id,
        characterId: character.id,
        tier: entry.tier,
        status: entry.isWinner ? "won" : "lost",
        prioritySnapshot: priorityFor(character),
        note,
      })
      .returning();
    inserted++;
    if (entry.isWinner && winningBidId === null) winningBidId = row.id;
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
  for (const w of winners) {
    const character = byLowerName.get(w.characterName.trim().toLowerCase());
    if (!character) continue;
    const points = await getActivePointValue(db, "gp", w.tier);
    if (points === null) continue;
    const gpResult = await insertLedgerEntry(
      db,
      { kind: "gp", characterId: character.id, tier: w.tier, itemName, points, occurredAt: w.occurredAt, note: note ?? "" },
      auth.userId,
      "parse",
    );
    if (!gpResult.ok) {
      return Response.json({ error: `Recorded the bids, but couldn't charge GP for ${w.characterName}: ${gpResult.error}` }, { status: 422 });
    }
  }

  return Response.json({ lootEventId: lootEvent.id, inserted, unmatched, invalidTiers }, { status: 201 });
}
