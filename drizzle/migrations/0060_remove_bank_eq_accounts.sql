-- Removes guild bank EQ account groups (2026-10-25 officer feedback). Every
-- slot designation now belongs to one character, SharedBank included.
-- Group-owned (SharedBank) flags are dropped; production had none. The
-- designations table is rebuilt BEFORE the group tables it referenced are
-- dropped, so nothing ever points at a missing table.
DELETE FROM `bank_slot_designations` WHERE `character_id` IS NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_bank_slot_designations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer NOT NULL,
	`container` text NOT NULL,
	`slot_index` integer DEFAULT 0 NOT NULL,
	`expected_item_id` integer,
	`expected_item_name` text,
	`updated_by` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_bank_slot_designations`("id", "character_id", "container", "slot_index", "expected_item_id", "expected_item_name", "updated_by", "updated_at") SELECT "id", "character_id", "container", "slot_index", "expected_item_id", "expected_item_name", "updated_by", "updated_at" FROM `bank_slot_designations`;--> statement-breakpoint
DROP TABLE `bank_slot_designations`;--> statement-breakpoint
ALTER TABLE `__new_bank_slot_designations` RENAME TO `bank_slot_designations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `bank_slot_designations_character_container_slot_unique` ON `bank_slot_designations` (`character_id`,`container`,`slot_index`);--> statement-breakpoint
DROP TABLE `bank_eq_account_characters`;--> statement-breakpoint
DROP TABLE `bank_eq_accounts`;
