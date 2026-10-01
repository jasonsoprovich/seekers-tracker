CREATE TABLE `item_tooltips` (
	`item_id` integer PRIMARY KEY NOT NULL,
	`html` text NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL
);
