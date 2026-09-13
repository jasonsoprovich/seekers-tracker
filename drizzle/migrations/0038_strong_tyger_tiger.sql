ALTER TABLE `bids` ADD `player_id` integer REFERENCES players(id);--> statement-breakpoint
CREATE INDEX `bids_player_id_idx` ON `bids` (`player_id`);--> statement-breakpoint
-- Remediation plan Phase 7 task 7.3 — backfill from the character's
-- CURRENT player_id, the best inference available for a bid recorded
-- before this column existed (true historical ownership at bid time isn't
-- reconstructable if the character changed hands since). New bids set
-- player_id directly at write time (bid-finalization.ts) and never need
-- this backfill. A character with no player_id of its own (never
-- claimed/attached) leaves the bid's player_id NULL too — an honest "no
-- player identity to compare against," not a bug.
UPDATE bids SET player_id = (SELECT player_id FROM characters WHERE characters.id = bids.character_id) WHERE player_id IS NULL;