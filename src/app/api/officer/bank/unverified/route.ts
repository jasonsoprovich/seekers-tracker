import { requireOfficerApiKey, requireOfficerCapability } from "@/lib/api-key-auth";
import { removeUnverifiedHoldings } from "@/lib/bank/sync";
import { getDb } from "@/lib/db";
import { officerApiActor, recordSystemEvent } from "@/lib/system-log";

type RemoveBody = { ids?: unknown; note?: unknown };

const MAX_IDS = 500;

// POST /api/officer/bank/unverified — the officer app's "Needs review"
// panel (2026-10-17): remove old-sheet/manual rows a banker has confirmed
// are gone, right where they run the sync. Same rules as the /bank page's
// Remove: unverified rows only, a note is required, and every row gets a
// bank_audit_log entry.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const db = await getDb();
  const capError = await requireOfficerCapability(db, auth.userId, "epgp.bank.manage");
  if (capError) return Response.json({ error: capError.error }, { status: capError.status });

  let body: RemoveBody;
  try {
    body = (await request.json()) as RemoveBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > MAX_IDS || !body.ids.every((id) => typeof id === "number" && Number.isInteger(id))) {
    return Response.json({ error: `\`ids\` must be 1-${MAX_IDS} integers.` }, { status: 400 });
  }
  if (typeof body.note !== "string" || body.note.length > 500) {
    return Response.json({ error: "`note` must be a string (max 500 characters)." }, { status: 400 });
  }

  const result = await removeUnverifiedHoldings(db, { kind: "rows", ids: body.ids as number[] }, body.note, auth.userId);
  if (result.error) return Response.json({ error: result.error }, { status: 422 });

  if (result.removed > 0) {
    await recordSystemEvent(db, await officerApiActor(db, auth.userId), {
      action: "bank.unverified.remove",
      targetType: "bank_holdings",
      summary: `Removed ${result.removed} unverified bank row(s) from the officer app (${body.note.trim()})`,
    });
  }

  return Response.json({ ok: true, removed: result.removed });
}
