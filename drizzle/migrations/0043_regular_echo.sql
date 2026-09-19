ALTER TABLE `gp_ledger` ADD `raid_date` text;--> statement-breakpoint
CREATE INDEX `gp_ledger_raid_date_idx` ON `gp_ledger` (`raid_date`);--> statement-breakpoint
UPDATE `epgp_point_values` SET `sort_order` = `sort_order` + 1 WHERE `kind` = 'ep' AND `sort_order` >= 12;--> statement-breakpoint
INSERT INTO `epgp_point_values` (`kind`, `activity`, `points`, `retired`, `sort_order`)
SELECT 'ep', 'Hitting lvl 65', 100, 0, 12
WHERE NOT EXISTS (SELECT 1 FROM `epgp_point_values` WHERE `kind` = 'ep' AND `activity` = 'Hitting lvl 65');
