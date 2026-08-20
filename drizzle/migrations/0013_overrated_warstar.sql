-- better-auth 1.7's account-identity change requires accounts.issuer,
-- looked up as (issuer, account_id) instead of (provider_id, account_id).
-- Existing rows have no issuer yet — every account this app has ever
-- created came from Discord OAuth (no credential sign-in), so per the 1.7
-- upgrade guide's documented value for "OAuth provider without an
-- issuer", they all backfill to 'local:oauth:' || provider_id (i.e.
-- 'local:oauth:discord'). SQLite requires a DEFAULT to ADD a NOT NULL
-- column to a non-empty table, so add with a placeholder default, backfill
-- real values, then the unique index enforces no future ambiguity.
ALTER TABLE `accounts` ADD `issuer` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `accounts` SET `issuer` = 'local:oauth:' || `provider_id` WHERE `issuer` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_issuer_account_id_idx` ON `accounts` (`issuer`,`account_id`);
