DROP INDEX `characters_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `characters_name_unique` ON `characters` ("name" collate nocase);