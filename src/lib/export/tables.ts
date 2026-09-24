// Admin+leader-only CSV export allowlist (/admin/logs "Export" tab).
//
// A TypeScript allowlist rather than a second set of SQL views — migration
// 0023's `v_*` views (src/app/(app)/epgp/sql/actions.ts) are the right
// PRECEDENT for what's safe to expose (no sessions/accounts/apikeys/
// verifications, no sos_bot_staging — raw Discord IDs, CLAUDE.md), but they
// predate several tables added since (raids, main_swap_events,
// player_epgp_totals, role_permissions, system_event_log) and carry no
// per-table date column, which this export needs. Encoding it once here
// keeps the two lists independently reviewable rather than silently
// drifting apart.
//
// Raw SQL table/column names (snake_case), not Drizzle table objects — the
// export route pages through D1 with keyset pagination on the SQLite
// built-in `rowid` (every table here is a normal rowid table, never
// WITHOUT ROWID), which needs no per-table knowledge of the real primary
// key shape (composite keys, no autoincrement id, etc. all still have a
// rowid). Keeping this file free of a Drizzle import also means it stays
// trivial to keep in sync by eye against schema.ts.

export type ExportDateColumnType = "timestamp" | "text-date";

export type ExportGroup = "Audit & History" | "EPGP" | "Roster" | "Reference";

export type ExportTable = {
  key: string;
  label: string;
  table: string;
  // The column `from`/`to` filters on, and how to interpret it: "timestamp"
  // columns are unix-epoch-seconds integers (unixepoch() default — bind as
  // an integer); "text-date" is a literal 'YYYY-MM-DD' string (only
  // raids.raid_date). Null means the table has no meaningful date column —
  // the range is ignored and the whole table exports every time.
  dateColumn: string | null;
  dateColumnType: ExportDateColumnType | null;
  // Explicit projection for a table that holds more than this surface
  // should hand out as a portable file — CLAUDE.md: never surface raw
  // Discord IDs; a downloaded CSV also leaves every access control behind,
  // unlike the app itself. Null means every column.
  columns: string[] | null;
  group: ExportGroup;
};

export const EXPORT_TABLES: ExportTable[] = [
  // --- Audit & History ---------------------------------------------------
  { key: "system_log", label: "System Log", table: "system_event_log", dateColumn: "occurred_at", dateColumnType: "timestamp", columns: null, group: "Audit & History" },
  { key: "audit", label: "Ledger Audit Trail", table: "ledger_audit_log", dateColumn: "changed_at", dateColumnType: "timestamp", columns: null, group: "Audit & History" },
  { key: "main_swaps", label: "Main Swap History", table: "main_swap_events", dateColumn: "swapped_at", dateColumnType: "timestamp", columns: null, group: "Audit & History" },
  { key: "claims", label: "Character Claims", table: "character_claims", dateColumn: "created_at", dateColumnType: "timestamp", columns: null, group: "Audit & History" },
  { key: "imports", label: "Import Log", table: "import_log", dateColumn: "created_at", dateColumnType: "timestamp", columns: null, group: "Audit & History" },

  // --- EPGP ---------------------------------------------------------------
  { key: "ep_ledger", label: "EP Ledger", table: "ep_ledger", dateColumn: "occurred_at", dateColumnType: "timestamp", columns: null, group: "EPGP" },
  { key: "gp_ledger", label: "GP Ledger", table: "gp_ledger", dateColumn: "occurred_at", dateColumnType: "timestamp", columns: null, group: "EPGP" },
  { key: "bids", label: "Bid History", table: "bids", dateColumn: "created_at", dateColumnType: "timestamp", columns: null, group: "EPGP" },
  { key: "loot_events", label: "Loot Events", table: "loot_events", dateColumn: "occurred_at", dateColumnType: "timestamp", columns: null, group: "EPGP" },
  { key: "decay_events", label: "Decay Events", table: "decay_events", dateColumn: "effective_date", dateColumnType: "timestamp", columns: null, group: "EPGP" },
  { key: "raids", label: "Raids", table: "raids", dateColumn: "raid_date", dateColumnType: "text-date", columns: null, group: "EPGP" },
  { key: "totals", label: "EPGP Standings", table: "player_epgp_totals", dateColumn: "updated_at", dateColumnType: "timestamp", columns: null, group: "EPGP" },
  { key: "settings", label: "EPGP Settings History", table: "epgp_settings", dateColumn: "effective_from", dateColumnType: "timestamp", columns: null, group: "EPGP" },
  { key: "point_values", label: "EP/GP Point Values", table: "epgp_point_values", dateColumn: null, dateColumnType: null, columns: null, group: "EPGP" },

  // --- Roster ---------------------------------------------------------------
  { key: "characters", label: "Characters", table: "characters", dateColumn: "created_at", dateColumnType: "timestamp", columns: null, group: "Roster" },
  {
    key: "players",
    label: "Players (accounts)",
    table: "players",
    dateColumn: "created_at",
    dateColumnType: "timestamp",
    // Excludes discord_id — CLAUDE.md: never surface raw Discord IDs.
    columns: [
      "id", "user_id", "display_name", "main_character_id", "role", "status",
      "joined_at", "departed_at", "note", "created_at", "updated_at",
    ],
    group: "Roster",
  },
  {
    key: "users",
    label: "Users (site accounts)",
    table: "users",
    dateColumn: "created_at",
    dateColumnType: "timestamp",
    // Excludes email/discord_id/discord_role_ids/avatar_url — same
    // projection migration 0023's v_users view already settled on.
    columns: ["id", "username", "role", "created_at"],
    group: "Roster",
  },
  { key: "pop_flags", label: "PoP Flags", table: "character_pop_flags", dateColumn: null, dateColumnType: null, columns: null, group: "Roster" },
  { key: "key_flags", label: "Key Flags (EmpVT/ST)", table: "character_key_flags", dateColumn: null, dateColumnType: null, columns: null, group: "Roster" },

  // --- Reference ---------------------------------------------------------------
  { key: "bank_holdings", label: "Guild Bank Holdings", table: "bank_holdings", dateColumn: "updated_at", dateColumnType: "timestamp", columns: null, group: "Reference" },
  { key: "bank_eq_accounts", label: "Guild Bank EQ Accounts", table: "bank_eq_accounts", dateColumn: "updated_at", dateColumnType: "timestamp", columns: null, group: "Reference" },
  { key: "bank_eq_account_characters", label: "Guild Bank EQ Account Members", table: "bank_eq_account_characters", dateColumn: null, dateColumnType: null, columns: null, group: "Reference" },
  { key: "bank_slot_designations", label: "Guild Bank Slot Designations", table: "bank_slot_designations", dateColumn: "updated_at", dateColumnType: "timestamp", columns: null, group: "Reference" },
  { key: "sky_bank_stock", label: "Sky Bank Stock", table: "sky_bank_stock", dateColumn: null, dateColumnType: null, columns: null, group: "Reference" },
  { key: "sky_bank_rewards", label: "Sky Bank Rewards", table: "sky_bank_rewards", dateColumn: null, dateColumnType: null, columns: null, group: "Reference" },
  { key: "cycles", label: "EPGP Cycles", table: "cycles", dateColumn: null, dateColumnType: null, columns: null, group: "Reference" },
  { key: "role_permissions", label: "Permission Overrides", table: "role_permissions", dateColumn: null, dateColumnType: null, columns: null, group: "Reference" },
  { key: "info_sections", label: "Rules Info Sections", table: "epgp_info_sections", dateColumn: null, dateColumnType: null, columns: null, group: "Reference" },
];

export function getExportTable(key: string): ExportTable | undefined {
  return EXPORT_TABLES.find((t) => t.key === key);
}

export const EXPORT_GROUP_ORDER: readonly ExportGroup[] = ["Audit & History", "EPGP", "Roster", "Reference"];
