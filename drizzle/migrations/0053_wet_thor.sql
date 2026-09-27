ALTER TABLE `bank_audit_log` ADD `batch_id` text;--> statement-breakpoint
CREATE INDEX `bank_audit_log_batch_idx` ON `bank_audit_log` (`batch_id`);--> statement-breakpoint
ALTER TABLE `bank_holdings` ADD `legacy_location` text;--> statement-breakpoint
ALTER TABLE `bank_holdings` ADD `not_found_since` integer;--> statement-breakpoint
-- Data migration, 2026-09-27 unverified-item tracking (not drizzle-kit
-- generated — hand-written, per this repo's own CLAUDE.md warning about
-- reviewing any migration that reshapes existing data).
--
-- Every sheet-imported row (source='import', import_id IS NULL) still sits
-- at the real bag/slot position scripts/import-bank-tabs.ts originally
-- parsed off the sheet ("Bank3" slot 2, say). Once an officer's real sync
-- writes a verified row into that same physical slot, applySync's
-- delete-and-replace only ever touches VERIFIED rows (import_id IS NOT
-- NULL) going forward — but the old sheet row sitting at that same
-- (holder, container, slot) would still collide with the new synced row on
-- the bank_holdings_holder_container_slot_unique index. Moving every sheet
-- row to the synthetic "Sheet" container (mirroring "Manual"'s existing
-- pseudo-container for officer-added rows) with a fresh per-holder running
-- slot_index makes that collision structurally impossible: "Sheet"/"Manual"
-- can never be a real Zeal-export container name (always "General"/"Bank"/
-- "SharedBank" + digits — validateSyncPayload in src/lib/bank/sync.ts
-- enforces this on every incoming sync row). legacy_location preserves the
-- original position as plain text ("Bank3-Slot2", or just "Bank3" for a
-- bag's own slot) so sync.ts's reconcileUnverified can still recognize "this
-- sheet row and this newly-synced row are probably the same physical item"
-- purely by comparing legacy_location to the incoming row's container/slot.
--
-- The correlated subquery ranks each holder's own sheet rows by id (a
-- stable, never-changing column) rather than a window function, for the
-- widest possible SQLite/D1 compatibility; ranks are 0-based and strictly
-- distinct per holder, so the resulting (holder, 'Sheet', rank) tuples can
-- never collide with each other regardless of the order SQLite applies this
-- UPDATE's rows in.
UPDATE bank_holdings
SET
  legacy_location = CASE WHEN slot_index = 0 THEN container ELSE container || '-Slot' || slot_index END,
  slot_index = (
    SELECT count(*)
    FROM bank_holdings AS b2
    WHERE b2.holder_character_id = bank_holdings.holder_character_id
      AND b2.source = 'import'
      AND b2.import_id IS NULL
      AND b2.id < bank_holdings.id
  ),
  container = 'Sheet'
WHERE source = 'import' AND import_id IS NULL;