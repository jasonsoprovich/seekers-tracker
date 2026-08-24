// PLAN.md §11 Phase 10 task 10.4 — "Reconcile against whatever the Discord
// bot has recorded, since both write the same relationships." "The Discord
// bot" here is Toryn's old SOS-Bot, whose dump (sos_bot_staging, loaded by
// scripts/import-sos-bot-dump.ts) is the one other source that ever
// asserted "this character belongs to this discord_id" before this phase's
// login-resolution/claiming/main-swap flow started writing the same kind
// of relationship live (src/lib/players.ts). seekers-bot (Phase 9) is
// read-only and asserts nothing of its own, so there's nothing further to
// reconcile against there.
//
// This is a report, not a hard assertion — read-only, always exits 0. Two
// kinds of divergence from the dump are *expected*, not bugs:
//   - a character the dump never mentioned at all (nothing to check)
//   - a character the dump associated with a discord_id, but the site
//     still has it on a standalone (discord_id-less) player — this is
//     exactly the gap task 10.1/10.2 close: once that real person logs in
//     and claims the character, it moves onto their real player. Listed
//     under "claimable" for visibility, not as an error.
// What's worth a human's attention is a *conflict*: the dump says a
// character belongs to discord_id A, but the site currently has it
// attached to a player whose discord_id is a *different*, non-null B —
// two real accounts asserting the same character identity. That can only
// happen through an explicit claim/attach, so it's worth a look, not
// guessed at here.
//
// Usage:
//   npx tsx scripts/verify-player-reconciliation.ts
import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

import * as schema from "../src/db";
import { characters, players, sosBotStaging } from "../src/db/schema";

async function main() {
  const proxy = await getPlatformProxy({ configPath: "wrangler.jsonc" });
  try {
    const db = drizzle(proxy.env.DATABASE as unknown as Parameters<typeof drizzle>[0], { schema });

    const [staged, allCharacters, allPlayers] = await Promise.all([
      db.select().from(sosBotStaging),
      db.select({ id: characters.id, name: characters.name, playerId: characters.playerId }).from(characters),
      db.select({ id: players.id, discordId: players.discordId }).from(players),
    ]);

    const characterByName = new Map(allCharacters.map((c) => [c.name.toLowerCase(), c]));
    const playerById = new Map(allPlayers.map((p) => [p.id, p]));

    let ok = 0;
    const claimable: { charName: string; stagedDiscordId: string }[] = [];
    const conflicts: { charName: string; stagedDiscordId: string; currentDiscordId: string }[] = [];
    const unmatched: string[] = [];

    for (const row of staged) {
      const character = characterByName.get(row.charName.toLowerCase());
      if (!character) {
        unmatched.push(row.charName);
        continue;
      }
      const currentPlayer = character.playerId !== null ? playerById.get(character.playerId) : undefined;
      const currentDiscordId = currentPlayer?.discordId ?? null;

      if (currentDiscordId === row.discordId) {
        ok++;
      } else if (currentDiscordId === null) {
        claimable.push({ charName: row.charName, stagedDiscordId: row.discordId });
      } else {
        conflicts.push({ charName: row.charName, stagedDiscordId: row.discordId, currentDiscordId });
      }
    }

    console.log(`${staged.length} sos_bot_staging rows checked against current characters/players state.\n`);
    console.log(`  OK (matches the dump's discord_id): ${ok}`);
    console.log(`  Claimable (dump asserted a discord_id, site still has it on a standalone player): ${claimable.length}`);
    console.log(`  Conflicts (dump's discord_id disagrees with a DIFFERENT real discord_id on file): ${conflicts.length}`);
    console.log(`  Unmatched (staged character name has no characters row at all): ${unmatched.length}`);

    if (claimable.length > 0) {
      console.log(`\nClaimable — resolves itself once the right person logs in and claims the character (/characters/claim):`);
      for (const c of claimable.slice(0, 25)) console.log(`  ${c.charName}`);
      if (claimable.length > 25) console.log(`  ... and ${claimable.length - 25} more`);
    }

    if (conflicts.length > 0) {
      console.log(`\nConflicts — needs a human look, not guessed at here:`);
      for (const c of conflicts) console.log(`  ${c.charName}: dump says discord_id ${c.stagedDiscordId}, site currently has ${c.currentDiscordId}`);
    }

    if (unmatched.length > 0) {
      console.log(`\nUnmatched — in the dump, no characters row by that name (should be 0; Phase 3 task 3.4 was meant to create these):`);
      for (const name of unmatched.slice(0, 25)) console.log(`  ${name}`);
      if (unmatched.length > 25) console.log(`  ... and ${unmatched.length - 25} more`);
    }
  } finally {
    await proxy.dispose();
  }
}

main();
