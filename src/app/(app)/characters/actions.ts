"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characters, players, users } from "@/db";
import { canManageAnyCharacter, canManageCharacter, getUserRole } from "@/lib/authz";
import { isValidCharacterStatus } from "@/lib/character-status";
import { getDb } from "@/lib/db";
import { refreshStandings } from "@/lib/epgp/standings";
import { isValidCharClass, isValidCharRace, MAX_CHAR_LEVEL } from "@/lib/eq/enums";
import { assignCharacterToUser, attachCharacterToPlayer, resolvePlayerForUser } from "@/lib/players";
import { getSession } from "@/lib/session";

export type CharacterFormState = { error?: string };

type ParsedCharacter = {
  name: string;
  class: number;
  race: number;
  level: number;
  charType: "main" | "alt" | "mule";
  mainCharacterId: number | null;
  quarmyUrl: string | null;
};

function parseCharacterForm(
  formData: FormData,
  selfId?: number,
): { data: ParsedCharacter } | { error: string } {
  const name = String(formData.get("name") ?? "").trim();
  const charClass = Number(formData.get("class"));
  const race = Number(formData.get("race"));
  const level = Number(formData.get("level"));
  const charType = String(formData.get("charType") ?? "main");
  const mainCharacterIdRaw = String(formData.get("mainCharacterId") ?? "").trim();
  const quarmyUrlRaw = String(formData.get("quarmyUrl") ?? "").trim();

  if (!name) return { error: "Name is required." };
  if (name.length > 64) return { error: "Name must be 64 characters or fewer." };
  if (!isValidCharClass(charClass)) return { error: "Invalid class." };
  if (!isValidCharRace(race)) return { error: "Invalid race." };
  if (!Number.isInteger(level) || level < 1 || level > MAX_CHAR_LEVEL) {
    return { error: `Level must be between 1 and ${MAX_CHAR_LEVEL}.` };
  }
  if (charType !== "main" && charType !== "alt" && charType !== "mule") return { error: "Invalid character type." };

  // Only alts carry a main-character link — a main or mule silently drops
  // any stale link rather than erroring.
  let mainCharacterId: number | null = null;
  if (charType === "alt" && mainCharacterIdRaw) {
    mainCharacterId = Number(mainCharacterIdRaw);
    if (!Number.isInteger(mainCharacterId) || mainCharacterId <= 0) {
      return { error: "Invalid main character selection." };
    }
    if (selfId !== undefined && mainCharacterId === selfId) {
      return { error: "A character can't be its own main." };
    }
  }

  let quarmyUrl: string | null = null;
  if (quarmyUrlRaw) {
    if (quarmyUrlRaw.length > 300) return { error: "Quarmy profile URL is too long." };
    try {
      const parsed = new URL(quarmyUrlRaw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
      quarmyUrl = parsed.toString();
    } catch {
      return { error: "Quarmy profile URL must be a valid http(s) link." };
    }
  }

  return { data: { name, class: charClass, race, level, charType, mainCharacterId, quarmyUrl } };
}

// Drizzle's D1 driver wraps the underlying SQLite error in
// DrizzleQueryError.cause rather than surfacing it as a typed exception or
// on .message directly, so walk the cause chain matching on message text.
function isUniqueConstraintError(err: unknown): boolean {
  for (let cause = err; cause instanceof Error; cause = cause.cause) {
    if (/UNIQUE constraint failed/i.test(cause.message)) return true;
  }
  return false;
}

// A submitted mainCharacterId must point at an actual "main"-typed
// character, or the link is silently meaningless (e.g. pointing at another
// alt, or a deleted row). Returns an error string, or undefined if fine.
async function validateMainCharacterId(
  db: Awaited<ReturnType<typeof getDb>>,
  mainCharacterId: number | null,
): Promise<string | undefined> {
  if (mainCharacterId === null) return undefined;
  const [target] = await db.select({ charType: characters.charType }).from(characters).where(eq(characters.id, mainCharacterId));
  if (!target) return "Selected main character no longer exists.";
  if (target.charType !== "main") return "Selected main character must itself be a main.";
  return undefined;
}

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

  // PLAN.md §11 Phase 10 task 10.2 / §16 gap — a character created straight
  // through this form (not claimed from the pre-seeded roster) previously
  // never got player_id set at all, making it invisible to computeEpgpTotals.
  const [me] = await db.select({ id: users.id, discordId: users.discordId, username: users.username }).from(users).where(eq(users.id, session.user.id));
  if (me) {
    const playerId = await resolvePlayerForUser(db, me);
    if (playerId) await attachCharacterToPlayer(db, created.id, playerId);
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

  const role = await getUserRole(session.user.id);
  if (!canManageAnyCharacter(role)) {
    // Self-service alt linking (post-live-test-1 LT-15): a member linking
    // one of their own alts may only point it at a main they also own.
    // Officers (canManageAnyCharacter) keep the guild-wide picker.
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
      error: canManageAnyCharacter(role)
        ? "This is the account's main — use “Make main” on the Account tab to swap it to another character first."
        : "Only an officer or leader can change which character is your main — ask a leader to swap it.",
    };
  }
  if (parsed.data.charType === "main" && existing.id !== playerMainId) {
    if (playerMainId !== null) {
      return {
        error: canManageAnyCharacter(role)
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

  // A character sitting on a real account's players row (has a user_id or a
  // discord_id) that isn't the caller's is a genuine identity — an officer
  // moves that, not a one-click self-serve. (assignCharacterToUser's
  // absorbStandalonePlayer would refuse it anyway; catch it here with a
  // clearer message.)
  if (target.playerId !== null && target.playerId !== callerPlayerId) {
    const [tp] = await db
      .select({ userId: players.userId, discordId: players.discordId })
      .from(players)
      .where(eq(players.id, target.playerId));
    if (tp && (tp.userId !== null || tp.discordId !== null)) {
      return { error: "That character is linked to another member's account — an officer needs to move it." };
    }
  }

  // Set owner + player (absorbing any sheet-only standalone player and its
  // ledger history) unless the caller already owns it.
  if (target.ownerId === null) {
    const assigned = await assignCharacterToUser(db, characterId, session.user.id);
    if (!assigned.ok) return { error: assigned.error };
  } else {
    await attachCharacterToPlayer(db, characterId, callerPlayerId);
  }

  // Type it as an alt of the caller's main. (assignCharacterToUser only
  // bootstraps a main when the player has none — here they already have one.)
  await db
    .update(characters)
    .set({ charType: "alt", mainCharacterId: mainId, updatedAt: new Date() })
    .where(eq(characters.id, characterId));

  await refreshStandings(db, { playerIds: [callerPlayerId] });
  return {};
}
