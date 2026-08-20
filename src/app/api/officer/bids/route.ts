import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { findCharacterIdByName } from "@/lib/epgp/character-lookup";
import { getDb } from "@/lib/db";
import { insertLedgerEntry } from "@/lib/epgp/ledger-entry";
import { getActivePointValue } from "@/lib/epgp/point-values";

type BidEntry = { characterName?: unknown; tier?: unknown; occurredAt?: unknown };
type BidsRequestBody = { itemName?: unknown; entries?: unknown; note?: unknown };

function isBidEntry(e: unknown): e is { characterName: string; tier: string; occurredAt: string } {
  const entry = e as BidEntry;
  return typeof entry?.characterName === "string" && typeof entry?.tier === "string" && typeof entry?.occurredAt === "string";
}

// One GP charge per remaining row from the officer app's Bids capture
// (item name + who's paying at what tier, after the officer has edited/
// removed rows in-app — see BidsPanel's Copy-to-clipboard sibling, Submit).
// Same points-resolved-server-side and unmatched-names-reported approach
// as /api/officer/attendance; here a bad tier is reported separately from
// a bad name since either can be true independently for the same row.
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
      { error: "`entries` must be a non-empty array of { characterName, tier, occurredAt }." },
      { status: 400 },
    );
  }
  const note = typeof body.note === "string" ? body.note : "";
  const itemName = body.itemName.trim();

  const db = await getDb();
  const unmatched: string[] = [];
  const invalidTiers: string[] = [];
  let inserted = 0;

  for (const entry of body.entries) {
    const points = await getActivePointValue(db, "gp", entry.tier);
    if (points === null) {
      invalidTiers.push(`${entry.characterName}: "${entry.tier}"`);
      continue;
    }
    const characterId = await findCharacterIdByName(db, entry.characterName);
    if (characterId === null) {
      unmatched.push(entry.characterName);
      continue;
    }
    const result = await insertLedgerEntry(
      db,
      { kind: "gp", characterId, tier: entry.tier, itemName, points, occurredAt: entry.occurredAt, note },
      auth.userId,
      "parse",
    );
    if (result.ok) inserted++;
    else unmatched.push(entry.characterName);
  }

  return Response.json({ inserted, unmatched, invalidTiers }, { status: 201 });
}
