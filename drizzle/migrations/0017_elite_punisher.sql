CREATE TABLE `players` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`discord_id` text,
	`user_id` text,
	`display_name` text NOT NULL,
	`main_character_id` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`joined_at` integer,
	`departed_at` integer,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`main_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_discord_id_unique` ON `players` (`discord_id`);--> statement-breakpoint
CREATE TABLE `sos_bot_staging` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`discord_id` text NOT NULL,
	`char_name` text NOT NULL,
	`char_race` text,
	`char_class` text,
	`char_type` text,
	`char_priority` integer,
	`is_officer` integer,
	`imported_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sos_bot_staging_discord_id_idx` ON `sos_bot_staging` (`discord_id`);--> statement-breakpoint
ALTER TABLE `characters` ADD `player_id` integer REFERENCES players(id);--> statement-breakpoint
ALTER TABLE `characters` ADD `char_priority` integer;