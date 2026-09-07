ALTER TABLE `ledger_audit_log` ADD `note` text;--> statement-breakpoint
ALTER TABLE `ledger_audit_log` ADD `note_updated_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `ledger_audit_log` ADD `note_updated_at` integer;