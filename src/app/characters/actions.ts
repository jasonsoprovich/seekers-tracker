"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { characters } from "@/db";
import { canManageAnyCharacter, getUserRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { isValidCharClass, isValidCharRace, MAX_CHAR_LEVEL } from "@/lib/eq/enums";
import { getSession } from "@/lib/session";

export type CharacterFormState = { error?: string };

type ParsedCharacter = {
  name: string;
  class: number;
  race: number;
  level: number;
  charType: "main" | "alt";
};

function parseCharacterForm(formData: FormData): { data: ParsedCharacter } | { error: string } {
  const name = String(formData.get("name") ?? "").trim();
  const charClass = Number(formData.get("class"));
  const race = Number(formData.get("race"));
  const level = Number(formData.get("level"));
  const charType = String(formData.get("charType") ?? "main");

  if (!name) return { error: "Name is required." };
  if (name.length > 64) return { error: "Name must be 64 characters or fewer." };
  if (!isValidCharClass(charClass)) return { error: "Invalid class." };
  if (!isValidCharRace(race)) return { error: "Invalid race." };
  if (!Number.isInteger(level) || level < 1 || level > MAX_CHAR_LEVEL) {
    return { error: `Level must be between 1 and ${MAX_CHAR_LEVEL}.` };
  }
  if (charType !== "main" && charType !== "alt") return { error: "Invalid character type." };

  return { data: { name, class: charClass, race, level, charType } };
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

export async function createCharacter(
  _prevState: CharacterFormState,
  formData: FormData,
): Promise<CharacterFormState> {
  const session = await getSession();
  if (!session) redirect("/login");

  const parsed = parseCharacterForm(formData);
  if ("error" in parsed) return { error: parsed.error };

  const db = await getDb();
  try {
    await db.insert(characters).values({ ownerId: session.user.id, ...parsed.data });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { error: "A character with that name already exists." };
    }
    throw err;
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

  const parsed = parseCharacterForm(formData);
  if ("error" in parsed) return { error: parsed.error };

  const db = await getDb();
  const [existing] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!existing) {
    return { error: "You don't have permission to edit this character." };
  }
  if (existing.ownerId !== session.user.id) {
    const role = await getUserRole(session.user.id);
    if (!canManageAnyCharacter(role)) {
      return { error: "You don't have permission to edit this character." };
    }
  }

  try {
    await db
      .update(characters)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(characters.id, characterId));
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { error: "A character with that name already exists." };
    }
    throw err;
  }

  redirect("/characters");
}
