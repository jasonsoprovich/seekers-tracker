import { requireOfficerApiKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { listLedgerRows } from "@/lib/epgp/ledger-list";

// Backs the officer app's Browse > EP/GP Ledger tabs — same paginated,
// searchable query as the website's own /epgp/ledger page (both call
// listLedgerRows), just as JSON. ?kind=ep|gp (default ep), ?q=<search>,
// ?page=<1-based, default 1>.
export async function GET(request: Request) {
  const auth = await requireOfficerApiKey(request);
  if ("error" in auth) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") === "gp" ? "gp" : "ep";
  const q = url.searchParams.get("q") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const db = await getDb();
  const { rows, hasNext } = kind === "ep" ? await listLedgerRows(db, { kind: "ep", q, page }) : await listLedgerRows(db, { kind: "gp", q, page });

  return Response.json({ rows, page, hasNext });
}
