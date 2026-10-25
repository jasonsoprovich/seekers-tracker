// Read-side queries for PLAN.md §11 Phase 11 (quest flags) — backs the
// /keys page, from the sheet's key tabs (scripts/import-quest-flags.ts):
//  - character_key_flags: per-character EmpVT/ST attunement, grouped here
//    into one row per character (only characters with at least one flag —
//    unlike Progression's every-character table, EmpVT/ST are opt-in
//    content most of the roster has never touched, so an all-783-rows
//    table would be almost entirely empty).
import { asc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characterKeyFlags, characters } from "@/db";
import { charClassLabel } from "@/lib/eq/enums";

type Db = ReturnType<typeof drizzle>;

export type CharacterKeyFlagRow = {
  characterId: number;
  name: string;
  className: string;
  charType: "main" | "alt" | "mule";
  empKeyDone: boolean;
  vtKeyDone: boolean;
  empVtLoggedBy: string | null;
  stKeys: { label: string; done: boolean; loggedBy: string | null }[];
};

export async function listCharacterKeyFlags(db: Db): Promise<CharacterKeyFlagRow[]> {
  const rows = await db
    .select({
      characterId: characterKeyFlags.characterId,
      name: characters.name,
      classId: characters.class,
      charType: characters.charType,
      category: characterKeyFlags.category,
      flagKey: characterKeyFlags.flagKey,
      label: characterKeyFlags.label,
      done: characterKeyFlags.done,
      loggedBy: characterKeyFlags.loggedBy,
    })
    .from(characterKeyFlags)
    .innerJoin(characters, eq(characterKeyFlags.characterId, characters.id))
    .orderBy(asc(characters.name));

  const byCharacter = new Map<number, CharacterKeyFlagRow>();
  for (const r of rows) {
    let entry = byCharacter.get(r.characterId);
    if (!entry) {
      entry = {
        characterId: r.characterId,
        name: r.name,
        className: charClassLabel(r.classId),
        charType: r.charType,
        empKeyDone: false,
        vtKeyDone: false,
        empVtLoggedBy: null,
        stKeys: [],
      };
      byCharacter.set(r.characterId, entry);
    }
    if (r.category === "empvt") {
      if (r.flagKey === "empvt_emp") entry.empKeyDone = r.done;
      if (r.flagKey === "empvt_vt") entry.vtKeyDone = r.done;
      entry.empVtLoggedBy = r.loggedBy;
    } else {
      entry.stKeys.push({ label: r.label, done: r.done, loggedBy: r.loggedBy });
    }
  }
  return [...byCharacter.values()];
}
