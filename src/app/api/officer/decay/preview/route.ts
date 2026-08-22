import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { previewExpansionDecay } from "@/lib/epgp/decay";

type PreviewRequestBody = { rate?: unknown; effectiveDate?: unknown };

function parseRate(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 1) return null;
  return raw;
}

function parseEffectiveDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// PLAN.md §11 Phase 2 task 2.4 — read-only preview of what an expansion
// decay commit would write: every character with a positive EP or GP
// balance as of `effectiveDate`, and the exact amount `rate` takes. No
// writes happen here; the leader UI (task 2.7) calls this before commit,
// same shape POST /api/officer/decay/commit accepts.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  // Decay rates are a leader call throughout PLAN.md §1b/§1c ("leader
  // picks %"), same tier as EPGP settings (canManageEpgpConfig) — a plain
  // officer key can enter ledger rows and bids, but not run a decay batch.
  const role = await getUserRole(auth.userId);
  if (!canManageEpgpConfig(role)) {
    return Response.json({ error: "Only leaders can run EPGP decay." }, { status: 403 });
  }

  let body: PreviewRequestBody;
  try {
    body = (await request.json()) as PreviewRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rate = parseRate(body.rate);
  if (rate === null) return Response.json({ error: "`rate` must be a number greater than 0 and at most 1." }, { status: 400 });
  const effectiveDate = parseEffectiveDate(body.effectiveDate);
  if (!effectiveDate) return Response.json({ error: "`effectiveDate` is required and must be a valid date." }, { status: 400 });

  const db = await getDb();
  const rows = await previewExpansionDecay(db, rate, effectiveDate);

  const totalEpDecay = rows.reduce((sum, r) => sum + r.epDecay, 0);
  const totalGpDecay = rows.reduce((sum, r) => sum + r.gpDecay, 0);

  return Response.json({ rows, characterCount: rows.length, totalEpDecay, totalGpDecay });
}
