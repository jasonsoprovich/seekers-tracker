CREATE TABLE `role_permissions` (
	`capability` text NOT NULL,
	`role` text NOT NULL,
	`allowed` integer NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`capability`, `role`),
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
