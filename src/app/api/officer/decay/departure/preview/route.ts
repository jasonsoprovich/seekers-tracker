import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { canManageEpgpConfig, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { previewDepartureWipe } from "@/lib/epgp/decay";

type PreviewRequestBody = { characterIds?: unknown; inactiveSince?: unknown };

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

// PLAN.md §11 Phase 2 task 2.11 — preview of a departure EP wipe (§1f):
// given an explicit character id list and/or an inactivity cutoff, returns
// every matching character's current EP (the amount that would be
// zeroed). GP is never touched. Read-only. Leader-only, same bar as
// expansion decay (§2.4).
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const role = await getUserRole(auth.userId);
  if (!canManageEpgpConfig(role)) {
    return Response.json({ error: "Only leaders can run an EPGP departure wipe." }, { status: 403 });
  }

  let body: PreviewRequestBody;
  try {
    body = (await request.json()) as PreviewRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const characterIds = parseCharacterIds(body.characterIds);
  const inactiveSince = parseInactiveSince(body.inactiveSince);
  if (!characterIds && !inactiveSince) {
    return Response.json({ error: "Provide `characterIds` (non-empty integer array) and/or a valid `inactiveSince` date." }, { status: 400 });
  }

  const db = await getDb();
  const rows = await previewDepartureWipe(db, { characterIds, inactiveSince });

  return Response.json({ rows, characterCount: rows.length });
}
