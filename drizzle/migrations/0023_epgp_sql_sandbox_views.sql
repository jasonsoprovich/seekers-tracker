-- Custom SQL migration file, put your code below! --

-- PLAN.md-adjacent security fix, 2026-08-25: /epgp/sql (the officer-facing
-- read-only SQL sandbox, src/app/(app)/epgp/sql/actions.ts) was validating
-- query TEXT (single statement, SELECT/WITH-only, banned-keyword denylist,
-- no comments) but running against env.DATABASE directly — the same D1
-- binding that also holds better-auth's own sessions/accounts/apikeys
-- tables. An officer (the lowest of the three privileged roles) could
-- `SELECT token FROM sessions` or `SELECT accessToken, refreshToken FROM
-- accounts` and walk away with another member's session or Discord OAuth
-- tokens (stored in plaintext — see src/auth/index.ts's comment on why
-- OAuth-token encryption isn't configured), despite authz.ts's own comment
-- describing this tool as scoped to "the EPGP tables".
--
-- These v_-prefixed views are that scope, made real: the sandbox's rewritten
-- validator (same file) requires every table-position identifier to either
-- start with "v_" or be a CTE defined in the query's own WITH clause, then
-- double-checks via EXPLAIN QUERY PLAN that SQLite's own view-expansion
-- never touches sessions/accounts/apikeys/verifications/sos_bot_staging.
-- D1 has no per-connection grants (no sqlite3_set_authorizer equivalent
-- exposed), so this is validation-plus-views, not a database-enforced
-- boundary — the EXPLAIN QUERY PLAN check is what makes it trustworthy,
-- since it reads SQLite's own parser output rather than re-deriving intent
-- from query text.
--
-- v_users and v_players project columns rather than SELECT * — v_users
-- exposes only (id, username, role), never email/discord_id/
-- discord_role_ids; v_players excludes discord_id (CLAUDE.md: never surface
-- raw Discord IDs). Every other view is a plain passthrough — none of these
-- tables hold anything sensitive beyond what Roster/Bank/Ledger already
-- show any signed-in member.
--
-- Deliberately no view over sessions, accounts, apikeys, verifications, or
-- sos_bot_staging (Toryn's raw-Discord-ID dump).

CREATE VIEW IF NOT EXISTS v_users AS
SELECT id, username, role FROM users;

CREATE VIEW IF NOT EXISTS v_players AS
SELECT
  id, user_id, display_name, main_character_id, main_character_changed_by,
  main_character_changed_at, status, joined_at, departed_at, note,
  status_changed_by, status_changed_at, created_at, updated_at
FROM players;

CREATE VIEW IF NOT EXISTS v_characters AS SELECT * FROM characters;
CREATE VIEW IF NOT EXISTS v_character_pop_flags AS SELECT * FROM character_pop_flags;
CREATE VIEW IF NOT EXISTS v_character_key_flags AS SELECT * FROM character_key_flags;
CREATE VIEW IF NOT EXISTS v_sky_bank_rewards AS SELECT * FROM sky_bank_rewards;
CREATE VIEW IF NOT EXISTS v_sky_bank_stock AS SELECT * FROM sky_bank_stock;
CREATE VIEW IF NOT EXISTS v_character_gear AS SELECT * FROM character_gear;
CREATE VIEW IF NOT EXISTS v_character_stats AS SELECT * FROM character_stats;
CREATE VIEW IF NOT EXISTS v_cycles AS SELECT * FROM cycles;
CREATE VIEW IF NOT EXISTS v_decay_events AS SELECT * FROM decay_events;
CREATE VIEW IF NOT EXISTS v_ep_ledger AS SELECT * FROM ep_ledger;
CREATE VIEW IF NOT EXISTS v_gp_ledger AS SELECT * FROM gp_ledger;
CREATE VIEW IF NOT EXISTS v_ledger_audit_log AS SELECT * FROM ledger_audit_log;
CREATE VIEW IF NOT EXISTS v_loot_events AS SELECT * FROM loot_events;
CREATE VIEW IF NOT EXISTS v_bids AS SELECT * FROM bids;
CREATE VIEW IF NOT EXISTS v_epgp_point_values AS SELECT * FROM epgp_point_values;
CREATE VIEW IF NOT EXISTS v_epgp_settings AS SELECT * FROM epgp_settings;
CREATE VIEW IF NOT EXISTS v_import_log AS SELECT * FROM import_log;
CREATE VIEW IF NOT EXISTS v_character_claims AS SELECT * FROM character_claims;
CREATE VIEW IF NOT EXISTS v_bank_imports AS SELECT * FROM bank_imports;
CREATE VIEW IF NOT EXISTS v_bank_holdings AS SELECT * FROM bank_holdings;
