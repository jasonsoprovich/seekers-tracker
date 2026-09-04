import type { drizzle } from "drizzle-orm/d1";

import { ledgerAuditLog } from "@/db";

// Whole-row JSON snapshots, not a per-field diff — see the ledgerAuditLog
// schema comment for why. Callers pass whatever they already selected off
// ep_ledger/gp_ledger; this doesn't re-fetch or validate shape.
//
// action:
//   create — before is null (row didn't exist); after is the new row
//   update — before/after are the row's full state either side of the edit
//   delete — before is the row; after is null
// `before` is stored as {} for a create, since ledger_audit_log.before is
// NOT NULL; the read side keys off `action`, not on before being empty.
export async function recordLedgerChange(
  db: ReturnType<typeof drizzle>,
  ledgerType: "ep" | "gp",
  ledgerId: number,
  action: "create" | "update" | "delete",
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  changedBy: string,
): Promise<void> {
  await db.insert(ledgerAuditLog).values({
    ledgerType,
    ledgerId,
    action,
    changedBy,
    before: before ?? {},
    after,
  });
}
