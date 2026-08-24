PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ep_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer,
	`player_id` integer,
	`cycle_id` integer,
	`occurred_at` integer NOT NULL,
	`activity` text NOT NULL,
	`points` real NOT NULL,
	`points_nominal` real,
	`points_awarded` real,
	`cap_applied` integer DEFAULT false NOT NULL,
	`cap_at_entry` real,
	`orphaned` integer DEFAULT false NOT NULL,
	`note` text,
	`entered_by` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`decay_event_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cycle_id`) REFERENCES `cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decay_event_id`) REFERENCES `decay_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_ep_ledger`("id", "character_id", "cycle_id", "occurred_at", "activity", "points", "note", "entered_by", "source", "decay_event_id", "created_at") SELECT "id", "character_id", "cycle_id", "occurred_at", "activity", "points", "note", "entered_by", "source", "decay_event_id", "created_at" FROM `ep_ledger`;--> statement-breakpoint
DROP TABLE `ep_ledger`;--> statement-breakpoint
ALTER TABLE `__new_ep_ledger` RENAME TO `ep_ledger`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ep_ledger_character_id_idx` ON `ep_ledger` (`character_id`);--> statement-breakpoint
CREATE INDEX `ep_ledger_player_id_idx` ON `ep_ledger` (`player_id`);--> statement-breakpoint
CREATE INDEX `ep_ledger_occurred_at_idx` ON `ep_ledger` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `ep_ledger_decay_event_id_idx` ON `ep_ledger` (`decay_event_id`);--> statement-breakpoint
CREATE TABLE `__new_gp_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer,
	`player_id` integer,
	`cycle_id` integer,
	`occurred_at` integer NOT NULL,
	`item_name` text,
	`tier` text NOT NULL,
	`points` real NOT NULL,
	`points_nominal` real,
	`points_awarded` real,
	`cap_applied` integer DEFAULT false NOT NULL,
	`cap_at_entry` real,
	`orphaned` integer DEFAULT false NOT NULL,
	`note` text,
	`duplicate_flag` integer DEFAULT false NOT NULL,
	`entered_by` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`decay_event_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cycle_id`) REFERENCES `cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decay_event_id`) REFERENCES `decay_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_gp_ledger`("id", "character_id", "cycle_id", "occurred_at", "item_name", "tier", "points", "note", "duplicate_flag", "entered_by", "source", "decay_event_id", "created_at") SELECT "id", "character_id", "cycle_id", "occurred_at", "item_name", "tier", "points", "note", "duplicate_flag", "entered_by", "source", "decay_event_id", "created_at" FROM `gp_ledger`;--> statement-breakpoint
DROP TABLE `gp_ledger`;--> statement-breakpoint
ALTER TABLE `__new_gp_ledger` RENAME TO `gp_ledger`;--> statement-breakpoint
CREATE INDEX `gp_ledger_character_id_idx` ON `gp_ledger` (`character_id`);--> statement-breakpoint
CREATE INDEX `gp_ledger_player_id_idx` ON `gp_ledger` (`player_id`);--> statement-breakpoint
CREATE INDEX `gp_ledger_occurred_at_idx` ON `gp_ledger` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `gp_ledger_decay_event_id_idx` ON `gp_ledger` (`decay_event_id`);