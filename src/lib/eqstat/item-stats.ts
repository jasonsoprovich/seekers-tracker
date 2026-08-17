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
