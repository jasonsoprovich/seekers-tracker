import { asc } from "drizzle-orm";

import { characters } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";

// Roster snapshot for the EPGP parser app's local name-matching/validation
// (attendance and bid rows reference characters by name — see the app's
// own validate-before-submit flow) before it ever calls
// /api/officer/manual-entry.
export async function GET(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      charType: characters.charType,
      mainCharacterId: characters.mainCharacterId,
      status: characters.status,
    })
    .from(characters)
    .orderBy(asc(characters.name));

  return Response.json({ characters: rows });
}
