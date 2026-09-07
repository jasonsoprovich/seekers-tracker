import { and, eq, isNull, ne } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characters, epLedger, gpLedger, playerEpgpTotals, players, users } from "@/db";

// PLAN.md §11 Phase 10 — character claiming rework, built on the `players`
// table Phase 3 introduced. Four entry points:
//   resolvePlayerForUser  — task 10.1, called on every login
//   attachCharacterToPlayer — task 10.2, called from claim approval and
//     from new-character creation (also closes the PLAN.md §16 gap: a
//     site-created character never got player_id set)
//   swapMainCharacter     — task 10.3, leader-only
//   createStandalonePlayer — same job as attachCharacterToPlayer, for a
//     character that has no player at all yet (discord_id-less, same
//     "sheet-only" shape PLAN.md §11 Phase 3 task 3.5 already established)

type Db = ReturnType<typeof drizzle>;

// Resolves the given (already Discord-authenticated) user to their
// `players` row, creating the link — or the row itself — if neither exists
// yet. Idempotent; safe to call on every login.
//
// Three cases, in order:
//  1. A players row already has user_id = this user — nothing to do.
//  2. Toryn's dump (or the sheet-only derivation, PLAN.md §11 Phase 3 tasks
//     3.4/3.5) already seeded a players row for this discord_id, but no
//     site account has ever claimed it (user_id NULL) — link it now. This
//     is the common case for anyone who's been in the guild a while.
//  3. No players row exists for this discord_id at all (a member who
//     joined after the dump, or whose discord_id somehow never made it in)
//     — create one. Every logged-in user needs a players row to eventually
//     attach characters to; there's nothing to "claim" for a brand-new
//     member.
export async function resolvePlayerForUser(
  db: Db,
  user: { id: string; discordId: string | null; username: string | null },
): Promise<number | null> {
  if (!user.discordId) return null; // Non-Discord accounts don't exist in this app; defensive only.

  const [linked] = await db.select({ id: players.id }).from(players).where(eq(players.userId, user.id));
  if (linked) return linked.id;

  const [seeded] = await db
    .select({ id: players.id })
    .from(players)
    .where(and(eq(players.discordId, user.discordId), isNull(players.userId)));
  if (seeded) {
    await db.update(players).set({ userId: user.id, updatedAt: new Date() }).where(eq(players.id, seeded.id));
    return seeded.id;
  }

  const [created] = await db
    .insert(players)
    .values({
      discordId: user.discordId,
      userId: user.id,
      displayName: user.username ?? user.discordId,
      status: "active",
      joinedAt: new Date(),
    })
    .returning({ id: players.id });
  return created.id;
}

// A character being attached to a player can already sit on a *different*
// player. If that old player is a pure import artefact — no site user, no
// discord_id: a standalone created by derive:players / the sheet import /
// createStandalonePlayer — it's the same real person, so absorb it
// wholesale: its characters AND its ledger history move to the target, and
// the defunct row is deleted. Without this, claiming a character that has
// EP history strands that history on the old player_id and the roster
// zeroes out (found 2026-09-06 — the first real claim on production, Osui,
// did exactly this).
//
// If the old player has a user_id or a discord_id it's a real account —
// never merged silently here (a genuine character transfer between two
// people is a leader decision, not a side effect of a claim).
async function absorbStandalonePlayer(db: Db, fromPlayerId: number, toPlayerId: number): Promise<boolean> {
  if (fromPlayerId === toPlayerId) return false;
  const [from] = await db
    .select({ userId: players.userId, discordId: players.discordId })
    .from(players)
    .where(eq(players.id, fromPlayerId));
  if (!from || from.userId !== null || from.discordId !== null) return false;

  const now = new Date();
  await db.update(characters).set({ playerId: toPlayerId, updatedAt: now }).where(eq(characters.playerId, fromPlayerId));
  await db.update(epLedger).set({ playerId: toPlayerId }).where(eq(epLedger.playerId, fromPlayerId));
  await db.update(gpLedger).set({ playerId: toPlayerId }).where(eq(gpLedger.playerId, fromPlayerId));
  await db.delete(playerEpgpTotals).where(eq(playerEpgpTotals.playerId, fromPlayerId));
  await db.delete(players).where(eq(players.id, fromPlayerId));
  return true;
}

export type AttachResult = { error?: string };

// Links a character to a player (PLAN.md §10 "claiming an unassigned
// character attaches it to their player, with type main/alt/mule" — the
// type itself is whatever the character's own char_type already carries
// from import/creation, not re-asked here). If the player doesn't have a
// main yet and this character already is one, bootstrap
// players.main_character_id — the common case of a member's very first
// claimed/created character. A player who already has a main is left
// alone here even if the newly attached character is also charType
// "main" (a genuine conflict, e.g. Toryn's dump had a couple of these,
// PLAN.md §11 Phase 3 task 3.4) — that needs a human decision
// (swapMainCharacter), not a guess.
export async function attachCharacterToPlayer(db: Db, characterId: number, playerId: number): Promise<AttachResult> {
  const [character] = await db
    .select({ id: characters.id, charType: characters.charType, playerId: characters.playerId })
    .from(characters)
    .where(eq(characters.id, characterId));
  if (!character) return { error: "Character not found." };

  // Character already belongs to a defunct standalone player — pull that
  // player's characters + ledger history across before repointing.
  if (character.playerId !== null && character.playerId !== playerId) {
    await absorbStandalonePlayer(db, character.playerId, playerId);
  }

  await db.update(characters).set({ playerId, updatedAt: new Date() }).where(eq(characters.id, characterId));

  if (character.charType === "main") {
    const [player] = await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, playerId));
    if (player && player.mainCharacterId === null) {
      await db.update(players).set({ mainCharacterId: characterId, updatedAt: new Date() }).where(eq(players.id, playerId));
    }
  }

  return {};
}

export type AssignResult = { ok: true; playerId: number | null } | { ok: false; error: string };

// The core of "this character now belongs to this account" — shared by
// claim approval (admin/claims/actions.ts) and the officer/leader "assign a
// character to a member" action (admin/actions.ts). Re-checks the character
// is still unclaimed (a benign check-then-write race if two assignments
// land together, same as acknowledged elsewhere), sets owner_id, resolves
// the user's players row and attaches the character to it — which also
// pulls any stranded ledger history under the one identity (see
// attachCharacterToPlayer / absorbStandalonePlayer). The caller does the
// follow-up refreshStandings({ playerIds: [result.playerId] }); kept out of
// here so this module doesn't take a dependency on the standings layer.
export async function assignCharacterToUser(db: Db, characterId: number, userId: string): Promise<AssignResult> {
  const [character] = await db.select({ ownerId: characters.ownerId }).from(characters).where(eq(characters.id, characterId));
  if (!character) return { ok: false, error: "That character no longer exists." };
  if (character.ownerId !== null) return { ok: false, error: "That character has already been claimed by someone else." };

  await db.update(characters).set({ ownerId: userId, updatedAt: new Date() }).where(eq(characters.id, characterId));

  const [user] = await db
    .select({ id: users.id, discordId: users.discordId, username: users.username })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return { ok: true, playerId: null };

  const playerId = await resolvePlayerForUser(db, user);
  if (playerId) await attachCharacterToPlayer(db, characterId, playerId);
  return { ok: true, playerId: playerId ?? null };
}

export type SwapMainResult = { error?: string };

// PLAN.md §11 Phase 10 task 10.3 — "leader-approved main swap = update
// players.main_character_id, EP/GP untouched." EP/GP is untouched by
// construction: computeEpgpTotals groups by ep_ledger/gp_ledger.player_id
// (Phase 3 task 3.11), which this never writes to — only
// players.main_character_id and, to keep the roster's display grouping
// correct (§4c: "char_type is display metadata kept in sync"), the
// affected characters' char_type/main_character_id.
//
// Caller (src/app/(app)/admin/actions.ts) is responsible for the
// canManageRoles gate — this function only enforces that the target
// character actually belongs to the given player.
export async function swapMainCharacter(
  db: Db,
  playerId: number,
  newMainCharacterId: number,
  approvedBy: string,
): Promise<SwapMainResult> {
  const [target] = await db
    .select({ id: characters.id, playerId: characters.playerId, charType: characters.charType })
    .from(characters)
    .where(eq(characters.id, newMainCharacterId));
  if (!target) return { error: "Character not found." };
  if (target.playerId !== playerId) return { error: "That character doesn't belong to this player." };
  if (target.charType === "mule") return { error: "A mule can't be a player's main character." };

  const now = new Date();

  // Every other non-mule character this player owns becomes an alt of the
  // new main; mules are left untouched (they're never grouped under a
  // main in the roster display regardless — RosterTable only nests
  // charType "alt" rows, PLAN.md §4c).
  await db
    .update(characters)
    .set({ charType: "alt", mainCharacterId: newMainCharacterId, updatedAt: now })
    .where(and(eq(characters.playerId, playerId), ne(characters.id, newMainCharacterId), ne(characters.charType, "mule")));

  await db
    .update(characters)
    .set({ charType: "main", mainCharacterId: null, updatedAt: now })
    .where(eq(characters.id, newMainCharacterId));

  await db
    .update(players)
    .set({ mainCharacterId: newMainCharacterId, mainCharacterChangedBy: approvedBy, mainCharacterChangedAt: now, updatedAt: now })
    .where(eq(players.id, playerId));

  return {};
}

// Same shape PLAN.md §11 Phase 3 task 3.5 used for every sheet-only
// character the sos_bot dump never mentioned: a standalone players row
// (discord_id NULL, main_character_id = the character itself), so a
// brand-new identity — a genuinely new main with no known player, not an
// alt of one — is claimable later (§10) rather than left with player_id
// NULL and invisible to computeEpgpTotals. Two writes, not one, the same
// way that Phase 3 backfill and characters/actions.ts's createCharacter
// are: players.main_character_id can't be set until the character row
// exists to reference, and characters.player_id can't be set until the
// player row exists to reference.
export async function createStandalonePlayer(db: Db, characterId: number, displayName: string): Promise<number> {
  const [player] = await db.insert(players).values({ displayName, status: "active" }).returning({ id: players.id });
  await db.update(players).set({ mainCharacterId: characterId }).where(eq(players.id, player.id));
  await db.update(characters).set({ playerId: player.id, updatedAt: new Date() }).where(eq(characters.id, characterId));
  return player.id;
}
