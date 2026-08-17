// Canonical worn-equipment slots, in EQ's standard paperdoll order. Doubled
// slots (two ears, two wrists, two rings) get their own numbered keys —
// `character_gear`'s primary key is (character_id, slot), so each physical
// slot needs a distinct key or the second item would silently overwrite the
// first on import. See quarmy.ts for how raw export locations map to these.
export const GEAR_SLOTS = [
  { key: "Charm", label: "Charm" },
  { key: "Ear1", label: "Ear 1" },
  { key: "Head", label: "Head" },
  { key: "Face", label: "Face" },
  { key: "Ear2", label: "Ear 2" },
  { key: "Neck", label: "Neck" },
  { key: "Shoulders", label: "Shoulders" },
  { key: "Arms", label: "Arms" },
  { key: "Back", label: "Back" },
  { key: "Wrist1", label: "Wrist 1" },
  { key: "Wrist2", label: "Wrist 2" },
  { key: "Range", label: "Range" },
  { key: "Hands", label: "Hands" },
  { key: "Primary", label: "Primary" },
  { key: "Secondary", label: "Secondary" },
  { key: "Fingers1", label: "Ring 1" },
  { key: "Fingers2", label: "Ring 2" },
  { key: "Chest", label: "Chest" },
  { key: "Legs", label: "Legs" },
  { key: "Feet", label: "Feet" },
  { key: "Waist", label: "Waist" },
  { key: "Ammo", label: "Ammo" },
  { key: "PowerSource", label: "Power Source" },
] as const;

export type GearSlotKey = (typeof GEAR_SLOTS)[number]["key"];

export function gearSlotLabel(key: string): string {
  return GEAR_SLOTS.find((s) => s.key === key)?.label ?? key;
}
