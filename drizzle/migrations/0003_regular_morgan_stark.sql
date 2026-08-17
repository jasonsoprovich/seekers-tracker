CREATE TABLE `character_stats` (
	`character_id` integer PRIMARY KEY NOT NULL,
	`base_str` integer NOT NULL,
	`base_sta` integer NOT NULL,
	`base_cha` integer NOT NULL,
	`base_dex` integer NOT NULL,
	`base_int` integer NOT NULL,
	`base_agi` integer NOT NULL,
	`base_wis` integer NOT NULL,
	`computed_json` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
