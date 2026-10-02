-- PoP flag dataset sync with pq-companion (2026-10-02). ADDITIVE ONLY: no
-- UPDATE, no DELETE, INSERT OR IGNORE so an existing row (including a member's
-- deliberate manual un-check) is never touched. The dataset reshuffled
-- prerequisites; a member who had already ticked a later step would otherwise
-- show "done" with an unmet (now-locked) prerequisite. These inserts fill in
-- the newly required earlier steps for characters whose own progress proves
-- them. Orphaned rows (e.g. the removed post_bot_keyring) are left in place.

-- Bastion chain now hangs off post_bot_shrine (replaces the keyring row).
INSERT OR IGNORE INTO character_pop_flags (character_id, flag_id, done, source, updated_at)
SELECT DISTINCT character_id, 'post_bot_shrine', 1, 'import', unixepoch()
FROM character_pop_flags
WHERE done = 1 AND flag_id IN ('post_bot_keyring', 'bot_agnarr', 'bot_torden_key');

-- Maelin cipher / Zek notes are new steps in front of Rallos and the elementals.
INSERT OR IGNORE INTO character_pop_flags (character_id, flag_id, done, source, updated_at)
SELECT DISTINCT character_id, 'pok_maelin_cipher', 1, 'import', unixepoch()
FROM character_pop_flags
WHERE done = 1 AND flag_id IN ('pok_maelin_zek_notes', 'potac_rallos', 'pok_maelin_information');

INSERT OR IGNORE INTO character_pop_flags (character_id, flag_id, done, source, updated_at)
SELECT DISTINCT character_id, 'pok_maelin_zek_notes', 1, 'import', unixepoch()
FROM character_pop_flags
WHERE done = 1 AND flag_id IN ('potac_rallos', 'pok_maelin_information');

-- Saryrn now requires the Keeper of Sorrows flag.
INSERT OR IGNORE INTO character_pop_flags (character_id, flag_id, done, source, updated_at)
SELECT DISTINCT character_id, 'potor_keeper', 1, 'import', unixepoch()
FROM character_pop_flags
WHERE done = 1 AND flag_id = 'potor_saryrn';
