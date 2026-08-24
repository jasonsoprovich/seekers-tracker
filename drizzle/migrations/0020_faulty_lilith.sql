CREATE TABLE `bank_holdings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`holder_character_id` integer NOT NULL,
	`category` text DEFAULT 'item' NOT NULL,
	`container` text NOT NULL,
	`slot_index` integer DEFAULT 0 NOT NULL,
	`item_name` text NOT NULL,
	`item_id` integer,
	`quantity` integer DEFAULT 1 NOT NULL,
	`class_restriction` text,
	`status` text DEFAULT 'guild_bank' NOT NULL,
	`note` text,
	`source` text NOT NULL,
	`import_id` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`holder_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_id`) REFERENCES `bank_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_holdings_holder_container_slot_unique` ON `bank_holdings` (`holder_character_id`,`container`,`slot_index`);--> statement-breakpoint
CREATE TABLE `bank_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`character_id` integer NOT NULL,
	`uploaded_by` text NOT NULL,
	`source_file` text,
	`row_count` integer NOT NULL,
	`reports_shared_bank` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
