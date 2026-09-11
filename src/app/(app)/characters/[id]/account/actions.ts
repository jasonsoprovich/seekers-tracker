"use server";

import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";

import { setUserRole } from "@/app/(app)/admin/actions";
import { claimAlt } from "@/app/(app)/characters/actions";
import { characters, players } from "@/db";
import { canManageAnyCharacter, canManageCharacter, canManageRoles, getUserRole, ROLES, type Role } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { refreshStandings } from "@/lib/epgp/standings";
import { attachCharacterToPlayer, createStandalonePlayer } from "@/lib/players";
import { getSession } from "@/lib/session";

// Server actions behind /characters/[id]/account — the one place a
// player's whole group of characters (main + alts + mules) is managed
// (2026-09-10 leader request). Permission tiers, matching the rest of the
// app: the character's owner or any officer+ may re-type alt <-> mule;
// officer+ may link/unlink characters; the account's owner may link an
// UNCLAIMED character to their own account (the LT-31 self-service path,
// delegated to claimAlt); leader/admin only for the main swap and guild
// removal (those live in admin/actions.ts).

export type AccountActionResult = { error?: string };

// alt <-> mule. Never touches the account's main — that's a main swap.
export async function setCharacterType(characterId: number, type: "alt" | "mule"): Promise<AccountActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (type !== "alt" && type !== "mule") return { error: "Invalid type." };

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character) return { error: "Character not found." };
  if (!(await canManageCharacter(character, session.user.id))) {
    return { error: "You don't have permission to change this character." };
  }

  let mainCharacterId: number | null = null;
  if (character.playerId !== null) {
    const [player] = await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, character.playerId));
    if (player?.mainCharacterId === character.id) {
      return { error: "This is the account's main character — a leader has to swap the main before it can be re-typed." };
    }
    if (type === "alt") mainCharacterId = player?.mainCharacterId ?? null;
  }

  await db
    .update(characters)
    .set({ charType: type, mainCharacterId, updatedAt: new Date() })
    .where(eq(characters.id, characterId));
  return {};
}

// Attach an unclaimed (or sheet-only standalone) character to this account.
// EP/GP history on a standalone comes across with it (absorbStandalonePlayer
// inside attachCharacterToPlayer). The account owner linking to their own
// account goes through claimAlt, which already enforces exactly the same
// "unclaimed, not on someone else's real account" rules.
export async function linkCharacterToAccount(playerId: number, characterId: number): Promise<AccountActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!Number.isInteger(characterId) || characterId <= 0 || !Number.isInteger(playerId) || playerId <= 0) {
    return { error: "Invalid character." };
  }

  const db = await getDb();
  const [player] = await db
    .select({ id: players.id, userId: players.userId, mainCharacterId: players.mainCharacterId, status: players.status })
    .from(players)
    .where(eq(players.id, playerId));
  if (!player) return { error: "Account not found." };

  if (player.userId === session.user.id) {
    const result = await claimAlt(characterId);
    return result.error ? { error: result.error } : {};
  }

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) {
    return { error: "Only officers, leaders, and admins can link characters to another member's account." };
  }

  const [target] = await db
    .select({ id: characters.id, ownerId: characters.ownerId, charType: characters.charType, status: characters.status, playerId: characters.playerId })
    .from(characters)
    .where(eq(characters.id, characterId));
  if (!target) return { error: "That character no longer exists." };
  if (target.status === "removed") return { error: "That character has been removed from the roster." };
  if (target.playerId === playerId) return { error: "That character is already on this account." };
  if (target.ownerId !== null && target.ownerId !== player.userId) {
    return { error: "That character is claimed by another member — resolve the ownership first." };
  }
  if (target.playerId !== null) {
    const [tp] = await db
      .select({ userId: players.userId, discordId: players.discordId })
      .from(players)
      .where(eq(players.id, target.playerId));
    if (tp && (tp.userId !== null || tp.discordId !== null)) {
      return { error: "That character is on another member's account — unlink it there first." };
    }
  }

  const attach = await attachCharacterToPlayer(db, characterId, playerId);
  if (attach.error) return { error: attach.error };

  // Display grouping: under an existing main it's an alt (unless it's a
  // mule); with no main yet, attachCharacterToPlayer already bootstrapped
  // it as the main when its own type is "main".
  const [after] = await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, playerId));
  const now = new Date();
  if (after?.mainCharacterId && after.mainCharacterId !== characterId && target.charType !== "mule") {
    await db
      .update(characters)
      .set({ charType: "alt", mainCharacterId: after.mainCharacterId, ownerId: target.ownerId ?? player.userId, updatedAt: now })
      .where(eq(characters.id, characterId));
  } else if (target.ownerId === null && player.userId !== null) {
    await db.update(characters).set({ ownerId: player.userId, updatedAt: now }).where(eq(characters.id, characterId));
  }

  await refreshStandings(db, { playerIds: [playerId] });
  return {};
}

// Detach a non-main character from its account. It becomes its own
// standalone, unclaimed character again (claimable later); its EP/GP rows
// stay with the account they were earned on — EP/GP attaches to the
// account, never the character (PLAN.md §4a).
export async function detachCharacterFromAccount(characterId: number): Promise<AccountActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) {
    return { error: "Only officers, leaders, and admins can unlink a character from an account." };
  }

  const db = await getDb();
  const [character] = await db
    .select({ id: characters.id, name: characters.name, playerId: characters.playerId })
    .from(characters)
    .where(eq(characters.id, characterId));
  if (!character) return { error: "Character not found." };
  if (character.playerId === null) return { error: "That character isn't on an account." };

  const [player] = await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, character.playerId));
  if (player?.mainCharacterId === characterId) {
    return { error: "This is the account's main — swap the main to another character first, then unlink this one." };
  }

  await createStandalonePlayer(db, characterId, character.name);
  await db
    .update(characters)
    .set({ charType: "main", mainCharacterId: null, ownerId: null, updatedAt: new Date() })
    .where(eq(characters.id, characterId));
  return {};
}

// Records disagree (2026-09-10, Tunedup/Nixzard): players.main_character_id
// points at one character while a different one is typed "main". The
// Roster groups by the character rows, the Account tab by the player
// pointer, so the two pages showed different mains. Leader/admin resolves it
// by picking which is right; this sets the pointer and re-types the rest
// as alts of it. No fee, no swap event — it's a data repair, not a swap.
export async function reconcilePlayerMain(playerId: number, characterId: number): Promise<AccountActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");
  const role = await getUserRole(session.user.id);
  if (!canManageRoles(role)) return { error: "Only leaders and admins can repair an account's main." };

  const db = await getDb();
  const [target] = await db
    .select({ id: characters.id, playerId: characters.playerId, charType: characters.charType })
    .from(characters)
    .where(eq(characters.id, characterId));
  if (!target || target.playerId !== playerId) return { error: "That character isn't on this account." };
  if (target.charType === "mule") return { error: "A mule can't be an account's main." };

  const now = new Date();
  await db
    .update(characters)
    .set({ charType: "alt", mainCharacterId: characterId, updatedAt: now })
    .where(and(eq(characters.playerId, playerId), ne(characters.id, characterId), ne(characters.charType, "mule")));
  await db.update(characters).set({ charType: "main", mainCharacterId: null, updatedAt: now }).where(eq(characters.id, characterId));
  await db
    .update(players)
    .set({ mainCharacterId: characterId, mainCharacterChangedBy: session.user.id, mainCharacterChangedAt: now, updatedAt: now })
    .where(eq(players.id, playerId));
  return {};
}

// In-game officer tag per character (characters.officer_tagged). The site
// role is on the account; this only decides whether an alt/mule DISPLAYS
// it on the roster (the account's main always does). Officer+ only —
// it's a roster-display fact about the guild, not a member preference.
export async function setCharacterOfficerTag(characterId: number, tagged: boolean): Promise<AccountActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");
  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) return { error: "Only officers, leaders, and admins can change a character's officer tag." };

  const db = await getDb();
  const [character] = await db.select({ id: characters.id }).from(characters).where(eq(characters.id, characterId));
  if (!character) return { error: "Character not found." };
  await db.update(characters).set({ officerTagged: tagged, updatedAt: new Date() }).where(eq(characters.id, characterId));
  return {};
}

// The account's guild role — settable even when nobody has claimed the
// account yet (2026-09-11: Koramak is an officer who has never logged in).
// With a login attached this is exactly setUserRole (its last-leader guard
// and API-key revocation included; it mirrors to players.role). Without
// one it's just the account row; syncAccountRole applies it to the login
// the day the member signs in and claims.
export async function setPlayerRole(playerId: number, role: string): Promise<AccountActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");
  const acting = await getUserRole(session.user.id);
  if (!canManageRoles(acting)) return { error: "Only leaders and admins can change an account's role." };
  if (!ROLES.includes(role as Role)) return { error: "Invalid role." };

  const db = await getDb();
  const [player] = await db.select({ id: players.id, userId: players.userId }).from(players).where(eq(players.id, playerId));
  if (!player) return { error: "Account not found." };
  if (player.userId !== null) {
    const result = await setUserRole(player.userId, role);
    return result.error ? { error: result.error } : {};
  }
  await db.update(players).set({ role: role as Role, updatedAt: new Date() }).where(eq(players.id, playerId));
  return {};
}
