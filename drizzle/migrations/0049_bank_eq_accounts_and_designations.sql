CREATE TABLE `bank_eq_account_characters` (
	`character_id` integer PRIMARY KEY NOT NULL,
	`eq_account_id` integer NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`eq_account_id`) REFERENCES `bank_eq_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bank_eq_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`shared_bank_holder_character_id` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`shared_bank_holder_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `bank_slot_designations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer,
	`eq_account_id` integer,
	`container` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`eq_account_id`) REFERENCES `bank_eq_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bank_slot_designations_owner_xor" CHECK(("bank_slot_designations"."character_id" IS NULL) != ("bank_slot_designations"."eq_account_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_slot_designations_character_container_unique` ON `bank_slot_designations` (`character_id`,`container`);--> statement-breakpoint
CREATE UNIQUE INDEX `bank_slot_designations_eq_account_container_unique` ON `bank_slot_designations` (`eq_account_id`,`container`);