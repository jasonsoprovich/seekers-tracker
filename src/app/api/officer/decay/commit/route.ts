import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { commitExpansionDecay } from "@/lib/epgp/decay";

type CommitRequestBody = { rate?: unknown; effectiveDate?: unknown; label?: unknown };

function parseRate(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 1) return null;
  return raw;
}

function parseEffectiveDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// PLAN.md §11 Phase 2 task 2.5 — commits one expansion decay batch: a
// decay_events row plus a linked negative ep_ledger/gp_ledger row per
// character with a positive balance. Rejects a duplicate unreversed event
// on the same effectiveDate (commitExpansionDecay itself enforces this) so
// a double-submit from the leader UI can't double-decay everyone.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const role = await getUserRole(auth.userId);
  if (!canManageEpgpConfig(role)) {
    return Response.json({ error: "Only leaders can run EPGP decay." }, { status: 403 });
  }

  let body: CommitRequestBody;
  try {
    body = (await request.json()) as CommitRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rate = parseRate(body.rate);
  if (rate === null) return Response.json({ error: "`rate` must be a number greater than 0 and at most 1." }, { status: 400 });
  const effectiveDate = parseEffectiveDate(body.effectiveDate);
  if (!effectiveDate) return Response.json({ error: "`effectiveDate` is required and must be a valid date." }, { status: 400 });
  const label = typeof body.label === "string" ? body.label : undefined;

  const db = await getDb();
  const result = await commitExpansionDecay(db, { rate, effectiveDate, label, appliedBy: auth.userId });
  if ("error" in result) return Response.json({ error: result.error }, { status: 409 });

  return Response.json(result, { status: 201 });
}
