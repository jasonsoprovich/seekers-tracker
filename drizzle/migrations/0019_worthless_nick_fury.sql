ALTER TABLE `characters` ADD `status_changed_at` integer;--> statement-breakpoint
ALTER TABLE `players` ADD `status_changed_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `players` ADD `status_changed_at` integer;