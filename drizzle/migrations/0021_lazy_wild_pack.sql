ALTER TABLE `players` ADD `main_character_changed_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `players` ADD `main_character_changed_at` integer;