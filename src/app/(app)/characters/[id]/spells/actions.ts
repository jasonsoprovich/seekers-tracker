"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { characterSpells, characters } from "@/db";
import { getDb } from "@/lib/db";
import { canManageCharacter } from "@/lib/permissions";
import { getSession } from "@/lib/session";
import { matchSpellbook, parseZealSpellbook, spellsForClass } from "@/lib/spells";
import { addCharacterSpells, loadCharacterSpells } from "@/lib/spells/db";
import { recordSpellEvent } from "@/lib/system-log/spells";

export type SetSpellResult = { error?: string };

// One checkbox on the Spells tab or one cell in the /spells grid. Only a
// spell on this character's class list can be set.
export async function setCharacterSpell(characterId: number, spellId: number, has: boolean): Promise<SetSpellResult> {
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character) return { error: "Character not found." };
  if (!(await canManageCharacter(character, session.user.id))) {
    return { error: "You don't have permission to edit this character's spells." };
  }
  const spell = spellsForClass(character.class).find((s) => s.spellId === spellId);
  if (!spell) return { error: "That spell isn't on this character's class list." };

  if (has) {
    const now = new Date();
    await db
      .insert(characterSpells)
      .values({ characterId, spellId, source: "manual", updatedBy: session.user.id, updatedAt: now })
      .onConflictDoUpdate({
        target: [characterSpells.characterId, characterSpells.spellId],
        set: { source: "manual", updatedBy: session.user.id, updatedAt: now },
      });
  } else {
    await db.delete(characterSpells).where(and(eq(characterSpells.characterId, characterId), eq(characterSpells.spellId, spellId)));
  }

  await recordSpellEvent(db, session.user.id, character, "spells.toggle", `${spell.name} ${has ? "checked" : "unchecked"}`, {
    spellId,
    has,
  });
  return {};
}

export type SpellbookImportState = {
  error?: string;
  preview?: {
    lineCount: number;
    matched: number;
    toAdd: { spellId: number; name: string; level: number }[];
  };
  added?: number;
};

// Two steps through one form: "preview" shows what a Zeal spellbook export
// would add; "commit" re-parses the same text (never trusts ids from the
// client) and adds them. Add-only — a spell the file doesn't list stays
// checked; removing one is a manual uncheck.
export async function importZealSpellbook(
  characterId: number,
  _prev: SpellbookImportState,
  formData: FormData,
): Promise<SpellbookImportState> {
  const session = await getSession();
  if (!session) redirect("/login");

  const text = String(formData.get("text") ?? "");
  const intent = formData.get("intent") === "commit" ? "commit" : "preview";
  if (!text.trim()) return { error: "Paste your spellbook export or choose the file." };

  const db = await getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!character) return { error: "Character not found." };
  if (!(await canManageCharacter(character, session.user.id))) {
    return { error: "You don't have permission to edit this character's spells." };
  }

  const book = parseZealSpellbook(text);
  if (book.lineCount === 0) {
    return { error: "No spells found — this doesn't look like a Zeal spellbook export (<Name>-Spellbook.txt)." };
  }

  const classSpells = spellsForClass(character.class);
  const matched = matchSpellbook(book, classSpells);
  const have = new Set((await loadCharacterSpells(db, characterId)).map((r) => r.spellId));
  const toAdd = matched.filter((s) => !have.has(s.spellId));

  if (intent === "preview") {
    return {
      preview: {
        lineCount: book.lineCount,
        matched: matched.length,
        toAdd: toAdd.map((s) => ({ spellId: s.spellId, name: s.name, level: s.level })),
      },
    };
  }

  await addCharacterSpells(
    db,
    characterId,
    toAdd.map((s) => s.spellId),
    "zeal",
    session.user.id,
  );
  await recordSpellEvent(db, session.user.id, character, "spells.import", `spellbook import added ${toAdd.length} spell${toAdd.length === 1 ? "" : "s"}`, {
    added: toAdd.map((s) => s.spellId),
    lineCount: book.lineCount,
  });
  revalidatePath(`/characters/${characterId}/spells`);
  return { added: toAdd.length };
}
