// Trimmed item_id -> stat-bonus lookup for derived-stat computation (§8
// Phase 3 / task 18). Sourced from pq-companion's bundled quarm.db, filtered
// to wearable items (slots > 0), keeping only the columns eqstat's formulas
// consume: AC/HP/mana, the seven attributes, and the five resists. Zero
// fields are omitted to keep the asset small.
import statsData from "@/data/item-stats.json";

export interface ItemStatBonus {
  ac?: number;
  hp?: number;
  mana?: number;
  str?: number;
  sta?: number;
  agi?: number;
  dex?: number;
  wis?: number;
  int?: number;
  cha?: number;
  mr?: number;
  cr?: number;
  fr?: number;
  dr?: number;
  pr?: number;
}

const stats = statsData as Record<string, ItemStatBonus>;

export function getItemStats(itemId: number): ItemStatBonus | undefined {
  return stats[String(itemId)];
}

export interface ItemStatLine {
  label: string;
  value: string;
}

const ATTRIBUTE_KEYS: [keyof ItemStatBonus, string][] = [
  ["str", "STR"],
  ["sta", "STA"],
  ["agi", "AGI"],
  ["dex", "DEX"],
  ["wis", "WIS"],
  ["int", "INT"],
  ["cha", "CHA"],
];

const RESIST_KEYS: [keyof ItemStatBonus, string][] = [
  ["mr", "Magic"],
  ["fr", "Fire"],
  ["cr", "Cold"],
  ["pr", "Poison"],
  ["dr", "Disease"],
];

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

// Groups a trimmed stat-bonus row into hover-card lines, Quarmy-style (AC,
// then HP/mana, then attributes, then resists) — only nonzero fields shown.
// No worn effects/lore/nodrop flags here (§8: item-stats.json only carries
// the columns eqstat's formulas consume), which is why this app also offers
// a Quarmy-profile link for full detail.
export function formatItemStatLines(stats: ItemStatBonus): ItemStatLine[] {
  const lines: ItemStatLine[] = [];
  if (stats.ac) lines.push({ label: "AC", value: signed(stats.ac) });
  if (stats.hp) lines.push({ label: "HP", value: signed(stats.hp) });
  if (stats.mana) lines.push({ label: "Mana", value: signed(stats.mana) });

  const attrs = ATTRIBUTE_KEYS.filter(([k]) => stats[k]).map(([k, label]) => `${label} ${signed(stats[k]!)}`);
  if (attrs.length) lines.push({ label: "Attributes", value: attrs.join("  ") });

  const resists = RESIST_KEYS.filter(([k]) => stats[k]).map(([k, label]) => `${label} ${signed(stats[k]!)}`);
  if (resists.length) lines.push({ label: "Resists", value: resists.join("  ") });

  return lines;
}
