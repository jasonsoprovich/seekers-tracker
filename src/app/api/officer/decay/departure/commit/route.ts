import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { commitDepartureWipe } from "@/lib/epgp/decay";

type CommitRequestBody = { characterIds?: unknown; inactiveSince?: unknown; label?: unknown };

function parseCharacterIds(raw: unknown): number[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "number" || !Number.isInteger(id))) return undefined;
  return raw.length > 0 ? raw : undefined;
}

function parseInactiveSince(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// PLAN.md §11 Phase 2 task 2.11 — commits a departure EP wipe (§1f): one
// decay_events row (kind "departure") plus a linked negative ep_ledger row
// per matched character, zeroing their EP. GP untouched. No duplicate
// guard — see commitDepartureWipe's comment for why that's fine here.
// Reversible via the same POST /api/officer/decay/reverse as expansion
// decay (reverseDecayEvent is kind-agnostic).
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const role = await getUserRole(auth.userId);
  if (!canManageEpgpConfig(role)) {
    return Response.json({ error: "Only leaders can run an EPGP departure wipe." }, { status: 403 });
  }

  let body: CommitRequestBody;
  try {
    body = (await request.json()) as CommitRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const characterIds = parseCharacterIds(body.characterIds);
  const inactiveSince = parseInactiveSince(body.inactiveSince);
  if (!characterIds && !inactiveSince) {
    return Response.json({ error: "Provide `characterIds` (non-empty integer array) and/or a valid `inactiveSince` date." }, { status: 400 });
  }
  const label = typeof body.label === "string" ? body.label : undefined;

  const db = await getDb();
  const result = await commitDepartureWipe(db, { characterIds, inactiveSince, label, appliedBy: auth.userId });
  if ("error" in result) return Response.json({ error: result.error }, { status: 409 });

  return Response.json(result, { status: 201 });
}
