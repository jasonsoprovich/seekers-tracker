import type { drizzle } from "drizzle-orm/d1";

import { ledgerAuditLog } from "@/db";

// Whole-row JSON snapshots, not a per-field diff — see the ledgerAuditLog
// schema comment for why. Callers pass whatever they already selected off
// ep_ledger/gp_ledger; this doesn't re-fetch or validate shape.
export async function recordLedgerChange(
  db: ReturnType<typeof drizzle>,
  ledgerType: "ep" | "gp",
  ledgerId: number,
  action: "update" | "delete",
  before: Record<string, unknown>,
  after: Record<string, unknown> | null,
  changedBy: string,
): Promise<void> {
  await db.insert(ledgerAuditLog).values({
    ledgerType,
    ledgerId,
    action,
    changedBy,
    before,
    after,
  });
}
