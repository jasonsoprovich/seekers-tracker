import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { drizzle } from "drizzle-orm/d1";

import { characterSpells, spellSettings } from "@/db";

type Db = ReturnType<typeof drizzle>;

// Whole table — at most a few hundred rows (one per spell an officer ever
// touched), no IN list.
export async function loadHiddenSpellIds(db: Db): Promise<Set<number>> {
  const rows = await db.select({ spellId: spellSettings.spellId, hidden: spellSettings.hidden }).from(spellSettings);
  return new Set(rows.filter((r) => r.hidden).map((r) => r.spellId));
}

export type CharacterSpellRow = typeof characterSpells.$inferSelect;

export async function loadCharacterSpells(db: Db, characterId: number): Promise<CharacterSpellRow[]> {
  return db.select().from(characterSpells).where(eq(characterSpells.characterId, characterId));
}

// 5 bound params per row (character_id, spell_id, source, updated_by,
// updated_at); 18 rows = 90, under D1's 100-param statement cap.
const INSERT_CHUNK_SIZE = 18;

// Adds spells a character has (Zeal import). Existing rows are left alone —
// a hand-checked spell keeps its "manual" source and original timestamp.
export async function addCharacterSpells(
  db: Db,
  characterId: number,
  spellIds: readonly number[],
  source: "manual" | "zeal",
  userId: string,
): Promise<void> {
  if (spellIds.length === 0) return;
  const now = new Date();
  const stmts: BatchItem<"sqlite">[] = [];
  for (let i = 0; i < spellIds.length; i += INSERT_CHUNK_SIZE) {
    stmts.push(
      db
        .insert(characterSpells)
        .values(
          spellIds.slice(i, i + INSERT_CHUNK_SIZE).map((spellId) => ({ characterId, spellId, source, updatedBy: userId, updatedAt: now })),
        )
        .onConflictDoNothing(),
    );
  }
  await db.batch(stmts as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}
