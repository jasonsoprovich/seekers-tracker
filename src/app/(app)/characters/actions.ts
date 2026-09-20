"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characters, players, users } from "@/db";
import { isUniqueConstraintError, parseCharacterForm, validateMainCharacterId } from "@/lib/character-form";
import { isValidCharacterStatus } from "@/lib/character-status";
import { getDb } from "@/lib/db";
import { settleStandings } from "@/lib/epgp/standings";
import { assignCharacterToUser, attachCharacterToPlayer, resolvePlayerForUser } from "@/lib/players";
import { canManageCharacter, getPermissions } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { recordSystemEvent, webActor } from "@/lib/system-log";

export type CharacterFormState = { error?: string };

export async function createCharacter(
  _prevState: CharacterFormState,
  formData: FormData,
): Promise<CharacterFormState> {
  const session = await getSession();
  if (!session) redirect("/login");

  const parsed = parseCharacterForm(formData);
  if ("error" in parsed) return { error: parsed.error };

  const db = await getDb();
  const mainError = await validateMainCharacterId(db, parsed.data.mainCharacterId);
  if (mainError) return { error: mainError };

  let created: { id: number };
  try {
    [created] = await db
      .insert(characters)
      .values({ ownerId: session.user.id, ...parsed.data })
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
    summary: `${parsed.data.name} created`,
    after: { charType: parsed.data.charType },
  });

  // PLAN.md §11 Phase 10 task 10.2 / §16 gap — a character created straight
  // through this form (not claimed from the pre-seeded roster) previously
  // never got player_id set at all, making it invisible to computeEpgpTotals.
  const [me] = await db.select({ id: users.id, discordId: users.discordId, username: users.username }).from(users).where(eq(users.id, session.user.id));
  if (me) {
    const playerId = await resolvePlayerForUser(db, me);
    if (playerId) await attachCharacterToPlayer(db, created.id, playerId, actor);
  }

  redirect("/characters");
}

export async function updateCharacter(
  characterId: number,
  _prevState: CharacterFormState,
  formData: FormData,
): Promise<CharacterFormState> {
  const session = await getSession();
  if (!session) redirect("/login");

  const parsed = parseCharacterForm(formData, characterId);
  if ("error" in parsed) return { error: parsed.error };

  const db = await getDb();
  const [existing] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!(await canManageCharacter(existing, session.user.id))) {
    return { error: "You don't have permission to edit this character." };
  }

  const mainError = await validateMainCharacterId(db, parsed.data.mainCharacterId);
  if (mainError) return { error: mainError };

  const perms = await getPermissions(session.user.id);
  if (!perms.can("characters.manageAny")) {
    // Self-service alt linking (post-live-test-1 LT-15): a member linking
    // one of their own alts may only point it at a main they also own.
    // Officers ("characters.manageAny") keep the guild-wide picker.
    if (parsed.data.charType === "alt" && parsed.data.mainCharacterId !== null) {
      const [target] = await db
        .select({ ownerId: characters.ownerId })
        .from(characters)
        .where(eq(characters.id, parsed.data.mainCharacterId));
      if (!target || target.ownerId !== session.user.id) {
        return { error: "You can only link an alt to a main character you own." };
      }
    }
  }

  // Which character is an account's MAIN lives in players.main_character_id
  // (the roster, the parser and priority all group by it); characters.
  // char_type is the display copy. This form used to let an officer flip
  // char_type freely, which is how an account ended up with a "main"-typed
  // character that wasn't the player's main (Tunedup/Nixzard, 2026-09-10):
  // the Roster said one thing, the Account tab another. Now the Type field
  // can't create that split — for anyone:
  //  - demoting the account's current main → refused (it's a swap)
  //  - promoting to main while the account already has a different main →
  //    refused (it's a swap, with its fee — the Account tab's "Make main")
  //  - promoting to main on an account with NO main yet → allowed, and the
  //    player pointer is set to match
  const [player] =
    existing.playerId !== null
      ? await db.select({ mainCharacterId: players.mainCharacterId }).from(players).where(eq(players.id, existing.playerId))
      : [undefined];
  const playerMainId = player?.mainCharacterId ?? null;
  let setPlayerMain = false;

  if (existing.id === playerMainId && parsed.data.charType !== "main") {
    return {
      error: perms.can("characters.manageAny")
        ? "This is the account's main — use “Make main” on the Account tab to swap it to another character first."
        : "Only an officer or leader can change which character is your main — ask a leader to swap it.",
    };
  }
  if (parsed.data.charType === "main" && existing.id !== playerMainId) {
    if (playerMainId !== null) {
      return {
        error: perms.can("characters.manageAny")
          ? "This account already has a main — use “Make main” on the Account tab to swap (500 GP, waivable)."
          : "Only an officer or leader can promote a character to main.",
      };
    }
    if (existing.playerId !== null) setPlayerMain = true;
  }

  const status = String(formData.get("status") ?? "");
  if (!isValidCharacterStatus(status)) return { error: "Invalid status." };

  try {
    await db
      .update(characters)
      .set({ ...parsed.data, status, updatedAt: new Date() })
      .where(eq(characters.id, characterId));
    if (setPlayerMain && existing.playerId !== null) {
      await db
        .update(players)
        .set({ mainCharacterId: existing.id, mainCharacterChangedBy: session.user.id, mainCharacterChangedAt: new Date(), updatedAt: new Date() })
        .where(eq(players.id, existing.playerId));
    }
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { error: "A character with that name already exists. If it's yours, claim it from /characters/claim instead." };
    }
    throw err;
  }

  const actor = await webActor(db, session.user.id);
  await recordSystemEvent(db, actor, {
    action: "characters.update",
    targetType: "character",
    targetId: characterId,
    targetLabel: parsed.data.name,
    summary: `${parsed.data.name} edited`,
    before: { name: existing.name, class: existing.class, race: existing.race, level: existing.level, charType: existing.charType, status: existing.status },
    after: { ...parsed.data, status },
  });

  redirect("/characters");
}

export type ClaimAltState = { error?: string };

// post-live-test-1 LT-31 — self-service "link an alt to my main" from the
// Your Characters page. Instantly attaches an UNCLAIMED roster character
// (owner_id NULL) to the caller's account as an alt of their existing main
// — no officer approval, same call chain as claim approval
// (assignCharacterToUser → attachCharacterToPlayer, which also absorbs a
// sheet-only standalone player and carries its stranded EP/GP history over,
// see src/lib/players.ts). Anything contested (owned by someone else, or a
// real account's main) is refused here and pointed at /characters/claim,
// which keeps the LT-14 officer request/approve flow.
export async function claimAlt(characterId: number): Promise<ClaimAltState> {
  const session = await getSession();
  if (!session) redirect("/login");

  if (!Number.isInteger(characterId) || characterId <= 0) return { error: "Invalid character." };

  const db = await getDb();

  const [me] = await db
    .select({ id: users.id, discordId: users.discordId, username: users.username })
    .from(users)
    .where(eq(users.id, session.user.id));
  if (!me) return { error: "Account not found." };

  const callerPlayerId = await resolvePlayerForUser(db, me);
  if (callerPlayerId === null) return { error: "Account not found." };
  const [callerPlayer] = await db
    .select({ mainCharacterId: players.mainCharacterId })
    .from(players)
    .where(eq(players.id, callerPlayerId));
  const mainId = callerPlayer?.mainCharacterId ?? null;
  if (mainId === null) {
    return { error: "Set your main character first — then you can link alts to it here." };
  }
  if (characterId === mainId) return { error: "That character is already your main." };

  const [target] = await db
    .select({
      id: characters.id,
      name: characters.name,
      ownerId: characters.ownerId,
      charType: characters.charType,
      status: characters.status,
      playerId: characters.playerId,
    })
    .from(characters)
    .where(eq(characters.id, characterId));
  if (!target) return { error: "That character no longer exists." };
  if (target.status === "removed") return { error: "That character has been removed from the roster." };

  if (target.ownerId !== null && target.ownerId !== session.user.id) {
    return { error: "That character belongs to another member — use “Claim a Character” to request it." };
  }

  // Set owner + player (absorbing any sheet-only standalone player and its
  // ledger history) unless the caller already owns it. A character sitting
  // on a DIFFERENT real identity's player (has a user_id or a discord_id)
  // is refused here by attachCharacterToPlayer's own centralized check
  // (Remediation plan Phase 5 task 5.6) — no need to duplicate that lookup.
  const actor = await webActor(db, session.user.id);
  if (target.ownerId === null) {
    const assigned = await assignCharacterToUser(db, characterId, session.user.id, actor);
    if (!assigned.ok) return { error: assigned.error };
  } else {
    const attached = await attachCharacterToPlayer(db, characterId, callerPlayerId, actor);
    if (attached.error) return { error: attached.error };
  }

  // Type it as an alt of the caller's main. (assignCharacterToUser only
  // bootstraps a main when the player has none — here they already have one.)
  await db
    .update(characters)
    .set({ charType: "alt", mainCharacterId: mainId, updatedAt: new Date() })
    .where(eq(characters.id, characterId));

  await settleStandings(db, { playerIds: [callerPlayerId] });
  return {};
}
