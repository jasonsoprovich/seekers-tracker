import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";

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
  role: text("role", { enum: ["member", "officer", "leader"] })
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
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull().unique(),
  class: integer("class").notNull(),
  race: integer("race").notNull(),
  level: integer("level").notNull(),
  charType: text("char_type", { enum: ["main", "alt"] })
    .notNull()
    .default("main"),
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

// Phase 4 (§10/§9 task 20) — mirrored read-only from the guild's EPGP Google
// Sheet's "Totals" tab, matched to `characters` by exact name. This site
// never writes back to the sheet; officers keep editing it by hand.
// priorityRating is copied verbatim (sheet already computes (EP+BaseEP)/
// (GP+BaseGP)) rather than recomputed here, since Base EP/GP and decay are
// guild-leadership-controlled values that drift over time — see §10.
export const characterEpgp = sqliteTable("character_epgp", {
  characterId: integer("character_id")
    .primaryKey()
    .references(() => characters.id),
  ep: integer("ep").notNull(),
  gp: integer("gp").notNull(),
  priorityRating: real("priority_rating").notNull(),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
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
