DROP INDEX `raids_raid_date_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `raids_date_name_unique` ON `raids` (`raid_date`, coalesce(`name`, ''));
--> statement-breakpoint
ALTER TABLE `ep_ledger` ADD `raid_name` text;
--> statement-breakpoint
ALTER TABLE `gp_ledger` ADD `raid_name` text;
