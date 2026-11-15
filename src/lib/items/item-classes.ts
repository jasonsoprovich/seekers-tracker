// Item -> usable-class bitmask lookup for /bank's class filter (2026-11-14).
// Sourced from pq-companion's bundled quarm.db via
// scripts/gen-item-classes.sh, same pattern as src/lib/eqstat/item-nodrop.ts.
// SERVER-ONLY in practice: the JSON is ~170 KB, so it's resolved inside
// listBankHoldings and only the per-row mask ever reaches the browser.
//
// Bit N = the site's 0-based class id N (CHAR_CLASSES in src/lib/eq/enums.ts:
// Warrior = bit 0 … Beastlord = bit 14). Spell scrolls carry their caster
// classes, so spells and songs filter exactly like gear.
import itemClassesData from "@/data/item-classes.json";
import { CHAR_CLASSES, UNKNOWN_CLASS_ID } from "@/lib/eq/enums";

export const ALL_CLASSES_MASK = 0x7fff;

const RESTRICTED = itemClassesData as Record<string, number>;

// Every id the generator left out is either usable by all classes or has no
// class data at all (bags, notes, tradeskill materials) — both read as
// "anyone can use it", per the leader's "always include" call.
export function getItemClassMask(itemId: number): number {
  return RESTRICTED[String(itemId)] ?? ALL_CLASSES_MASK;
}

const REAL_CLASSES = CHAR_CLASSES.filter((c) => c.id !== UNKNOWN_CLASS_ID);

// Best-effort read of bank_holdings.class_restriction — a free-text field
// officers could fill in by hand ("WAR PAL", "Shadow Knight, Cleric",
// "all"). Only used as a fallback when an item can't be matched to the item
// database. Returns null when nothing recognizable is in it.
export function parseClassRestriction(text: string | null): number | null {
  if (!text) return null;
  const norm = ` ${text.toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
  if (norm === "  ") return null;
  if (/ (all|any|everyone) /.test(norm)) return ALL_CLASSES_MASK;
  let mask = 0;
  for (const c of REAL_CLASSES) {
    const name = ` ${c.name.toLowerCase()} `;
    const abbr = ` ${c.abbr.toLowerCase()} `;
    if (norm.includes(name) || norm.includes(abbr)) mask |= 1 << c.id;
  }
  // Common aliases officers actually type.
  if (/ (sk|shadowknight) /.test(norm)) mask |= 1 << 4;
  if (/ (mage) /.test(norm)) mask |= 1 << 12;
  if (/ (necro) /.test(norm)) mask |= 1 << 10;
  if (/ (ench|chanter) /.test(norm)) mask |= 1 << 13;
  if (/ (pally) /.test(norm)) mask |= 1 << 2;
  if (/ (shammy|sham) /.test(norm)) mask |= 1 << 9;
  if (/ (bl|beast) /.test(norm)) mask |= 1 << 14;
  return mask === 0 ? null : mask;
}
