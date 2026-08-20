CREATE TABLE `ledger_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ledger_type` text NOT NULL,
	`ledger_id` integer NOT NULL,
	`action` text NOT NULL,
	`changed_by` text,
	`changed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`before` text NOT NULL,
	`after` text,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ledger_audit_log_ledger_idx` ON `ledger_audit_log` (`ledger_type`,`ledger_id`);--> statement-breakpoint
CREATE INDEX `ledger_audit_log_changed_at_idx` ON `ledger_audit_log` (`changed_at`);