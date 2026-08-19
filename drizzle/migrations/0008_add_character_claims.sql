CREATE TABLE `character_claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer NOT NULL,
	`requester_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`decision_note` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `character_claims_status_idx` ON `character_claims` (`status`);--> statement-breakpoint
CREATE INDEX `character_claims_character_id_idx` ON `character_claims` (`character_id`);--> statement-breakpoint
-- Hand-added: drizzle-kit doesn't generate WHERE-qualified indexes. Blocks
-- the same requester from double-submitting a pending claim on the same
-- character; two different requesters may each still have one pending.
CREATE UNIQUE INDEX `character_claims_one_pending` ON `character_claims` (`character_id`, `requester_id`) WHERE `status` = 'pending';