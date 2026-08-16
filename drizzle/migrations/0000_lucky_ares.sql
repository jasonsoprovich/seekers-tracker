CREATE TABLE `character_pop_flags` (
	`character_id` integer NOT NULL,
	`flag_id` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`character_id`, `flag_id`),
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `characters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`class` integer NOT NULL,
	`race` integer NOT NULL,
	`level` integer NOT NULL,
	`char_type` text DEFAULT 'main' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `characters_name_unique` ON `characters` (`name`);--> statement-breakpoint
CREATE TABLE `import_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text,
	`summary` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`discord_id` text,
	`username` text,
	`avatar_url` text,
	`role` text DEFAULT 'member' NOT NULL,
	`discord_verified` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_discord_id_unique` ON `users` (`discord_id`);