CREATE TABLE `character_epgp` (
	`character_id` integer PRIMARY KEY NOT NULL,
	`ep` integer NOT NULL,
	`gp` integer NOT NULL,
	`priority_rating` real NOT NULL,
	`last_synced_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
