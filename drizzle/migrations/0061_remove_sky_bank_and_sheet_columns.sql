-- Sheet-era guild bank cleanup (2026-10-25). The Sky Bank catalog is
-- retired (one guild bank for everything), and the two bank_holdings
-- columns that only ever tracked old Google Sheet rows (their original
-- location, and "a sync couldn't find it") go with the reconciliation code
-- that used them. Production bank data was wiped the same day, so no row
-- carries a value here. The SQL sandbox views (0023) over these tables are
-- dropped first, and v_bank_holdings is rebuilt around the column drops.
DROP VIEW IF EXISTS v_sky_bank_rewards;--> statement-breakpoint
DROP VIEW IF EXISTS v_sky_bank_stock;--> statement-breakpoint
DROP VIEW IF EXISTS v_bank_holdings;--> statement-breakpoint
DROP TABLE `sky_bank_rewards`;--> statement-breakpoint
DROP TABLE `sky_bank_stock`;--> statement-breakpoint
ALTER TABLE `bank_holdings` DROP COLUMN `legacy_location`;--> statement-breakpoint
ALTER TABLE `bank_holdings` DROP COLUMN `not_found_since`;--> statement-breakpoint
CREATE VIEW IF NOT EXISTS v_bank_holdings AS SELECT * FROM bank_holdings;
