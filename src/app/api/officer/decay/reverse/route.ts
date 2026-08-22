import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { reverseDecayEvent } from "@/lib/epgp/decay";

type ReverseRequestBody = { decayEventId?: unknown };

// PLAN.md §11 Phase 2 task 2.6 — undoes one decay batch as a unit: deletes
// every ep_ledger/gp_ledger row it wrote and marks the decay_events row
// reversed. See reverseDecayEvent's comment for why the event row itself
// isn't deleted.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const role = await getUserRole(auth.userId);
  if (!canManageEpgpConfig(role)) {
    return Response.json({ error: "Only leaders can reverse EPGP decay." }, { status: 403 });
  }

  let body: ReverseRequestBody;
  try {
    body = (await request.json()) as ReverseRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const decayEventId = typeof body.decayEventId === "number" && Number.isInteger(body.decayEventId) ? body.decayEventId : null;
  if (decayEventId === null) return Response.json({ error: "`decayEventId` must be an integer." }, { status: 400 });

  const db = await getDb();
  const result = await reverseDecayEvent(db, decayEventId, auth.userId);
  if ("error" in result) return Response.json({ error: result.error }, { status: 409 });

  return Response.json(result);
}
