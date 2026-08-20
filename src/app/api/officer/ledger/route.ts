import { desc, eq, like, or } from "drizzle-orm";

import { characters, epLedger, gpLedger, users } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";

const PAGE_SIZE = 50;

// Backs the officer app's Browse > EP/GP Ledger tabs — same paginated,
// searchable query as the website's own /epgp/ledger page, just as JSON.
// ?kind=ep|gp (default ep), ?q=<search>, ?page=<1-based, default 1>.
export async function GET(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") === "gp" ? "gp" : "ep";
  const term = (url.searchParams.get("q") ?? "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const db = await getDb();

  const rows =
    kind === "ep"
      ? await db
          .select({
            id: epLedger.id,
            characterName: characters.name,
            occurredAt: epLedger.occurredAt,
            activity: epLedger.activity,
            points: epLedger.points,
            note: epLedger.note,
            source: epLedger.source,
            enteredByName: users.username,
          })
          .from(epLedger)
          .innerJoin(characters, eq(epLedger.characterId, characters.id))
          .leftJoin(users, eq(epLedger.enteredBy, users.id))
          .where(term ? or(like(characters.name, `%${term}%`), like(epLedger.activity, `%${term}%`)) : undefined)
          .orderBy(desc(epLedger.occurredAt))
          .limit(PAGE_SIZE + 1)
          .offset(offset)
      : await db
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
          .limit(PAGE_SIZE + 1)
          .offset(offset);

  const hasNext = rows.length > PAGE_SIZE;
  return Response.json({ rows: rows.slice(0, PAGE_SIZE), page, hasNext });
}
