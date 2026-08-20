import { asc } from "drizzle-orm";

import { characters } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { computeEpgpTotals } from "@/lib/epgp/totals";

// Roster snapshot for the EPGP parser app's local name-matching/validation
// (attendance and bid rows reference characters by name — see the app's
// own validate-before-submit flow) before it ever calls
// /api/officer/manual-entry, /attendance, or /bids.
//
// mainCharacterName + priorityRating are resolved the same way Roster's
// own totalsFor does: an alt has no ledger rows of its own going forward
// (see insertLedgerEntry's redirect-to-main), so its priority is its
// main's — the app's Bids/Attendance tables show both columns so an
// officer can see at a glance whose priority actually applies to a bid.
export async function GET(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: characters.id,
        name: characters.name,
        charType: characters.charType,
        mainCharacterId: characters.mainCharacterId,
        status: characters.status,
      })
      .from(characters)
      .orderBy(asc(characters.name)),
    computeEpgpTotals(db),
  ]);

  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  const result = rows.map((r) => {
    const isAlt = r.charType === "alt" && r.mainCharacterId !== null;
    const priorityCharacterId = isAlt ? (r.mainCharacterId as number) : r.id;
    const total = totals.get(priorityCharacterId) ?? (isAlt ? totals.get(r.id) : undefined);
    return {
      id: r.id,
      name: r.name,
      charType: r.charType,
      mainCharacterId: r.mainCharacterId,
      status: r.status,
      mainCharacterName: isAlt ? (nameById.get(r.mainCharacterId as number) ?? null) : null,
      priorityRating: total?.priorityRating ?? null,
    };
  });

  return Response.json({ characters: result });
}
