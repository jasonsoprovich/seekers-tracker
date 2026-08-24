// Read-side queries for PLAN.md §11 Phase 11 (quest flags) — backs the
// /keys page. Three independent shapes, matching the three real sheet
// tabs the data comes from (scripts/import-quest-flags.ts):
//  - character_key_flags: per-character EmpVT/ST attunement, grouped here
//    into one row per character (only characters with at least one flag —
//    unlike Progression's every-character table, EmpVT/ST are opt-in
//    content most of the roster has never touched, so an all-783-rows
//    table would be almost entirely empty).
//  - sky_bank_rewards / sky_bank_stock: guild-wide catalogs, no character
//    grouping — listed as-is.
import { asc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

import { characterKeyFlags, characters, skyBankRewards, skyBankStock } from "@/db";
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

export type SkyBankRewardRow = {
  itemName: string;
  qty: number;
  questName: string;
  classRestriction: string | null;
  item2Status: string | null;
  item3Status: string | null;
  item4Status: string | null;
  officerHolding: string | null;
};

export async function listSkyBankRewards(db: Db): Promise<SkyBankRewardRow[]> {
  return db.select().from(skyBankRewards).orderBy(asc(skyBankRewards.questName), asc(skyBankRewards.itemName));
}

export type SkyBankStockRow = { itemName: string; qty: number };

export async function listSkyBankStock(db: Db): Promise<SkyBankStockRow[]> {
  return db
    .select({ itemName: skyBankStock.itemName, qty: skyBankStock.qty })
    .from(skyBankStock)
    .orderBy(asc(skyBankStock.itemName));
}
