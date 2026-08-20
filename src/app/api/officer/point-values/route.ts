import { and, asc, eq } from "drizzle-orm";

import { epgpPointValues } from "@/db";
import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";

// Backs the officer app's Manual Entry tab — the same non-retired
// activity/tier list the website's own AddLedgerEntryForm suggests,
// grouped by kind so the app can populate an EP or GP dropdown and
// auto-fill that activity's canonical point value (still editable —
// manual entries can have one-off custom amounts).
export async function GET(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const [ep, gp] = await Promise.all([
    db
      .select({ activity: epgpPointValues.activity, points: epgpPointValues.points })
      .from(epgpPointValues)
      .where(and(eq(epgpPointValues.kind, "ep"), eq(epgpPointValues.retired, false)))
      .orderBy(asc(epgpPointValues.sortOrder)),
    db
      .select({ activity: epgpPointValues.activity, points: epgpPointValues.points })
      .from(epgpPointValues)
      .where(and(eq(epgpPointValues.kind, "gp"), eq(epgpPointValues.retired, false)))
      .orderBy(asc(epgpPointValues.sortOrder)),
  ]);

  return Response.json({ ep, gp });
}
