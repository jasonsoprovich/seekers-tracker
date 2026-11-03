// The fixed level 61-65 spell list behind /spells and each character's
// Spells tab. src/data/spells-61-65.json is generated from pq-companion's
// bundled quarm.db by scripts/gen-spells-61-65.sh — regenerate, don't
// hand-edit. Officers can only hide/unhide entries (spell_settings); adding a
// spell means regenerating the file.

import spellsData from "@/data/spells-61-65.json";

export const SPELL_LEVELS = [61, 62, 63, 64, 65] as const;

export interface SpellClassLevel {
  classId: number;
  level: number;
}

export interface Spell {
  spellId: number;
  name: string;
  // Lowest item id whose scrolleffect teaches this spell — feeds ItemLink's
  // PQDI tooltip.
  scrollItemId: number;
  // Every class that gets it in 61-65, with that class's own level (a shared
  // spell like Pacification is CLR 65 but ENC 62).
  classes: SpellClassLevel[];
}

// One spell as seen by a single class: the level is that class's level.
export interface ClassSpell {
  spellId: number;
  name: string;
  level: number;
  scrollItemId: number;
}

export const SPELLS: readonly Spell[] = spellsData as Spell[];

const byId = new Map(SPELLS.map((s) => [s.spellId, s]));
const byName = new Map(SPELLS.map((s) => [s.name.toLowerCase(), s]));

export function getSpell(spellId: number): Spell | undefined {
  return byId.get(spellId);
}

export function getSpellByName(name: string): Spell | undefined {
  return byName.get(name.trim().toLowerCase());
}

const classCache = new Map<number, ClassSpell[]>();

// A class's 61-65 spells, level then name. Empty for WAR/MNK/ROG.
export function spellsForClass(classId: number): ClassSpell[] {
  let list = classCache.get(classId);
  if (!list) {
    list = [];
    for (const s of SPELLS) {
      const c = s.classes.find((k) => k.classId === classId);
      if (c) list.push({ spellId: s.spellId, name: s.name, level: c.level, scrollItemId: s.scrollItemId });
    }
    list.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    classCache.set(classId, list);
  }
  return list;
}

// Class ids (0-based, src/lib/eq/enums.ts) that have any 61-65 spell.
export const SPELL_CLASS_IDS: readonly number[] = [...new Set(SPELLS.flatMap((s) => s.classes.map((c) => c.classId)))].sort(
  (a, b) => a - b,
);

export { parseZealSpellbook, matchSpellbook, type ParsedSpellbook } from "./zeal-spellbook";
