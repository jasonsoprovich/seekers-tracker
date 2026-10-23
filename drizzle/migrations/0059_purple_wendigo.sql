ALTER TABLE `cycles` ADD `started_by_decay_event_id` integer REFERENCES decay_events(id);--> statement-breakpoint
-- Cycles now roll over when the leader commits a global cycle decay instead
-- of on the sheet's pre-filled calendar. Drop the calendar rows that haven't
-- started yet (nothing can reference a cycle that hasn't begun) so the cycle
-- running now stays current until the next decay.
DELETE FROM `cycles`
WHERE `start_date` > unixepoch()
  AND `id` NOT IN (SELECT `cycle_id` FROM `ep_ledger` WHERE `cycle_id` IS NOT NULL)
  AND `id` NOT IN (SELECT `cycle_id` FROM `gp_ledger` WHERE `cycle_id` IS NOT NULL);
