CREATE TABLE `player_epgp_totals` (
	`player_id` integer PRIMARY KEY NOT NULL,
	`ep` real NOT NULL,
	`gp` real NOT NULL,
	`ep_decay` real NOT NULL,
	`gp_decay` real NOT NULL,
	`priority_rating` real NOT NULL,
	`raw_ep` real NOT NULL,
	`raw_gp` real NOT NULL,
	`pre_cycle_ep` real DEFAULT 0 NOT NULL,
	`pre_cycle_gp` real DEFAULT 0 NOT NULL,
	`last_activity_at` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
