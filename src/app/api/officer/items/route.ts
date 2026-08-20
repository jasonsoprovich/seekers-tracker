import { asc, isNotNull } from "drizzle-orm";

import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { gpLedger } from "@/db";
import { getDb } from "@/lib/db";

// Item-name catalog for the officer app's Bids autocomplete — there's no
// dedicated items table (this guild's loot isn't tracked as a fixed
// catalog, just whatever's been charged before), so this is every
// distinct item_name gp_ledger has ever seen, which is exactly "items
// this guild has actually looted" and grows on its own as new items get
// submitted through Bids. Good enough for an autocomplete; a typo just
// means a new entry the next officer's autocomplete picks up.
export async function GET(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const rows = await db
    .selectDistinct({ itemName: gpLedger.itemName })
    .from(gpLedger)
    .where(isNotNull(gpLedger.itemName))
    .orderBy(asc(gpLedger.itemName));

  return Response.json({ items: rows.map((r) => r.itemName).filter((n): n is string => n !== null) });
}
