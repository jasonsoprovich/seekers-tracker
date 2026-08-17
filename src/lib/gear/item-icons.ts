// Trimmed item_id -> icon_id lookup for gear-list display (§8: "consider
// shipping a trimmed static JSON of item id->name/icon rather than a full
// SQLite copy"). Item *names* come from the Quarmy export itself (the
// export already carries them), so this only needs id->icon. Sourced from
// pq-companion's bundled quarm.db, filtered to `icon > 0 AND slots > 0`
// (wearable items only) to keep the asset small — see
// docs/guild-website-feasibility.md §8.
//
// The icon id has no renderable art bundled with this app (pq-companion's
// icon PNGs are extracted client assets it ships as a desktop app; this
// public website doesn't redistribute them) — it's stored for a future
// icon source, not rendered as an image yet.
import iconData from "@/data/item-icons.json";

const icons = iconData as Record<string, number>;

export function getItemIcon(itemId: number): number | undefined {
  return icons[String(itemId)];
}
