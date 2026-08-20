import { asc, like } from "drizzle-orm";

import { characters } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { computeEpgpTotals } from "@/lib/epgp/totals";

// Backs the officer app's Browse > Totals tab — same EP/GP/Priority
// standings as /roster, with the same alt-borrows-its-main's-totals
// display rule (see Roster's totalsFor). No pagination: the guild roster
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
      })
      .from(characters)
      .where(term ? like(characters.name, `%${term}%`) : undefined)
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
