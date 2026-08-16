import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
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
