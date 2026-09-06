import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { rebuildAllStandings } from "@/lib/epgp/standings";

// Recomputes the whole player_epgp_totals materialized table from the
// ledgers, in-Worker against the live DATABASE binding — the remote-safe
// counterpart to `npm run recompute:standings` (local D1 only). The reason
// to call it: after a sheet-sync .sql is applied to remote D1 with
// `wrangler d1 execute --remote`, those rows land as plain INSERTs that
// never run refreshStandings, so /roster and the officer read paths show
// stale numbers until this runs. Leader-keyed — same bar as
// /api/officer/decay/*, since it rewrites every standings row.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const role = await getUserRole(auth.userId);
  if (!canManageEpgpConfig(role)) {
    return Response.json({ error: "Only leaders can rebuild standings." }, { status: 403 });
  }

  const db = await getDb();
  const result = await rebuildAllStandings(db);
  return Response.json({ ok: true, ...result });
}
