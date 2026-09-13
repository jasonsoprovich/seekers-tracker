ALTER TABLE `loot_events` ADD `submission_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `loot_events_submission_id_unique` ON `loot_events` (`submission_id`);