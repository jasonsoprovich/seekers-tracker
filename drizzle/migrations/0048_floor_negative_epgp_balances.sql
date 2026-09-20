-- Historical legacy-cycle rows can remain after the corresponding earned
-- history was removed. Preserve the audit trail and bring each account back
-- to its EPGP floor instead of deleting those old rows.
INSERT INTO ep_ledger (character_id, player_id, occurred_at, activity, points, points_nominal, points_awarded, note, source)
SELECT p.main_character_id, p.id, unixepoch(), 'Balance correction', -SUM(e.points), -SUM(e.points), -SUM(e.points), 'Automatic correction: EPGP balances cannot fall below zero.', 'manual'
FROM players p
JOIN ep_ledger e ON e.player_id = p.id
WHERE p.main_character_id IS NOT NULL
GROUP BY p.id
HAVING SUM(e.points) < 0;
--> statement-breakpoint
INSERT INTO gp_ledger (character_id, player_id, occurred_at, tier, points, points_nominal, points_awarded, note, source)
SELECT p.main_character_id, p.id, unixepoch(), 'Balance correction', -SUM(g.points), -SUM(g.points), -SUM(g.points), 'Automatic correction: EPGP balances cannot fall below zero.', 'manual'
FROM players p
JOIN gp_ledger g ON g.player_id = p.id
WHERE p.main_character_id IS NOT NULL
GROUP BY p.id
HAVING SUM(g.points) < 0;
