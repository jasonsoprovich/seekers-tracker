import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, primaryKey, index, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

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
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
});

export const characters = sqliteTable("characters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Nullable: the EPGP import (scripts/import-epgp.ts) creates rows for
  // every character name in the guild's ledger, most of which have no site
  // account yet. Null means "unclaimed roster character" — see the EPGP
  // plan's "Character claiming" open question.
  ownerId: text("owner_id").references(() => users.id),
  name: text("name").notNull().unique(),
  class: integer("class").notNull(),
  race: integer("race").notNull(),
  level: integer("level").notNull(),
  charType: text("char_type", { enum: ["main", "alt"] })
    .notNull()
    .default("main"),
  // Non-destructive roster housekeeping: "retired"/"removed" hide the
  // character from the guild-wide read views (Roster/EPGP/Progression/
  // Dashboard) by default without touching its EP/GP history or deleting
  // it — see src/lib/character-status.ts. Settable by the owner or any
  // officer/leader/admin, same gate as every other edit-form field.
  status: text("status", { enum: ["active", "retired", "removed"] })
    .notNull()
    .default("active"),
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
});

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

// Effort Points ledger. Decay is an explicit negative-point row here (as it
// was in the sheet's EP Log), not separate bookkeeping — totals are a
// straight SUM(). See scripts/import-epgp.ts and src/lib/epgp/totals.ts.
export const epLedger = sqliteTable(
  "ep_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    characterId: integer("character_id")
      .notNull()
      .references(() => characters.id),
    cycleId: integer("cycle_id").references(() => cycles.id),
    occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
    activity: text("activity").notNull(),
    points: real("points").notNull(),
    note: text("note"),
    enteredBy: text("entered_by").references(() => users.id),
    source: text("source", { enum: ["import", "manual", "parse"] })
      .notNull()
      .default("manual"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("ep_ledger_character_id_idx").on(table.characterId), index("ep_ledger_occurred_at_idx").on(table.occurredAt)],
);

// Gear Points ledger — one row per awarded/decayed/adjusted GP transaction.
// `tier` is the bid tier ("High Bid", "Epic Drop (Main)", "Decay", …), kept
// as free text to match the guild's own evolving tier list (epgp_point_values
// below is the editable reference, not an enum constraint).
export const gpLedger = sqliteTable(
  "gp_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    characterId: integer("character_id")
      .notNull()
      .references(() => characters.id),
    cycleId: integer("cycle_id").references(() => cycles.id),
    occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
    itemName: text("item_name"),
    tier: text("tier").notNull(),
    points: real("points").notNull(),
    note: text("note"),
    duplicateFlag: integer("duplicate_flag", { mode: "boolean" }).notNull().default(false),
    enteredBy: text("entered_by").references(() => users.id),
    source: text("source", { enum: ["import", "manual", "parse"] })
      .notNull()
      .default("manual"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("gp_ledger_character_id_idx").on(table.characterId), index("gp_ledger_occurred_at_idx").on(table.occurredAt)],
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

// Guild-tunable EPGP constants (base EP/GP, decay %, per-cycle EP cap) —
// key/value rather than fixed columns so new settings don't need a schema
// change. See src/lib/epgp/totals.ts for how these combine with the
// ledgers into a character's live EP/GP/Priority Rating.
export const epgpSettings = sqliteTable("epgp_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedBy: text("updated_by").references(() => users.id),
});

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
