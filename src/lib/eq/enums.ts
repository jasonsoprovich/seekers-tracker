// Ported from pq-companion's char_class.go / char_race.go (0-based class
// index used by the spell-table API + character-creation dropdowns; raw EQ
// PC race id, not the compact 1-14 RaceIndex — see schema.ts comments and
// docs/guild-website-feasibility.md §4/§5).

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
] as const;

export const CHAR_RACES = [
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
  const entry = CHAR_CLASSES.find((c) => c.id === id);
  return entry ? `${entry.abbr} — ${entry.name}` : "Unknown";
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
