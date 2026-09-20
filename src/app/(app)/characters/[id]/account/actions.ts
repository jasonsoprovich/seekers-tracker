"use server";

import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";

import { setUserRole } from "@/app/(app)/admin/actions";
import { claimAlt, type CharacterFormState } from "@/app/(app)/characters/actions";
import { characters, players } from "@/db";
import { getRealUserRole, ROLES, roleRank, type Role } from "@/lib/authz";
import { isUniqueConstraintError, parseCharacterForm } from "@/lib/character-form";
import { getDb } from "@/lib/db";
import { settleStandings } from "@/lib/epgp/standings";
import { attachCharacterToPlayer, createStandalonePlayer } from "@/lib/players";
import { canManageCharacter, getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { recordSystemEvent, webActor } from "@/lib/system-log";

// Server actions behind /characters/[id]/account — the one place a
// player's whole group of characters (main + alts + mules) is managed
// (2026-09-10 leader request). Permission tiers are matrix-tunable
// (src/lib/permissions) — defaults match the pre-registry behavior: the
// character's owner or any officer+ may re-type alt <-> mule
// ("characters.manageAny", checked via canManageCharacter); officer+ may
// link/unlink characters ("characters.link"); the account's owner may link
// an UNCLAIMED character to their own account (the LT-31 self-service path,
// delegated to claimAlt); leader/admin only by default for the main swap
// ("members.main.swap") and guild removal (those live in admin/actions.ts).

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
  const actor = await webActor(db, session.user.id);
  await recordSystemEvent(db, actor, {
    action: "characters.retype",
    targetType: "character",
    targetId: characterId,
    targetLabel: character.name,
    summary: `${character.name} retyped ${character.charType} → ${type}`,
    before: { charType: character.charType },
    after: { charType: type },
  });
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

  const perms = await getPermissions(session.user.id);
  if (!perms.can("characters.link")) {
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

  // A character on a DIFFERENT real identity's account (has a user_id or a
  // discord_id) is refused by attachCharacterToPlayer's own centralized
  // check (Remediation plan Phase 5 task 5.6) — no need to duplicate that
  // lookup here.
  const attach = await attachCharacterToPlayer(db, characterId, playerId, await webActor(db, session.user.id));
  if (attach.error) return { error: attach.error };

  // Display grouping: under an existing main it's an alt (unless it's a
  // mule); with no main yet, attachCharacterToPlayer already bootstrapped
  // it as the main when its own type is "main". owner_id needs no separate
  // write here — attachCharacterToPlayer's syncCharacterOwnership already
  // set it for the whole group, this character included (task 5.1/5.4).
  const [after] = await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, playerId));
  if (after?.mainCharacterId && after.mainCharacterId !== characterId && target.charType !== "mule") {
    await db
      .update(characters)
      .set({ charType: "alt", mainCharacterId: after.mainCharacterId, updatedAt: new Date() })
      .where(eq(characters.id, characterId));
  }

  await settleStandings(db, { playerIds: [playerId] });
  return {};
}

// Create a brand-new alt or mule directly on this account — for when the
// character has never appeared on the roster at all (no import row, no
// prior claim), unlike linkCharacterToAccount above, which only attaches an
// EXISTING unclaimed character. "characters.create.forOther" (2026-09-19
// guild leader request: an easy way for admin/officer/leader to add a new
// alt and link it to an account in one step). Deliberately refuses
// charType "main" — promoting a character to main is the 500 GP
// swapMainCharacter path (admin/actions.ts), not a create; this only grows
// an existing account's alt/mule roster. The account's owner may always add
// to their own account, same self-service carve-out linkCharacterToAccount
// gives claimAlt.
export async function createCharacterForAccount(
  playerId: number,
  _prevState: CharacterFormState,
  formData: FormData,
): Promise<CharacterFormState> {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [player] = await db
    .select({ id: players.id, userId: players.userId, mainCharacterId: players.mainCharacterId })
    .from(players)
    .where(eq(players.id, playerId));
  if (!player) return { error: "Account not found." };

  if (player.userId !== session.user.id) {
    const perms = await getPermissions(session.user.id);
    if (!perms.can("characters.create.forOther")) {
      return { error: "Only officers, leaders, and admins can add a character to another member's account." };
    }
  }

  const parsed = parseCharacterForm(formData);
  if ("error" in parsed) return { error: parsed.error };
  if (parsed.data.charType === "main") {
    return {
      error:
        "This adds an alt or mule to an existing account. To make a character the account's main, use “Make main” instead; a brand-new account starts from Your Characters → Add Character.",
    };
  }

  // The main link is this account's own main, never the client-submitted
  // value — mirrors linkCharacterToAccount's own "display grouping" comment
  // above. A mule is never nested under a main (schema.ts); an alt on an
  // account with no main yet is left with mainCharacterId null, same
  // tolerance linkCharacterToAccount already has.
  const mainCharacterId = parsed.data.charType === "alt" ? player.mainCharacterId : null;
  // Mirrors the bot's display-order convention (schema.ts's charPriority
  // comment): main 0, alt 1, mule 2.
  const charPriority = parsed.data.charType === "alt" ? 1 : 2;

  let created: { id: number };
  try {
    [created] = await db
      .insert(characters)
      .values({
        ownerId: player.userId,
        playerId,
        charType: parsed.data.charType,
        mainCharacterId,
        charPriority,
        name: parsed.data.name,
        class: parsed.data.class,
        race: parsed.data.race,
        level: parsed.data.level,
        quarmyUrl: parsed.data.quarmyUrl,
      })
      .returning({ id: characters.id });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { error: "A character with that name already exists. If it's yours, claim it from /characters/claim instead." };
    }
    throw err;
  }

  const actor = await webActor(db, session.user.id);
  await recordSystemEvent(db, actor, {
    action: "characters.create",
    targetType: "character",
    targetId: created.id,
    targetLabel: parsed.data.name,
    summary: `${parsed.data.name} created as a new ${parsed.data.charType} on player #${playerId}`,
    after: { charType: parsed.data.charType, playerId },
  });

  // Belt-and-suspenders: the insert above already set playerId/ownerId
  // directly, but routing through attachCharacterToPlayer keeps this on the
  // same centralized path every other attach goes through (real-identity
  // refusal, ownership sync) rather than duplicating that logic here — a
  // no-op in the normal case since the character already points at this
  // player.
  const attach = await attachCharacterToPlayer(db, created.id, playerId, actor);
  if (attach.error) return { error: attach.error };

  redirect(`/characters/${created.id}/account`);
}

// Detach a non-main character from its account. It becomes its own
// standalone, unclaimed character again (claimable later); its EP/GP rows
// stay with the account they were earned on — EP/GP attaches to the
// account, never the character (PLAN.md §4a).
export async function detachCharacterFromAccount(characterId: number): Promise<AccountActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const perms = await getPermissions(session.user.id);
  if (!perms.can("characters.link")) {
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

  const actor = await webActor(db, session.user.id);
  const prevPlayerId = character.playerId;
  await createStandalonePlayer(db, characterId, character.name, actor);
  await db
    .update(characters)
    .set({ charType: "main", mainCharacterId: null, ownerId: null, updatedAt: new Date() })
    .where(eq(characters.id, characterId));
  await recordSystemEvent(db, actor, {
    action: "characters.detach",
    targetType: "character",
    targetId: characterId,
    targetLabel: character.name,
    summary: `${character.name} detached from player #${prevPlayerId} (now standalone)`,
    before: { playerId: prevPlayerId },
  });
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
  const perms = await getPermissions(session.user.id);
  if (!perms.can("members.main.swap")) return { error: "Only leaders and admins can repair an account's main." };

  const db = await getDb();
  const [target] = await db
    .select({ id: characters.id, playerId: characters.playerId, charType: characters.charType })
    .from(characters)
    .where(eq(characters.id, characterId));
  if (!target || target.playerId !== playerId) return { error: "That character isn't on this account." };
  if (target.charType === "mule") return { error: "A mule can't be an account's main." };

  const [beforePlayer] = await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, playerId));

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

  const actor = await webActor(db, session.user.id);
  await recordSystemEvent(db, actor, {
    action: "members.main.swap",
    targetType: "player",
    targetId: playerId,
    summary: `Player #${playerId}'s main pointer reconciled to character #${characterId} (data repair, no fee)`,
    before: { mainCharacterId: beforePlayer?.mainCharacterId ?? null },
    after: { mainCharacterId: characterId },
  });
  return {};
}

// In-game officer tag per character (characters.officer_tagged). The site
// role is on the account; this only decides whether an alt/mule DISPLAYS
// it on the roster (the account's main always does). Officer+ only —
// it's a roster-display fact about the guild, not a member preference.
export async function setCharacterOfficerTag(characterId: number, tagged: boolean): Promise<AccountActionResult> {
  const session = await getSession();
  if (!session) redirect("/login");
  const perms = await getPermissions(session.user.id);
  if (!perms.can("characters.officerTag")) return { error: "Only officers, leaders, and admins can change a character's officer tag." };

  const db = await getDb();
  const [character] = await db.select({ id: characters.id, name: characters.name, officerTagged: characters.officerTagged }).from(characters).where(eq(characters.id, characterId));
  if (!character) return { error: "Character not found." };
  await db.update(characters).set({ officerTagged: tagged, updatedAt: new Date() }).where(eq(characters.id, characterId));
  const actor = await webActor(db, session.user.id);
  await recordSystemEvent(db, actor, {
    action: "characters.officerTag",
    targetType: "character",
    targetId: characterId,
    targetLabel: character.name,
    summary: `${character.name}'s officer tag ${tagged ? "enabled" : "disabled"}`,
    before: { officerTagged: character.officerTagged },
    after: { officerTagged: tagged },
  });
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
  const perms = await getPermissions(session.user.id);
  if (!perms.can("members.role.manage")) return { error: "Only leaders and admins can change an account's role." };
  if (!ROLES.includes(role as Role)) return { error: "Invalid role." };

  const db = await getDb();
  const [player] = await db.select({ id: players.id, userId: players.userId, role: players.role, displayName: players.displayName }).from(players).where(eq(players.id, playerId));
  if (!player) return { error: "Account not found." };
  if (player.userId !== null) {
    const result = await setUserRole(player.userId, role);
    return result.error ? { error: result.error } : {};
  }

  // Same rank ceiling as setUserRole (admin/actions.ts) for the linked-login
  // branch above — an unclaimed account has no login to route through, so
  // it's enforced directly here instead.
  const actingReal = await getRealUserRole(session.user.id);
  if (roleRank(role as Role) > roleRank(actingReal)) {
    return { error: "You can't grant a role above your own." };
  }

  await db.update(players).set({ role: role as Role, updatedAt: new Date() }).where(eq(players.id, playerId));
  const actor = await webActor(db, session.user.id);
  await recordSystemEvent(db, actor, {
    action: "roles.player.change",
    targetType: "player",
    targetId: playerId,
    targetLabel: player.displayName,
    summary: `${player.displayName ?? `Player #${playerId}`}'s account role changed ${player.role} → ${role} (unclaimed account)`,
    before: { role: player.role },
    after: { role },
  });
  return {};
}
