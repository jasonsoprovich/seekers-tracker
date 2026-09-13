CREATE TABLE `standings_dirty` (
	`scope` text PRIMARY KEY NOT NULL,
	`marked_at` integer DEFAULT (unixepoch()) NOT NULL
);
