ALTER TABLE `ep_ledger` ADD `source_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `ep_ledger_source_key_unique` ON `ep_ledger` (`source_key`);--> statement-breakpoint
ALTER TABLE `gp_ledger` ADD `source_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `gp_ledger_source_key_unique` ON `gp_ledger` (`source_key`);