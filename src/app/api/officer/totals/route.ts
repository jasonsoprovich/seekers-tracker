import { asc, like } from "drizzle-orm";

import { characters } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { getStandings } from "@/lib/epgp/standings";

// Backs the officer app's Browse > Totals tab — same EP/GP/Priority
// standings as /roster: every character sharing a player_id (PLAN.md §11
// Phase 3 task 3.11) reads the same total. No pagination: the guild roster
// is small enough to send in one response. ?q=<character name search>.
export async function GET(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const term = (url.searchParams.get("q") ?? "").trim();

  const db = await getDb();
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: characters.id,
        name: characters.name,
        charType: characters.charType,
        status: characters.status,
        mainCharacterId: characters.mainCharacterId,
        playerId: characters.playerId,
      })
      .from(characters)
      .where(term ? like(characters.name, `%${term}%`) : undefined)
      .orderBy(asc(characters.name)),
    getStandings(db),
  ]);

  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  // computeEpgpTotals groups by player_id (PLAN.md §11 Phase 3 task 3.11).
  const result = rows.map((r) => {
    const isAlt = r.charType === "alt" && r.mainCharacterId !== null;
    const total = r.playerId !== null ? totals.get(r.playerId) : undefined;
    return {
      id: r.id,
      name: r.name,
      charType: r.charType,
      status: r.status,
      mainCharacterName: isAlt ? (nameById.get(r.mainCharacterId as number) ?? null) : null,
      ep: total?.ep ?? null,
      gp: total?.gp ?? null,
      epDecay: total?.epDecay ?? null,
      gpDecay: total?.gpDecay ?? null,
      priorityRating: total?.priorityRating ?? null,
    };
  });

  return Response.json({ totals: result });
}
