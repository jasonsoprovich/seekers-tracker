ALTER TABLE `gp_ledger` ADD `loot_event_id` integer;--> statement-breakpoint
CREATE INDEX `gp_ledger_loot_event_id_idx` ON `gp_ledger` (`loot_event_id`);--> statement-breakpoint
CREATE INDEX `ep_ledger_player_occurred_idx` ON `ep_ledger` (`player_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `loot_events_occurred_at_idx` ON `loot_events` (`occurred_at`);