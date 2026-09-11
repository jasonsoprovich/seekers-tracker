ALTER TABLE `players` ADD `role` text DEFAULT 'member' NOT NULL;
--> statement-breakpoint
-- Backfill: an account that already has a login takes that login's role.
UPDATE `players` SET `role` = (SELECT `role` FROM `users` WHERE `users`.`id` = `players`.`user_id`) WHERE `user_id` IS NOT NULL AND EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `players`.`user_id`);
