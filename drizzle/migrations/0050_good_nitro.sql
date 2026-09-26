DROP INDEX `bank_slot_designations_character_container_unique`;--> statement-breakpoint
DROP INDEX `bank_slot_designations_eq_account_container_unique`;--> statement-breakpoint
ALTER TABLE `bank_slot_designations` ADD `slot_index` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bank_slot_designations` ADD `expected_item_id` integer;--> statement-breakpoint
ALTER TABLE `bank_slot_designations` ADD `expected_item_name` text;--> statement-breakpoint
CREATE UNIQUE INDEX `bank_slot_designations_character_container_slot_unique` ON `bank_slot_designations` (`character_id`,`container`,`slot_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `bank_slot_designations_eq_account_container_slot_unique` ON `bank_slot_designations` (`eq_account_id`,`container`,`slot_index`);--> statement-breakpoint
-- Currency is never shown or synced (2026-09-25 officer feedback: nobody,
-- officers included, needs this visible) — purge the only rows that could
-- ever hold it (the manual Add form's Currency option, since the parser
-- already drops Bank-Coin/General-Coin before either display or sync).
DELETE FROM `bank_holdings` WHERE `category` = 'currency';