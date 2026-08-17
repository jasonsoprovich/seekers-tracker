ALTER TABLE `characters` ADD `main_character_id` integer REFERENCES characters(id);--> statement-breakpoint
ALTER TABLE `characters` ADD `quarmy_url` text;