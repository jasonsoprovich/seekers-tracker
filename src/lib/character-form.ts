import { eq } from "drizzle-orm";

import { characters } from "@/db";
import { isValidCharClass, isValidCharRace, MAX_CHAR_LEVEL } from "@/lib/eq/enums";

import type { getDb } from "./db";

// Shared by src/app/(app)/characters/actions.ts (createCharacter,
// updateCharacter) and src/app/(app)/characters/[id]/account/actions.ts
// (createCharacterForAccount) — both parse the same CharacterForm submission.
// Deliberately NOT in either "use server" actions file: every export of a
// "use server" file becomes a server-action reference and must itself be an
// async function (Next build error otherwise), which these plain sync
// helpers aren't.

export type ParsedCharacter = {
  name: string;
  class: number;
  race: number;
  level: number;
  charType: "main" | "alt" | "mule";
  mainCharacterId: number | null;
  quarmyUrl: string | null;
};

export function parseCharacterForm(
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
export function isUniqueConstraintError(err: unknown): boolean {
  for (let cause = err; cause instanceof Error; cause = cause.cause) {
    if (/UNIQUE constraint failed/i.test(cause.message)) return true;
  }
  return false;
}

// A submitted mainCharacterId must point at an actual "main"-typed
// character, or the link is silently meaningless (e.g. pointing at another
// alt, or a deleted row). Returns an error string, or undefined if fine.
export async function validateMainCharacterId(
  db: Awaited<ReturnType<typeof getDb>>,
  mainCharacterId: number | null,
): Promise<string | undefined> {
  if (mainCharacterId === null) return undefined;
  const [target] = await db.select({ charType: characters.charType }).from(characters).where(eq(characters.id, mainCharacterId));
  if (!target) return "Selected main character no longer exists.";
  if (target.charType !== "main") return "Selected main character must itself be a main.";
  return undefined;
}
