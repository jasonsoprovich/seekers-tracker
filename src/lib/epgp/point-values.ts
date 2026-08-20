import { and, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { epgpPointValues } from "@/db";

// Looks up the guild-configured point value for an EP/GP activity —
// used by the officer attendance/bid routes so a raid-attendance award or
// a bid tier's GP cost always matches what's configured in
// epgp_point_values (Admin's tunable list), the same source the website's
// own manual-entry form points officers at, rather than trusting a value
// the calling app might send. Retired activities don't resolve — they're
// kept in the table for ledger-history display, not for awarding new
// points.
export async function getActivePointValue(
  db: ReturnType<typeof drizzle>,
  kind: "ep" | "gp",
  activity: string,
): Promise<number | null> {
  const [row] = await db
    .select({ points: epgpPointValues.points })
    .from(epgpPointValues)
    .where(and(eq(epgpPointValues.kind, kind), eq(epgpPointValues.activity, activity), eq(epgpPointValues.retired, false)));
  return row?.points ?? null;
}
