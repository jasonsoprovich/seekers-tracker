CREATE TABLE `bank_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`holding_id` integer,
	`holder_character_id` integer NOT NULL,
	`item_name` text NOT NULL,
	`action` text NOT NULL,
	`source` text NOT NULL,
	`changed_by` text,
	`changed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`before` text,
	`after` text,
	FOREIGN KEY (`holder_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bank_audit_log_holder_idx` ON `bank_audit_log` (`holder_character_id`);--> statement-breakpoint
CREATE INDEX `bank_audit_log_changed_at_idx` ON `bank_audit_log` (`changed_at`);