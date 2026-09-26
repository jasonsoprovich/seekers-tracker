// NO DROP flag lookup (PLAN.md §9, 2026-09-25 officer feedback): "is it
// possible to display a red no drop flag... besides items that are marked
// as no drop in the quarm dump database so that members can quickly see
// if the item is tradeable or not." Sourced from pq-companion's bundled
// quarm.db via scripts/gen-item-nodrop.sh, same pattern as
// src/lib/eqstat/item-stats.ts's item-stats.json.
//
// Quarm's own `items.nodrop` column is confusingly named: `nodrop = 0`
// means the item IS a NO DROP item; any other value (-1, 1, and 255 all
// appear in the real data) is tradeable. Confirmed against pq-companion's
// own reader (backend/internal/db/queries.go's HideNoDrop filter, whose
// code comment there gets this right — the schema doc's own prose does
// not). item-nodrop.json is therefore already filtered down to just the
// NO DROP item IDs, sorted, so this file only needs a Set membership
// check, not the raw flag value.
import itemNodropData from "@/data/item-nodrop.json";

const NO_DROP_IDS = new Set<number>(itemNodropData as number[]);

// Returns false for null (a sheet/manual row never captured an item ID)
// and for any ID not in the NO DROP set — never guesses.
export function isNoDropItem(itemId: number | null): boolean {
  if (itemId === null) return false;
  return NO_DROP_IDS.has(itemId);
}
