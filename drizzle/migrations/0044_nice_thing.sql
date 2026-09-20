CREATE TABLE `system_event_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` integer DEFAULT (unixepoch()) NOT NULL,
	`actor_user_id` text,
	`actor_label` text,
	`actor_role` text,
	`source` text NOT NULL,
	`category` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`target_label` text,
	`summary` text NOT NULL,
	`before` text,
	`after` text,
	`request_id` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `system_event_log_occurred_idx` ON `system_event_log` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `system_event_log_category_idx` ON `system_event_log` (`category`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `system_event_log_actor_idx` ON `system_event_log` (`actor_user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `system_event_log_target_idx` ON `system_event_log` (`target_type`,`target_id`);