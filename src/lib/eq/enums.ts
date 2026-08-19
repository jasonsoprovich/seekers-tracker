// Ported from pq-companion's char_class.go / char_race.go (0-based class
// index used by the spell-table API + character-creation dropdowns; raw EQ
// PC race id, not the compact 1-14 RaceIndex — see schema.ts comments and
// docs/guild-website-feasibility.md §4/§5).

// id 99 is a sentinel for "unknown" — not a real Quarm class id. Used by
// scripts/import-epgp.ts for characters that only ever appear in the sheet's
// GP Log (no Totals row to read a real class from).
export const UNKNOWN_CLASS_ID = 99;

export const CHAR_CLASSES = [
  { id: 0, abbr: "WAR", name: "Warrior" },
  { id: 1, abbr: "CLR", name: "Cleric" },
  { id: 2, abbr: "PAL", name: "Paladin" },
  { id: 3, abbr: "RNG", name: "Ranger" },
  { id: 4, abbr: "SHD", name: "Shadow Knight" },
  { id: 5, abbr: "DRU", name: "Druid" },
  { id: 6, abbr: "MNK", name: "Monk" },
  { id: 7, abbr: "BRD", name: "Bard" },
  { id: 8, abbr: "ROG", name: "Rogue" },
  { id: 9, abbr: "SHM", name: "Shaman" },
  { id: 10, abbr: "NEC", name: "Necromancer" },
  { id: 11, abbr: "WIZ", name: "Wizard" },
  { id: 12, abbr: "MAG", name: "Magician" },
  { id: 13, abbr: "ENC", name: "Enchanter" },
  { id: 14, abbr: "BST", name: "Beastlord" },
  { id: UNKNOWN_CLASS_ID, abbr: "UNK", name: "Unknown" },
] as const;

// Per-class hues, ported verbatim from pq-companion's DEFAULT_DPS_CLASS_COLORS
// (frontend/src/types/config.ts) — the WoW-style palette it uses everywhere
// class identity shows up (DPS meter, player tracker). Keyed by the same
// 0-indexed class id as CHAR_CLASSES so a class reads as the same color in
// both apps.
export const CLASS_COLORS: Record<number, string> = {
  0: "#C79C6E", // Warrior
  1: "#FFFFFF", // Cleric
  2: "#F58CBA", // Paladin
  3: "#ABD473", // Ranger
  4: "#C41F3B", // Shadow Knight
  5: "#FF7D0A", // Druid
  6: "#00FF96", // Monk
  7: "#8A47E8", // Bard
  8: "#FFF569", // Rogue
  9: "#0070DE", // Shaman
  10: "#9482C9", // Necromancer
  11: "#40ED57", // Wizard
  12: "#69CCF0", // Magician
  13: "#ED5CE5", // Enchanter
  14: "#03B78A", // Beastlord
};

export function classColor(id: number): string {
  return CLASS_COLORS[id] ?? "#B2B2B2";
}

// id 0 is a sentinel for "unknown" — not a real EQ race id (those start at
// 1). The sheet's EPGP tabs never recorded race, so scripts/import-epgp.ts
// has no source data to fill this column with for imported characters.
export const UNKNOWN_RACE_ID = 0;

export const CHAR_RACES = [
  { id: UNKNOWN_RACE_ID, name: "Unknown" },
  { id: 1, name: "Human" },
  { id: 2, name: "Barbarian" },
  { id: 3, name: "Erudite" },
  { id: 4, name: "Wood Elf" },
  { id: 5, name: "High Elf" },
  { id: 6, name: "Dark Elf" },
  { id: 7, name: "Half Elf" },
  { id: 8, name: "Dwarf" },
  { id: 9, name: "Troll" },
  { id: 10, name: "Ogre" },
  { id: 11, name: "Halfling" },
  { id: 12, name: "Gnome" },
  { id: 128, name: "Iksar" },
  { id: 130, name: "Vah Shir" },
  { id: 330, name: "Froglok" },
] as const;

export const MAX_CHAR_LEVEL = 60;

export function charClassLabel(id: number): string {
  return CHAR_CLASSES.find((c) => c.id === id)?.name ?? "Unknown";
}

export function charRaceName(id: number): string {
  return CHAR_RACES.find((r) => r.id === id)?.name ?? "Unknown";
}

export function isValidCharClass(id: number): boolean {
  return CHAR_CLASSES.some((c) => c.id === id);
}

export function isValidCharRace(id: number): boolean {
  return CHAR_RACES.some((r) => r.id === id);
}

// 10-wide brackets for the guild dashboard's level distribution, with the
// level cap broken out on its own — "how many are already 60" is a more
// useful read than folding it into "50-59".
export const LEVEL_BRACKETS = ["1-9", "10-19", "20-29", "30-39", "40-49", "50-59", `${MAX_CHAR_LEVEL}`] as const;

export function levelBracket(level: number): (typeof LEVEL_BRACKETS)[number] {
  if (level >= MAX_CHAR_LEVEL) return `${MAX_CHAR_LEVEL}`;
  if (level < 10) return "1-9";
  const start = Math.floor(level / 10) * 10;
  return `${start}-${start + 9}` as (typeof LEVEL_BRACKETS)[number];
}
