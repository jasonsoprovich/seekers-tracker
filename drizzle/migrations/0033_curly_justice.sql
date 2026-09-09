CREATE TABLE `main_swap_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`player_id` integer NOT NULL,
	`prev_main_character_id` integer,
	`new_main_character_id` integer NOT NULL,
	`fee_gp` real DEFAULT 0 NOT NULL,
	`fee_gp_ledger_id` integer,
	`affected_before` text NOT NULL,
	`swapped_by` text,
	`swapped_at` integer DEFAULT (unixepoch()) NOT NULL,
	`reversed_at` integer,
	`reversed_by` text,
	`note` text,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prev_main_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`new_main_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fee_gp_ledger_id`) REFERENCES `gp_ledger`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`swapped_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reversed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `main_swap_events_player_idx` ON `main_swap_events` (`player_id`,`reversed_at`);