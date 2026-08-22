-- PLAN.md §4i / Phase 1 task 1.1 — make epgp_settings effective-dated
-- rather than a single mutable row per key. Only 6 rows exist today
-- (base_ep, base_gp, ep_decay, gp_decay, ep_cap_per_cycle, min_ep) and
-- nothing else has a foreign key into this table, so a clean recreate is
-- simpler and safer than an in-place column rename. Phase 1 task 1.2
-- re-seeds current values immediately after this migration applies.
DROP TABLE `epgp_settings`;
--> statement-breakpoint
CREATE TABLE `epgp_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`setting_key` text NOT NULL,
	`value` text NOT NULL,
	`effective_from` integer NOT NULL,
	`changed_by` text,
	`changed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`note` text,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `epgp_settings_key_effective_idx` ON `epgp_settings` (`setting_key`,`effective_from`);
