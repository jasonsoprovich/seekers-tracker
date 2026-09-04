CREATE TABLE `raids` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`raid_date` text NOT NULL,
	`name` text,
	`note` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raids_raid_date_unique` ON `raids` (`raid_date`);