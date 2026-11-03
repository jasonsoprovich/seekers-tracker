CREATE TABLE `character_spells` (
	`character_id` integer NOT NULL,
	`spell_id` integer NOT NULL,
	`source` text NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`character_id`, `spell_id`),
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `spell_settings` (
	`spell_id` integer PRIMARY KEY NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
-- Pre-hidden on launch (tradeskill/cosmetic): Imbue scrolls, the mage's
-- summoned pet jewelry, Illusion: Froglok. Officers can unhide from /spells.
INSERT INTO `spell_settings` (`spell_id`, `hidden`) VALUES
  (3040, 1),
  (3044, 1),
  (3063, 1),
  (3353, 1),
  (3591, 1),
  (3352, 1),
  (3356, 1),
  (3595, 1),
  (3344, 1),
  (3346, 1),
  (3594, 1),
  (3592, 1),
  (3593, 1),
  (3357, 1),
  (3209, 1),
  (3210, 1),
  (3205, 1),
  (3206, 1),
  (3207, 1),
  (3208, 1); -- 20 spells
