import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { getSettingsAt } from "@/lib/epgp/settings";

// Backs the officer app's startup settings fetch (PLAN.md §4i, task 1.6) —
// the website is the source of truth for every leader-tunable EPGP
// constant, the app never hardcodes a threshold. Returns the values in
// force right now, key -> raw string (the app parses what it needs; a
// numeric setting like ep_cap_per_cycle is text on this side too, since
// epgp_settings stores everything as text to stay schema-stable as new
// settings get added).
export async function GET(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const settings = await getSettingsAt(db, new Date());

  return Response.json({ settings });
}
