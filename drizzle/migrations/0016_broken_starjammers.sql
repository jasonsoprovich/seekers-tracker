CREATE TABLE `decay_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ep_rate` real,
	`gp_rate` real,
	`effective_date` integer NOT NULL,
	`label` text,
	`applied_by` text,
	`applied_at` integer DEFAULT (unixepoch()) NOT NULL,
	`reversed_at` integer,
	`reversed_by` text,
	FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reversed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `decay_events_kind_effective_idx` ON `decay_events` (`kind`,`effective_date`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_epgp_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`setting_key` text NOT NULL,
	`value` text NOT NULL,
	`effective_from` integer NOT NULL,
	`changed_by` text,
	`changed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`note` text,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_epgp_settings`("id", "setting_key", "value", "effective_from", "changed_by", "changed_at", "note") SELECT "id", "setting_key", "value", "effective_from", "changed_by", "changed_at", "note" FROM `epgp_settings`;--> statement-breakpoint
DROP TABLE `epgp_settings`;--> statement-breakpoint
ALTER TABLE `__new_epgp_settings` RENAME TO `epgp_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `epgp_settings_key_effective_idx` ON `epgp_settings` (`setting_key`,`effective_from`);--> statement-breakpoint
ALTER TABLE `ep_ledger` ADD `decay_event_id` integer REFERENCES decay_events(id);--> statement-breakpoint
CREATE INDEX `ep_ledger_decay_event_id_idx` ON `ep_ledger` (`decay_event_id`);--> statement-breakpoint
ALTER TABLE `gp_ledger` ADD `decay_event_id` integer REFERENCES decay_events(id);--> statement-breakpoint
CREATE INDEX `gp_ledger_decay_event_id_idx` ON `gp_ledger` (`decay_event_id`);