import type { drizzle } from "drizzle-orm/d1";

import { ledgerAuditLog } from "@/db";

const EP_DELETE_SNAPSHOT = `json_patch(
  json_object(
    'id', id,
    'characterId', character_id,
    'playerId', player_id,
    'cycleId', cycle_id,
    'occurredAt', strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, 'unixepoch'),
    'activity', activity,
    'points', points,
    'pointsNominal', points_nominal,
    'pointsAwarded', points_awarded,
    'capApplied', json(iif(cap_applied, 'true', 'false')),
    'capAtEntry', cap_at_entry,
    'orphaned', json(iif(orphaned, 'true', 'false')),
    'note', note,
    'zone', zone,
    'enteredBy', entered_by,
    'source', source
  ),
  json_object(
    'sourceKey', source_key,
    'decayEventId', decay_event_id,
    'createdAt', strftime('%Y-%m-%dT%H:%M:%fZ', created_at, 'unixepoch')
  )
)`;

const GP_DELETE_SNAPSHOT = `json_patch(
  json_object(
    'id', id,
    'characterId', character_id,
    'playerId', player_id,
    'cycleId', cycle_id,
    'occurredAt', strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, 'unixepoch'),
    'itemName', item_name,
    'tier', tier,
    'points', points,
    'pointsNominal', points_nominal,
    'pointsAwarded', points_awarded,
    'capApplied', json(iif(cap_applied, 'true', 'false')),
    'capAtEntry', cap_at_entry,
    'orphaned', json(iif(orphaned, 'true', 'false')),
    'note', note,
    'duplicateFlag', json(iif(duplicate_flag, 'true', 'false')),
    'enteredBy', entered_by
  ),
  json_object(
    'source', source,
    'sourceKey', source_key,
    'decayEventId', decay_event_id,
    'createdAt', strftime('%Y-%m-%dT%H:%M:%fZ', created_at, 'unixepoch')
  )
)`;

export function prepareDeleteAudit(
  d1: D1Database,
  ledgerType: "ep" | "gp",
  predicate: string,
  bindings: unknown[],
  changedBy: string,
): D1PreparedStatement {
  const table = ledgerType === "ep" ? "ep_ledger" : "gp_ledger";
  const snapshot = ledgerType === "ep" ? EP_DELETE_SNAPSHOT : GP_DELETE_SNAPSHOT;
  return d1
    .prepare(`
      INSERT INTO ledger_audit_log (ledger_type, ledger_id, action, changed_by, before, after)
      SELECT ?, id, 'delete', ?, ${snapshot}, NULL
      FROM ${table}
      WHERE ${predicate}
    `)
    .bind(ledgerType, changedBy, ...bindings);
}

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
