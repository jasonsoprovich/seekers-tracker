ALTER TABLE `ep_ledger` ADD `raid_date` text;--> statement-breakpoint
CREATE INDEX `ep_ledger_raid_date_idx` ON `ep_ledger` (`raid_date`);