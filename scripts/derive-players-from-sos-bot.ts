// PLAN.md §11 Phase 3 tasks 3.4-3.6 — derive `players` and backfill
// `characters.player_id`/`char_priority`/`char_type` from `sos_bot_staging`
// (loaded by scripts/import-sos-bot-dump.ts), plus create standalone
// `players` rows for sheet characters the dump never mentions (§1e/§4a: GP
// history must stay attributable even for characters with no known
// discord_id).
//
// Confirmed with the user 2026-08-23 (real dump from Toryn, 697 rows / 243
// distinct discord_id):
//   - Dump characters with no existing `characters` row (525 of 697 — 57
//     mains, 438 alts, 30 mules) get a NEW characters row created from the
//     dump's own race/class/type/priority, not just linked. Race/class name
//     strings are resolved case-insensitively against CHAR_RACES/CHAR_CLASSES
//     (src/lib/eq/enums.ts); anything unresolved (e.g. the dump's literal
//     "None") falls back to UNKNOWN_RACE_ID/UNKNOWN_CLASS_ID, same fallback
//     scripts/import-epgp.ts already uses for GP-log-only characters. Level
//     is unknown from this source — defaults to 1, same convention.
//   - A discord_id group with exactly one char_type='main' row gets that
//     character as players.main_character_id. A group with zero or 2+ mains
//     (25 and 2 of the 243 groups respectively, in the real dump) gets a
//     players row with main_character_id left NULL and a note flagging it —
//     never guessed.
//   - Every existing `characters` row the dump never mentions (86 of 258 in
//     the real dump — "sheet-only") gets its own standalone players row
//     (discord_id NULL, main_character_id = itself), so GP history stays
//     attributable per §1e even with no known discord account. Per §14,
//     these are claimable later via §10.
//
// Never overwrites data written by anything other than this script or the
// sheet importer: characters.player_id/char_type/char_priority are only set
// when currently NULL, and an existing players row for a given discord_id
// (or a given standalone character) is reused rather than duplicated — safe
// to re-run after a corrected sos_bot_staging reload.
//
// Usage:
//   npx tsx scripts/derive-players-from-sos-bot.ts             # dry run, report only
//   npx tsx scripts/derive-players-from-sos-bot.ts --commit     # write
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characters, players, sosBotStaging } from "../src/db/schema";
import { CHAR_CLASSES, CHAR_RACES, UNKNOWN_CLASS_ID, UNKNOWN_RACE_ID } from "../src/lib/eq/enums";

const CLASS_ID_BY_NAME = new Map(CHAR_CLASSES.map((c) => [c.name.toLowerCase(), c.id]));
const RACE_ID_BY_NAME = new Map(CHAR_RACES.map((r) => [r.name.toLowerCase(), r.id]));

function resolveClassId(raw: string | null): number {
  if (!raw) return UNKNOWN_CLASS_ID;
  return CLASS_ID_BY_NAME.get(raw.toLowerCase()) ?? UNKNOWN_CLASS_ID;
}

function resolveRaceId(raw: string | null): number {
  if (!raw) return UNKNOWN_RACE_ID;
  return RACE_ID_BY_NAME.get(raw.toLowerCase()) ?? UNKNOWN_RACE_ID;
}

type StagingRow = typeof sosBotStaging.$inferSelect;
type ExistingCharacter = { id: number; name: string; playerId: number | null };

async function main() {
  const commit = process.argv.includes("--commit");

  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    const staging: StagingRow[] = await db.select().from(sosBotStaging);
    if (staging.length === 0) {
      console.error("sos_bot_staging is empty — run scripts/import-sos-bot-dump.ts first.");
      process.exit(1);
    }

    const existingCharacters: ExistingCharacter[] = await db
      .select({ id: characters.id, name: characters.name, playerId: characters.playerId })
      .from(characters);
    const byNameLower = new Map(existingCharacters.map((c) => [c.name.toLowerCase(), c]));

    const existingPlayers = await db.select({ id: players.id, discordId: players.discordId }).from(players);
    const playerIdByDiscordId = new Map(existingPlayers.filter((p) => p.discordId).map((p) => [p.discordId as string, p.id]));

    // ---------- resolve every staging row to a characters.id, creating new
    // rows for ones with no existing match ----------
    const toCreateCharacters: { row: StagingRow; classId: number; raceId: number }[] = [];
    for (const row of staging) {
      const existing = byNameLower.get(row.charName.toLowerCase());
      if (!existing) {
        toCreateCharacters.push({ row, classId: resolveClassId(row.charClass), raceId: resolveRaceId(row.charRace) });
      }
    }

    // ---------- group staging rows by discord_id ----------
    const groups = new Map<string, StagingRow[]>();
    for (const row of staging) {
      const g = groups.get(row.discordId) ?? [];
      g.push(row);
      groups.set(row.discordId, g);
    }

    const cleanMainGroups: { discordId: string; mainName: string }[] = [];
    const ambiguousGroups: { discordId: string; reason: string; names: string[] }[] = [];
    for (const [discordId, rows] of groups) {
      const mains = rows.filter((r) => r.charType === "main");
      if (mains.length === 1) {
        cleanMainGroups.push({ discordId, mainName: mains[0].charName });
      } else {
        ambiguousGroups.push({
          discordId,
          reason: mains.length === 0 ? "no character flagged main" : `${mains.length} characters flagged main`,
          names: rows.map((r) => r.charName),
        });
      }
    }

    const newPlayersForGroups = [...groups.keys()].filter((d) => !playerIdByDiscordId.has(d));

    // ---------- sheet-only characters (task 3.6): no dump row at all ----------
    const dumpNamesLower = new Set(staging.map((r) => r.charName.toLowerCase()));
    const sheetOnly = existingCharacters.filter((c) => !dumpNamesLower.has(c.name.toLowerCase()) && c.playerId === null);

    // ---------- report ----------
    console.log(`sos_bot_staging: ${staging.length} rows, ${groups.size} distinct discord_id.`);
    console.log(`Existing players already covering a discord_id: ${groups.size - newPlayersForGroups.length}.`);
    console.log(`New players to create for discord_id groups: ${newPlayersForGroups.length}.`);
    console.log(`New standalone players for sheet-only characters: ${sheetOnly.length}.`);
    console.log(`New characters rows to create from the dump: ${toCreateCharacters.length}.`);
    console.log(`Dump rows linking to an existing characters row: ${staging.length - toCreateCharacters.length}.`);
    console.log();
    console.log(`Clean single-main groups: ${cleanMainGroups.length}.`);
    console.log(`Ambiguous groups (main_character_id will be left NULL): ${ambiguousGroups.length}`);
    for (const g of ambiguousGroups) {
      console.log(`  discord_id ${g.discordId} — ${g.reason}: ${g.names.join(", ")}`);
    }
    console.log();
    console.log(`Sheet characters absent from the dump (${sheetOnly.length}):`);
    for (const c of sheetOnly.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  ${c.name}`);
    }

    if (!commit) {
      console.log();
      console.log("Dry run — no writes made. Re-run with --commit to apply.");
      return;
    }

    // ---------- commit: create missing characters rows ----------
    for (const { row, classId, raceId } of toCreateCharacters) {
      const [created] = await db
        .insert(characters)
        .values({
          ownerId: null,
          name: row.charName,
          class: classId,
          race: raceId,
          level: 1,
          charType: (row.charType as "main" | "alt" | "mule" | null) ?? "main",
          charPriority: row.charPriority,
          playerId: null, // set below, once the owning player exists
        })
        .returning({ id: characters.id, name: characters.name });
      byNameLower.set(created.name.toLowerCase(), { id: created.id, name: created.name, playerId: null });
    }

    // ---------- commit: create players for discord_id groups, backfill characters ----------
    for (const [discordId, rows] of groups) {
      let playerId = playerIdByDiscordId.get(discordId);
      if (playerId === undefined) {
        const mains = rows.filter((r) => r.charType === "main");
        const ambiguous = mains.length !== 1;
        // Provisional display name when there's no clean single main: lowest
        // char_priority (ties broken alphabetically), so the player has SOME
        // label rather than none — main_character_id itself still stays
        // NULL below, never guessed.
        const fallback = [...rows].sort((a, b) => (a.charPriority ?? 99) - (b.charPriority ?? 99) || a.charName.localeCompare(b.charName))[0];
        const displayName = mains.length === 1 ? mains[0].charName : fallback.charName;
        const mainCharacter = mains.length === 1 ? byNameLower.get(mains[0].charName.toLowerCase()) : null;

        const [created] = await db
          .insert(players)
          .values({
            discordId,
            userId: null,
            displayName,
            mainCharacterId: mainCharacter?.id ?? null,
            status: "active",
            note: ambiguous ? `Seeded from Toryn's bot dump — ${mains.length === 0 ? "no character flagged main" : `${mains.length} characters flagged main`}; needs leader review.` : null,
          })
          .returning({ id: players.id });
        playerId = created.id;
        playerIdByDiscordId.set(discordId, playerId);
      }

      for (const row of rows) {
        const char = byNameLower.get(row.charName.toLowerCase());
        if (!char) continue; // shouldn't happen — every row was resolved or created above
        if (char.playerId !== null) continue; // don't clobber an existing link
        await db
          .update(characters)
          .set({ playerId, charType: (row.charType as "main" | "alt" | "mule" | null) ?? undefined, charPriority: row.charPriority ?? undefined })
          .where(and(eq(characters.id, char.id), isNull(characters.playerId)));
        char.playerId = playerId;
      }
    }

    // ---------- commit: standalone players for sheet-only characters ----------
    for (const c of sheetOnly) {
      const [created] = await db
        .insert(players)
        .values({
          discordId: null,
          userId: null,
          displayName: c.name,
          mainCharacterId: c.id,
          status: "active",
          note: "Seeded standalone — no discord_id known (absent from Toryn's bot dump). Claimable via character claiming once built (§10).",
        })
        .returning({ id: players.id });
      await db
        .update(characters)
        .set({ playerId: created.id })
        .where(and(eq(characters.id, c.id), isNull(characters.playerId)));
    }

    console.log();
    console.log("Committed.");
  } finally {
    await proxy.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
