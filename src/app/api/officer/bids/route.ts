import { eq } from "drizzle-orm";

import { bids as bidsTable, characters, lootEvents } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { insertLedgerEntry } from "@/lib/epgp/ledger-entry";
import { getActivePointValue } from "@/lib/epgp/point-values";
import { computeEpgpTotals } from "@/lib/epgp/totals";

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
// had this. Exactly one entry must be marked the winner (the app's
// "Determine Winner" — tier first, then priority — is a client-side
// suggestion the officer can override; this route just trusts whichever
// one row came back flagged). Only the winner gets a gp_ledger charge,
// via insertLedgerEntry same as manual-entry/attendance, which redirects
// an alt's charge to its main.
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
  if (winners.length !== 1) {
    return Response.json({ error: "Exactly one entry must be marked as the winner." }, { status: 400 });
  }
  const winner = winners[0];
  const winnerOccurredAt = parseOccurredAt(winner.occurredAt);
  if (!winnerOccurredAt) {
    return Response.json({ error: "Invalid `occurredAt` on the winning entry." }, { status: 400 });
  }

  const db = await getDb();

  const winnerPoints = await getActivePointValue(db, "gp", winner.tier);
  if (winnerPoints === null) {
    return Response.json({ error: `"${winner.tier}" isn't a current GP tier.` }, { status: 422 });
  }

  const [allCharacters, totals] = await Promise.all([
    db
      .select({ id: characters.id, name: characters.name, charType: characters.charType, mainCharacterId: characters.mainCharacterId })
      .from(characters),
    computeEpgpTotals(db),
  ]);
  const byLowerName = new Map(allCharacters.map((c) => [c.name.toLowerCase(), c]));

  function priorityFor(c: (typeof allCharacters)[number]): number | null {
    const pid = c.charType === "alt" && c.mainCharacterId !== null ? c.mainCharacterId : c.id;
    return totals.get(pid)?.priorityRating ?? totals.get(c.id)?.priorityRating ?? null;
  }

  const winnerCharacter = byLowerName.get(winner.characterName.trim().toLowerCase());
  if (!winnerCharacter) {
    return Response.json({ error: `No character found named "${winner.characterName}" — fix the name and resubmit.` }, { status: 422 });
  }

  const [lootEvent] = await db
    .insert(lootEvents)
    .values({ itemName, occurredAt: winnerOccurredAt, status: "awarded", openedBy: auth.userId })
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
    if (entry.isWinner) winningBidId = row.id;
  }

  if (winningBidId !== null) {
    await db.update(lootEvents).set({ winningBidId }).where(eq(lootEvents.id, lootEvent.id));
  }

  const gpResult = await insertLedgerEntry(
    db,
    { kind: "gp", characterId: winnerCharacter.id, tier: winner.tier, itemName, points: winnerPoints, occurredAt: winner.occurredAt, note: note ?? "" },
    auth.userId,
    "parse",
  );
  if (!gpResult.ok) {
    return Response.json({ error: gpResult.error }, { status: 422 });
  }

  return Response.json({ lootEventId: lootEvent.id, inserted, unmatched, invalidTiers }, { status: 201 });
}
