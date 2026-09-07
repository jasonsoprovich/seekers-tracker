ALTER TABLE `characters` ADD `last_activity_at` integer;--> statement-breakpoint
CREATE INDEX `gp_ledger_item_name_idx` ON `gp_ledger` (`item_name`);--> statement-breakpoint
-- Backfill: last non-decay ep_ledger / gp_ledger occurred_at per character.
-- Decay rows (decay_event_id set) are excluded — a decay isn't activity.
-- Kept in step going forward by insertLedgerEntry + ledger edit/delete +
-- rebuildAllStandings (the nightly cron re-runs this same recompute).
UPDATE `characters` SET `last_activity_at` = (
  SELECT MAX(t) FROM (
    SELECT MAX(`occurred_at`) AS t FROM `ep_ledger` WHERE `character_id` = `characters`.`id` AND `decay_event_id` IS NULL
    UNION ALL
    SELECT MAX(`occurred_at`) AS t FROM `gp_ledger` WHERE `character_id` = `characters`.`id` AND `decay_event_id` IS NULL
  )
);
