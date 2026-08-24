CREATE TABLE `character_key_flags` (
	`character_id` integer NOT NULL,
	`category` text NOT NULL,
	`flag_key` text NOT NULL,
	`label` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`logged_by` text,
	`note` text,
	`source` text DEFAULT 'import' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`character_id`, `flag_key`),
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sky_bank_rewards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_name` text NOT NULL,
	`qty` integer DEFAULT 0 NOT NULL,
	`quest_name` text NOT NULL,
	`class_restriction` text,
	`item2_status` text,
	`item3_status` text,
	`item4_status` text,
	`officer_holding` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sky_bank_rewards_item_unique` ON `sky_bank_rewards` (`item_name`);--> statement-breakpoint
CREATE TABLE `sky_bank_stock` (
	`item_name` text PRIMARY KEY NOT NULL,
	`qty` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
