import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { insertLedgerEntry, type InsertLedgerEntryInput } from "@/lib/epgp/ledger-entry";

// Same validation as the website's manual-entry form
// (src/app/(app)/epgp/ledger/actions.ts) — used by the officer app for
// donations/guild-bank-buys entered directly from the app, alongside its
// attendance/bid submission routes. Body shape matches InsertLedgerEntryInput
// exactly; unlike the website form this doesn't wait on sample log text, so
// it ships now while attendance/bids stay pending on that.
export async function POST(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: InsertLedgerEntryInput;
  try {
    body = (await request.json()) as InsertLedgerEntryInput;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body?.kind !== "ep" && body?.kind !== "gp") {
    return Response.json({ error: "`kind` must be \"ep\" or \"gp\"." }, { status: 400 });
  }
  if (typeof body.characterId !== "number" || !Number.isInteger(body.characterId)) {
    return Response.json({ error: "`characterId` must be an integer." }, { status: 400 });
  }

  const db = await getDb();
  const result = await insertLedgerEntry(db, body, auth.userId, "manual");
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 422 });
  }

  return Response.json({ ok: true }, { status: 201 });
}
