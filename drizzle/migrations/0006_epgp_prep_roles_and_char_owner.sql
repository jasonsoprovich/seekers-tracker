DROP TABLE `character_epgp`;--> statement-breakpoint
PRAGMA defer_foreign_keys=on;--> statement-breakpoint
CREATE TABLE `__new_characters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text,
	`name` text NOT NULL,
	`class` integer NOT NULL,
	`race` integer NOT NULL,
	`level` integer NOT NULL,
	`char_type` text DEFAULT 'main' NOT NULL,
	`main_character_id` integer,
	`quarmy_url` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`main_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_characters`("id", "owner_id", "name", "class", "race", "level", "char_type", "main_character_id", "quarmy_url", "created_at", "updated_at") SELECT "id", "owner_id", "name", "class", "race", "level", "char_type", "main_character_id", "quarmy_url", "created_at", "updated_at" FROM `characters`;--> statement-breakpoint
DROP TABLE `characters`;--> statement-breakpoint
ALTER TABLE `__new_characters` RENAME TO `characters`;--> statement-breakpoint
PRAGMA defer_foreign_keys=off;--> statement-breakpoint
CREATE UNIQUE INDEX `characters_name_unique` ON `characters` (`name`);