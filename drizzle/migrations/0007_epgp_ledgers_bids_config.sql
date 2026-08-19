CREATE TABLE `bids` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`loot_event_id` integer NOT NULL,
	`character_id` integer NOT NULL,
	`tier` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`priority_snapshot` real,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`loot_event_id`) REFERENCES `loot_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bids_loot_event_id_idx` ON `bids` (`loot_event_id`);--> statement-breakpoint
CREATE INDEX `bids_character_id_idx` ON `bids` (`character_id`);--> statement-breakpoint
CREATE TABLE `cycles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cycle_number` integer NOT NULL,
	`start_date` integer NOT NULL,
	`end_date` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cycles_cycle_number_unique` ON `cycles` (`cycle_number`);--> statement-breakpoint
CREATE TABLE `ep_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer NOT NULL,
	`cycle_id` integer,
	`occurred_at` integer NOT NULL,
	`activity` text NOT NULL,
	`points` real NOT NULL,
	`note` text,
	`entered_by` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cycle_id`) REFERENCES `cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ep_ledger_character_id_idx` ON `ep_ledger` (`character_id`);--> statement-breakpoint
CREATE INDEX `ep_ledger_occurred_at_idx` ON `ep_ledger` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `epgp_point_values` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`activity` text NOT NULL,
	`points` real NOT NULL,
	`retired` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `epgp_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `gp_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer NOT NULL,
	`cycle_id` integer,
	`occurred_at` integer NOT NULL,
	`item_name` text,
	`tier` text NOT NULL,
	`points` real NOT NULL,
	`note` text,
	`duplicate_flag` integer DEFAULT false NOT NULL,
	`entered_by` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cycle_id`) REFERENCES `cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gp_ledger_character_id_idx` ON `gp_ledger` (`character_id`);--> statement-breakpoint
CREATE INDEX `gp_ledger_occurred_at_idx` ON `gp_ledger` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `loot_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` integer NOT NULL,
	`item_name` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_by` text,
	`winning_bid_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`opened_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`winning_bid_id`) REFERENCES `bids`(`id`) ON UPDATE no action ON DELETE no action
);
