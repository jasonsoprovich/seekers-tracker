import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, primaryKey, index, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// Core fields (email, emailVerified, username/name, avatarUrl/image,
// createdAt, updatedAt) are required by better-auth's user model — see
// src/auth/index.ts for the field-name mapping (name -> username,
// image -> avatarUrl) and the guild-specific additionalFields.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  discordId: text("discord_id").unique(),
  username: text("username"),
  avatarUrl: text("avatar_url"),
  // "admin" is site/dev administration (DB, config, roles) — distinct from
  // guild loot/attendance authority (officer/leader). See
  // docs/guild-website-feasibility.md and the EPGP plan for why the two are
  // kept separate rather than folding admin into "leader".
  role: text("role", { enum: ["member", "officer", "leader", "admin"] })
    .notNull()
    .default("member"),
  discordVerified: integer("discord_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  // JSON-stringified array of the user's Discord role IDs within
  // SEEKERS_DISCORD_GUILD_ID, snapshotted at the same time as
  // discordVerified (see src/lib/discord-verify.ts). Not yet used to
  // derive `role` — that's still admin-panel-driven — this just captures
  // the data so a future role-mapping decision doesn't need a schema
  // change of its own.
  discordRoleIds: text("discord_role_ids"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
});

// The account EP/GP attaches to (PLAN.md §4a / Phase 3) — not the same thing
// as a `users` site login (a player may exist, seeded from Toryn's Discord
// bot dump, before anyone ever logs into the site) nor a `characters` row (a
// player owns a group of characters: one main plus alts/mules). Introduced so
// a leader-approved main swap (mainCharacterId) no longer orphans EP/GP
// history the way redirecting `characters.ownerId` would — see
// characters.playerId's comment and computeEpgpTotals's Phase 3 note.
// discordId is the stable key: Discord membership is mandatory for guild
// members, unlike a site account.
export const players = sqliteTable("players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  discordId: text("discord_id").unique(),
  userId: text("user_id").references(() => users.id),
  displayName: text("display_name").notNull(),
  mainCharacterId: integer("main_character_id").references((): AnySQLiteColumn => characters.id),
  // Departed clears EP but never GP (PLAN.md §1e) — that asymmetry lives in
  // decay_events (kind 'departure'), not here. This status just drives
  // default-view filtering (roster/priority/bid views hide non-active by
  // default) per §4j.
  status: text("status", { enum: ["active", "inactive", "departed"] })
    .notNull()
    .default("active"),
  joinedAt: integer("joined_at", { mode: "timestamp" }),
  departedAt: integer("departed_at", { mode: "timestamp" }),
  // §4j's "status_note" — reused as this table's general free-text note
  // (also used by scripts/derive-players-from-sos-bot.ts for provenance),
  // not a second dedicated column.
  note: text("note"),
  statusChangedBy: text("status_changed_by").references(() => users.id),
  statusChangedAt: integer("status_changed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const characters = sqliteTable("characters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Nullable: the EPGP import (scripts/import-epgp.ts) creates rows for
  // every character name in the guild's ledger, most of which have no site
  // account yet. Null means "unclaimed roster character" — see the EPGP
  // plan's "Character claiming" open question.
  ownerId: text("owner_id").references(() => users.id),
  // Nullable: populated by Phase 3's players backfill (PLAN.md §4c), not at
  // table-creation time — most existing rows predate any players data.
  // players.mainCharacterId is authoritative for "which character is this
  // player's main"; this column is the reverse pointer used to group a
  // player's characters and is kept in sync with it, not the other way
  // around.
  playerId: integer("player_id").references(() => players.id),
  // Display order mirroring Toryn's Discord bot (main 0, alt 1, mule 2), so
  // the bot (Phase 10) and this site agree on character list ordering
  // without either recomputing it. Nullable until Phase 3 backfills it from
  // the bot dump.
  charPriority: integer("char_priority"),
  // COLLATE NOCASE (not a plain .unique()) so "tuffums" and "Tuffums" collide
  // at the DB level instead of silently becoming two characters with two
  // separate EP/GP ledgers — the exact class of bug the EPGP importer had to
  // work around for the guild's sheet itself (its SUMIF totals are also
  // case-insensitive). Leading/trailing whitespace is trimmed before this
  // column is ever written (see characters/actions.ts and
  // scripts/import-epgp.ts's cellText()), so this only needs to guard case.
  name: text("name").notNull(),
  class: integer("class").notNull(),
  race: integer("race").notNull(),
  level: integer("level").notNull(),
  // "mule" added Phase 3 (PLAN.md §4c) — bank-holding characters
  // (Lunamule, Darkclaw) excluded from EPGP, distinct from a played alt.
  charType: text("char_type", { enum: ["main", "alt", "mule"] })
    .notNull()
    .default("main"),
  // Non-destructive roster housekeeping: "inactive"/"removed" hide the
  // character from the guild-wide read views (Roster/EPGP/Progression/
  // Dashboard) by default without touching its EP/GP history or deleting
  // it — see src/lib/character-status.ts. Settable by the owner or any
  // officer/leader/admin, same gate as every other edit-form field. Renamed
  // from "retired" to "inactive" in Phase 3 (§4j), for parity with
  // players.status — a character can be removed (deleted in-game,
  // transferred away) while its player stays active, and vice versa.
  status: text("status", { enum: ["active", "inactive", "removed"] })
    .notNull()
    .default("active"),
  // When `status` last changed (§4j) — nullable, since every pre-Phase-3
  // character predates this column and its true change date is unknown.
  statusChangedAt: integer("status_changed_at", { mode: "timestamp" }),
  // Which main character this alt belongs to (admin/officer- or
  // owner-assignable), so alts can be tracked back to a main even when the
  // guild's EPGP sheet has no player/account column of its own — see §10.
  // Not enforced same-owner: alts occasionally live on a friend's/alt
  // Discord login, and officers need to link those too.
  mainCharacterId: integer("main_character_id").references((): AnySQLiteColumn => characters.id),
  // Optional link to this character's Quarmy profile (quarmy.com) for full
  // gear/stat detail beyond what this app's own hover cards show — see
  // GearList.tsx.
  quarmyUrl: text("quarmy_url"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [uniqueIndex("characters_name_unique").on(sql`${table.name} collate nocase`)]);

export const characterPopFlags = sqliteTable(
  "character_pop_flags",
  {
    characterId: integer("character_id")
      .notNull()
      .references(() => characters.id),
    flagId: text("flag_id").notNull(),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    source: text("source", { enum: ["manual", "seer", "import"] }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [primaryKey({ columns: [table.characterId, table.flagId] })],
);

export const characterGear = sqliteTable(
  "character_gear",
  {
    characterId: integer("character_id")
      .notNull()
      .references(() => characters.id),
    slot: text("slot").notNull(),
    itemId: integer("item_id").notNull(),
    itemName: text("item_name").notNull(),
    icon: integer("icon"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [primaryKey({ columns: [table.characterId, table.slot] })],
);

// Base (unbuffed, no-item) attributes, captured from the Quarmy export's
// character-stats row (§8 Phase 3 / task 18) — the one piece of derived-stat
// input the app has no other source for (class/level/race already live on
// `characters`, gear already lives in `character_gear`). computed_json is a
// best-effort cache of the last computed derived-stat sheet, written at gear
// import time; the Stats page always recomputes fresh rather than trusting
// it, since a character edit (level/class change) can go stale without a
// re-import — see src/lib/eqstat/compute.ts.
export const characterStats = sqliteTable("character_stats", {
  characterId: integer("character_id")
    .primaryKey()
    .references(() => characters.id),
  baseStr: integer("base_str").notNull(),
  baseSta: integer("base_sta").notNull(),
  baseCha: integer("base_cha").notNull(),
  baseDex: integer("base_dex").notNull(),
  baseInt: integer("base_int").notNull(),
  baseAgi: integer("base_agi").notNull(),
  baseWis: integer("base_wis").notNull(),
  computedJson: text("computed_json"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const cycles = sqliteTable("cycles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cycleNumber: integer("cycle_number").notNull().unique(),
  startDate: integer("start_date", { mode: "timestamp" }).notNull(),
  endDate: integer("end_date", { mode: "timestamp" }).notNull(),
});

// Explicit decay applications (PLAN.md §1b/1c/1e) — every decay mechanism
// except the legacy pre-cutover cycle decay (§1a, which stays derived at
// read time from raw ledger sums and is never stored) writes one row here
// plus the linked negative ep_ledger/gp_ledger rows it produced. One row =
// one leader-triggered batch: preview -> commit -> optionally reverse as a
// unit. See src/lib/epgp/decay.ts.
export const decayEvents = sqliteTable(
  "decay_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ["legacy_cycle", "global_cycle", "expansion", "departure"] }).notNull(),
    // Nullable: a departure event only ever touches EP (§1e — GP is never
    // cleared on departure), so gpRate stays null for that kind.
    epRate: real("ep_rate"),
    gpRate: real("gp_rate"),
    effectiveDate: integer("effective_date", { mode: "timestamp" }).notNull(),
    label: text("label"),
    appliedBy: text("applied_by").references(() => users.id),
    appliedAt: integer("applied_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    // Reversal (src/lib/epgp/decay.ts's reverseDecayEvent) deletes the
    // linked ep_ledger/gp_ledger rows outright — PLAN.md §2.6 — but keeps
    // this row so the fact that a decay was applied and then undone stays
    // in the record, instead of vanishing entirely.
    reversedAt: integer("reversed_at", { mode: "timestamp" }),
    reversedBy: text("reversed_by").references(() => users.id),
  },
  (table) => [index("decay_events_kind_effective_idx").on(table.kind, table.effectiveDate)],
);

// Effort Points ledger. Decay is an explicit negative-point row here (as it
// was in the sheet's EP Log), not separate bookkeeping — totals are a
// straight SUM(). See scripts/import-epgp.ts and src/lib/epgp/totals.ts.
export const epLedger = sqliteTable(
  "ep_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Nullable as of Phase 3 (§4d/§1e) — an orphaned row (see `orphaned`
    // below) has no character to attribute to at all, its name having been
    // stripped in the sheet before this site existed.
    characterId: integer("character_id").references(() => characters.id),
    // The account this row's points belong to (§4a) — the aggregation key
    // `computeEpgpTotals` uses from Phase 3 task 3.11 on, replacing raw
    // `character_id` grouping. NULL on an orphaned row: it contributes to
    // no one's total, which is the entire point of orphaning it rather than
    // guessing an attribution.
    playerId: integer("player_id").references(() => players.id),
    cycleId: integer("cycle_id").references(() => cycles.id),
    occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
    activity: text("activity").notNull(),
    points: real("points").notNull(),
    // §2: the sheet's "EP Points" (T) vs. "Points Earned" (V) columns —
    // nominal is what the activity is worth before the per-cycle cap,
    // awarded is what actually landed (`points` above mirrors awarded,
    // kept as-is so no existing reader needs to change). Nullable only
    // because pre-Phase-3 rows are backfilled after the fact (task 3.8);
    // every row written from Phase 3 on sets both.
    pointsNominal: real("points_nominal"),
    pointsAwarded: real("points_awarded"),
    // True when this row's nominal points exceeded what was awarded — i.e.
    // the 900 EP/cycle cap (§2) actually bit. Never true for a decay row
    // (nominal == awarded by construction, §2's "never clamp a negative").
    capApplied: integer("cap_applied", { mode: "boolean" }).notNull().default(false),
    // The EP cap value in force when this row was written (via
    // getSettingAt, §4i) — without this, a later leader change to the cap
    // makes historical awards unexplainable. NULL on a gp_ledger row (GP has
    // no cap) and on any ep_ledger row written before this column existed.
    capAtEntry: real("cap_at_entry"),
    // True for one of the 1,637 EP Log rows whose character name was
    // stripped before this site existed (§1e) — unattributable, contributes
    // to no one's total (player_id/character_id both NULL), but the row and
    // its point value are kept for audit completeness rather than dropped.
    orphaned: integer("orphaned", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    enteredBy: text("entered_by").references(() => users.id),
    source: text("source", { enum: ["import", "manual", "parse"] })
      .notNull()
      .default("manual"),
    // Set only on rows a decay_events batch produced (or, for the 3
    // historical expansion decays, backfilled onto rows the sheet import
    // already created — PLAN.md §2.3). Null on every ordinary award row.
    decayEventId: integer("decay_event_id").references(() => decayEvents.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("ep_ledger_character_id_idx").on(table.characterId),
    index("ep_ledger_player_id_idx").on(table.playerId),
    index("ep_ledger_occurred_at_idx").on(table.occurredAt),
    index("ep_ledger_decay_event_id_idx").on(table.decayEventId),
  ],
);

// Gear Points ledger — one row per awarded/decayed/adjusted GP transaction.
// `tier` is the bid tier ("High Bid", "Epic Drop (Main)", "Decay", …), kept
// as free text to match the guild's own evolving tier list (epgp_point_values
// below is the editable reference, not an enum constraint).
export const gpLedger = sqliteTable(
  "gp_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Nullable as of Phase 3 (§4d) — GP Log has zero blank names (§1e), so
    // this is never actually null in practice; kept nullable only for shape
    // parity with ep_ledger.
    characterId: integer("character_id").references(() => characters.id),
    // See epLedger.playerId's comment — same aggregation-key role.
    playerId: integer("player_id").references(() => players.id),
    cycleId: integer("cycle_id").references(() => cycles.id),
    occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
    itemName: text("item_name"),
    tier: text("tier").notNull(),
    points: real("points").notNull(),
    // §4d's shared ep_ledger/gp_ledger shape — GP has no per-cycle cap
    // (§2 is EP-only), so pointsNominal/pointsAwarded always equal `points`,
    // capApplied is always false, and capAtEntry is always NULL here. Kept
    // for schema symmetry, not because GP needs the distinction.
    pointsNominal: real("points_nominal"),
    pointsAwarded: real("points_awarded"),
    capApplied: integer("cap_applied", { mode: "boolean" }).notNull().default(false),
    capAtEntry: real("cap_at_entry"),
    // GP Log has zero blank-name rows (§1e verified) — always false here,
    // kept only for shape parity with ep_ledger.
    orphaned: integer("orphaned", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    duplicateFlag: integer("duplicate_flag", { mode: "boolean" }).notNull().default(false),
    enteredBy: text("entered_by").references(() => users.id),
    source: text("source", { enum: ["import", "manual", "parse"] })
      .notNull()
      .default("manual"),
    // See epLedger.decayEventId's comment — same meaning here.
    decayEventId: integer("decay_event_id").references(() => decayEvents.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("gp_ledger_character_id_idx").on(table.characterId),
    index("gp_ledger_player_id_idx").on(table.playerId),
    index("gp_ledger_occurred_at_idx").on(table.occurredAt),
    index("gp_ledger_decay_event_id_idx").on(table.decayEventId),
  ],
);

// Edit/delete trail for ep_ledger/gp_ledger rows — who's recorded points is
// already on each row (entered_by), but that only ever shows the ORIGINAL
// entry; an officer correcting or removing someone else's entry left no
// trace before this. `before`/`after` are whole-row JSON snapshots (not a
// per-field diff) so this table doesn't need its own schema migration
// every time ep_ledger/gp_ledger gains a column. No FK on ledgerId — a
// delete's audit row must survive after the ledger row it describes is
// gone. See src/lib/epgp/ledger-audit.ts for the write path (called from
// both the website's ledger actions and any future officer-app edit/delete
// route) and /epgp/ledger/audit for the read view.
export const ledgerAuditLog = sqliteTable(
  "ledger_audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ledgerType: text("ledger_type", { enum: ["ep", "gp"] }).notNull(),
    ledgerId: integer("ledger_id").notNull(),
    action: text("action", { enum: ["update", "delete"] }).notNull(),
    changedBy: text("changed_by").references(() => users.id),
    changedAt: integer("changed_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    before: text("before", { mode: "json" }).notNull(),
    after: text("after", { mode: "json" }),
  },
  (table) => [
    index("ledger_audit_log_ledger_idx").on(table.ledgerType, table.ledgerId),
    index("ledger_audit_log_changed_at_idx").on(table.changedAt),
  ],
);

// New capability the sheet never had (guild leadership asked for this
// directly — see the EPGP plan): a loot event groups every bid placed on a
// drop, not just the eventual winner, so retractions/last-second changes/
// tell-to-the-wrong-person mistakes stay in the record instead of being
// overwritten.
export const lootEvents = sqliteTable("loot_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
  itemName: text("item_name").notNull(),
  status: text("status", { enum: ["open", "awarded", "rot", "cancelled"] })
    .notNull()
    .default("open"),
  openedBy: text("opened_by").references(() => users.id),
  winningBidId: integer("winning_bid_id").references((): AnySQLiteColumn => bids.id),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const bids = sqliteTable(
  "bids",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lootEventId: integer("loot_event_id")
      .notNull()
      .references(() => lootEvents.id),
    characterId: integer("character_id")
      .notNull()
      .references(() => characters.id),
    tier: text("tier").notNull(),
    status: text("status", { enum: ["active", "retracted", "won", "lost"] })
      .notNull()
      .default("active"),
    // Priority Rating at bid time, so a bid's context stays explainable even
    // after later decay/GP changes move the character's live PR.
    prioritySnapshot: real("priority_snapshot"),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("bids_loot_event_id_idx").on(table.lootEventId), index("bids_character_id_idx").on(table.characterId)],
);

// Editable mirror of the sheet's "Point Values" tab (EP activity → points,
// GP tier → points), so leadership can retune values without a deploy.
// `retired` keeps old tiers selectable for historical reference without
// offering them for new entries.
export const epgpPointValues = sqliteTable("epgp_point_values", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["ep", "gp"] }).notNull(),
  activity: text("activity").notNull(),
  points: real("points").notNull(),
  retired: integer("retired", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

// Guild-tunable EPGP constants (base EP/GP, decay %, per-cycle EP cap,
// minimum attendance, decay model) — key/value rather than fixed columns so
// new settings don't need a schema change. Effective-dated (PLAN.md §4i):
// changing a value writes a NEW row rather than overwriting the old one, so
// `getSettingAt(key, date)` (src/lib/epgp/settings.ts) can resolve "what was
// this setting worth when a given ledger row was written" even after the
// leader retunes it later. This is what makes the mutable 900 EP cap (§2)
// and the dual legacy/global decay model (§1c) safe — a rate change never
// silently rewrites history. The row with the greatest effective_from <=
// the query date, per setting_key, is the one "in force". Never update or
// delete a row in place; always insert a new one.
export const epgpSettings = sqliteTable(
  "epgp_settings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    settingKey: text("setting_key").notNull(),
    value: text("value").notNull(),
    effectiveFrom: integer("effective_from", { mode: "timestamp" }).notNull(),
    changedBy: text("changed_by").references(() => users.id),
    changedAt: integer("changed_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    note: text("note"),
  },
  (table) => [index("epgp_settings_key_effective_idx").on(table.settingKey, table.effectiveFrom)],
);

// Staging landing zone for Toryn's sos_bot.characters dump (PLAN.md §14,
// Phase 3 task 3.1) — verbatim columns, one row per dump record. Populated by
// scripts/import-sos-bot-dump.ts, which truncates and reloads this table on
// every run so a corrected dump can be re-imported without accumulating
// duplicates. Never read directly by the app; tasks 3.4+ derive players and
// characters.player_id/char_priority from it in a separate, reviewable step
// (kept separate from staging so a bad derivation can be re-run without
// re-importing the dump). columns and expected shape are documented in
// data/imports/sos-bot/README.md.
export const sosBotStaging = sqliteTable(
  "sos_bot_staging",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    discordId: text("discord_id").notNull(),
    charName: text("char_name").notNull(),
    charRace: text("char_race"),
    charClass: text("char_class"),
    charType: text("char_type"),
    charPriority: integer("char_priority"),
    // Toryn's schema field, unused per PLAN.md §14 (officer status comes
    // from Discord roles, §4b) — carried through verbatim for completeness,
    // not read by any derivation step.
    isOfficer: integer("is_officer", { mode: "boolean" }),
    importedAt: integer("imported_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("sos_bot_staging_discord_id_idx").on(table.discordId)],
);

export const importLog = sqliteTable("import_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  characterId: integer("character_id")
    .notNull()
    .references(() => characters.id),
  uploadedBy: text("uploaded_by")
    .notNull()
    .references(() => users.id),
  kind: text("kind", { enum: ["seer_text", "pqc_export", "gear_export"] }).notNull(),
  r2Key: text("r2_key"),
  summary: text("summary"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// A member's request to attach an unclaimed roster character (see
// characters.ownerId's comment) to their own account. Left pending until an
// officer approves/denies it — characters.ownerId is only ever set on
// approval, never at request time, so a denied or still-pending claim
// leaves the character untouched. A partial unique index (hand-added in the
// migration — drizzle-kit doesn't generate WHERE-qualified indexes) blocks
// the same requester from double-submitting a pending claim on the same
// character; two different requesters may each have one pending, and an
// officer arbitrates by approving one (which auto-denies the other — see
// admin/claims/actions.ts).
export const characterClaims = sqliteTable(
  "character_claims",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    characterId: integer("character_id")
      .notNull()
      .references(() => characters.id),
    requesterId: text("requester_id")
      .notNull()
      .references(() => users.id),
    status: text("status", { enum: ["pending", "approved", "denied"] })
      .notNull()
      .default("pending"),
    note: text("note"),
    decisionNote: text("decision_note"),
    reviewedBy: text("reviewed_by").references(() => users.id),
    reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("character_claims_status_idx").on(table.status),
    index("character_claims_character_id_idx").on(table.characterId),
  ],
);
