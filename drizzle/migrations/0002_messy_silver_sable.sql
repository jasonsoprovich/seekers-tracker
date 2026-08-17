CREATE TABLE `character_gear` (
	`character_id` integer NOT NULL,
	`slot` text NOT NULL,
	`item_id` integer NOT NULL,
	`item_name` text NOT NULL,
	`icon` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`character_id`, `slot`),
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
